package controlplane

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestNewAgentLoopDefaults(t *testing.T) {
	l := NewAgentLoop(AgentLoopConfig{}, AgentIdentity{InstanceID: "x"}, nil, nil, nil)
	if l.cfg.SnapshotInterval == 0 || l.cfg.HeartbeatInterval == 0 {
		t.Errorf("expected defaults: %+v", l.cfg)
	}
}

func TestNewAgentLoopPreservesIntervals(t *testing.T) {
	l := NewAgentLoop(AgentLoopConfig{SnapshotInterval: 5 * time.Second, HeartbeatInterval: 7 * time.Second}, AgentIdentity{}, nil, nil, nil)
	if l.cfg.SnapshotInterval != 5*time.Second || l.cfg.HeartbeatInterval != 7*time.Second {
		t.Errorf("intervals not preserved: %+v", l.cfg)
	}
}

func TestRunEmptyEndpoint(t *testing.T) {
	l := NewAgentLoop(AgentLoopConfig{}, AgentIdentity{}, nil, nil, nil)
	if err := l.Run(context.Background()); err == nil {
		t.Errorf("expected error")
	}
}

func TestBuildClientTLSEmpty(t *testing.T) {
	cfg, err := buildClientTLS(false, "", "", "")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if cfg.MinVersion == 0 {
		t.Errorf("MinVersion not set")
	}
}

func TestBuildClientTLSInsecure(t *testing.T) {
	cfg, err := buildClientTLS(true, "", "", "")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !cfg.InsecureSkipVerify {
		t.Errorf("InsecureSkipVerify not set")
	}
}

func TestBuildClientTLSMissingCA(t *testing.T) {
	if _, err := buildClientTLS(false, "/no/such/ca.pem", "", ""); err == nil {
		t.Errorf("expected error")
	}
}

func TestBuildClientTLSInvalidCA(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(tmp, []byte("not pem"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := buildClientTLS(false, tmp, "", ""); err == nil {
		t.Errorf("expected error")
	}
}

func TestBuildClientTLSWithValidCA(t *testing.T) {
	dir := t.TempDir()
	caPath := writeTestCA(t, dir)
	cfg, err := buildClientTLS(false, caPath, "", "")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if cfg.RootCAs == nil {
		t.Errorf("RootCAs not set")
	}
}

func TestBuildClientTLSBadCertKey(t *testing.T) {
	dir := t.TempDir()
	c := filepath.Join(dir, "c.pem")
	k := filepath.Join(dir, "k.pem")
	if err := os.WriteFile(c, []byte("bad"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(k, []byte("bad"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := buildClientTLS(false, "", c, k); err == nil {
		t.Errorf("expected error")
	}
}

type fakeAgentSource struct {
	called int
	fail   bool
}

func (f *fakeAgentSource) Snapshot(ctx context.Context, id AgentIdentity) (AgentSnapshot, error) {
	f.called++
	if f.fail {
		return AgentSnapshot{}, context.Canceled
	}
	return AgentSnapshot{Agent: id}, nil
}

func TestSnapshotTickerCancellation(t *testing.T) {
	src := &fakeAgentSource{}
	l := NewAgentLoop(AgentLoopConfig{
		SnapshotInterval:  5 * time.Millisecond,
		HeartbeatInterval: 5 * time.Millisecond,
	}, AgentIdentity{InstanceID: "x"}, src, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	gc := NewGRPCClient(GRPCClientConfig{Endpoint: "127.0.0.1:1"})
	done := make(chan struct{})
	go func() {
		l.snapshotTicker(ctx, gc)
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("snapshotTicker did not exit")
	}
}

func TestSnapshotTickerSourceError(t *testing.T) {
	src := &fakeAgentSource{fail: true}
	l := NewAgentLoop(AgentLoopConfig{
		SnapshotInterval:  3 * time.Millisecond,
		HeartbeatInterval: 3 * time.Millisecond,
	}, AgentIdentity{InstanceID: "x"}, src, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	gc := NewGRPCClient(GRPCClientConfig{Endpoint: "127.0.0.1:1"})
	done := make(chan struct{})
	go func() {
		l.snapshotTicker(ctx, gc)
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	<-done
}

func TestRunBadTLS(t *testing.T) {
	l := NewAgentLoop(AgentLoopConfig{
		GRPCEndpoint: "127.0.0.1:1",
		CACertPath:   "/no/such/ca",
	}, AgentIdentity{InstanceID: "x"}, &fakeAgentSource{}, nil, nil)
	if err := l.Run(context.Background()); err == nil {
		t.Errorf("expected tls error")
	}
}

func TestRunCanceledQuickly(t *testing.T) {
	l := NewAgentLoop(AgentLoopConfig{
		GRPCEndpoint:      "127.0.0.1:1",
		SnapshotInterval:  5 * time.Millisecond,
		HeartbeatInterval: 5 * time.Millisecond,
	}, AgentIdentity{InstanceID: "x"}, &fakeAgentSource{}, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := l.Run(ctx); err != nil {
		t.Errorf("expected nil on cancel, got %v", err)
	}
}

func writeTestCA(t *testing.T, dir string) string {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatal(err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	p := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(p, pemBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

type chanAuditSource struct{ ch chan map[string]any }

func (c chanAuditSource) Audits() <-chan map[string]any { return c.ch }

type recordingAuditSender struct {
	mu   sync.Mutex
	sent []map[string]any
}

func (r *recordingAuditSender) SendAudit(ev map[string]any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, ev)
	return nil
}

func (r *recordingAuditSender) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sent)
}

func TestAuditForwarderSendsEvents(t *testing.T) {
	src := chanAuditSource{ch: make(chan map[string]any, 2)}
	l := NewAgentLoop(AgentLoopConfig{}, AgentIdentity{InstanceID: "x"}, &fakeAgentSource{}, nil, nil).WithAuditSource(src)
	sender := &recordingAuditSender{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		l.auditForwarder(ctx, sender)
		close(done)
	}()
	src.ch <- map[string]any{"action": "apply"}
	src.ch <- map[string]any{"action": "policy_updated"}
	deadline := time.Now().Add(time.Second)
	for sender.count() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if sender.count() != 2 {
		t.Fatalf("forwarded %d events, want 2", sender.count())
	}
}
