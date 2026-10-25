package rules

import (
	"math"
	"net"
	"strconv"
	"strings"

	"firefik/internal/config"
	"firefik/internal/docker"
	"firefik/internal/policy"
)

const PolicyLabel = "firefik.policy"

func ApplyPolicies(cfg docker.ContainerConfig, labels map[string]string, policies map[string]*policy.Policy) docker.ContainerConfig {
	if len(policies) == 0 {
		return cfg
	}
	raw := labels[PolicyLabel]
	if raw == "" {
		return cfg
	}
	for _, name := range splitCommaPolicy(raw) {
		p, ok := policies[name]
		if !ok {
			continue
		}
		comp, err := policy.Compile(p)
		if err != nil {
			continue
		}
		cfg.RuleSets = append(cfg.RuleSets, comp.RuleSets...)
	}
	return cfg
}

func splitCommaPolicy(s string) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, p := range strings.Split(s, ",") {
		name := strings.TrimSpace(p)
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	return out
}

func ApplyTemplates(cfg docker.ContainerConfig, labels map[string]string, templates map[string]config.RuleTemplate) docker.ContainerConfig {
	if len(templates) == 0 {
		return cfg
	}
	names := config.ResolveTemplateNames(labels[config.TemplateLabel])
	if len(names) == 0 {
		return cfg
	}
	for _, name := range names {
		t, ok := templates[name]
		if !ok {
			continue
		}
		cfg.RuleSets = append(cfg.RuleSets, templateToRuleSet(t))
	}
	return cfg
}

func templateToRuleSet(t config.RuleTemplate) docker.FirewallRuleSet {
	rs := docker.FirewallRuleSet{
		Name:              "tpl:" + t.Name + "@" + t.Version,
		Ports:             append([]uint16(nil), t.Ports...),
		Protocol:          t.Protocol,
		Profile:           t.Profile,
		Log:               t.Log,
		LogPrefix:         t.LogPrefix,
		AllowlistNetworks: append([]string(nil), t.AllowlistNetworks...),
		BlocklistNetworks: append([]string(nil), t.BlocklistNetworks...),
		GeoBlock:          append([]string(nil), t.GeoBlock...),
		GeoAllow:          append([]string(nil), t.GeoAllow...),
	}
	for _, cidr := range t.Allowlist {
		if n := parseCIDRLenient(cidr); n != nil {
			rs.Allowlist = append(rs.Allowlist, *n)
		}
	}
	for _, cidr := range t.Blocklist {
		if n := parseCIDRLenient(cidr); n != nil {
			rs.Blocklist = append(rs.Blocklist, *n)
		}
	}
	if t.Ratelimit != "" {
		if rc := parseRatelimitLenient(t.Ratelimit); rc != nil {
			rs.RateLimit = rc
		}
	}
	return rs
}

func parseCIDRLenient(s string) *net.IPNet {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
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
		return nil
	}
	return n
}

func parseRatelimitLenient(s string) *docker.RateLimitConfig {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	main := s
	burst := uint(0)
	if idx := strings.Index(s, ","); idx >= 0 {
		main = strings.TrimSpace(s[:idx])
		rest := strings.TrimSpace(s[idx+1:])
		if strings.HasPrefix(rest, "burst=") {
			if v, err := strconv.ParseUint(strings.TrimPrefix(rest, "burst="), 10, 32); err == nil {
				burst = uint(v)
			}
		}
	}
	main = strings.TrimSuffix(main, "/s")
	n, err := strconv.ParseUint(main, 10, 32)
	if err != nil {
		return nil
	}
	if burst == 0 {
		burst = min(uint(n)*2, math.MaxUint32)
	}
	return &docker.RateLimitConfig{Rate: uint(n), Burst: burst}
}
