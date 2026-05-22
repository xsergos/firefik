package rules

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"firefik/internal/audit"
	"firefik/internal/config"
	"firefik/internal/docker"
	"firefik/internal/geoip"
	"firefik/internal/policy"
	"firefik/internal/telemetry"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

const (
	reconcileTimeout = 30 * time.Second
	applyTimeout     = 10 * time.Second
)

type DockerReader interface {
	ListContainers(ctx context.Context) ([]docker.ContainerInfo, error)
	Inspect(ctx context.Context, id string) (docker.ContainerInfo, bool, error)
}

type Engine struct {
	backend     Backend
	ip6backend  Backend
	inetBackend bool
	geoDB       *geoip.DB
	auditLog    *audit.Logger
	docker      DockerReader
	cfg         *config.Config
	logger      *slog.Logger

	mu        sync.Mutex
	applied   map[string]docker.ContainerConfig
	templates map[string]config.RuleTemplate
	policies  map[string]*policy.Policy

	hostMu           sync.Mutex
	appliedHostRules []config.FileHostRuleSet
	appliedHostDef   string

	ipMu        sync.RWMutex
	containerIP map[string]string
}

func (e *Engine) GetHostRules() ([]config.FileHostRuleSet, string) {
	e.hostMu.Lock()
	defer e.hostMu.Unlock()
	out := make([]config.FileHostRuleSet, len(e.appliedHostRules))
	copy(out, e.appliedHostRules)
	return out, e.appliedHostDef
}

func (e *Engine) SetPolicies(p map[string]*policy.Policy) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if p == nil {
		e.policies = nil
		return
	}
	cp := make(map[string]*policy.Policy, len(p))
	for k, v := range p {
		cp[k] = v
	}
	e.policies = cp
}

func (e *Engine) getPolicies() map[string]*policy.Policy {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.policies
}

func (e *Engine) SetTemplates(t map[string]config.RuleTemplate) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if t == nil {
		e.templates = nil
		return
	}
	cp := make(map[string]config.RuleTemplate, len(t))
	for k, v := range t {
		cp[k] = v
	}
	e.templates = cp
}

func (e *Engine) getTemplates() map[string]config.RuleTemplate {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.templates
}

func NewEngine(backend Backend, dockerClient DockerReader, cfg *config.Config, logger *slog.Logger) *Engine {
	return &Engine{
		backend:     backend,
		docker:      dockerClient,
		cfg:         cfg,
		logger:      logger,
		applied:     make(map[string]docker.ContainerConfig),
		containerIP: make(map[string]string),
	}
}

func (e *Engine) setContainerIPs(sid string, ips []net.IP) {
	e.ipMu.Lock()
	defer e.ipMu.Unlock()
	for ip, existing := range e.containerIP {
		if existing == sid {
			delete(e.containerIP, ip)
		}
	}
	for _, ip := range ips {
		if ip == nil {
			continue
		}
		e.containerIP[ip.String()] = sid
	}
}

func (e *Engine) dropContainerIPs(sid string) {
	e.ipMu.Lock()
	defer e.ipMu.Unlock()
	for ip, existing := range e.containerIP {
		if existing == sid {
			delete(e.containerIP, ip)
		}
	}
}

func (e *Engine) ContainerIDByIP(ip string) string {
	if ip == "" {
		return ""
	}
	e.ipMu.RLock()
	defer e.ipMu.RUnlock()
	return e.containerIP[ip]
}

func (e *Engine) SetIP6Backend(b Backend) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ip6backend = b
}

func (e *Engine) SetInetBackend(v bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.inetBackend = v
}

func (e *Engine) SetGeoDB(db *geoip.DB) {
	e.mu.Lock()
	old := e.geoDB
	e.geoDB = db
	e.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
}

func (e *Engine) Close() {
	e.mu.Lock()
	db := e.geoDB
	e.geoDB = nil
	e.mu.Unlock()
	if db != nil {
		_ = db.Close()
	}
}

func (e *Engine) SetAuditLogger(l *audit.Logger) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.auditLog = l
}

func (e *Engine) Rehydrate(ctx context.Context) (err error) {
	_, span := telemetry.Tracer().Start(ctx, "engine.Rehydrate")
	defer func() {
		span.SetAttributes(attribute.Int("firefik.rehydrated_count", len(e.applied)))
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}
		span.End()
	}()

	e.mu.Lock()
	defer e.mu.Unlock()

	ids, err := e.backend.ListAppliedContainerIDs()
	if err != nil {
		return fmt.Errorf("primary backend rehydrate: %w", err)
	}
	for _, id := range ids {
		if _, ok := e.applied[id]; !ok {
			e.applied[id] = docker.ContainerConfig{}
		}
	}

	if e.ip6backend != nil {
		ip6ids, err := e.ip6backend.ListAppliedContainerIDs()
		if err != nil {
			e.logger.Warn("ip6 backend rehydrate failed", "error", err)
		} else {
			for _, id := range ip6ids {
				if _, ok := e.applied[id]; !ok {
					e.applied[id] = docker.ContainerConfig{}
				}
			}
		}
	}

	rehydratedChains.Set(float64(len(e.applied)))
	e.logger.Info("rehydrated applied state from kernel", "containers", len(e.applied))
	return nil
}

func (e *Engine) Reconcile(ctx context.Context, source audit.Source) (err error) {
	ctx, cancel := context.WithTimeout(ctx, reconcileTimeout)
	defer cancel()

	if source == "" {
		source = audit.SourceConfigReload
	}
	ctx, span := telemetry.Tracer().Start(ctx, "engine.Reconcile")
	span.SetAttributes(attribute.String("firefik.source", string(source)))
	defer span.End()

	start := time.Now()
	reconcileTotal.Inc()
	defer func() {
		reconcileDuration.Observe(time.Since(start).Seconds())
		if err != nil {
			reconcileErrorsTotal.Inc()
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}
	}()

	e.mu.Lock()
	al := e.auditLog
	e.mu.Unlock()
	if al != nil {
		al.ReconcileStarted(source)
	}

	fileRules, err := config.LoadRulesFile(e.cfg.ConfigFile)
	if err != nil {
		e.logger.Warn("aborting reconcile: rules file error, existing rules preserved", "path", e.cfg.ConfigFile, "error", err)
		return fmt.Errorf("rules file: %w", err)
	}

	if err := e.applyHostRules(fileRules); err != nil {
		e.logger.Error("host rules apply failed", "error", err)
	}

	containers, err := e.docker.ListContainers(ctx)
	if err != nil {
		return fmt.Errorf("reconcile: list containers: %w", err)
	}

	templates := e.getTemplates()
	policies := e.getPolicies()

	e.mu.Lock()
	defer e.mu.Unlock()

	seen := make(map[string]struct{}, len(containers))
	for _, ctr := range containers {
		seen[shortID(ctr.ID)] = struct{}{}
		cfg, parseErrs := docker.ParseLabels(ctr.Labels)
		for _, pe := range parseErrs {
			e.logger.Warn("label parse error", "container", ctr.Name, "error", pe)
		}

		cfg = MergeFileRules(cfg, ctr.Name, fileRules)
		cfg = ApplyTemplates(cfg, ctr.Labels, templates)
		cfg = ApplyPolicies(cfg, ctr.Labels, policies)

		if cfg.Enable {
			if err := e.applyContainerInner(ctx, ctr, cfg, source); err != nil {
				e.logger.Error("apply rules", "container", ctr.Name, "error", err)
				applyErrorsTotal.WithLabelValues("reconcile").Inc()
			}
		}
	}

	for id := range e.applied {
		if _, ok := seen[id]; !ok {
			if err := e.removeChains(id, source); err != nil {
				e.logger.Error("remove rules", "container_id", id, "error", err)
			} else {
				orphansCleanedTotal.Inc()
			}
		}
	}
	return nil
}

func (e *Engine) ApplyContainer(ctx context.Context, containerID string, source audit.Source) (err error) {
	ctx, cancel := context.WithTimeout(ctx, applyTimeout)
	defer cancel()

	ctx, span := telemetry.Tracer().Start(ctx, "engine.ApplyContainer")

	span.SetAttributes(
		attribute.String("container.id", containerID),
		attribute.String("audit.source", string(source)),
	)
	defer span.End()

	start := time.Now()
	defer func() {
		result := "ok"
		if err != nil {
			result = "error"
			applyErrorsTotal.WithLabelValues("apply_container").Inc()
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}
		applyDuration.WithLabelValues(result).Observe(time.Since(start).Seconds())
	}()

	ctr, ok, err := e.docker.Inspect(ctx, containerID)
	if err != nil {
		return fmt.Errorf("apply: inspect container %s: %w", containerID, err)
	}
	if !ok {
		return fmt.Errorf("container %s not found", containerID)
	}

	fileRules, err := config.LoadRulesFile(e.cfg.ConfigFile)
	if err != nil {
		e.logger.Warn("aborting apply: rules file error, existing rules preserved", "path", e.cfg.ConfigFile, "error", err)
		return fmt.Errorf("rules file: %w", err)
	}

	cfg, parseErrs := docker.ParseLabels(ctr.Labels)
	for _, pe := range parseErrs {
		e.logger.Warn("label parse error", "container", ctr.Name, "error", pe)
	}
	cfg = MergeFileRules(cfg, ctr.Name, fileRules)
	cfg = ApplyTemplates(cfg, ctr.Labels, e.getTemplates())
	cfg = ApplyPolicies(cfg, ctr.Labels, e.getPolicies())
	if !cfg.Enable {
		return nil
	}
	return e.applyContainerLocked(ctx, ctr, cfg, source)
}

func matchContainerIDLegacy(containerID, query string) bool {
	return matchContainerID(containerID, query)
}

func (e *Engine) GetApplied() map[string]docker.ContainerConfig {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make(map[string]docker.ContainerConfig, len(e.applied))
	for k, v := range e.applied {
		out[k] = v
	}
	return out
}

type DriftReport struct {
	OrphanIDs  []string `json:"orphan_ids,omitempty"`
	MissingIDs []string `json:"missing_ids,omitempty"`
}

func (r DriftReport) HasDrift() bool {
	return len(r.OrphanIDs) > 0 || len(r.MissingIDs) > 0
}

func (e *Engine) CheckDrift() (DriftReport, error) {
	kernelIDs, err := e.backend.ListAppliedContainerIDs()
	if err != nil {
		return DriftReport{}, fmt.Errorf("list kernel chains: %w", err)
	}
	kernelSet := make(map[string]struct{}, len(kernelIDs))
	for _, id := range kernelIDs {
		kernelSet[id] = struct{}{}
	}

	e.mu.Lock()
	memSet := make(map[string]struct{}, len(e.applied))
	for id := range e.applied {
		memSet[id] = struct{}{}
	}
	e.mu.Unlock()

	var rep DriftReport
	for id := range kernelSet {
		if _, ok := memSet[id]; !ok {
			rep.OrphanIDs = append(rep.OrphanIDs, id)
		}
	}
	for id := range memSet {
		if _, ok := kernelSet[id]; !ok {
			rep.MissingIDs = append(rep.MissingIDs, id)
		}
	}
	return rep, nil
}

func (e *Engine) RunDriftLoop(ctx context.Context, interval time.Duration) error {
	if interval <= 0 {
		return nil
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			e.runDriftOnce()
		}
	}
}

func (e *Engine) hasScheduledRules() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, cfg := range e.applied {
		for _, rs := range cfg.RuleSets {
			if rs.Schedule != nil {
				return true
			}
		}
	}
	return false
}

func (e *Engine) scheduleTransitionCount(prev, next time.Time) (openNow, closeNow int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, cfg := range e.applied {
		for _, rs := range cfg.RuleSets {
			if rs.Schedule == nil {
				continue
			}
			wasActive := rs.Schedule.Active(prev)
			isActive := rs.Schedule.Active(next)
			switch {
			case !wasActive && isActive:
				openNow++
			case wasActive && !isActive:
				closeNow++
			}
		}
	}
	return openNow, closeNow
}

func (e *Engine) RunScheduleLoop(ctx context.Context, interval time.Duration) error {
	if interval <= 0 {
		return nil
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	last := time.Now()
	for {
		select {
		case <-ctx.Done():
			return nil
		case now := <-t.C:
			if !e.hasScheduledRules() {
				last = now
				continue
			}
			openN, closeN := e.scheduleTransitionCount(last, now)
			if openN == 0 && closeN == 0 {
				last = now
				continue
			}
			if openN > 0 {
				scheduledToggleTotal.WithLabelValues("open").Add(float64(openN))
			}
			if closeN > 0 {
				scheduledToggleTotal.WithLabelValues("close").Add(float64(closeN))
			}
			scheduledReconcileTotal.Inc()
			if err := e.Reconcile(ctx, audit.SourceSchedule); err != nil {
				e.logger.Warn("scheduled reconcile failed", "error", err)
			}
			last = now
		}
	}
}

func (e *Engine) runDriftOnce() {
	driftChecksTotal.Inc()
	rep, err := e.CheckDrift()
	if err != nil {
		driftCheckErrorsTotal.Inc()
		e.logger.Warn("drift check failed", "error", err)
		return
	}
	if !rep.HasDrift() {
		return
	}
	if len(rep.OrphanIDs) > 0 {
		driftTotal.WithLabelValues("orphan").Add(float64(len(rep.OrphanIDs)))
	}
	if len(rep.MissingIDs) > 0 {
		driftTotal.WithLabelValues("missing").Add(float64(len(rep.MissingIDs)))
	}
	e.mu.Lock()
	auditLog := e.auditLog
	e.mu.Unlock()
	if auditLog != nil {
		auditLog.DriftDetected("periodic", map[string]int{
			"orphan":  len(rep.OrphanIDs),
			"missing": len(rep.MissingIDs),
		})
	}
	e.logger.Warn("drift detected",
		"orphans", len(rep.OrphanIDs),
		"missing", len(rep.MissingIDs),
	)
}

func (e *Engine) RemoveContainer(containerID string, source audit.Source) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.removeChains(shortID(containerID), source)
}

func ShortID(id string) string {
	return shortID(id)
}

func shortID(id string) string {
	if len(id) > ContainerIDShortLen {
		return id[:ContainerIDShortLen]
	}
	return id
}

func matchContainerID(containerID, query string) bool {
	if containerID == query {
		return true
	}
	return len(query) >= 3 && len(query) <= ContainerIDShortLen && strings.HasPrefix(containerID, query)
}

func (e *Engine) applyContainerLocked(ctx context.Context, ctr docker.ContainerInfo, cfg docker.ContainerConfig, source audit.Source) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.applyContainerInner(ctx, ctr, cfg, source)
}

func (e *Engine) applyContainerInner(ctx context.Context, ctr docker.ContainerInfo, cfg docker.ContainerConfig, source audit.Source) error {
	var ip4s, ip6s []net.IP
	for _, ep := range ctr.Networks {
		ip := net.ParseIP(ep.IP)
		if ip == nil {
			continue
		}
		if ip.To4() != nil {
			ip4s = append(ip4s, ip)
		} else {
			ip6s = append(ip6s, ip)
		}
	}
	if len(ip4s) == 0 && len(ip6s) == 0 {
		e.logger.Debug("skipping container with no IPs", "container", ctr.Name)
		return nil
	}
	var autoAllowlist []net.IPNet
	if e.cfg.AutoAllowlist && !cfg.NoAutoAllowlist {
		autoAllowlist = containerNetworkCIDRs(ctr)
	}

	resolvedSets := resolveNetworkNames(cfg.RuleSets, ctr)

	policy := cfg.DefaultPolicy
	if policy == "" {
		policy = e.cfg.DefaultPolicy
	}
	cfg.DefaultPolicy = policy

	now := time.Now()
	activeSets := make([]docker.FirewallRuleSet, 0, len(resolvedSets))
	for _, rs := range resolvedSets {
		if rs.Schedule != nil && !rs.Schedule.Active(now) {
			continue
		}
		activeSets = append(activeSets, rs)
	}

	ruleSets := make([]docker.FirewallRuleSet, len(activeSets))
	copy(ruleSets, activeSets)
	for i := range ruleSets {
		applyProfile(&ruleSets[i])
	}

	for i := range ruleSets {
		res := applyGeoIP(&ruleSets[i], e.geoDB)
		for _, w := range res.Warnings {
			e.logger.Warn("geoip warning", "container", ctr.Name, "rule_set", ruleSets[i].Name, "warning", w)
		}
		if res.Fatal != nil {
			return fmt.Errorf("geoip fail-closed for container %s rule set %q: %w", ctr.Name, ruleSets[i].Name, res.Fatal)
		}
	}

	sid := shortID(ctr.ID)
	if _, exists := e.applied[sid]; exists {
		if err := e.backend.RemoveContainerChains(sid); err != nil {
			return fmt.Errorf("pre-cleanup existing rules for %s: %w", ctr.Name, err)
		}
		if e.ip6backend != nil {
			if err := e.ip6backend.RemoveContainerChains(sid); err != nil {
				e.logger.Warn("ip6tables pre-cleanup failed (best-effort)", "container", ctr.Name, "error", err)
			}
		}
	}

	if e.inetBackend {
		allIPs := make([]net.IP, 0, len(ip4s)+len(ip6s))
		allIPs = append(allIPs, ip4s...)
		allIPs = append(allIPs, ip6s...)
		if len(allIPs) > 0 {
			if err := e.backend.ApplyContainerRules(ctr.ID, ctr.Name, allIPs, ruleSets, policy, autoAllowlist); err != nil {
				return fmt.Errorf("apply rules for %s: %w", ctr.Name, err)
			}
		}
	} else {
		if len(ip4s) > 0 {
			if err := e.backend.ApplyContainerRules(ctr.ID, ctr.Name, ip4s, ruleSets, policy, autoAllowlist); err != nil {
				return fmt.Errorf("apply ipv4 rules for %s: %w", ctr.Name, err)
			}
		}
		if e.ip6backend != nil && len(ip6s) > 0 {
			if err := e.ip6backend.ApplyContainerRules(ctr.ID, ctr.Name, ip6s, ruleSets, policy, autoAllowlist); err != nil {
				if len(ip4s) > 0 {
					if rbErr := e.backend.RemoveContainerChains(ctr.ID); rbErr != nil {
						e.logger.Error("ipv4 rollback after ipv6 failure failed", "container", ctr.Name, "error", rbErr)
					}
				}
				return fmt.Errorf("apply ipv6 rules for %s: %w", ctr.Name, err)
			}
		}
	}

	e.applied[sid] = cfg
	allIPs := make([]net.IP, 0, len(ip4s)+len(ip6s))
	allIPs = append(allIPs, ip4s...)
	allIPs = append(allIPs, ip6s...)
	e.setContainerIPs(sid, allIPs)
	e.logger.Info("rules applied",
		"container", ctr.Name,
		"rule_sets", len(ruleSets),
		"default_policy", policy,
	)
	if e.auditLog != nil {
		e.auditLog.RulesApplied(ctr.ID, ctr.Name, ip4s, len(ruleSets), policy, source)
	}
	return nil
}

func (e *Engine) removeChains(containerID string, source audit.Source) error {
	if err := e.backend.RemoveContainerChains(containerID); err != nil {
		return err
	}
	if e.ip6backend != nil {
		if err := e.ip6backend.RemoveContainerChains(containerID); err != nil {
			e.logger.Warn("ip6tables cleanup failed (best-effort)", "containerID", containerID, "error", err)
		}
	}
	delete(e.applied, containerID)
	e.dropContainerIPs(containerID)
	if e.auditLog != nil {
		e.auditLog.RulesRemoved(containerID, source)
	}
	return nil
}

func MergeFileRules(cfg docker.ContainerConfig, containerName string, rf config.RulesFile) docker.ContainerConfig {
	existing := make(map[string]struct{}, len(cfg.RuleSets))
	for _, rs := range cfg.RuleSets {
		existing[rs.Name] = struct{}{}
	}

	for _, fr := range rf.Rules {
		if fr.Container != containerName {
			continue
		}
		cfg.Enable = true

		if fr.DefaultPolicy != "" && cfg.DefaultPolicy == "" {
			cfg.DefaultPolicy = fr.DefaultPolicy
		}

		if _, ok := existing[fr.Name]; ok {
			continue
		}

		al, _ := config.ParseFileAllowlist(fr.Allowlist)
		bl, _ := config.ParseFileAllowlist(fr.Blocklist)

		cfg.RuleSets = append(cfg.RuleSets, docker.FirewallRuleSet{
			Name:      fr.Name,
			Ports:     fr.Ports,
			Allowlist: al,
			Blocklist: bl,
			Protocol:  fr.Protocol,
			Profile:   fr.Profile,
			Log:       fr.Log,
			LogPrefix: strings.TrimSpace(fr.LogPrefix),
		})
	}
	return cfg
}

func resolveNetworkNames(sets []docker.FirewallRuleSet, ctr docker.ContainerInfo) []docker.FirewallRuleSet {
	netCIDRs := make(map[string][]net.IPNet)
	for netName, ep := range ctr.Networks {
		ip := net.ParseIP(ep.IP)
		if ip == nil {
			continue
		}
		if ip4 := ip.To4(); ip4 != nil {
			prefixLen := ep.PrefixLen
			if prefixLen <= 0 || prefixLen > 32 {
				prefixLen = 24
			}
			mask := net.CIDRMask(prefixLen, 32)
			netCIDRs[netName] = append(netCIDRs[netName], net.IPNet{
				IP:   ip4.Mask(mask),
				Mask: mask,
			})
		} else {
			ip6 := ip.To16()
			prefixLen := ep.PrefixLen
			if prefixLen <= 0 || prefixLen > 128 {
				prefixLen = 64
			}
			mask := net.CIDRMask(prefixLen, 128)
			netCIDRs[netName] = append(netCIDRs[netName], net.IPNet{
				IP:   ip6.Mask(mask),
				Mask: mask,
			})
		}
	}

	resolved := make([]docker.FirewallRuleSet, len(sets))
	copy(resolved, sets)
	for i := range resolved {
		for _, name := range resolved[i].AllowlistNetworks {
			if cidrs, ok := netCIDRs[name]; ok {
				resolved[i].Allowlist = append(resolved[i].Allowlist, cidrs...)
			}
		}
		for _, name := range resolved[i].BlocklistNetworks {
			if cidrs, ok := netCIDRs[name]; ok {
				resolved[i].Blocklist = append(resolved[i].Blocklist, cidrs...)
			}
		}
		resolved[i].AllowlistNetworks = nil
		resolved[i].BlocklistNetworks = nil
	}
	return resolved
}

func containerNetworkCIDRs(ctr docker.ContainerInfo) []net.IPNet {
	var cidrs []net.IPNet
	for _, ep := range ctr.Networks {
		ip := net.ParseIP(ep.IP)
		if ip == nil {
			continue
		}
		if ip4 := ip.To4(); ip4 != nil {
			prefixLen := ep.PrefixLen
			if prefixLen <= 0 || prefixLen > 32 {
				prefixLen = 24
			}
			mask := net.CIDRMask(prefixLen, 32)
			cidrs = append(cidrs, net.IPNet{
				IP:   ip4.Mask(mask),
				Mask: mask,
			})
		} else {
			ip6 := ip.To16()
			prefixLen := ep.PrefixLen
			if prefixLen <= 0 || prefixLen > 128 {
				prefixLen = 64
			}
			mask := net.CIDRMask(prefixLen, 128)
			cidrs = append(cidrs, net.IPNet{
				IP:   ip6.Mask(mask),
				Mask: mask,
			})
		}
	}
	return cidrs
}
