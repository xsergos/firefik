//go:build linux

package rules

import (
	"net"
	"strings"
	"testing"

	"github.com/google/nftables/expr"
)

func TestNFTContainerChain(t *testing.T) {
	b := &NFTablesBackend{chainName: "FIREFIK"}
	got := b.nftContainerChain("0123456789abcdef0123")
	if got != "firefik-0123456789ab" {
		t.Errorf("short: got %q", got)
	}

	long := &NFTablesBackend{chainName: strings.Repeat("X", 30)}
	got2 := long.nftContainerChain("abcdef")
	if len(got2) > 30 {
		t.Errorf("expected len<=30, got %d", len(got2))
	}
}

func TestPerSourceLimitSetName(t *testing.T) {
	b := &NFTablesBackend{chainName: "FIREFIK"}
	short := b.perSourceLimitSetName("0123456789ab", "ssh", "v4")
	if short != "rl-0123456789ab-ssh-v4" {
		t.Errorf("short: got %q", short)
	}

	long := b.perSourceLimitSetName("0123456789ab", strings.Repeat("xy", 50), "v4")
	if len(long) > 30 {
		t.Errorf("expected len<=30 via hash-fallback, got %d (%q)", len(long), long)
	}
	if !strings.HasPrefix(long, "rl-0123456789ab-") || !strings.HasSuffix(long, "-v4") {
		t.Errorf("hash fallback prefix/suffix: %q", long)
	}
}

func TestNFTRuleSetChain(t *testing.T) {
	b := &NFTablesBackend{chainName: "FIREFIK"}
	short := b.nftRuleSetChain("0123456789ab", "ssh")
	if short != "firefik-0123456789ab-ssh" {
		t.Errorf("short: got %q", short)
	}

	long := b.nftRuleSetChain("0123456789ab", strings.Repeat("xy", 50))
	if len(long) > 30 {
		t.Errorf("expected len<=30, got %d (%q)", len(long), long)
	}
}

func TestHasCTStateAcceptExprs(t *testing.T) {
	if !hasCTStateAcceptExprs(ctStateEstablishedRelatedAcceptExprs()) {
		t.Fatal("expected match on canonical exprs")
	}
	if hasCTStateAcceptExprs([]expr.Any{&expr.Verdict{Kind: expr.VerdictAccept}}) {
		t.Fatal("missing CT state should not match")
	}
	if hasCTStateAcceptExprs([]expr.Any{&expr.Ct{Key: expr.CtKeySTATE}}) {
		t.Fatal("missing accept verdict should not match")
	}
	if hasCTStateAcceptExprs([]expr.Any{}) {
		t.Fatal("empty exprs")
	}
}

func TestCTStateExprsCanonical(t *testing.T) {
	got := ctStateEstablishedRelatedAcceptExprs()
	if len(got) != 4 {
		t.Fatalf("expected 4 exprs, got %d", len(got))
	}
	if _, ok := got[0].(*expr.Ct); !ok {
		t.Errorf("first expr should be *expr.Ct, got %T", got[0])
	}
	if v, ok := got[3].(*expr.Verdict); !ok || v.Kind != expr.VerdictAccept {
		t.Errorf("last expr should be Verdict{Accept}, got %T", got[3])
	}
}

func TestIifLoopbackAcceptExprs(t *testing.T) {
	got := iifLoopbackAcceptExprs()
	if len(got) != 3 {
		t.Fatalf("expected 3 exprs, got %d", len(got))
	}
	m, ok := got[0].(*expr.Meta)
	if !ok || m.Key != expr.MetaKeyIIFNAME {
		t.Errorf("first expr should be Meta{IIFNAME}, got %T", got[0])
	}
	c, ok := got[1].(*expr.Cmp)
	if !ok || c.Op != expr.CmpOpEq || string(c.Data) != "lo\x00" {
		t.Errorf("second expr should be Cmp eq \"lo\\x00\", got %+v", got[1])
	}
	if v, ok := got[2].(*expr.Verdict); !ok || v.Kind != expr.VerdictAccept {
		t.Errorf("last expr should be Verdict{Accept}, got %T", got[2])
	}
}

func TestBinaryUint32(t *testing.T) {
	got := binaryUint32(0x01020304)
	if len(got) != 4 {
		t.Fatalf("expected 4 bytes, got %d", len(got))
	}
	if got[0] != 0x04 || got[3] != 0x01 {
		t.Errorf("expected little-endian, got %x", got)
	}
}

func TestDstIPMatchExprs(t *testing.T) {
	v4 := dstIPMatchExprs(net.ParseIP("10.0.0.1"))
	if len(v4) != 4 {
		t.Errorf("expected 4 exprs for v4, got %d", len(v4))
	}
	v6 := dstIPMatchExprs(net.ParseIP("::1"))
	if len(v6) != 4 {
		t.Errorf("expected 4 exprs for v6, got %d", len(v6))
	}
}

func TestSrcNetMatchExprs(t *testing.T) {
	_, n4, _ := net.ParseCIDR("10.0.0.0/8")
	v4 := srcNetMatchExprs(*n4)
	if len(v4) != 5 {
		t.Errorf("expected 5 exprs for v4 cidr, got %d", len(v4))
	}

	_, n6, _ := net.ParseCIDR("fd00::/64")
	v6 := srcNetMatchExprs(*n6)
	if len(v6) != 5 {
		t.Errorf("expected 5 exprs for v6 cidr, got %d", len(v6))
	}
}

func TestNflogExpr(t *testing.T) {
	defaultPrefix := nflogExpr("", "DROP")
	if !strings.HasPrefix(string(defaultPrefix.Data), "FIREFIK") {
		t.Errorf("default prefix: got %q", defaultPrefix.Data)
	}

	custom := nflogExpr("MyPrefix", "ACCEPT")
	if string(custom.Data) != "MyPrefix" {
		t.Errorf("custom: got %q", custom.Data)
	}

	long := nflogExpr(strings.Repeat("a", 200), "DROP")
	if len(long.Data) > LogPrefixMaxLen {
		t.Errorf("expected truncation to %d, got %d", LogPrefixMaxLen, len(long.Data))
	}
}

func TestProtoPortExprs(t *testing.T) {
	tcp := protoPortExprs("tcp", 22)
	if len(tcp) != 4 {
		t.Errorf("expected 4 exprs, got %d", len(tcp))
	}

	udp := protoPortExprs("UDP", 53)
	if len(udp) != 4 {
		t.Errorf("expected 4 exprs for udp, got %d", len(udp))
	}
}
