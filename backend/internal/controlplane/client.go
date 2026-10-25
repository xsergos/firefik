package controlplane

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	pb "firefik/internal/controlplane/gen/controlplanev1"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

type EnrollRequest struct {
	AgentID         string `json:"agent_id"`
	TTLSeconds      int    `json:"ttl_seconds,omitempty"`
	TrustDomain     string `json:"trust_domain,omitempty"`
	EnrollmentToken string `json:"enrollment_token,omitempty"`
}

type EnrollResponse struct {
	CertPEM      string `json:"cert_pem"`
	KeyPEM       string `json:"key_pem"`
	BundlePEM    string `json:"bundle_pem"`
	Serial       string `json:"serial"`
	SPIFFEURI    string `json:"spiffe_uri"`
	NotAfterUnix int64  `json:"not_after_unix"`
}

type EnrollClient struct {
	Endpoint string
	Token    string
	HTTP     *http.Client
}

func NewEnrollClient(endpoint, token string) *EnrollClient {
	return &EnrollClient{
		Endpoint: endpoint,
		Token:    token,
		HTTP:     &http.Client{Timeout: 30 * time.Second},
	}
}

type RenewGRPCDialConfig struct {
	Endpoint string
	CertPath string
	KeyPath  string
	CAPath   string
	Insecure bool
}

func DialRenewClient(cfg RenewGRPCDialConfig) (pb.ControlPlaneClient, *grpc.ClientConn, error) {
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: cfg.Insecure} // #nosec G402 -- explicit operator opt-in flag
	if cfg.CAPath != "" {
		caPEM, err := os.ReadFile(cfg.CAPath)
		if err != nil {
			return nil, nil, fmt.Errorf("read ca: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caPEM) {
			return nil, nil, fmt.Errorf("no certs in %s", cfg.CAPath)
		}
		tlsCfg.RootCAs = pool
	}
	loader := newKeyPairLoader(cfg.CertPath, cfg.KeyPath)
	tlsCfg.GetClientCertificate = loader.GetClientCertificate

	conn, err := grpc.NewClient(cfg.Endpoint, grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)))
	if err != nil {
		return nil, nil, fmt.Errorf("grpc dial %s: %w", cfg.Endpoint, err)
	}
	return pb.NewControlPlaneClient(conn), conn, nil
}

func (c *EnrollClient) Enroll(ctx context.Context, req EnrollRequest) (*EnrollResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Endpoint+"/v1/enroll", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTP.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("enroll returned %d: %s", resp.StatusCode, string(raw))
	}
	var out EnrollResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode enroll: %w", err)
	}
	return &out, nil
}
