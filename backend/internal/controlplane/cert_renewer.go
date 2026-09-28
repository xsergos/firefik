package controlplane

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
	"time"

	pb "firefik/internal/controlplane/gen/controlplanev1"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const DefaultCertRenewBefore = 72 * time.Hour

type RenewClient interface {
	RenewCert(ctx context.Context, in *pb.RenewCertRequest, opts ...grpc.CallOption) (*pb.RenewCertResponse, error)
}

type CertRenewer struct {
	AgentID     string
	CertPath    string
	KeyPath     string
	BundlePath  string
	RenewBefore time.Duration
	Interval    time.Duration
	TTLSeconds  int
	Logger      *slog.Logger
	Client      RenewClient
	OnRotated   func()

	clock    func() time.Time
	cpWindow atomic.Int64
}

func (r *CertRenewer) Run(ctx context.Context) error {
	if r.Client == nil || r.CertPath == "" || r.KeyPath == "" {
		return nil
	}
	logger := r.logger()
	interval := r.Interval
	if interval <= 0 {
		interval = 30 * time.Minute
	}
	if r.RenewBefore <= 0 {
		r.RenewBefore = DefaultCertRenewBefore
	}

	r.tick(ctx, logger)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			r.tick(ctx, logger)
		}
	}
}

func (r *CertRenewer) Tick(ctx context.Context) {
	r.tick(ctx, r.logger())
}

func (r *CertRenewer) tick(ctx context.Context, logger *slog.Logger) {
	cert, err := loadAgentCert(r.CertPath)
	if err != nil {
		logger.Warn("cert renew: load existing cert", "path", r.CertPath, "error", err)
		AgentCertRenewFailedTotal.WithLabelValues("load_cert").Inc()
		return
	}
	now := time.Now()
	if r.clock != nil {
		now = r.clock()
	}
	remaining := cert.NotAfter.Sub(now)
	if remaining > r.renewThreshold() {
		return
	}
	logger.Info("cert renew: starting", "agent_id", r.AgentID, "remaining", remaining.Truncate(time.Second))

	csrPEM, err := buildCSR(r.KeyPath, r.AgentID)
	if err != nil {
		logger.Warn("cert renew: build CSR", "error", err)
		AgentCertRenewFailedTotal.WithLabelValues("build_csr").Inc()
		return
	}

	resp, err := r.Client.RenewCert(ctx, &pb.RenewCertRequest{
		AgentId:    r.AgentID,
		TtlSeconds: int64(r.TTLSeconds),
		CsrPem:     csrPEM,
	})
	if err != nil {
		reason := renewFailureReason(err)
		AgentCertRenewFailedTotal.WithLabelValues(reason).Inc()
		if reason == "outside_window" {
			window, _ := parseRenewWindow(err)
			r.cpWindow.Store(int64(window))
			logger.Info("cert renew: outside control-plane renew window, deferring",
				"remaining", remaining.Truncate(time.Second),
				"cp_window", window,
				"renew_before", r.RenewBefore,
			)
			return
		}
		logger.Warn("cert renew: RPC failed", "reason", reason, "error", err)
		return
	}
	if len(resp.GetCertPem()) == 0 {
		logger.Warn("cert renew: empty response payload")
		AgentCertRenewFailedTotal.WithLabelValues("empty_response").Inc()
		return
	}

	if err := writeFileAtomic(r.CertPath, resp.GetCertPem(), 0o644); err != nil {
		logger.Warn("cert renew: write cert", "error", err)
		AgentCertRenewFailedTotal.WithLabelValues("write_cert").Inc()
		return
	}
	if r.BundlePath != "" && len(resp.GetBundlePem()) > 0 {
		existing, _ := os.ReadFile(r.BundlePath)
		if !bytes.Equal(existing, resp.GetBundlePem()) {
			if err := writeFileAtomic(r.BundlePath, resp.GetBundlePem(), 0o644); err != nil {
				logger.Warn("cert renew: write bundle", "error", err)
			} else {
				AgentBundleRotatedTotal.Inc()
				logger.Info("cert renew: bundle rotated", "path", r.BundlePath)
			}
		}
	}

	r.cpWindow.Store(0)
	AgentCertRenewedTotal.Inc()
	logger.Info("cert renew: rotated",
		"agent_id", r.AgentID,
		"serial", resp.GetSerial(),
		"expires_at", time.Unix(resp.GetExpiresUnix(), 0).UTC().Format(time.RFC3339),
	)
	if r.OnRotated != nil {
		r.OnRotated()
	}
}

func (r *CertRenewer) renewThreshold() time.Duration {
	threshold := r.RenewBefore
	if threshold <= 0 {
		threshold = DefaultCertRenewBefore
	}
	if w := time.Duration(r.cpWindow.Load()); w > 0 && w < threshold {
		threshold = w
	}
	return threshold
}

func renewFailureReason(err error) string {
	switch status.Code(err) {
	case codes.FailedPrecondition:
		if _, ok := parseRenewWindow(err); ok {
			return "outside_window"
		}
	case codes.ResourceExhausted:
		return "rate_limited"
	case codes.PermissionDenied, codes.Unauthenticated:
		return "denied"
	}
	return "rpc_error"
}

func parseRenewWindow(err error) (time.Duration, bool) {
	msg := status.Convert(err).Message()
	i := strings.LastIndex(msg, renewWindowMarker)
	if i < 0 {
		return 0, false
	}
	d, perr := time.ParseDuration(msg[i+len(renewWindowMarker):])
	if perr != nil || d <= 0 {
		return 0, false
	}
	return d, true
}

func (r *CertRenewer) logger() *slog.Logger {
	if r.Logger != nil {
		return r.Logger
	}
	return slog.Default()
}

func buildCSR(keyPath, agentID string) ([]byte, error) {
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("read key: %w", err)
	}
	signer, err := parsePrivateKeyPEM(keyPEM)
	if err != nil {
		return nil, fmt.Errorf("parse key: %w", err)
	}
	tmpl := &x509.CertificateRequest{Subject: pkix.Name{CommonName: agentID}}
	der, err := x509.CreateCertificateRequest(rand.Reader, tmpl, signer)
	if err != nil {
		return nil, fmt.Errorf("create CSR: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}), nil
}

func parsePrivateKeyPEM(data []byte) (crypto.Signer, error) {
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("no PEM block")
	}
	switch block.Type {
	case "EC PRIVATE KEY":
		k, err := x509.ParseECPrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		return k, nil
	case "RSA PRIVATE KEY":
		k, err := x509.ParsePKCS1PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		return k, nil
	case "PRIVATE KEY":
		k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		signer, ok := k.(crypto.Signer)
		if !ok {
			return nil, errors.New("PKCS8 key is not a Signer")
		}
		return signer, nil
	default:
		return nil, fmt.Errorf("unsupported PEM type %q", block.Type)
	}
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	if path == "" {
		return errors.New("empty path")
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("write temp: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("sync temp: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("close temp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}
