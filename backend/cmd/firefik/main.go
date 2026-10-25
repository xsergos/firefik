package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sync/errgroup"

	"firefik/internal/agentdispatch"
	"firefik/internal/api"
	"firefik/internal/audit"
	"firefik/internal/autogen"
	"firefik/internal/config"
	"firefik/internal/controlplane"
	"firefik/internal/docker"
	"firefik/internal/geoip"
	"firefik/internal/logstream"
	"firefik/internal/metrics"
	"firefik/internal/policy"
	"firefik/internal/rules"
	"firefik/internal/telemetry"
)

var version = "dev"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	if err := run(logger); err != nil {
		logger.Error("firefik exited with error", "error", err)
		os.Exit(1)
	}
	logger.Info("firefik stopped")
}

func run(logger *slog.Logger) error {
	cfg := config.Load()
	cfg.Version = version

	tracesShutdown := setupTraces(logger, version)
	defer runShutdown(logger, "opentelemetry shutdown failed", tracesShutdown)
	metricsShutdown := setupMetrics(logger, version)
	defer runShutdown(logger, "opentelemetry metrics shutdown failed", metricsShutdown)
	logsShutdown := setupLogs(logger, version)
	defer runShutdown(logger, "opentelemetry logs shutdown failed", logsShutdown)

	if cfg.Backend == "auto" {
		cfg.Backend = rules.DetectBackendType()
		logger.Info("auto-detected backend", "backend", cfg.Backend)
	}

	if err := cfg.FinaliseForRuntime(); err != nil {
		return err
	}
	if cfg.EffectiveChain != cfg.ChainName {
		logger.Info("blue-green deploy: using suffixed chain", "base", cfg.ChainName, "effective", cfg.EffectiveChain)
	}

	_ = metrics.NewRegistry()

	if cfg.Backend == "nftables" {
		if _, err := metrics.NewNFTablesCollector(cfg.EffectiveChain); err != nil {
			logger.Warn("nftables collector unavailable", "error", err)
		}
	} else {
		if _, err := metrics.NewIPTablesCollector(cfg.EffectiveChain); err != nil {
			logger.Warn("iptables collector unavailable", "error", err)
		}
	}

	dockerClient, err := docker.NewClient()
	if err != nil {
		return fmt.Errorf("create docker client: %w", err)
	}
	defer dockerClient.Close()

	backend, err := selectBackend(cfg, logger)
	if err != nil {
		return fmt.Errorf("init firewall backend: %w", err)
	}
	if err := backend.SetupChains(); err != nil {
		return fmt.Errorf("setup firewall chains: %w", err)
	}
	defer func() {
		if err := backend.Cleanup(); err != nil {
			logger.Warn("firewall cleanup failed", "error", err)
		}
	}()

	auditLogger := audit.New(logger)
	historyBuf := audit.NewHistoryBuffer(500)
	if sink, err := buildAuditSink(cfg, logger, version, historyBuf); err != nil {
		logger.Warn("audit sink unavailable; falling back to slog-only", "error", err)
	} else if sink != nil {
		auditLogger = auditLogger.WithSink(sink)
		defer func() {
			if err := auditLogger.Close(); err != nil {
				logger.Warn("audit sink close failed", "error", err)
			}
		}()
	}

	if err := cleanupOldSuffixes(cfg, logger, auditLogger); err != nil {
		logger.Warn("blue-green cleanup of old suffixes failed", "error", err)
	}

	engine := rules.NewEngine(backend, dockerClient, cfg, logger)
	defer engine.Close()
	engine.SetAuditLogger(auditLogger)
	if cfg.Backend == "nftables" {
		engine.SetInetBackend(true)
	}

	if cfg.UseGeoIPDB {
		geoDB, err := geoip.Open(cfg.GeoIPDBPath)
		if err != nil {
			if cfg.GeoIPAutoUpdate {
				logger.Info("GeoIP database not found, will be downloaded by auto-updater", "path", cfg.GeoIPDBPath)
			} else {
				logger.Warn("GeoIP database unavailable, geoblock/geoallow disabled", "error", err)
			}
		} else {
			engine.SetGeoDB(geoDB)
			logger.Info("GeoIP enabled", "db", cfg.GeoIPDBPath)
		}
	}

	if cfg.EnableIPv6 {
		if cfg.Backend == "nftables" {
			logger.Info("IPv6 firewall enabled (nftables inet family handles both IPv4 and IPv6)")
		} else {
			ip6t, err := rules.NewIP6TablesBackend(cfg.EffectiveChain, cfg.ParentChain)
			if err != nil {
				logger.Warn("ip6tables unavailable, IPv6 rules disabled", "error", err)
			} else {
				if err := ip6t.SetupChains(); err != nil {
					logger.Warn("ip6tables chain setup failed", "error", err)
				} else {
					engine.SetIP6Backend(ip6t)
					defer func() {
						if err := ip6t.Cleanup(); err != nil {
							logger.Warn("ip6tables cleanup failed", "error", err)
						}
					}()
					logger.Info("IPv6 firewall enabled (ip6tables)")
				}
			}
		}
	}

	hub := logstream.NewHub(logger)
	trafficStore := api.NewTrafficStore()

	srv := api.NewServer(cfg, dockerClient, engine, hub, logger, trafficStore)
	srv.SetHistory(historyBuf)
	srv.SetAuditLogger(auditLogger)

	if cfg.ControlPlaneHTTP != "" {
		proxy, err := api.NewControlPlaneProxy(cfg.ControlPlaneHTTP, cfg.ControlPlaneToken, cfg.ControlPlaneCACert, cfg.ControlPlaneInsecure)
		if err != nil {
			logger.Warn("control-plane HTTP proxy disabled", "error", err)
		} else {
			srv.SetControlPlaneProxy(proxy)
			logger.Info("control-plane HTTP proxy enabled", "endpoint", cfg.ControlPlaneHTTP)
		}
	}

	var observer *autogen.Observer
	if cfg.AutogenMode == "observe" {
		if cfg.AutogenDBPath != "" {
			store, err := autogen.NewSQLiteStore(context.Background(), cfg.AutogenDBPath, logger)
			if err != nil {
				logger.Warn("autogen sqlite store unavailable; falling back to memory", "error", err)
				observer = autogen.NewObserver()
			} else {
				observer = autogen.NewObserverWithStore(store)
				logger.Info("autogen sqlite persistence enabled", "path", cfg.AutogenDBPath)
			}
		} else {
			observer = autogen.NewObserver()
		}
		srv.SetAutogen(observer)
		logger.Info("autogen observe-mode enabled",
			"min_samples", cfg.AutogenMinSamples,
			"endpoint", "/api/autogen/proposals",
		)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger.Info("firefik starting", "addr", cfg.ListenAddr, "chain", cfg.EffectiveChain)

	if err := engine.Rehydrate(ctx); err != nil {
		logger.Warn("rehydrate from kernel failed", "error", err)
	}

	g, gctx := errgroup.WithContext(ctx)

	g.Go(func() error {
		hub.Run(gctx)
		return nil
	})

	var onFlow func(logstream.FlowEvent)
	if observer != nil {
		onFlow = func(ev logstream.FlowEvent) {
			srcCID := engine.ContainerIDByIP(ev.SrcIP)
			dstCID := engine.ContainerIDByIP(ev.DstIP)
			switch {
			case dstCID != "":
				observer.Record(autogen.Flow{
					ContainerID: dstCID,
					Protocol:    strings.ToLower(ev.Proto),
					Port:        uint16(ev.DstPort), // #nosec G115 -- decoded from a 16-bit packet header field
					PeerIP:      ev.SrcIP,
				})
				rules.AutogenRecordedTotal.Inc()
			case srcCID != "":
				observer.Record(autogen.Flow{
					ContainerID: srcCID,
					Protocol:    strings.ToLower(ev.Proto),
					Port:        uint16(ev.DstPort), // #nosec G115 -- decoded from a 16-bit packet header field
					PeerIP:      ev.DstIP,
				})
				rules.AutogenRecordedTotal.Inc()
			default:
				rules.AutogenResolveMissTotal.Inc()
			}
		}
	}

	g.Go(func() error {
		if err := logstream.StartNflogReader(gctx, rules.NflogGroup, hub, logger, trafficStore.RecordAction, onFlow); err != nil {
			logger.Warn("nflog reader stopped", "error", err)
		}
		return nil
	})

	g.Go(func() error {
		return dockerClient.WatchEvents(gctx, func(e docker.EventMessage) {
			switch e.Action {
			case "start":
				if err := engine.ApplyContainer(gctx, e.Actor.ID, audit.SourceEvent); err != nil {
					logger.Error("apply container rules", "container", e.Actor.Attributes["name"], "error", err)
				}
			case "stop", "die", "destroy":
				if err := engine.RemoveContainer(e.Actor.ID, audit.SourceEvent); err != nil {
					logger.Error("remove container rules", "container", e.Actor.Attributes["name"], "error", err)
				}
			case "rename":
				if err := engine.ApplyContainer(gctx, e.Actor.ID, audit.SourceEvent); err != nil {
					logger.Error("re-apply container rules after rename", "container", e.Actor.Attributes["name"], "error", err)
				}
			}
		}, func(err error) {
			logger.Warn("docker events error, reconnecting", "error", err)
		})
	})

	if err := engine.Reconcile(ctx, audit.SourceStartup); err != nil {
		logger.Warn("initial reconcile failed", "error", err)
	}

	g.Go(func() error {
		select {
		case <-gctx.Done():
			return nil
		case <-time.After(3 * time.Second):
		}
		if err := engine.Reconcile(gctx, audit.SourceStartup); err != nil {
			logger.Warn("safety-net reconcile failed", "error", err)
		}
		return nil
	})

	if cfg.DriftCheckInterval > 0 {
		interval := time.Duration(cfg.DriftCheckInterval) * time.Second
		logger.Info("drift detection enabled", "interval", interval)
		g.Go(func() error {
			return engine.RunDriftLoop(gctx, interval)
		})
	}

	if cfg.ScheduleInterval > 0 {
		interval := time.Duration(cfg.ScheduleInterval) * time.Second
		logger.Info("schedule loop enabled", "interval", interval)
		g.Go(func() error {
			return engine.RunScheduleLoop(gctx, interval)
		})
	}

	if cfg.TemplatesFile != "" {
		if templates, err := config.LoadTemplates(cfg.TemplatesFile); err != nil {
			logger.Warn("failed to load rule templates", "path", cfg.TemplatesFile, "error", err)
		} else if len(templates) > 0 {
			srv.Templates().Set(templates)
			engine.SetTemplates(templates)
			logger.Info("rule templates loaded", "count", len(templates), "path", cfg.TemplatesFile)
			g.Go(func() error {
				return config.WatchFile(gctx, cfg.TemplatesFile, logger, func() {
					tpl, err := config.LoadTemplates(cfg.TemplatesFile)
					if err != nil {
						logger.Warn("templates reload failed", "error", err)
						return
					}
					srv.Templates().Set(tpl)
					engine.SetTemplates(tpl)
					logger.Info("rule templates reloaded", "count", len(tpl))
					if err := engine.Reconcile(gctx, audit.SourceConfigReload); err != nil {
						logger.Warn("reconcile after templates reload failed", "error", err)
					}
				})
			})
		}
	}

	if cfg.PoliciesDir != "" {
		if policies, err := policy.LoadDir(cfg.PoliciesDir); err != nil {
			logger.Warn("failed to load policies", "path", cfg.PoliciesDir, "error", err)
		} else if len(policies) > 0 {
			srv.Policies().Set(policies)
			engine.SetPolicies(policies)
			logger.Info("policies loaded", "count", len(policies), "path", cfg.PoliciesDir)
		}
	}

	if cfg.UseGeoIPDB && cfg.GeoIPAutoUpdate {
		src := geoip.SourceConfig{
			Source:      cfg.GeoIPSource,
			LicenseKey:  cfg.GeoIPLicenseKey,
			DownloadURL: cfg.GeoIPDownloadURL,
			Version:     version,
		}
		updater := geoip.NewUpdater(cfg.GeoIPDBPath, src, cfg.GeoIPUpdateCron, logger, func(newDB *geoip.DB) {
			engine.SetGeoDB(newDB)
			logger.Info("GeoIP database reloaded after update")
		})
		g.Go(func() error {
			return updater.Run(gctx)
		})
	}

	if cfg.ConfigFile != "" {
		if _, err := os.Stat(cfg.ConfigFile); err == nil {
			g.Go(func() error {
				return config.WatchFile(gctx, cfg.ConfigFile, logger, func() {
					if err := engine.Reconcile(gctx, audit.SourceConfigReload); err != nil {
						logger.Error("reconcile after config reload", "error", err)
					}
				})
			})
		}
	}

	if cfg.APITokenFile != "" {
		if _, err := os.Stat(cfg.APITokenFile); err == nil {
			g.Go(func() error {
				return config.WatchFile(gctx, cfg.APITokenFile, logger, func() {
					data, err := os.ReadFile(cfg.APITokenFile)
					if err != nil {
						logger.Warn("token file reload failed", "error", err)
						return
					}
					newToken := strings.TrimSpace(string(data))
					if newToken == "" {
						logger.Warn("token file is empty, keeping previous token")
						return
					}
					if newToken == srv.APIToken().Get() {
						return
					}
					srv.APIToken().Set(newToken)
					srv.MetricsToken().Set(newToken)
					logger.Info("API token hot-reloaded", "fingerprint", srv.APIToken().Fingerprint())
					auditLogger.TokenRotated(srv.APIToken().Fingerprint())
				})
			})
		}
	}

	if cfg.ControlPlaneGRPC != "" {
		hostname, _ := os.Hostname()
		identity := controlplane.AgentIdentity{
			InstanceID: firstNonEmpty(os.Getenv("FIREFIK_CONTROL_PLANE_INSTANCE_ID"), hostname),
			Hostname:   hostname,
			Version:    version,
			Backend:    cfg.Backend,
			Chain:      cfg.EffectiveChain,
		}
		loopCfg := controlplane.AgentLoopConfig{
			GRPCEndpoint:      cfg.ControlPlaneGRPC,
			Token:             cfg.ControlPlaneToken,
			Insecure:          cfg.ControlPlaneInsecure,
			CACertPath:        cfg.ControlPlaneCACert,
			ClientCertPath:    cfg.ControlPlaneClientCert,
			ClientKeyPath:     cfg.ControlPlaneClientKey,
			SnapshotInterval:  time.Duration(cfg.ControlPlaneSnapshotS) * time.Second,
			HeartbeatInterval: time.Duration(cfg.ControlPlaneHeartbeatS) * time.Second,
		}
		source := &engineSnapshotSource{engine: engine, docker: dockerClient, traffic: trafficStore}
		dispatcher := agentdispatch.New(agentdispatch.Deps{
			Engine:   engine,
			Docker:   dockerClient,
			Config:   cfg,
			Traffic:  &trafficStoreAdapter{store: trafficStore},
			Observer: observer,
			Audit:    auditLogger,
			Logger:   logger,
		})
		bridge := newCPLogBridge(hub)
		loop := controlplane.NewAgentLoop(loopCfg, identity, source, dispatcher, logger).WithLogSource(bridge)
		if observer != nil {
			loop = loop.WithProposalSource(&agentdispatch.ProposalSource{Observer: observer, Config: cfg})
		}
		logger.Info("control-plane agent enabled",
			"grpc", cfg.ControlPlaneGRPC,
			"mtls", cfg.ControlPlaneClientCert != "",
		)
		g.Go(func() error {
			stop := make(chan struct{})
			go func() {
				<-gctx.Done()
				close(stop)
			}()
			bridge.Pump(stop)
			return nil
		})
		g.Go(func() error {
			return loop.Run(gctx)
		})

		if cfg.ControlPlaneClientCert != "" {
			watcher := &controlplane.CertExpiryWatcher{
				CertPath: cfg.ControlPlaneClientCert,
				AgentID:  identity.InstanceID,
				Logger:   logger,
			}
			g.Go(func() error {
				watcher.Run(gctx)
				return nil
			})
		}

		if cfg.ControlPlaneClientCert != "" && cfg.ControlPlaneClientKey != "" && cfg.ControlPlaneGRPC != "" {
			rc, conn, err := controlplane.DialRenewClient(controlplane.RenewGRPCDialConfig{
				Endpoint: cfg.ControlPlaneGRPC,
				CertPath: cfg.ControlPlaneClientCert,
				KeyPath:  cfg.ControlPlaneClientKey,
				CAPath:   cfg.ControlPlaneCACert,
				Insecure: cfg.ControlPlaneInsecure,
			})
			if err != nil {
				logger.Warn("cert renewer dial failed; renewer disabled", "error", err)
			} else {
				bundlePath := cfg.ControlPlaneCACert
				renewer := &controlplane.CertRenewer{
					AgentID:     identity.InstanceID,
					CertPath:    cfg.ControlPlaneClientCert,
					KeyPath:     cfg.ControlPlaneClientKey,
					BundlePath:  bundlePath,
					Client:      rc,
					RenewBefore: time.Duration(cfg.CertRenewBeforeS) * time.Second,
					Interval:    time.Duration(cfg.CertRenewIntervalS) * time.Second,
					TTLSeconds:  cfg.CertRenewTTLS,
					Logger:      logger,
				}
				logger.Info("control-plane cert renewer enabled",
					"renew_before", renewer.RenewBefore,
					"interval", renewer.Interval,
				)
				g.Go(func() error {
					return renewer.Run(gctx)
				})
				g.Go(func() error {
					<-gctx.Done()
					_ = conn.Close()
					return nil
				})
			}
		}
	}

	g.Go(func() error {
		return srv.Run(gctx)
	})

	if err := g.Wait(); err != nil {
		return err
	}
	return nil
}

func setupTraces(logger *slog.Logger, ver string) telemetry.Shutdown {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdown, err := telemetry.Init(ctx, ver, logger)
	if err != nil {
		logger.Warn("opentelemetry init failed; tracing disabled", "error", err)
		return nil
	}
	return shutdown
}

func setupMetrics(logger *slog.Logger, ver string) telemetry.Shutdown {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdown, err := telemetry.InitMetrics(ctx, ver, logger, nil)
	if err != nil {
		logger.Warn("opentelemetry metrics init failed; metrics push disabled", "error", err)
		return nil
	}
	return shutdown
}

func setupLogs(logger *slog.Logger, ver string) telemetry.Shutdown {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdown, err := telemetry.InitLogs(ctx, ver, logger)
	if err != nil {
		logger.Warn("opentelemetry logs init failed; logs push disabled", "error", err)
		return nil
	}
	return shutdown
}

func runShutdown(logger *slog.Logger, message string, shutdown telemetry.Shutdown) {
	if shutdown == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := shutdown(ctx); err != nil {
		logger.Warn(message, "error", err)
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

type engineSnapshotSource struct {
	engine  *rules.Engine
	docker  rules.DockerReader
	traffic *api.TrafficStore
}

func copyLabelsWithRuleSets(orig map[string]string, ruleSetsJSON string) map[string]string {
	out := make(map[string]string, len(orig)+1)
	for k, v := range orig {
		out[k] = v
	}
	out[controlplane.RuleSetsLabelKey] = ruleSetsJSON
	return out
}

func deriveSources(firewallStatus string, labels map[string]string) []string {
	if firewallStatus != "active" {
		return nil
	}
	hasLabel := false
	for k := range labels {
		if strings.HasPrefix(k, "firefik.") {
			hasLabel = true
			break
		}
	}
	if hasLabel {
		return []string{"label"}
	}
	return []string{"config"}
}

func (s *engineSnapshotSource) Snapshot(ctx context.Context, id controlplane.AgentIdentity) (controlplane.AgentSnapshot, error) {
	containers, err := s.docker.ListContainers(ctx)
	if err != nil {
		return controlplane.AgentSnapshot{}, err
	}
	applied := s.engine.GetApplied()
	hostRules, hostDefault := s.engine.GetHostRules()
	if len(hostRules) > 0 || hostDefault != "" {
		payload := controlplane.HostRulesPayload{
			Default: hostDefault,
			Rules:   make([]controlplane.HostRuleDTO, 0, len(hostRules)),
		}
		for _, hr := range hostRules {
			payload.Rules = append(payload.Rules, controlplane.HostRuleDTO{
				Name:      hr.Name,
				Protocol:  hr.Protocol,
				Ports:     append([]uint16(nil), hr.Ports...),
				Allowlist: append([]string(nil), hr.Allowlist...),
				Blocklist: append([]string(nil), hr.Blocklist...),
				Log:       hr.Log,
				LogPrefix: hr.LogPrefix,
			})
		}
		if body, jerr := json.Marshal(payload); jerr == nil {
			labels := make(map[string]string, len(id.Labels)+1)
			for k, v := range id.Labels {
				labels[k] = v
			}
			labels[controlplane.HostRulesLabelKey] = string(body)
			id.Labels = labels
		}
	}
	out := controlplane.AgentSnapshot{Agent: id, At: time.Now().UTC()}
	for _, ctr := range containers {
		sid := rules.ShortID(ctr.ID)
		fwStatus := "disabled"
		policy := ""
		ruleCount := 0
		labels := ctr.Labels
		if cfg, ok := applied[sid]; ok {
			fwStatus = "active"
			policy = cfg.DefaultPolicy
			ruleCount = len(cfg.RuleSets)
			if len(cfg.RuleSets) > 0 {
				dtos := make([]api.FirewallRuleSetDTO, 0, len(cfg.RuleSets))
				for _, rs := range cfg.RuleSets {
					dtos = append(dtos, api.RuleSetToDTO(rs))
				}
				if body, err := json.Marshal(dtos); err == nil {
					labels = copyLabelsWithRuleSets(ctr.Labels, string(body))
				}
			}
		}
		out.Containers = append(out.Containers, controlplane.ContainerState{
			ID:             ctr.ID,
			Name:           ctr.Name,
			Status:         ctr.Status,
			FirewallStatus: fwStatus,
			DefaultPolicy:  policy,
			Labels:         labels,
			RuleSetCount:   ruleCount,
			Sources:        deriveSources(fwStatus, ctr.Labels),
		})
	}
	if s.traffic != nil {
		for _, b := range s.traffic.Last(60) {
			out.Traffic = append(out.Traffic, controlplane.TrafficBucket{
				Timestamp: b.Timestamp,
				Accepted:  b.Accepted,
				Dropped:   b.Dropped,
			})
		}
	}
	return out, nil
}

type trafficStoreAdapter struct{ store *api.TrafficStore }

func (a *trafficStoreAdapter) Last(n int) []agentdispatch.TrafficBucket {
	src := a.store.Last(n)
	out := make([]agentdispatch.TrafficBucket, 0, len(src))
	for _, b := range src {
		out = append(out, agentdispatch.TrafficBucket{
			Timestamp: b.Timestamp,
			Accepted:  b.Accepted,
			Dropped:   b.Dropped,
		})
	}
	return out
}

func cleanupOldSuffixes(cfg *config.Config, logger *slog.Logger, auditLog *audit.Logger) error {
	if len(cfg.CleanupOldSuffixes) == 0 {
		return nil
	}
	legacyChains := config.DeriveLegacyChains(cfg.ChainName, cfg.EffectiveChain, cfg.CleanupOldSuffixes)
	for i, legacy := range legacyChains {
		suffix := ""
		if i < len(cfg.CleanupOldSuffixes) {
			suffix = cfg.CleanupOldSuffixes[i]
		}
		legacyCfg := *cfg
		legacyCfg.EffectiveChain = legacy
		legacyBackend, err := selectBackend(&legacyCfg, logger)
		if err != nil {
			logger.Warn("could not init legacy backend for cleanup", "chain", legacy, "error", err)
			rules.LegacyCleanupErrorsTotal.WithLabelValues(suffix).Inc()
			if auditLog != nil {
				auditLog.LegacyCleanup(legacy, suffix, 0, "init: "+err.Error())
			}
			continue
		}
		removed := 0
		if ids, listErr := legacyBackend.ListAppliedContainerIDs(); listErr == nil {
			removed = len(ids)
		}
		if err := legacyBackend.Cleanup(); err != nil {
			logger.Warn("legacy cleanup failed", "chain", legacy, "error", err)
			rules.LegacyCleanupErrorsTotal.WithLabelValues(suffix).Inc()
			if auditLog != nil {
				auditLog.LegacyCleanup(legacy, suffix, removed, err.Error())
			}
			continue
		}
		logger.Info("removed legacy blue-green chain", "chain", legacy, "removed_container_chains", removed)
		if auditLog != nil {
			auditLog.LegacyCleanup(legacy, suffix, removed, "")
		}
	}
	return nil
}

func buildAuditSink(cfg *config.Config, logger *slog.Logger, version string, history *audit.HistoryBuffer) (audit.Sink, error) {
	sinks, err := buildConfiguredSinks(cfg, logger, version, history)
	if err != nil {
		return nil, err
	}
	if wh := buildWebhookSink(cfg, logger); wh != nil {
		sinks = append(sinks, wh)
	}
	if telemetry.LogsEnabledFromEnv() {
		sinks = append(sinks, audit.NewOTelSink())
		logger.Info("OTel audit sink enabled")
	}
	if len(sinks) == 0 {
		return nil, nil
	}
	if len(sinks) == 1 {
		return sinks[0], nil
	}
	return audit.NewMultiSink(logger, sinks...), nil
}

func buildConfiguredSinks(cfg *config.Config, logger *slog.Logger, version string, history *audit.HistoryBuffer) ([]audit.Sink, error) {
	if cfg.AuditSinkType == "" || cfg.AuditSinkType == "none" {
		return nil, nil
	}

	types := splitAndTrim(cfg.AuditSinkType)
	paths := splitAndTrim(cfg.AuditSinkPath)
	rot := audit.RotationConfig{
		MaxSizeMB:  cfg.AuditRotation.MaxSizeMB,
		MaxBackups: cfg.AuditRotation.MaxBackups,
		MaxAgeDays: cfg.AuditRotation.MaxAgeDays,
		Compress:   cfg.AuditRotation.Compress,
	}
	remoteOpts := audit.RemoteSinkOptions{
		Endpoint:  cfg.AuditSinkEndpoint,
		AuthToken: cfg.APIToken,
		Logger:    logger,
	}

	if len(types) == 1 {
		s, err := buildSingleSink(types[0], cfg.AuditSinkPath, version, rot, remoteOpts, history)
		if err != nil {
			return nil, err
		}
		if s == nil {
			return nil, nil
		}
		return []audit.Sink{s}, nil
	}

	if len(paths) == 0 {
		return nil, fmt.Errorf("FIREFIK_AUDIT_SINK lists %d sinks but FIREFIK_AUDIT_SINK_PATH is empty", len(types))
	}
	if len(types) != len(paths) {
		return nil, fmt.Errorf("FIREFIK_AUDIT_SINK (%d entries) and FIREFIK_AUDIT_SINK_PATH (%d entries) must have matching length", len(types), len(paths))
	}

	sinks := make([]audit.Sink, 0, len(types))
	for i, t := range types {
		s, err := buildSingleSink(t, paths[i], version, rot, remoteOpts, history)
		if err != nil {
			return nil, fmt.Errorf("audit sink %q: %w", t, err)
		}
		if s != nil {
			sinks = append(sinks, s)
		}
	}
	return sinks, nil
}

func buildWebhookSink(cfg *config.Config, logger *slog.Logger) audit.Sink {
	if cfg.WebhookURL == "" {
		return nil
	}
	s, err := audit.NewWebhookSink(audit.WebhookOptions{
		URL:     cfg.WebhookURL,
		Events:  cfg.WebhookEvents,
		Secret:  cfg.WebhookSecret,
		Timeout: time.Duration(cfg.WebhookTimeoutMS) * time.Millisecond,
	})
	if err != nil {
		logger.Warn("webhook audit sink unavailable", "error", err)
		return nil
	}
	logger.Info("webhook audit sink enabled",
		"url", cfg.WebhookURL,
		"events", cfg.WebhookEvents,
		"signed", cfg.WebhookSecret != "",
	)
	return s
}

func buildSingleSink(kind, path, version string, rot audit.RotationConfig, remote audit.RemoteSinkOptions, history *audit.HistoryBuffer) (audit.Sink, error) {
	switch kind {
	case "", "none":
		return nil, nil
	case "json-file", "json":
		return audit.NewJSONFileSink(path, rot)
	case "cef-file", "cef":
		return audit.NewCEFFileSink(path, version, rot)
	case "remote", "grpc", "http-ndjson":
		if remote.Endpoint == "" {
			return nil, fmt.Errorf("audit sink %q requires FIREFIK_AUDIT_SINK_ENDPOINT", kind)
		}
		return audit.NewRemoteSink(remote)
	case "history":
		if history == nil {
			return nil, fmt.Errorf("history sink requires an in-memory ring buffer (bug: main.go should pass one)")
		}
		return history, nil
	default:
		return nil, fmt.Errorf("unknown audit sink type %q (expected one of: json-file, cef-file, remote, history)", kind)
	}
}

func splitAndTrim(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	for i, p := range parts {
		parts[i] = strings.TrimSpace(p)
	}
	return parts
}

func selectBackend(cfg *config.Config, logger *slog.Logger) (rules.Backend, error) {
	chain := cfg.EffectiveChain
	if chain == "" {
		chain = cfg.ChainName
	}
	switch cfg.Backend {
	case "nftables":
		b, err := rules.NewNFTablesBackend(chain, logger)
		if err != nil {
			return nil, fmt.Errorf("nftables: %w", err)
		}
		b.SetStateful(cfg.StatefulAccept)
		logger.Info("using nftables backend", "stateful_accept", cfg.StatefulAccept)
		return b, nil
	default:
		b, err := rules.NewIPTablesBackend(chain, cfg.ParentChain)
		if err != nil {
			return nil, fmt.Errorf("iptables: %w", err)
		}
		b.SetStateful(cfg.StatefulAccept)
		logger.Info("using iptables backend", "stateful_accept", cfg.StatefulAccept)
		return b, nil
	}
}
