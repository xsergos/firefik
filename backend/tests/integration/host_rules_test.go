//go:build integration

package integration

import (
	"net"
	"strings"
	"testing"

	"firefik/internal/rules"
)

func TestNFTables_ApplyHostRules_LoopbackAcceptOnDrop(t *testing.T) {
	requireRoot(t)
	b := newNFTablesBackend(t, testChainName(t))
	t.Cleanup(func() { _ = b.RemoveHostChain() })

	if err := b.ApplyHostRules(nil, "DROP"); err != nil {
		t.Fatalf("ApplyHostRules DROP: %v", err)
	}

	out := nftListRuleset(t)
	assertContains(t, out, "chain firefik_host")
	assertContains(t, out, `iifname "lo" accept`)

	ct := strings.Index(out, "ct state established,related accept")
	lo := strings.Index(out, `iifname "lo" accept`)
	if ct < 0 || lo < 0 || lo < ct {
		t.Errorf("loopback accept must follow ct established accept (ct=%d lo=%d):\n%s", ct, lo, out)
	}
}

func TestNFTables_ApplyHostRules_NoLoopbackOnReturn(t *testing.T) {
	requireRoot(t)
	b := newNFTablesBackend(t, testChainName(t))
	t.Cleanup(func() { _ = b.RemoveHostChain() })

	if err := b.ApplyHostRules(nil, "RETURN"); err != nil {
		t.Fatalf("ApplyHostRules RETURN: %v", err)
	}

	out := nftListRuleset(t)
	assertNotContains(t, out, `iifname "lo" accept`)
}

func TestNFTables_ApplyHostRules_ICMPProtoScoped(t *testing.T) {
	requireRoot(t)
	b := newNFTablesBackend(t, testChainName(t))
	t.Cleanup(func() { _ = b.RemoveHostChain() })

	hostRules := []rules.HostRule{
		{Name: "ping", Protocol: "icmp"},
		{Name: "ping6", Protocol: "icmpv6"},
	}
	if err := b.ApplyHostRules(hostRules, "DROP"); err != nil {
		t.Fatalf("ApplyHostRules: %v", err)
	}

	out := nftListRuleset(t)
	assertContains(t, out, "chain firefik_host")
	assertContains(t, out, "l4proto icmp accept")
	assertContains(t, out, "l4proto ipv6-icmp accept")
}

func TestNFTables_ApplyHostRules_UnsupportedProtoNotFailOpen(t *testing.T) {
	requireRoot(t)
	b := newNFTablesBackend(t, testChainName(t))
	t.Cleanup(func() { _ = b.RemoveHostChain() })

	hostRules := []rules.HostRule{
		{Name: "weird", Protocol: "gre", Allowlist: []net.IPNet{mustCIDR("203.0.113.7/32")}},
	}
	if err := b.ApplyHostRules(hostRules, "DROP"); err != nil {
		t.Fatalf("ApplyHostRules: %v", err)
	}

	out := nftListRuleset(t)
	assertNotContains(t, out, "203.0.113.7")
}

func TestIPTables_ApplyHostRules_LoopbackAcceptOnDrop(t *testing.T) {
	requireRoot(t)
	b := newIPTablesBackend(t, testChainName(t))
	t.Cleanup(func() { _ = b.RemoveHostChain() })

	if err := b.ApplyHostRules(nil, "DROP"); err != nil {
		t.Fatalf("ApplyHostRules DROP: %v", err)
	}

	out := iptablesSave(t)
	assertContains(t, out, "-A FIREFIK_HOST -i lo -j ACCEPT")
}

func TestIPTables_ApplyHostRules_NoLoopbackOnReturn(t *testing.T) {
	requireRoot(t)
	b := newIPTablesBackend(t, testChainName(t))
	t.Cleanup(func() { _ = b.RemoveHostChain() })

	if err := b.ApplyHostRules(nil, "RETURN"); err != nil {
		t.Fatalf("ApplyHostRules RETURN: %v", err)
	}

	out := iptablesSave(t)
	assertNotContains(t, out, "-A FIREFIK_HOST -i lo")
}
