package policy

import (
	"fmt"
	"net"
	"strings"

	"firefik/internal/docker"
)

type Compiled struct {
	Policy   *Policy
	RuleSets []docker.FirewallRuleSet
	Warnings []string
}

func Compile(pol *Policy) (*Compiled, error) {
	out := &Compiled{Policy: pol}
	for _, r := range pol.Rules {
		sets, warns, err := compileRule(pol.Name, pol.Version, r)
		if err != nil {
			return nil, fmt.Errorf("policy %q: %w", pol.Name, err)
		}
		out.Warnings = append(out.Warnings, warns...)
		out.RuleSets = append(out.RuleSets, sets...)
	}
	return out, nil
}

func compileRule(polName, polVersion string, r Rule) ([]docker.FirewallRuleSet, []string, error) {
	terms := flattenOr(r.Expr)
	var sets []docker.FirewallRuleSet
	var warns []string
	for i, term := range terms {
		rs := docker.FirewallRuleSet{
			Name:      fmt.Sprintf("pol:%s@%s#%s-%d", polName, polVersion, r.Action, i),
			Protocol:  "tcp",
			Log:       r.Action == ActionLog,
			LogPrefix: fmt.Sprintf("%s@%s", polName, polVersion),
		}
		predicates := flattenAnd(term)
		for _, pred := range predicates {
			if err := applyPredicate(&rs, pred); err != nil {
				return nil, nil, err
			}
		}
		if r.Action == ActionBlock {

			rs.Blocklist = append(rs.Blocklist, cidrAll4(), cidrAll6())
		}
		sets = append(sets, rs)
	}
	return sets, warns, nil
}

func flattenOr(e Expr) []Expr {
	if o, ok := e.(OrExpr); ok {
		return append(flattenOr(o.Left), flattenOr(o.Right)...)
	}
	return []Expr{e}
}

func flattenAnd(e Expr) []Expr {
	if a, ok := e.(AndExpr); ok {
		return append(flattenAnd(a.Left), flattenAnd(a.Right)...)
	}
	return []Expr{e}
}

func applyPredicate(rs *docker.FirewallRuleSet, pred Expr) error {
	switch p := pred.(type) {
	case CompareExpr:
		return applyCompare(rs, p)
	case InExpr:
		return applyIn(rs, p)
	case NotExpr:

		if inner, ok := p.Inner.(CompareExpr); ok {
			inner.Op = invertOp(inner.Op)
			return applyCompare(rs, inner)
		}
		return fmt.Errorf("unsupported negated expression %T", p.Inner)
	}
	return fmt.Errorf("unsupported predicate type %T", pred)
}

func invertOp(op string) string {
	switch op {
	case "==":
		return "!="
	case "!=":
		return "=="
	case "<":
		return ">="
	case ">":
		return "<="
	case "<=":
		return ">"
	case ">=":
		return "<"
	}
	return op
}

func applyCompare(rs *docker.FirewallRuleSet, c CompareExpr) error {
	field := strings.ToLower(c.Field)
	switch field {
	case "proto", "protocol":
		if !c.Value.IsStr {
			return fmt.Errorf("proto expects string value")
		}
		if c.Op != "==" {
			return fmt.Errorf("proto only supports ==")
		}
		rs.Protocol = c.Value.Str
	case "port":
		if !c.Value.IsNum {
			return fmt.Errorf("port expects integer value")
		}
		if c.Op != "==" {
			return fmt.Errorf("port compare only supports ==; use `in [...]` for ranges")
		}
		p, err := portNum(c.Value.Num)
		if err != nil {
			return err
		}
		rs.Ports = append(rs.Ports, p)
	case "src_ip":
		if !c.Value.IsStr {
			return fmt.Errorf("src_ip expects string value")
		}
		n, err := parseCIDR(c.Value.Str + "/32")
		if err != nil {
			return err
		}
		if c.Op == "!=" {
			rs.Blocklist = append(rs.Blocklist, *n)
		} else {
			rs.Allowlist = append(rs.Allowlist, *n)
		}
	case "src_net":
		if !c.Value.IsStr {
			return fmt.Errorf("src_net expects CIDR string value")
		}
		n, err := parseCIDR(c.Value.Str)
		if err != nil {
			return err
		}
		if c.Op == "!=" {
			rs.Blocklist = append(rs.Blocklist, *n)
		} else {
			rs.Allowlist = append(rs.Allowlist, *n)
		}
	case "geo":
		if !c.Value.IsStr {
			return fmt.Errorf("geo expects country-code string value")
		}
		if c.Op == "!=" {
			rs.GeoBlock = append(rs.GeoBlock, strings.ToUpper(c.Value.Str))
		} else {
			rs.GeoAllow = append(rs.GeoAllow, strings.ToUpper(c.Value.Str))
		}
	default:
		return fmt.Errorf("unknown field %q", c.Field)
	}
	return nil
}

func applyIn(rs *docker.FirewallRuleSet, c InExpr) error {
	field := strings.ToLower(c.Field)
	switch field {
	case "port":
		for _, v := range c.Values {
			if !v.IsNum {
				return fmt.Errorf("port list expects integers")
			}
			p, err := portNum(v.Num)
			if err != nil {
				return err
			}
			rs.Ports = append(rs.Ports, p)
		}
	case "geo":
		codes := make([]string, 0, len(c.Values))
		for _, v := range c.Values {
			if !v.IsStr {
				return fmt.Errorf("geo list expects country-code strings")
			}
			codes = append(codes, strings.ToUpper(v.Str))
		}
		if c.Negate {
			rs.GeoAllow = append(rs.GeoAllow, codes...)
		} else {
			rs.GeoBlock = append(rs.GeoBlock, codes...)
		}
	default:
		return fmt.Errorf("`in` on field %q not supported", c.Field)
	}
	return nil
}

func portNum(n int64) (uint16, error) {
	if n < 1 || n > 65535 {
		return 0, fmt.Errorf("port %d out of range 1-65535", n)
	}
	return uint16(n), nil
}

func parseCIDR(s string) (*net.IPNet, error) {
	if !strings.Contains(s, "/") {
		if ip := net.ParseIP(s); ip != nil {
			if ip.To4() != nil {
				s += "/32"
			} else {
				s += "/128"
			}
		}
	}
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		return nil, fmt.Errorf("invalid CIDR %q: %w", s, err)
	}
	return n, nil
}

func cidrAll4() net.IPNet {
	_, n, _ := net.ParseCIDR("0.0.0.0/0")
	return *n
}

func cidrAll6() net.IPNet {
	_, n, _ := net.ParseCIDR("::/0")
	return *n
}
