package rules

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"firefik/internal/config"
)

func writeFile(t *testing.T, path, body string) error {
	t.Helper()
	return os.WriteFile(path, []byte(body), 0o600)
}

func newHostTestEngine(t *testing.T, back Backend) *Engine {
	t.Helper()
	cfg := &config.Config{
		ChainName:      "FIREFIK",
		EffectiveChain: "FIREFIK",
		DefaultPolicy:  "RETURN",
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewEngine(back, &fakeDocker{}, cfg, logger)
}

func TestEngine_ApplyHostRules_NormalizesDefaultAndCIDRs(t *testing.T) {
	back := newRecordingBackend()
	eng := newHostTestEngine(t, back)

	rf := config.RulesFile{
		HostDefault: "drop",
		HostRules: []config.FileHostRuleSet{
			{Name: "ssh", Protocol: "tcp", Ports: []uint16{22}, Allowlist: []string{"10.0.0.0/8", "192.168.1.5"}},
			{Name: "blockchina", Protocol: "tcp", Ports: []uint16{80, 443}, Blocklist: []string{"203.0.113.0/24"}},
		},
	}
	if err := eng.applyHostRules(rf); err != nil {
		t.Fatalf("applyHostRules: %v", err)
	}
	if back.hostApplyCalls != 1 {
		t.Fatalf("expected 1 ApplyHostRules call, got %d", back.hostApplyCalls)
	}
	if back.hostAppliedDefault != "DROP" {
		t.Fatalf("default not normalized: %q", back.hostAppliedDefault)
	}
	if len(back.hostAppliedRules) != 2 {
		t.Fatalf("rules count: %d", len(back.hostAppliedRules))
	}
	ssh := back.hostAppliedRules[0]
	if ssh.Name != "ssh" || len(ssh.Allowlist) != 2 {
		t.Fatalf("ssh rule: %+v", ssh)
	}
	if ssh.Allowlist[0].String() != "10.0.0.0/8" {
		t.Fatalf("CIDR not preserved: %s", ssh.Allowlist[0].String())
	}
	if ssh.Allowlist[1].String() != "192.168.1.5/32" {
		t.Fatalf("bare IP not normalized to /32: %s", ssh.Allowlist[1].String())
	}
	if back.hostAppliedRules[1].Blocklist[0].String() != "203.0.113.0/24" {
		t.Fatalf("blocklist CIDR: %s", back.hostAppliedRules[1].Blocklist[0].String())
	}
}

func TestEngine_ApplyHostRules_PreservesICMPProtocol(t *testing.T) {
	back := newRecordingBackend()
	eng := newHostTestEngine(t, back)

	rf := config.RulesFile{
		HostDefault: "DROP",
		HostRules: []config.FileHostRuleSet{
			{Name: "ping", Protocol: "ICMP"},
			{Name: "ping6", Protocol: "ICMPv6", Allowlist: []string{"fe80::/10"}},
		},
	}
	if err := eng.applyHostRules(rf); err != nil {
		t.Fatalf("applyHostRules: %v", err)
	}
	if len(back.hostAppliedRules) != 2 {
		t.Fatalf("rules count: %d", len(back.hostAppliedRules))
	}
	if back.hostAppliedRules[0].Protocol != "icmp" {
		t.Fatalf("icmp protocol not normalized to lowercase: %q", back.hostAppliedRules[0].Protocol)
	}
	if back.hostAppliedRules[1].Protocol != "icmpv6" {
		t.Fatalf("icmpv6 protocol not normalized to lowercase: %q", back.hostAppliedRules[1].Protocol)
	}
	if back.hostAppliedRules[1].Allowlist[0].String() != "fe80::/10" {
		t.Fatalf("v6 allowlist CIDR not preserved: %s", back.hostAppliedRules[1].Allowlist[0].String())
	}
}

func TestEngine_ApplyHostRules_RemovesChainWhenEmpty(t *testing.T) {
	back := newRecordingBackend()
	eng := newHostTestEngine(t, back)
	if err := eng.applyHostRules(config.RulesFile{}); err != nil {
		t.Fatalf("applyHostRules: %v", err)
	}
	if back.hostRemoveCalls != 1 || back.hostApplyCalls != 0 {
		t.Fatalf("empty rules should only remove: apply=%d remove=%d", back.hostApplyCalls, back.hostRemoveCalls)
	}
}

func TestEngine_ApplyHostRules_PropagatesBackendError(t *testing.T) {
	back := newRecordingBackend()
	back.hostApplyErr = errors.New("kernel angry")
	eng := newHostTestEngine(t, back)
	err := eng.applyHostRules(config.RulesFile{
		HostDefault: "ACCEPT",
		HostRules:   []config.FileHostRuleSet{{Name: "x", Protocol: "tcp", Ports: []uint16{1}}},
	})
	if err == nil {
		t.Fatal("expected error to bubble up from backend")
	}
}

func TestEngine_ApplyHostRules_SkipsRulesWithoutName(t *testing.T) {
	back := newRecordingBackend()
	eng := newHostTestEngine(t, back)
	rf := config.RulesFile{
		HostDefault: "ACCEPT",
		HostRules: []config.FileHostRuleSet{
			{Name: "  "},
			{Name: "good", Protocol: "tcp", Ports: []uint16{80}},
		},
	}
	if err := eng.applyHostRules(rf); err != nil {
		t.Fatalf("applyHostRules: %v", err)
	}
	if len(back.hostAppliedRules) != 1 || back.hostAppliedRules[0].Name != "good" {
		t.Fatalf("anonymous rules should be skipped: %+v", back.hostAppliedRules)
	}
}

func TestEngine_Reconcile_AppliesHostRulesFromFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rules.yml")
	if err := writeFile(t, path, `host_default: DROP
host_rules:
  - name: ssh
    protocol: tcp
    ports: [22]
    allowlist: ["10.0.0.0/8"]
`); err != nil {
		t.Fatal(err)
	}
	back := newRecordingBackend()
	cfg := &config.Config{
		ChainName:      "FIREFIK",
		EffectiveChain: "FIREFIK",
		DefaultPolicy:  "RETURN",
		ConfigFile:     path,
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	eng := NewEngine(back, &fakeDocker{}, cfg, logger)
	if err := eng.Reconcile(context.Background(), "test"); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if back.hostApplyCalls == 0 {
		t.Fatalf("Reconcile should call ApplyHostRules")
	}
}
