//go:build linux

package rules

import (
	"strings"
	"testing"

	"firefik/internal/docker"
)

func TestIPTablesBackend_ContainerChainName(t *testing.T) {
	b := &IPTablesBackend{chainName: "FIREFIK"}

	short := b.containerChainName("abc")
	if short != "FIREFIK-abc" {
		t.Errorf("short id: got %q", short)
	}

	full := b.containerChainName("0123456789abcdef0123456789abcdef")
	if full != "FIREFIK-0123456789ab" {
		t.Errorf("trimmed to short id: got %q", full)
	}

	long := &IPTablesBackend{chainName: strings.Repeat("X", 30)}
	got := long.containerChainName("abcdef")
	if len(got) != iptablesMaxChainLen {
		t.Errorf("expected truncation to %d, got %d (%q)", iptablesMaxChainLen, len(got), got)
	}
}

func TestIPTablesBackend_RuleSetChainName(t *testing.T) {
	b := &IPTablesBackend{chainName: "FIREFIK"}

	short := b.ruleSetChainName("abc", "ssh")
	if short != "FIREFIK-abc-ssh" {
		t.Errorf("short: got %q", short)
	}

	long := b.ruleSetChainName("0123456789ab", "very-long-rule-set-name-overflow")
	if len(long) > iptablesMaxChainLen {
		t.Errorf("long name exceeded limit: %q (len=%d)", long, len(long))
	}
	if !strings.HasPrefix(long, "FIREFIK-0123456789ab-") {
		t.Errorf("expected prefix: %q", long)
	}

	bigChain := &IPTablesBackend{chainName: strings.Repeat("Z", 24)}
	res := bigChain.ruleSetChainName("abc", "set")
	if len(res) > iptablesMaxChainLen {
		t.Errorf("hash-fallback path: still over limit %q", res)
	}
}

func TestRuleJumpsTo_EdgeCases(t *testing.T) {
	if !ruleJumpsTo([]string{"-p", "tcp", "-j", "ACCEPT"}, "ACCEPT") {
		t.Fatal("expected match")
	}
	if ruleJumpsTo([]string{"-p", "tcp", "-j", "DROP"}, "ACCEPT") {
		t.Fatal("unexpected match")
	}
	if ruleJumpsTo([]string{"-j"}, "ACCEPT") {
		t.Fatal("trailing -j alone should not match")
	}
	if ruleJumpsTo([]string{}, "ACCEPT") {
		t.Fatal("empty parts")
	}
}

func TestBuildRule(t *testing.T) {
	got := buildRule("tcp", "22", "10.0.0.0/8", "ACCEPT")
	want := []string{"-p", "tcp", "--dport", "22", "-s", "10.0.0.0/8", "-j", "ACCEPT"}
	if !equalSlice(got, want) {
		t.Errorf("got %v want %v", got, want)
	}

	got2 := buildRule("tcp", "22", "0.0.0.0/0", "DROP")
	if hasFlag(got2, "-s") {
		t.Errorf("expected source omitted for 0.0.0.0/0: %v", got2)
	}

	got3 := buildRule("udp", "53", "::/0", "ACCEPT")
	if hasFlag(got3, "-s") {
		t.Errorf("expected source omitted for ::/0: %v", got3)
	}
	if got3[1] != "udp" {
		t.Errorf("expected udp proto: %v", got3)
	}
}

func TestBuildNflogRule(t *testing.T) {
	r := buildNflogRule("tcp", "22", "10.0.0.0/8", "", "DROP")
	if !hasFlag(r, "--nflog-prefix") {
		t.Fatalf("missing nflog-prefix: %v", r)
	}
	prefix := flagValue(r, "--nflog-prefix")
	if prefix != "FIREFIK DROP" {
		t.Errorf("default prefix: got %q", prefix)
	}

	custom := buildNflogRule("tcp", "22", "", "MyPrefix*&^", "DROP")
	if got := flagValue(custom, "--nflog-prefix"); got != "FIREFIK DROP MyPrefix" {
		t.Errorf("sanitized prefix: got %q", got)
	}

	accept := buildNflogRule("tcp", "443", "", "web", "ACCEPT")
	if got := flagValue(accept, "--nflog-prefix"); got != "FIREFIK ACCEPT web" {
		t.Errorf("rule label prefix: got %q", got)
	}

	veryLong := strings.Repeat("a", 200)
	cut := buildNflogRule("tcp", "22", "", veryLong, "DROP")
	if got := flagValue(cut, "--nflog-prefix"); len(got) > LogPrefixMaxLen {
		t.Errorf("expected truncation to %d, got %d", LogPrefixMaxLen, len(got))
	}
}

func TestDefaultDropNflogArgs(t *testing.T) {
	args := defaultDropNflogArgs(10, DefaultPolicyLogLabel)
	if flagValue(args, "--limit") != "10/second" || flagValue(args, "--limit-burst") != "10" {
		t.Errorf("limit flags: %v", args)
	}
	if flagValue(args, "-j") != "NFLOG" {
		t.Errorf("target: %v", args)
	}
	if got := flagValue(args, "--nflog-prefix"); got != "FIREFIK DROP default" {
		t.Errorf("prefix: got %q", got)
	}
}

func TestBuildRateLimitRule(t *testing.T) {
	rl := &docker.RateLimitConfig{Rate: 5, Burst: 10}
	got := buildRateLimitRule("tcp", "443", "10.0.0.0/8", "myset", rl)
	if !hasFlag(got, "-m") || flagValue(got, "-m") != "hashlimit" {
		t.Errorf("missing hashlimit: %v", got)
	}
	if name := flagValue(got, "--hashlimit-name"); name != "FF-myset-443" {
		t.Errorf("hashlimit-name: got %q", name)
	}

	longName := strings.Repeat("name", 10)
	got2 := buildRateLimitRule("tcp", "443", "", longName, rl)
	name := flagValue(got2, "--hashlimit-name")
	if len(name) > 15 {
		t.Errorf("hashed name too long: %q", name)
	}
	if !strings.HasPrefix(name, "FF-") {
		t.Errorf("hashed name prefix wrong: %q", name)
	}
}

func equalSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func hasFlag(parts []string, flag string) bool {
	for _, p := range parts {
		if p == flag {
			return true
		}
	}
	return false
}

func flagValue(parts []string, flag string) string {
	for i := 0; i < len(parts)-1; i++ {
		if parts[i] == flag {
			return parts[i+1]
		}
	}
	return ""
}
