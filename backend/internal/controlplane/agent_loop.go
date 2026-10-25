package controlplane

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"os"
	"time"
)

type AgentLoopConfig struct {
	GRPCEndpoint      string
	Token             string
	Insecure          bool
	CACertPath        string
	ClientCertPath    string
	ClientKeyPath     string
	SnapshotInterval  time.Duration
	HeartbeatInterval time.Duration
}

type AgentSource interface {
	Snapshot(ctx context.Context, id AgentIdentity) (AgentSnapshot, error)
}

type LogForwardSource interface {
	Logs() <-chan LogLine
}

type AutogenProposalSource interface {
	Proposals(ctx context.Context) []AutogenProposal
}

type AgentLoop struct {
	cfg            AgentLoopConfig
	identity       AgentIdentity
	source         AgentSource
	logSource      LogForwardSource
	proposalSource AutogenProposalSource
	dispatcher     CommandDispatcher
	logger         *slog.Logger
}

func NewAgentLoop(
	cfg AgentLoopConfig,
	identity AgentIdentity,
	source AgentSource,
	dispatcher CommandDispatcher,
	logger *slog.Logger,
) *AgentLoop {
	if cfg.SnapshotInterval == 0 {
		cfg.SnapshotInterval = 30 * time.Second
	}
	if cfg.HeartbeatInterval == 0 {
		cfg.HeartbeatInterval = 30 * time.Second
	}
	return &AgentLoop{
		cfg:        cfg,
		identity:   identity,
		source:     source,
		dispatcher: dispatcher,
		logger:     logger,
	}
}

func (l *AgentLoop) WithLogSource(s LogForwardSource) *AgentLoop {
	l.logSource = s
	return l
}

func (l *AgentLoop) WithProposalSource(s AutogenProposalSource) *AgentLoop {
	l.proposalSource = s
	return l
}

func (l *AgentLoop) Run(ctx context.Context) error {
	if l.cfg.GRPCEndpoint == "" {
		return fmt.Errorf("FIREFIK_CONTROL_PLANE_GRPC is empty")
	}
	tlsCfg, err := buildClientTLS(l.cfg.Insecure, l.cfg.CACertPath, l.cfg.ClientCertPath, l.cfg.ClientKeyPath)
	if err != nil {
		return fmt.Errorf("control-plane tls: %w", err)
	}

	grpcClient := NewGRPCClient(GRPCClientConfig{
		Endpoint:   l.cfg.GRPCEndpoint,
		Token:      l.cfg.Token,
		Identity:   l.identity,
		TLSConfig:  tlsCfg,
		Dispatcher: l.dispatcher,
		Logger:     l.logger,
	})

	pushCtx, pushCancel := context.WithCancel(ctx)
	defer pushCancel()
	go l.snapshotTicker(pushCtx, grpcClient)
	if l.logSource != nil {
		go l.logForwarder(pushCtx, grpcClient)
	}

	return grpcClient.Run(ctx)
}

func (l *AgentLoop) logForwarder(ctx context.Context, grpcClient *GRPCClient) {
	ch := l.logSource.Logs()
	if ch == nil {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case line, ok := <-ch:
			if !ok {
				return
			}
			if err := grpcClient.SendLog(line); err != nil && l.logger != nil {
				l.logger.Debug("log forward failed", "error", err)
			}
		}
	}
}

func (l *AgentLoop) snapshotTicker(ctx context.Context, grpcClient *GRPCClient) {
	snapTicker := time.NewTicker(l.cfg.SnapshotInterval)
	defer snapTicker.Stop()
	hbTicker := time.NewTicker(l.cfg.HeartbeatInterval)
	defer hbTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return

		case <-snapTicker.C:
			snap, err := l.source.Snapshot(ctx, l.identity)
			if err != nil {
				if l.logger != nil {
					l.logger.Debug("snapshot build failed", "error", err)
				}
			} else if err := grpcClient.SendSnapshot(snap); err != nil && l.logger != nil {
				l.logger.Debug("snapshot send", "error", err)
			}
			if l.proposalSource != nil {
				if items := l.proposalSource.Proposals(ctx); len(items) > 0 {
					if err := grpcClient.SendAutogenProposals(items); err != nil && l.logger != nil {
						l.logger.Debug("autogen proposals send", "error", err)
					}
				}
			}

		case <-hbTicker.C:
			if err := grpcClient.SendHeartbeat(); err != nil && l.logger != nil {
				l.logger.Debug("heartbeat send", "error", err)
			}
		}
	}
}

func buildClientTLS(insecureSkipVerify bool, caPath, certPath, keyPath string) (*tls.Config, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if insecureSkipVerify {
		cfg.InsecureSkipVerify = true // #nosec G402 -- explicit operator opt-in flag
	}
	if caPath != "" {
		pem, err := os.ReadFile(caPath)
		if err != nil {
			return nil, fmt.Errorf("read ca: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("no certs in %s", caPath)
		}
		cfg.RootCAs = pool
	}
	if certPath != "" && keyPath != "" {
		if _, err := tls.LoadX509KeyPair(certPath, keyPath); err != nil {
			return nil, fmt.Errorf("client cert/key: %w", err)
		}
		loader := newKeyPairLoader(certPath, keyPath)
		cfg.GetClientCertificate = loader.GetClientCertificate
	}
	return cfg, nil
}
