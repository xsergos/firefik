package policy

import (
	"strings"
	"testing"

	"firefik/internal/docker"
)

func TestParseCIDR_Table(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		wantErr bool
		wantStr string
	}{
		{"ipv4 bare", "10.0.0.1", false, "10.0.0.1/32"},
		{"ipv4 cidr", "10.0.0.0/24", false, "10.0.0.0/24"},
		{"ipv6 bare", "fd00::1", false, "fd00::1/128"},
		{"ipv6 cidr", "fd00::/64", false, "fd00::/64"},
		{"malformed", "not-an-ip", true, ""},
		{"empty", "", true, ""},
		{"bad mask", "10.0.0.0/99", true, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			n, err := parseCIDR(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got %v", tt.in, n)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if n.String() != tt.wantStr {
				t.Errorf("parseCIDR(%q) = %q, want %q", tt.in, n.String(), tt.wantStr)
			}
		})
	}
}

func TestInvertOp_All(t *testing.T) {
	tests := [][2]string{
		{"==", "!="},
		{"!=", "=="},
		{"<", ">="},
		{">", "<="},
		{"<=", ">"},
		{">=", "<"},
		{"unknown", "unknown"},
	}
	for _, tt := range tests {
		if got := invertOp(tt[0]); got != tt[1] {
			t.Errorf("invertOp(%q) = %q, want %q", tt[0], got, tt[1])
		}
	}
}

func TestApplyCompare_ProtoStringOnly(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyCompare(&rs, CompareExpr{Field: "proto", Op: "==", Value: Value{IsNum: true, Num: 42}})
	if err == nil {
		t.Fatal("expected type-mismatch error for proto with int value")
	}
}

func TestApplyCompare_ProtoOnlyEquals(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyCompare(&rs, CompareExpr{Field: "proto", Op: "!=", Value: Value{IsStr: true, Str: "udp"}})
	if err == nil || !strings.Contains(err.Error(), "==") {
		t.Fatalf("expected proto !=  rejection, got %v", err)
	}
}

func TestApplyCompare_ProtoSetsProtocol(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	if err := applyCompare(&rs, CompareExpr{Field: "Protocol", Op: "==", Value: Value{IsStr: true, Str: "udp"}}); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if rs.Protocol != "udp" {
		t.Errorf("protocol=%q", rs.Protocol)
	}
}

func TestApplyCompare_PortRequiresInt(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyCompare(&rs, CompareExpr{Field: "port", Op: "==", Value: Value{IsStr: true, Str: "80"}})
	if err == nil {
		t.Fatalf("expected type-mismatch for port")
	}
}

func TestApplyCompare_PortOnlyEq(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyCompare(&rs, CompareExpr{Field: "port", Op: ">", Value: Value{IsNum: true, Num: 80}})
	if err == nil {
		t.Fatalf("expected rejection of port>")
	}
}

func TestApplyCompare_PortAppends(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	if err := applyCompare(&rs, CompareExpr{Field: "port", Op: "==", Value: Value{IsNum: true, Num: 443}}); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(rs.Ports) != 1 || rs.Ports[0] != 443 {
		t.Errorf("ports=%v", rs.Ports)
	}
}

func TestApplyPort_OutOfRange(t *testing.T) {
	for _, n := range []int64{0, -1, 65536, 70000} {
		rs := docker.FirewallRuleSet{}
		if err := applyCompare(&rs, CompareExpr{Field: "port", Op: "==", Value: Value{IsNum: true, Num: n}}); err == nil {
			t.Errorf("compare: expected error for port %d, got ports=%v", n, rs.Ports)
		}
		if err := applyIn(&rs, InExpr{Field: "port", Values: []Value{{IsNum: true, Num: 80}, {IsNum: true, Num: n}}}); err == nil {
			t.Errorf("in: expected error for port %d, got ports=%v", n, rs.Ports)
		}
	}
	rs := docker.FirewallRuleSet{}
	if err := applyIn(&rs, InExpr{Field: "port", Values: []Value{{IsNum: true, Num: 1}, {IsNum: true, Num: 65535}}}); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(rs.Ports) != 2 || rs.Ports[0] != 1 || rs.Ports[1] != 65535 {
		t.Errorf("ports=%v", rs.Ports)
	}
}

func TestApplyCompare_SrcIPAllowAndBlock(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	if err := applyCompare(&rs, CompareExpr{Field: "src_ip", Op: "==", Value: Value{IsStr: true, Str: "10.0.0.1"}}); err != nil {
		t.Fatalf("allow ip: %v", err)
	}
	if len(rs.Allowlist) != 1 {
		t.Fatalf("allowlist=%v", rs.Allowlist)
	}
	if err := applyCompare(&rs, CompareExpr{Field: "src_ip", Op: "!=", Value: Value{IsStr: true, Str: "10.0.0.2"}}); err != nil {
		t.Fatalf("block ip: %v", err)
	}
	if len(rs.Blocklist) != 1 {
		t.Fatalf("blocklist=%v", rs.Blocklist)
	}
}

func TestApplyCompare_SrcIPRequiresString(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyCompare(&rs, CompareExpr{Field: "src_ip", Op: "==", Value: Value{IsNum: true, Num: 1}})
	if err == nil {
		t.Fatalf("expected error for non-string src_ip")
	}
}

func TestApplyCompare_SrcIPInvalid(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyCompare(&rs, CompareExpr{Field: "src_ip", Op: "==", Value: Value{IsStr: true, Str: "zzz"}})
	if err == nil {
		t.Fatalf("expected invalid CIDR error")
	}
}

func TestApplyCompare_SrcNetAllowAndBlock(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	if err := applyCompare(&rs, CompareExpr{Field: "src_net", Op: "==", Value: Value{IsStr: true, Str: "10.0.0.0/8"}}); err != nil {
		t.Fatalf("allow net: %v", err)
	}
	if err := applyCompare(&rs, CompareExpr{Field: "src_net", Op: "!=", Value: Value{IsStr: true, Str: "192.168.0.0/16"}}); err != nil {
		t.Fatalf("block net: %v", err)
	}
	if len(rs.Allowlist) != 1 || len(rs.Blocklist) != 1 {
		t.Errorf("unexpected lists: allow=%v block=%v", rs.Allowlist, rs.Blocklist)
	}
}

func TestApplyCompare_SrcNetRequiresString(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyCompare(&rs, CompareExpr{Field: "src_net", Op: "==", Value: Value{IsNum: true, Num: 1}})
	if err == nil {
		t.Fatalf("expected error for non-string src_net")
	}
}

func TestApplyCompare_SrcNetInvalidCIDR(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyCompare(&rs, CompareExpr{Field: "src_net", Op: "==", Value: Value{IsStr: true, Str: "10.0.0.0/99"}})
	if err == nil {
		t.Fatalf("expected invalid CIDR")
	}
}

func TestApplyCompare_GeoAllowAndBlock(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	if err := applyCompare(&rs, CompareExpr{Field: "geo", Op: "==", Value: Value{IsStr: true, Str: "us"}}); err != nil {
		t.Fatalf("geo allow: %v", err)
	}
	if err := applyCompare(&rs, CompareExpr{Field: "geo", Op: "!=", Value: Value{IsStr: true, Str: "ru"}}); err != nil {
		t.Fatalf("geo block: %v", err)
	}
	if len(rs.GeoAllow) != 1 || rs.GeoAllow[0] != "US" {
		t.Errorf("geoallow=%v", rs.GeoAllow)
	}
	if len(rs.GeoBlock) != 1 || rs.GeoBlock[0] != "RU" {
		t.Errorf("geoblock=%v", rs.GeoBlock)
	}
}

func TestApplyCompare_GeoRequiresString(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyCompare(&rs, CompareExpr{Field: "geo", Op: "==", Value: Value{IsNum: true, Num: 1}})
	if err == nil {
		t.Fatalf("expected error for non-string geo")
	}
}

func TestApplyCompare_UnknownField(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyCompare(&rs, CompareExpr{Field: "weird", Op: "==", Value: Value{IsStr: true, Str: "v"}})
	if err == nil {
		t.Fatalf("expected unknown-field error")
	}
}

func TestApplyPredicate_CompareDelegates(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyPredicate(&rs, CompareExpr{Field: "port", Op: "==", Value: Value{IsNum: true, Num: 22}})
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(rs.Ports) != 1 {
		t.Errorf("no port added: %v", rs.Ports)
	}
}

func TestApplyPredicate_InDelegates(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyPredicate(&rs, InExpr{Field: "port", Values: []Value{{IsNum: true, Num: 80}, {IsNum: true, Num: 443}}})
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(rs.Ports) != 2 {
		t.Errorf("ports=%v", rs.Ports)
	}
}

func TestApplyPredicate_NotCompareInvertsOp(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	inner := CompareExpr{Field: "src_ip", Op: "==", Value: Value{IsStr: true, Str: "10.0.0.1"}}
	err := applyPredicate(&rs, NotExpr{Inner: inner})
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(rs.Blocklist) != 1 {
		t.Errorf("expected inverted to produce blocklist, got %+v", rs)
	}
}

func TestApplyPredicate_NotOnNonCompareRejected(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyPredicate(&rs, NotExpr{Inner: InExpr{Field: "port", Values: []Value{{IsNum: true, Num: 80}}}})
	if err == nil {
		t.Fatalf("expected rejection of negated non-compare")
	}
}

func TestApplyPredicate_UnknownType(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyPredicate(&rs, AndExpr{})
	if err == nil {
		t.Fatalf("expected unsupported predicate error")
	}
}

func TestApplyIn_PortRequiresInts(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyIn(&rs, InExpr{Field: "port", Values: []Value{{IsStr: true, Str: "80"}}})
	if err == nil {
		t.Fatalf("expected error for non-int port list")
	}
}

func TestApplyIn_GeoRequiresStrings(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyIn(&rs, InExpr{Field: "geo", Values: []Value{{IsNum: true, Num: 1}}})
	if err == nil {
		t.Fatalf("expected error for non-string geo list")
	}
}

func TestApplyIn_GeoNegateAllowList(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyIn(&rs, InExpr{Field: "geo", Negate: true, Values: []Value{{IsStr: true, Str: "us"}}})
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if len(rs.GeoAllow) != 1 || rs.GeoAllow[0] != "US" {
		t.Errorf("geoallow=%v", rs.GeoAllow)
	}
}

func TestApplyIn_UnknownField(t *testing.T) {
	rs := docker.FirewallRuleSet{}
	err := applyIn(&rs, InExpr{Field: "bogus", Values: []Value{{IsNum: true, Num: 1}}})
	if err == nil {
		t.Fatalf("expected unknown-field error")
	}
}

func TestCompile_BlockRuleAppendsCatchAll(t *testing.T) {
	p := &Policy{Name: "blk", Version: "v1", Rules: []Rule{
		{Action: ActionBlock, Expr: CompareExpr{Field: "port", Op: "==", Value: Value{IsNum: true, Num: 22}}},
	}}
	comp, err := Compile(p)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(comp.RuleSets) != 1 {
		t.Fatalf("expected 1 ruleset, got %d", len(comp.RuleSets))
	}
	if len(comp.RuleSets[0].Blocklist) < 2 {
		t.Errorf("expected catch-all v4+v6 blocklist entries, got %+v", comp.RuleSets[0].Blocklist)
	}
}

func TestCompile_LogRuleMarksFlag(t *testing.T) {
	p := &Policy{Name: "l", Version: "v1", Rules: []Rule{
		{Action: ActionLog, Expr: CompareExpr{Field: "port", Op: "==", Value: Value{IsNum: true, Num: 22}}},
	}}
	comp, err := Compile(p)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !comp.RuleSets[0].Log {
		t.Errorf("expected Log=true on log action rule")
	}
	if comp.RuleSets[0].LogPrefix == "" {
		t.Errorf("expected non-empty LogPrefix")
	}
}

func TestCompile_PropagatesPredicateError(t *testing.T) {
	p := &Policy{Name: "e", Version: "v1", Rules: []Rule{
		{Action: ActionAllow, Expr: CompareExpr{Field: "unknown", Op: "==", Value: Value{IsStr: true, Str: "x"}}},
	}}
	_, err := Compile(p)
	if err == nil || !strings.Contains(err.Error(), "policy \"e\"") {
		t.Fatalf("expected wrapped policy error, got %v", err)
	}
}

func TestFlattenOrAndAnd(t *testing.T) {
	leaf := CompareExpr{Field: "port", Op: "==", Value: Value{IsNum: true, Num: 1}}
	or := OrExpr{Left: leaf, Right: OrExpr{Left: leaf, Right: leaf}}
	if got := flattenOr(or); len(got) != 3 {
		t.Errorf("flattenOr = %d", len(got))
	}
	and := AndExpr{Left: leaf, Right: AndExpr{Left: leaf, Right: leaf}}
	if got := flattenAnd(and); len(got) != 3 {
		t.Errorf("flattenAnd = %d", len(got))
	}
	if got := flattenOr(leaf); len(got) != 1 {
		t.Errorf("flattenOr(leaf) = %d", len(got))
	}
	if got := flattenAnd(leaf); len(got) != 1 {
		t.Errorf("flattenAnd(leaf) = %d", len(got))
	}
}
