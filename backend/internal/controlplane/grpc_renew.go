package controlplane

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"strings"
	"time"

	pb "firefik/internal/controlplane/gen/controlplanev1"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

const (
	DefaultRenewWindow      = 72 * time.Hour
	defaultMinRenewInterval = 5 * time.Minute
	renewWindowMarker       = "; renew window is "
)

type CertAuthority interface {
	Issue(req CAIssueRequest) (*CAIssueResult, error)
	IssueFromCSR(csrPEM []byte, agentID string, ttl time.Duration) (*CAIssueResult, error)
	IsRevoked(serial string) bool
	TrustBundlePEM() []byte
}

type CAIssueRequest struct {
	AgentID   string
	TTL       time.Duration
	PublicKey interface{}
}

type CAIssueResult struct {
	CertPEM   []byte
	KeyPEM    []byte
	BundlePEM []byte
	SerialHex string
	NotAfter  time.Time
	SPIFFEURI string
}

func (s *GRPCServer) RenewCert(ctx context.Context, req *pb.RenewCertRequest) (*pb.RenewCertResponse, error) {
	if s.CA == nil {
		return nil, status.Error(codes.FailedPrecondition, "renew disabled: no CA configured")
	}
	peerCert, err := peerCertFromContext(ctx)
	if err != nil {
		IncRenewRejected("no_peer_cert")
		return nil, status.Error(codes.Unauthenticated, err.Error())
	}

	if s.TrustDomain != "" {
		verify := spiffeVerifier(s.TrustDomain)
		if err := verify(peerCert); err != nil {
			IncRenewRejected("trust_domain")
			IncMTLSRejected("trust_domain")
			return nil, status.Error(codes.PermissionDenied, err.Error())
		}
	}

	certAgentID := agentIDFromCert(peerCert)
	if certAgentID == "" {
		IncRenewRejected("no_spiffe_san")
		return nil, status.Error(codes.PermissionDenied, "peer cert lacks SPIFFE agent SAN")
	}

	if req.GetAgentId() != "" && req.GetAgentId() != certAgentID {
		IncRenewRejected("id_mismatch")
		return nil, status.Error(codes.PermissionDenied, "agent_id does not match peer certificate")
	}
	agentID := certAgentID

	peerSerial := strings.ToLower(peerCert.SerialNumber.Text(16))
	if s.CA.IsRevoked(peerSerial) {
		IncRenewRejected("revoked")
		s.emitAudit("cert_renew_rejected", map[string]string{
			"agent_id":  agentID,
			"serial":    peerSerial,
			"reason":    "revoked",
			"transport": "grpc",
		})
		return nil, status.Error(codes.PermissionDenied, "client certificate is revoked")
	}

	now := time.Now()
	window := s.RenewWindow
	if window <= 0 {
		window = DefaultRenewWindow
	}
	if peerCert.NotAfter.Sub(now) > window {
		IncRenewRejected("outside_renewal_window")
		return nil, status.Error(codes.FailedPrecondition,
			"certificate valid for "+peerCert.NotAfter.Sub(now).Truncate(time.Second).String()+
				renewWindowMarker+window.String())
	}

	minInterval := s.MinRenewInterval
	if minInterval < 0 {
		minInterval = 0
	}
	if minInterval == 0 {
		minInterval = defaultMinRenewInterval
	}
	if s.Registry != nil && s.Registry.store != nil && minInterval > 0 {
		last, ok, lerr := s.Registry.store.LastCertRenew(ctx, peerSerial)
		if lerr == nil && ok && now.Sub(last) < minInterval {
			IncRenewRejected("rate_limited")
			return nil, status.Error(codes.ResourceExhausted, "renew too frequent for this serial; wait "+minInterval.String())
		}
	}

	ttl := time.Duration(req.GetTtlSeconds()) * time.Second
	var (
		result *CAIssueResult
		issErr error
	)
	csrMode := false
	if len(req.GetCsrPem()) > 0 {
		csrMode = true
		if !csrPubKeyMatchesPeer(req.GetCsrPem(), peerCert) {
			IncRenewRejected("csr_pubkey_mismatch")
			return nil, status.Error(codes.InvalidArgument, "CSR public key must match the peer cert public key")
		}
		result, issErr = s.CA.IssueFromCSR(req.GetCsrPem(), agentID, ttl)
	} else {
		result, issErr = s.CA.Issue(CAIssueRequest{AgentID: agentID, TTL: ttl})
	}
	if issErr != nil {
		IncRenewRejected("internal_error")
		if s.Logger != nil {
			s.Logger.Warn("renew issue failed", "agent_id", agentID, "error", issErr)
		}
		return nil, status.Error(codes.Internal, "issue failed")
	}

	if s.Registry != nil && s.Registry.store != nil {
		if err := s.Registry.store.RecordCertRenew(ctx, peerSerial, agentID, now); err != nil && s.Logger != nil {
			s.Logger.Warn("record renew failed", "error", err)
		}
	}

	IncCertRenewed()
	s.emitAudit("cert_renewed", map[string]string{
		"agent_id":   agentID,
		"serial_old": peerSerial,
		"serial_new": result.SerialHex,
		"expires_at": result.NotAfter.Format(time.RFC3339),
		"csr_mode":   boolStr(csrMode),
		"transport":  "grpc",
	})

	resp := &pb.RenewCertResponse{
		CertPem:     result.CertPEM,
		KeyPem:      result.KeyPEM,
		BundlePem:   result.BundlePEM,
		Serial:      result.SerialHex,
		ExpiresUnix: result.NotAfter.Unix(),
	}
	return resp, nil
}

func (s *GRPCServer) emitAudit(action string, meta map[string]string) {
	if s.Audit != nil {
		s.Audit.Emit(action, meta)
	}
}

func peerCertFromContext(ctx context.Context) (*x509.Certificate, error) {
	p, ok := peer.FromContext(ctx)
	if !ok {
		return nil, errors.New("no peer in context")
	}
	tlsInfo, ok := p.AuthInfo.(credentials.TLSInfo)
	if !ok {
		return nil, errors.New("peer is not TLS")
	}
	if len(tlsInfo.State.PeerCertificates) == 0 {
		return nil, errors.New("client certificate required")
	}
	return tlsInfo.State.PeerCertificates[0], nil
}

func spiffeVerifier(trustDomain string) func(*x509.Certificate) error {
	domain := strings.TrimPrefix(trustDomain, "spiffe://")
	domain = strings.TrimSuffix(domain, "/")
	prefix := "spiffe://" + domain + "/"
	return func(cert *x509.Certificate) error {
		for _, u := range cert.URIs {
			if u != nil && strings.HasPrefix(u.String(), prefix) {
				return nil
			}
		}
		return errors.New("peer has no SPIFFE SAN under " + prefix)
	}
}

func agentIDFromCert(cert *x509.Certificate) string {
	for _, u := range cert.URIs {
		if u == nil {
			continue
		}
		s := u.String()
		const marker = "/agent/"
		if i := strings.Index(s, marker); i >= 0 {
			return s[i+len(marker):]
		}
	}
	return ""
}

func csrPubKeyMatchesPeer(csrPEM []byte, peer *x509.Certificate) bool {
	block, _ := pem.Decode(csrPEM)
	if block == nil {
		return false
	}
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil {
		return false
	}
	csrPub, err := x509.MarshalPKIXPublicKey(csr.PublicKey)
	if err != nil {
		return false
	}
	peerPub, err := x509.MarshalPKIXPublicKey(peer.PublicKey)
	if err != nil {
		return false
	}
	return bytes.Equal(csrPub, peerPub)
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
