package rules

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"sync"
	"testing"
	"time"

	"firefik/internal/audit"
	"firefik/internal/config"
	"firefik/internal/docker"
	"firefik/internal/policy"
	"firefik/internal/schedule"
)

func TestShortID(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"", ""},
		{"abc", "abc"},
		{"0123456789ab", "0123456789ab"},
		{"0123456789abcdef0123456789abcdef", "0123456789ab"},
	}
	for _, tt := range tests {
		if got := shortID(tt.in); got != tt.want {
			t.Fatalf("shortID(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
	if ShortID("0123456789abcdef0123456789abcdef") != "0123456789ab" {
		t.Fatalf("ShortID wrapper broken")
	}
}

func TestMatchContainerID_ShortPrefix(t *testing.T) {
	if !matchContainerID("abcdef012345", "abcdef012345") {
		t.Fatalf("exact match expected to succeed")
	}
	if !matchContainerID("abcdef012345", "abc") {
		t.Fatalf("3-char prefix should match")
	}
	if matchContainerID("abcdef012345", "ab") {
		t.Fatalf("2-char prefix must not match")
	}
	if matchContainerID("abcdef012345", "abcdef012345ff") {
		t.Fatalf("prefix longer than shortID must not match (except exact)")
	}
	if !matchContainerIDLegacy("abcdef012345", "abc") {
		t.Fatalf("legacy wrapper broken")
	}
}

func newFullEngine(t *testing.T) (*Engine, *recordingBackend, *recordingDocker) {
	t.Helper()
	back := newRecordingBackend()
	doc := &recordingDocker{}
	cfg := &config.Config{
		ChainName:      "FIREFIK",
		EffectiveChain: "FIREFIK",
		DefaultPolicy:  "DROP",
		AutoAllowlist:  true,
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	eng := NewEngine(back, doc, cfg, logger)
	return eng, back, doc
}

func TestSetAndGetPolicies(t *testing.T) {
	eng, _, _ := newFullEngine(t)

	if got := eng.getPolicies(); got != nil {
		t.Fatalf("expected nil policies initially, got %v", got)
	}

	p := map[string]*policy.Policy{
		"p1": {Name: "p1", Version: "v1"},
		"p2": {Name: "p2", Version: "v1"},
	}
	eng.SetPolicies(p)
	got := eng.getPolicies()
	if len(got) != 2 {
		t.Fatalf("expected 2 policies, got %d", len(got))
	}

	delete(p, "p1")
	if _, ok := eng.getPolicies()["p1"]; !ok {
		t.Errorf("external mutation leaked into engine state (SetPolicies must copy)")
	}

	eng.SetPolicies(nil)
	if got := eng.getPolicies(); got != nil {
		t.Errorf("SetPolicies(nil) should clear, got %v", got)
	}
}

func TestSetAndGetTemplates(t *testing.T) {
	eng, _, _ := newFullEngine(t)

	if got := eng.getTemplates(); got != nil {
		t.Fatalf("expected nil templates initially, got %v", got)
	}

	in := map[string]config.RuleTemplate{
		"web": {Name: "web", Version: "v1", Ports: []uint16{80}},
	}
	eng.SetTemplates(in)
	if len(eng.getTemplates()) != 1 {
		t.Errorf("expected 1 template, got %d", len(eng.getTemplates()))
	}
	delete(in, "web")
	if _, ok := eng.getTemplates()["web"]; !ok {
		t.Errorf("SetTemplates must deep-copy")
	}

	eng.SetTemplates(nil)
	if eng.getTemplates() != nil {
		t.Errorf("SetTemplates(nil) should clear")
	}
}

func TestSimpleSettersCover(t *testing.T) {
	eng, _, _ := newFullEngine(t)

	eng.SetAuditLogger(nil)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	al := audit.New(logger)
	eng.SetAuditLogger(al)

	eng.SetInetBackend(true)
	if !eng.inetBackend {
		t.Errorf("SetInetBackend(true) did not stick")
	}
	eng.SetInetBackend(false)

	b6 := newRecordingBackend()
	eng.SetIP6Backend(b6)
	if eng.ip6backend != b6 {
		t.Errorf("SetIP6Backend did not stick")
	}

	eng.SetGeoDB(nil)

	eng.Close()
}

func TestContainerIPIndex(t *testing.T) {
	eng, _, _ := newFullEngine(t)

	if got := eng.ContainerIDByIP(""); got != "" {
		t.Errorf("empty ip lookup = %q, want empty", got)
	}

	if got := eng.ContainerIDByIP("1.2.3.4"); got != "" {
		t.Errorf("unknown ip lookup = %q, want empty", got)
	}

	eng.setContainerIPs("sid1", []net.IP{net.ParseIP("10.0.0.1"), nil, net.ParseIP("10.0.0.2")})
	if eng.ContainerIDByIP("10.0.0.1") != "sid1" {
		t.Errorf("ip 10.0.0.1 not indexed")
	}
	if eng.ContainerIDByIP("10.0.0.2") != "sid1" {
		t.Errorf("ip 10.0.0.2 not indexed")
	}

	eng.setContainerIPs("sid1", []net.IP{net.ParseIP("10.0.0.3")})
	if eng.ContainerIDByIP("10.0.0.1") != "" {
		t.Errorf("old ip should be cleared on re-set")
	}
	if eng.ContainerIDByIP("10.0.0.3") != "sid1" {
		t.Errorf("new ip not indexed")
	}

	eng.dropContainerIPs("sid1")
	if eng.ContainerIDByIP("10.0.0.3") != "" {
		t.Errorf("ip should be dropped")
	}
}

func TestReconcileEmptyContainerList(t *testing.T) {
	eng, _, _ := newFullEngine(t)

	if err := eng.Reconcile(context.Background(), audit.SourceStartup); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
}

func TestReconcileDockerListFailure(t *testing.T) {
	eng, _, doc := newFullEngine(t)
	doc.listErr = errors.New("docker down")

	err := eng.Reconcile(context.Background(), audit.SourceStartup)
	if err == nil {
		t.Fatalf("expected error")
	}
	if !errIncludes(err, "list containers") {
		t.Errorf("error does not mention list containers: %v", err)
	}
}

func TestReconcileDefaultSource(t *testing.T) {
	eng, _, _ := newFullEngine(t)
	al := audit.New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	eng.SetAuditLogger(al)
	if err := eng.Reconcile(context.Background(), ""); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
}

func TestReconcileWithAuditLogger(t *testing.T) {
	eng, _, _ := newFullEngine(t)
	al := audit.New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	eng.SetAuditLogger(al)

	if err := eng.Reconcile(context.Background(), audit.SourceStartup); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
}

func TestApplyContainerHappyPath(t *testing.T) {
	eng, back, doc := newFullEngine(t)
	ctr := makeContainer("aaaaaaaaaaaa", "web", "10.0.0.10")
	doc.setContainers(ctr)

	if err := eng.ApplyContainer(context.Background(), "aaaaaaaaaaaa", audit.SourceEvent); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if back.applyCallCount() != 1 {
		t.Errorf("expected 1 apply call, got %d", back.applyCallCount())
	}
	if _, ok := eng.GetApplied()["aaaaaaaaaaaa"]; !ok {
		t.Errorf("applied map missing container")
	}

	if eng.ContainerIDByIP("10.0.0.10") != "aaaaaaaaaaaa" {
		t.Errorf("IP index not populated")
	}
}

func TestApplyContainerIdempotent(t *testing.T) {
	eng, back, doc := newFullEngine(t)
	ctr := makeContainer("aaaaaaaaaaaa", "web", "10.0.0.10")
	doc.setContainers(ctr)

	if err := eng.ApplyContainer(context.Background(), "aaaaaaaaaaaa", audit.SourceEvent); err != nil {
		t.Fatalf("apply1: %v", err)
	}
	if err := eng.ApplyContainer(context.Background(), "aaaaaaaaaaaa", audit.SourceEvent); err != nil {
		t.Fatalf("apply2: %v", err)
	}

	if back.removeCallCount() == 0 {
		t.Errorf("expected pre-cleanup remove on second apply")
	}
	if back.applyCallCount() != 2 {
		t.Errorf("expected 2 total applies, got %d", back.applyCallCount())
	}
}

func TestApplyContainerInspectNotFound(t *testing.T) {
	eng, _, _ := newFullEngine(t)
	err := eng.ApplyContainer(context.Background(), "does-not-exist", audit.SourceEvent)
	if err == nil {
		t.Fatalf("expected not-found error")
	}
	if !errIncludes(err, "not found") {
		t.Errorf("error should mention not found: %v", err)
	}
}

func TestApplyContainerInspectErr(t *testing.T) {
	eng, _, doc := newFullEngine(t)
	doc.inspectErr = errors.New("inspect kaboom")
	err := eng.ApplyContainer(context.Background(), "any", audit.SourceEvent)
	if err == nil {
		t.Fatalf("expected inspect error")
	}
}

func TestApplyContainerDisabledLabel(t *testing.T) {
	eng, back, doc := newFullEngine(t)
	ctr := makeContainer("cccccccccccc", "db", "10.0.0.20")
	ctr.Labels["firefik.enable"] = "false"
	doc.setContainers(ctr)

	if err := eng.ApplyContainer(context.Background(), "cccccccccccc", audit.SourceEvent); err != nil {
		t.Fatalf("apply with disabled label: %v", err)
	}
	if back.applyCallCount() != 0 {
		t.Errorf("disabled container should not trigger backend apply")
	}
}

func TestApplyContainerBackendError(t *testing.T) {
	eng, back, doc := newFullEngine(t)
	ctr := makeContainer("aaaaaaaaaaaa", "web", "10.0.0.10")
	doc.setContainers(ctr)
	back.applyErr = errors.New("kernel exploded")

	err := eng.ApplyContainer(context.Background(), "aaaaaaaaaaaa", audit.SourceEvent)
	if err == nil {
		t.Fatalf("expected apply error to propagate")
	}
}

func TestApplyContainerNoIPsSkipped(t *testing.T) {
	eng, back, doc := newFullEngine(t)
	ctr := makeContainer("ddddddddddd0", "noip", "10.0.0.10")
	ctr.Networks = map[string]docker.NetworkEndpoint{}
	doc.setContainers(ctr)

	if err := eng.ApplyContainer(context.Background(), "ddddddddddd0", audit.SourceEvent); err != nil {
		t.Fatalf("apply no-ip: %v", err)
	}
	if back.applyCallCount() != 0 {
		t.Errorf("container without ips should not reach backend")
	}
}

func TestApplyContainerGeoIPFailClosed(t *testing.T) {
	eng, back, doc := newFullEngine(t)
	ctr := makeContainer("eeeeeeeeeeee", "geo", "10.0.0.30",
		"firefik.firewall.web.geoallow", "US")
	doc.setContainers(ctr)

	err := eng.ApplyContainer(context.Background(), "eeeeeeeeeeee", audit.SourceEvent)
	if err == nil {
		t.Fatalf("expected geoip fail-closed error")
	}
	if back.applyCallCount() != 0 {
		t.Errorf("backend must not be called when geoip fails closed")
	}
}

func TestApplyContainerWithAuditLogger(t *testing.T) {
	eng, _, doc := newFullEngine(t)
	al := audit.New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	eng.SetAuditLogger(al)

	ctr := makeContainer("auditaaaaaaa", "withaudit", "10.0.0.70")
	doc.setContainers(ctr)
	if err := eng.ApplyContainer(context.Background(), "auditaaaaaaa", audit.SourceEvent); err != nil {
		t.Fatalf("apply: %v", err)
	}
}

func TestApplyContainerIPv6Backend(t *testing.T) {
	eng, back, doc := newFullEngine(t)
	b6 := newRecordingBackend()
	eng.SetIP6Backend(b6)

	ctr := makeContainer("ffffffffffff", "dual", "10.0.0.40")
	ctr.Networks["bridge6"] = docker.NetworkEndpoint{IP: "fd00::1", PrefixLen: 64}
	doc.setContainers(ctr)

	if err := eng.ApplyContainer(context.Background(), "ffffffffffff", audit.SourceEvent); err != nil {
		t.Fatalf("apply dual-stack: %v", err)
	}
	if back.applyCallCount() != 1 {
		t.Errorf("ipv4 backend should have been called once")
	}
	if b6.applyCallCount() != 1 {
		t.Errorf("ipv6 backend should have been called once")
	}
}

func TestApplyContainerIPv6ErrorRollsBackIPv4(t *testing.T) {
	eng, back, doc := newFullEngine(t)
	b6 := newRecordingBackend()
	b6.applyErr = errors.New("ip6 broken")
	eng.SetIP6Backend(b6)

	ctr := makeContainer("111111111111", "dual2", "10.0.0.41")
	ctr.Networks["bridge6"] = docker.NetworkEndpoint{IP: "fd00::2", PrefixLen: 64}
	doc.setContainers(ctr)

	err := eng.ApplyContainer(context.Background(), "111111111111", audit.SourceEvent)
	if err == nil {
		t.Fatalf("expected ipv6 error to propagate")
	}

	if back.removeCallCount() == 0 {
		t.Errorf("expected ipv4 rollback on ipv6 failure")
	}
}

func TestApplyContainerInetBackend(t *testing.T) {
	eng, back, doc := newFullEngine(t)
	eng.SetInetBackend(true)

	ctr := makeContainer("222222222222", "inet", "10.0.0.50")
	ctr.Networks["bridge6"] = docker.NetworkEndpoint{IP: "fd00::3", PrefixLen: 64}
	doc.setContainers(ctr)

	if err := eng.ApplyContainer(context.Background(), "222222222222", audit.SourceEvent); err != nil {
		t.Fatalf("inet apply: %v", err)
	}
	if back.applyCallCount() != 1 {
		t.Errorf("inet backend should produce exactly one apply call, got %d", back.applyCallCount())
	}
}

func TestRemoveContainer(t *testing.T) {
	eng, back, doc := newFullEngine(t)
	ctr := makeContainer("333333333333", "rm", "10.0.0.60")
	doc.setContainers(ctr)

	if err := eng.ApplyContainer(context.Background(), "333333333333", audit.SourceEvent); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if _, ok := eng.GetApplied()["333333333333"]; !ok {
		t.Fatalf("not applied: %v", eng.GetApplied())
	}

	if err := eng.RemoveContainer("333333333333", audit.SourceEvent); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if _, ok := eng.GetApplied()["333333333333"]; ok {
		t.Errorf("still applied after remove")
	}
	if back.removeCallCount() == 0 {
		t.Errorf("backend Remove never called")
	}

	if err := eng.RemoveContainer("333333333333", audit.SourceEvent); err != nil {
		t.Fatalf("idempotent remove: %v", err)
	}
}

func TestRemoveContainerWithIP6Backend(t *testing.T) {
	eng, _, doc := newFullEngine(t)
	b6 := newRecordingBackend()
	eng.SetIP6Backend(b6)

	ctr := makeContainer("88aabbccddee", "dualrm", "10.0.0.65")
	ctr.Networks["bridge6"] = docker.NetworkEndpoint{IP: "fd00::9", PrefixLen: 64}
	doc.setContainers(ctr)

	if err := eng.ApplyContainer(context.Background(), "88aabbccddee", audit.SourceEvent); err != nil {
		t.Fatalf("apply: %v", err)
	}

	if err := eng.RemoveContainer("88aabbccddee", audit.SourceEvent); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if b6.removeCallCount() == 0 {
		t.Errorf("expected ip6 backend remove")
	}
}

func TestRemoveContainerIP6BackendErrorTolerated(t *testing.T) {
	eng, _, _ := newFullEngine(t)
	b6 := newRecordingBackend()
	b6.removeErr = errors.New("ip6 stuck")
	eng.SetIP6Backend(b6)

	if err := eng.RemoveContainer("does-not-matter", audit.SourceEvent); err != nil {
		t.Fatalf("expected best-effort ip6 failure, got %v", err)
	}
}

func TestRemoveContainerBackendError(t *testing.T) {
	eng, back, _ := newFullEngine(t)
	back.removeErr = errors.New("nope")
	if err := eng.RemoveContainer("missing", audit.SourceEvent); err == nil {
		t.Fatalf("expected error from backend")
	}
}

func TestRemoveContainerWithAuditLogger(t *testing.T) {
	eng, _, _ := newFullEngine(t)
	al := audit.New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	eng.SetAuditLogger(al)
	if err := eng.RemoveContainer("some-id", audit.SourceEvent); err != nil {
		t.Fatalf("remove: %v", err)
	}
}

func TestRehydrate(t *testing.T) {
	back := newRecordingBackend()
	back.seedApplied("aaaaaaaaaaaa", "bbbbbbbbbbbb")
	doc := &recordingDocker{}
	cfg := &config.Config{ChainName: "FIREFIK", EffectiveChain: "FIREFIK", DefaultPolicy: "DROP"}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	eng := NewEngine(back, doc, cfg, logger)

	if err := eng.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	if len(eng.GetApplied()) != 2 {
		t.Errorf("expected 2 rehydrated, got %d", len(eng.GetApplied()))
	}
}

func TestRehydrateWithIP6BackendAndError(t *testing.T) {
	back := newRecordingBackend()
	back.seedApplied("aaaaaaaaaaaa")
	b6 := newRecordingBackend()
	b6.listErr = errors.New("ip6 list broken")

	doc := &recordingDocker{}
	cfg := &config.Config{ChainName: "FIREFIK", EffectiveChain: "FIREFIK", DefaultPolicy: "DROP"}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	eng := NewEngine(back, doc, cfg, logger)
	eng.SetIP6Backend(b6)

	if err := eng.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	if len(eng.GetApplied()) != 1 {
		t.Errorf("expected 1 applied, got %d", len(eng.GetApplied()))
	}
}

func TestRehydratePrimaryListError(t *testing.T) {
	back := newRecordingBackend()
	back.listErr = errors.New("boom")
	doc := &recordingDocker{}
	cfg := &config.Config{ChainName: "FIREFIK", EffectiveChain: "FIREFIK", DefaultPolicy: "DROP"}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	eng := NewEngine(back, doc, cfg, logger)

	if err := eng.Rehydrate(context.Background()); err == nil {
		t.Fatalf("expected error from primary backend list failure")
	}
}

func TestRehydrateWithIP6BackendOK(t *testing.T) {
	back := newRecordingBackend()
	back.seedApplied("aaaaaaaaaaaa")
	b6 := newRecordingBackend()
	b6.seedApplied("cccccccccccc")

	doc := &recordingDocker{}
	cfg := &config.Config{ChainName: "FIREFIK", EffectiveChain: "FIREFIK", DefaultPolicy: "DROP"}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	eng := NewEngine(back, doc, cfg, logger)
	eng.SetIP6Backend(b6)

	if err := eng.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	if len(eng.GetApplied()) != 2 {
		t.Errorf("expected 2 merged applied IDs, got %d", len(eng.GetApplied()))
	}
}

func TestCheckDriftOrphanAndMissing(t *testing.T) {
	eng, back, _ := newFullEngine(t)

	back.seedApplied("aaaaaaaaaaaa")

	eng.mu.Lock()
	eng.applied["bbbbbbbbbbbb"] = docker.ContainerConfig{}
	eng.mu.Unlock()

	rep, err := eng.CheckDrift()
	if err != nil {
		t.Fatalf("CheckDrift: %v", err)
	}
	if !rep.HasDrift() {
		t.Fatalf("expected drift, got: %+v", rep)
	}
	if err := expectIn(rep.OrphanIDs, "aaaaaaaaaaaa"); err != nil {
		t.Errorf("orphan: %v (report=%+v)", err, rep)
	}
	if err := expectIn(rep.MissingIDs, "bbbbbbbbbbbb"); err != nil {
		t.Errorf("missing: %v (report=%+v)", err, rep)
	}
}

func TestCheckDriftBackendError(t *testing.T) {
	eng, back, _ := newFullEngine(t)
	back.listErr = errors.New("kaboom")
	_, err := eng.CheckDrift()
	if err == nil {
		t.Fatalf("expected error")
	}
}

func TestCheckDriftNoDrift(t *testing.T) {
	eng, back, _ := newFullEngine(t)
	back.seedApplied("aaaaaaaaaaaa")
	eng.mu.Lock()
	eng.applied["aaaaaaaaaaaa"] = docker.ContainerConfig{}
	eng.mu.Unlock()

	rep, err := eng.CheckDrift()
	if err != nil {
		t.Fatalf("CheckDrift: %v", err)
	}
	if rep.HasDrift() {
		t.Errorf("expected no drift, got: %+v", rep)
	}
}

func TestRunDriftOnceWithDriftAndAudit(t *testing.T) {
	eng, back, _ := newFullEngine(t)
	al := audit.New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	eng.SetAuditLogger(al)
	back.seedApplied("aaaaaaaaaaaa")
	eng.mu.Lock()
	eng.applied["bbbbbbbbbbbb"] = docker.ContainerConfig{}
	eng.mu.Unlock()

	eng.runDriftOnce()
}

func TestRunDriftOnceError(t *testing.T) {
	eng, back, _ := newFullEngine(t)
	back.listErr = errors.New("bad")
	eng.runDriftOnce()
}

func TestRunDriftOnceNoDrift(t *testing.T) {
	eng, _, _ := newFullEngine(t)
	eng.runDriftOnce()
}

func TestRunDriftLoopZeroInterval(t *testing.T) {
	eng, _, _ := newFullEngine(t)
	if err := eng.RunDriftLoop(context.Background(), 0); err != nil {
		t.Fatalf("RunDriftLoop(0) should return immediately without error, got %v", err)
	}
}

func TestRunDriftLoopCancels(t *testing.T) {
	eng, _, _ := newFullEngine(t)
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() {
		done <- eng.RunDriftLoop(ctx, 10*time.Millisecond)
	}()
	time.Sleep(25 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("loop returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("RunDriftLoop did not stop on context cancel")
	}
}

func TestHasScheduledRulesAndTransitionCount(t *testing.T) {
	eng, _, _ := newFullEngine(t)
	if eng.hasScheduledRules() {
		t.Errorf("no containers yet — should not have scheduled rules")
	}

	w, err := schedule.Parse("09:00-17:00")
	if err != nil {
		t.Fatalf("parse schedule: %v", err)
	}
	cfg := docker.ContainerConfig{
		Enable: true,
		RuleSets: []docker.FirewallRuleSet{
			{Name: "office", Schedule: &w},
		},
	}
	eng.mu.Lock()
	eng.applied["sched01"] = cfg
	eng.mu.Unlock()

	if !eng.hasScheduledRules() {
		t.Errorf("expected hasScheduledRules true")
	}

	prev := time.Date(2025, 6, 2, 8, 59, 0, 0, time.UTC)
	next := time.Date(2025, 6, 2, 9, 1, 0, 0, time.UTC)
	openN, closeN := eng.scheduleTransitionCount(prev, next)
	if openN != 1 || closeN != 0 {
		t.Errorf("expected open=1 close=0, got open=%d close=%d", openN, closeN)
	}

	prev = time.Date(2025, 6, 2, 16, 59, 0, 0, time.UTC)
	next = time.Date(2025, 6, 2, 17, 1, 0, 0, time.UTC)
	openN, closeN = eng.scheduleTransitionCount(prev, next)
	if openN != 0 || closeN != 1 {
		t.Errorf("expected open=0 close=1, got open=%d close=%d", openN, closeN)
	}

	prev = time.Date(2025, 6, 2, 10, 0, 0, 0, time.UTC)
	next = time.Date(2025, 6, 2, 11, 0, 0, 0, time.UTC)
	openN, closeN = eng.scheduleTransitionCount(prev, next)
	if openN != 0 || closeN != 0 {
		t.Errorf("expected no transition, got open=%d close=%d", openN, closeN)
	}

	eng.mu.Lock()
	eng.applied["sched02"] = docker.ContainerConfig{
		RuleSets: []docker.FirewallRuleSet{{Name: "nosched", Schedule: nil}},
	}
	eng.mu.Unlock()
	openN, closeN = eng.scheduleTransitionCount(prev, next)
	if openN != 0 || closeN != 0 {
		t.Errorf("unscheduled rule set must not affect transitions")
	}
}

func TestRunScheduleLoopZeroInterval(t *testing.T) {
	eng, _, _ := newFullEngine(t)
	if err := eng.RunScheduleLoop(context.Background(), 0); err != nil {
		t.Fatalf("RunScheduleLoop(0) should no-op, got %v", err)
	}
}

func TestRunScheduleLoopCancels_NoScheduledRules(t *testing.T) {

	eng, _, _ := newFullEngine(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- eng.RunScheduleLoop(ctx, 5*time.Millisecond)
	}()
	time.Sleep(30 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("loop err: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("RunScheduleLoop did not stop on context cancel")
	}
}

func TestMergeFileRules(t *testing.T) {
	cfg := docker.ContainerConfig{}
	rf := config.RulesFile{
		Rules: []config.FileRuleSet{
			{Container: "web", Name: "http", Ports: []uint16{80, 443}, DefaultPolicy: "DROP", Log: true, LogPrefix: "  web-http  "},
			{Container: "db", Name: "sql", Ports: []uint16{5432}},
		},
	}
	out := MergeFileRules(cfg, "web", rf)
	if !out.Enable {
		t.Errorf("expected Enable=true for matching container")
	}
	if out.DefaultPolicy != "DROP" {
		t.Errorf("DefaultPolicy not merged, got %q", out.DefaultPolicy)
	}
	if len(out.RuleSets) != 1 {
		t.Fatalf("expected 1 rule set, got %d", len(out.RuleSets))
	}
	if out.RuleSets[0].Name != "http" {
		t.Errorf("unexpected rule set name: %q", out.RuleSets[0].Name)
	}
	if !out.RuleSets[0].Log {
		t.Errorf("Log not merged, got %v", out.RuleSets[0].Log)
	}
	if out.RuleSets[0].LogPrefix != "web-http" {
		t.Errorf("LogPrefix not trimmed/merged, got %q", out.RuleSets[0].LogPrefix)
	}

	cfg2 := docker.ContainerConfig{
		RuleSets: []docker.FirewallRuleSet{{Name: "http", Ports: []uint16{8080}}},
	}
	out2 := MergeFileRules(cfg2, "web", rf)
	if len(out2.RuleSets) != 1 {
		t.Errorf("existing rule set should prevent duplicate merge, got %d", len(out2.RuleSets))
	}
}

func TestResolveNetworkNames(t *testing.T) {
	ctr := docker.ContainerInfo{
		Networks: map[string]docker.NetworkEndpoint{
			"bridge":  {IP: "10.0.0.1", PrefixLen: 24},
			"podnet6": {IP: "fd00::1", PrefixLen: 64},
			"badnet":  {IP: "not-an-ip"},
		},
	}
	sets := []docker.FirewallRuleSet{
		{Name: "a", AllowlistNetworks: []string{"bridge", "podnet6", "missing"}},
		{Name: "b", BlocklistNetworks: []string{"bridge"}},
	}
	resolved := resolveNetworkNames(sets, ctr)
	if len(resolved) != 2 {
		t.Fatalf("unexpected length: %d", len(resolved))
	}
	if len(resolved[0].Allowlist) == 0 {
		t.Errorf("expected resolved allowlist for 'a'")
	}
	if len(resolved[1].Blocklist) == 0 {
		t.Errorf("expected resolved blocklist for 'b'")
	}
	if resolved[0].AllowlistNetworks != nil || resolved[0].BlocklistNetworks != nil {
		t.Errorf("resolved network names should be cleared after expansion")
	}
}

func TestContainerNetworkCIDRs(t *testing.T) {
	ctr := docker.ContainerInfo{
		Networks: map[string]docker.NetworkEndpoint{
			"bridge":  {IP: "10.0.0.1", PrefixLen: 0},
			"bridge6": {IP: "fd00::1", PrefixLen: 200},
			"bad":     {IP: "zzz"},
		},
	}
	cidrs := containerNetworkCIDRs(ctr)
	if len(cidrs) != 2 {
		t.Fatalf("expected 2 cidrs, got %d", len(cidrs))
	}
}

func TestDriftReportHasDrift(t *testing.T) {
	r := DriftReport{}
	if r.HasDrift() {
		t.Errorf("empty report should not indicate drift")
	}
	r = DriftReport{OrphanIDs: []string{"x"}}
	if !r.HasDrift() {
		t.Errorf("orphans should indicate drift")
	}
	r = DriftReport{MissingIDs: []string{"y"}}
	if !r.HasDrift() {
		t.Errorf("missing should indicate drift")
	}
}

func TestConcurrentApplyAndRemove(t *testing.T) {
	eng, _, doc := newFullEngine(t)
	ctrs := []docker.ContainerInfo{
		makeContainer("c000000000aa", "c1", "10.1.0.1"),
		makeContainer("c000000000bb", "c2", "10.1.0.2"),
		makeContainer("c000000000cc", "c3", "10.1.0.3"),
	}
	doc.setContainers(ctrs...)

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		for _, ctr := range ctrs {
			wg.Add(2)
			go func(id string) {
				defer wg.Done()
				_ = eng.ApplyContainer(context.Background(), id, audit.SourceEvent)
			}(ctr.ID)
			go func(id string) {
				defer wg.Done()
				_ = eng.RemoveContainer(id, audit.SourceEvent)
			}(ctr.ID)
		}
	}
	wg.Wait()
}

func TestReconcile_HappyPath_WithContainers(t *testing.T) {
	eng, back, doc := newFullEngine(t)
	doc.setContainers(
		makeContainer("aaaaaaaaaaaa", "web", "10.0.0.10"),
		makeContainer("bbbbbbbbbbbb", "api", "10.0.0.11"),
	)

	if err := eng.Reconcile(context.Background(), audit.Source("test")); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	if got := back.applyCallCount(); got != 2 {
		t.Errorf("expected 2 apply calls after first reconcile, got %d", got)
	}
	if doc.listCalls < 1 {
		t.Errorf("expected docker.ListContainers to be called, got %d", doc.listCalls)
	}
	applied := eng.GetApplied()
	if len(applied) != 2 {
		t.Errorf("expected 2 applied entries, got %d", len(applied))
	}

	before := back.applyCallCount()
	if err := eng.Reconcile(context.Background(), audit.Source("test")); err != nil {
		t.Fatalf("reconcile (2nd): %v", err)
	}
	if delta := back.applyCallCount() - before; delta != 2 {
		t.Errorf("reconcile re-applies every seen container, got delta=%d", delta)
	}
}

func TestReconcile_OrphanCleanup(t *testing.T) {
	eng, back, doc := newFullEngine(t)
	doc.setContainers(
		makeContainer("aaaaaaaaaaaa", "c1", "10.0.0.10"),
		makeContainer("bbbbbbbbbbbb", "c2", "10.0.0.11"),
	)
	if err := eng.Reconcile(context.Background(), audit.Source("test")); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if _, ok := eng.GetApplied()["bbbbbbbbbbbb"]; !ok {
		t.Fatalf("precondition: bbbbbbbbbbbb must be applied")
	}

	doc.setContainers(makeContainer("aaaaaaaaaaaa", "c1", "10.0.0.10"))
	removesBefore := back.removeCallCount()
	if err := eng.Reconcile(context.Background(), audit.Source("test")); err != nil {
		t.Fatalf("reconcile (after removal): %v", err)
	}
	if back.removeCallCount() == removesBefore {
		t.Errorf("expected RemoveContainerChains to be called for orphan")
	}
	if _, ok := eng.GetApplied()["bbbbbbbbbbbb"]; ok {
		t.Errorf("orphan bbbbbbbbbbbb should have been cleaned up")
	}
	if _, ok := eng.GetApplied()["aaaaaaaaaaaa"]; !ok {
		t.Errorf("surviving container aaaaaaaaaaaa should still be applied")
	}
}

func TestReconcile_DockerListFail(t *testing.T) {
	eng, back, doc := newFullEngine(t)
	doc.setContainers(makeContainer("aaaaaaaaaaaa", "web", "10.0.0.10"))
	doc.listErr = errors.New("docker offline")

	err := eng.Reconcile(context.Background(), audit.Source("test"))
	if err == nil {
		t.Fatalf("expected wrapped error")
	}
	if !errIncludes(err, "list containers") {
		t.Errorf("error should wrap list-containers failure: %v", err)
	}
	if back.applyCallCount() != 0 {
		t.Errorf("no Apply should have been issued when ListContainers failed, got %d", back.applyCallCount())
	}
}

func TestReconcile_UsesTemplatesAndPoliciesWithoutDeadlock(t *testing.T) {
	eng, back, doc := newFullEngine(t)
	eng.SetTemplates(map[string]config.RuleTemplate{
		"basic": {Name: "basic", Version: "v1", Ports: []uint16{8080}},
	})

	p, err := policy.Parse(`policy "p1" { allow if proto == "tcp" and port == 22 }`)
	if err != nil {
		t.Fatalf("parse policy: %v", err)
	}
	eng.SetPolicies(map[string]*policy.Policy{"p1": p[0]})

	ctr := makeContainer("ccdddeeeff11", "withpol", "10.0.0.20",
		"firefik.policy", "p1",
		"firefik.template", "basic")
	doc.setContainers(ctr)

	done := make(chan error, 1)
	go func() {
		done <- eng.Reconcile(context.Background(), audit.Source("test"))
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("reconcile: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Reconcile deadlocked with templates+policies set")
	}

	if back.applyCallCount() != 1 {
		t.Errorf("expected 1 apply, got %d", back.applyCallCount())
	}
}

func errIncludes(err error, substr string) bool {
	if err == nil {
		return false
	}
	return stringsContains(err.Error(), substr)
}

func stringsContains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
