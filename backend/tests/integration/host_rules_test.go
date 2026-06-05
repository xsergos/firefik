//go:build integration

package integration

import (
	"strings"
	"testing"
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
