package controlplane

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	pb "firefik/internal/controlplane/gen/controlplanev1"

	dto "github.com/prometheus/client_model/go"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type directRenewClient struct {
	srv   *GRPCServer
	peer  *x509.Certificate
	calls int
}

func (c *directRenewClient) RenewCert(_ context.Context, in *pb.RenewCertRequest, _ ...grpc.CallOption) (*pb.RenewCertResponse, error) {
	c.calls++
	return c.srv.RenewCert(ctxWithPeerCert(c.peer), in)
}

func renewFailed(reason string) float64 {
	m := &dto.Metric{}
	if err := AgentCertRenewFailedTotal.WithLabelValues(reason).Write(m); err != nil {
		return -1
	}
	return m.GetCounter().GetValue()
}

func setupRenewPair(t *testing.T, ttl time.Duration, srv *GRPCServer) (*CertRenewer, *directRenewClient, string) {
	t.Helper()
	pki := makeTestPKI(t)
	dir := t.TempDir()
	certPath := filepath.Join(dir, "client.crt")
	keyPath := filepath.Join(dir, "client.key")
	certPEM, keyPEM := pki.issueClient(t, "agent-a", ttl)
	writeAll(t, map[string][]byte{certPath: certPEM, keyPath: keyPEM})
	block, _ := pem.Decode(certPEM)
	peerCert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	client := &directRenewClient{srv: srv, peer: peerCert}
	r := &CertRenewer{
		AgentID:  "agent-a",
		CertPath: certPath,
		KeyPath:  keyPath,
		Client:   client,
		Logger:   slog.Default(),
	}
	return r, client, certPath
}

func defaultRenewServer() *GRPCServer {
	return &GRPCServer{
		Registry:    &Registry{store: NewMemoryStore()},
		Logger:      slog.Default(),
		CA:          newFakeCA(),
		TrustDomain: "spiffe://test.firefik/",
	}
}

func TestRenewDefaults_AgentRenewBeforeWithinCPWindow(t *testing.T) {
	if DefaultCertRenewBefore > DefaultRenewWindow {
		t.Fatalf("agent default renew-before %s exceeds CP default renew window %s", DefaultCertRenewBefore, DefaultRenewWindow)
	}
}

func TestCertRenewer_DefaultsAgainstDefaultCP(t *testing.T) {
	r, client, _ := setupRenewPair(t, DefaultCertRenewBefore+10*time.Minute, defaultRenewServer())
	r.Tick(context.Background())
	if client.calls != 0 {
		t.Fatalf("renewed %d times before entering the renew-before window", client.calls)
	}

	r, client, certPath := setupRenewPair(t, DefaultCertRenewBefore-time.Minute, defaultRenewServer())
	outside, rpcErr := renewFailed("outside_window"), renewFailed("rpc_error")
	r.Tick(context.Background())
	if client.calls != 1 {
		t.Fatalf("expected one RenewCert call, got %d", client.calls)
	}
	if got, _ := os.ReadFile(certPath); string(got) != "CERT" {
		t.Fatalf("cert not rotated on first tick inside the window: %q", got)
	}
	if renewFailed("outside_window") != outside || renewFailed("rpc_error") != rpcErr {
		t.Fatal("renew failure counted with default agent and CP settings")
	}
}

func TestCertRenewer_OutsideWindowBacksOff(t *testing.T) {
	srv := defaultRenewServer()
	srv.RenewWindow = 24 * time.Hour
	r, client, certPath := setupRenewPair(t, 48*time.Hour, srv)
	outside, rpcErr := renewFailed("outside_window"), renewFailed("rpc_error")

	r.Tick(context.Background())
	if client.calls != 1 {
		t.Fatalf("expected one RenewCert call, got %d", client.calls)
	}
	if renewFailed("outside_window") != outside+1 {
		t.Fatal("outside_window not counted")
	}
	if renewFailed("rpc_error") != rpcErr {
		t.Fatal("outside_window counted as rpc_error")
	}
	if got := r.renewThreshold(); got != 24*time.Hour {
		t.Fatalf("threshold after outside_window: %s", got)
	}

	r.Tick(context.Background())
	if client.calls != 1 {
		t.Fatalf("agent retried outside the CP window: %d calls", client.calls)
	}

	srv.RenewWindow = DefaultRenewWindow
	r.clock = func() time.Time { return time.Now().Add(25 * time.Hour) }
	r.Tick(context.Background())
	if client.calls != 2 {
		t.Fatalf("agent did not renew inside the learned window: %d calls", client.calls)
	}
	if got, _ := os.ReadFile(certPath); string(got) != "CERT" {
		t.Fatalf("cert not rotated: %q", got)
	}
	if got := r.renewThreshold(); got != DefaultCertRenewBefore {
		t.Fatalf("learned window not reset after renewal: %s", got)
	}
}

func TestRenewFailureReason(t *testing.T) {
	srv := newGRPCRenewServer(newFakeCA())
	cert, _ := makePeerCert(t, "agent-a", 10*24*time.Hour)
	_, windowErr := srv.RenewCert(ctxWithPeerCert(cert), &pb.RenewCertRequest{AgentId: "agent-a"})
	if d, ok := parseRenewWindow(windowErr); !ok || d != srv.RenewWindow {
		t.Fatalf("parse CP window from %v: %s %v", windowErr, d, ok)
	}

	cases := []struct {
		err  error
		want string
	}{
		{windowErr, "outside_window"},
		{status.Error(codes.FailedPrecondition, "renew disabled: no CA configured"), "rpc_error"},
		{status.Error(codes.FailedPrecondition, "certificate valid for 1h; renew window is soon"), "rpc_error"},
		{status.Error(codes.ResourceExhausted, "renew too frequent"), "rate_limited"},
		{status.Error(codes.PermissionDenied, "revoked"), "denied"},
		{status.Error(codes.Unauthenticated, "client certificate required"), "denied"},
		{status.Error(codes.Unavailable, "connection refused"), "rpc_error"},
		{status.Error(codes.Internal, "issue failed"), "rpc_error"},
		{errors.New("boom"), "rpc_error"},
	}
	for _, c := range cases {
		if got := renewFailureReason(c.err); got != c.want {
			t.Errorf("%v: got %q, want %q", c.err, got, c.want)
		}
	}
}
