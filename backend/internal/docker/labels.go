package docker

import (
	"fmt"
	"math/big"
	"net"
	"strconv"
	"strings"

	"firefik/internal/schedule"
)

const (
	LabelEnable          = "firefik.enable"
	LabelDefaultPolicy   = "firefik.defaultpolicy"
	LabelNoAutoAllowlist = "firefik.no-auto-allowlist"

	firewallPrefix   = "firefik.firewall."
	defaultRateBurst = 20
)

type RateLimitConfig struct {
	Rate  uint
	Burst uint
}

type FirewallRuleSet struct {
	Name              string
	Ports             []uint16
	Allowlist         []net.IPNet
	Blocklist         []net.IPNet
	AllowlistNetworks []string
	BlocklistNetworks []string
	RateLimit         *RateLimitConfig
	Profile           string
	Log               bool
	LogPrefix         string
	Protocol          string
	GeoBlock          []string
	GeoAllow          []string

	Schedule *schedule.Window
}

type ContainerConfig struct {
	Enable          bool
	DefaultPolicy   string
	NoAutoAllowlist bool
	RuleSets        []FirewallRuleSet
}

func ParseLabels(labels map[string]string) (ContainerConfig, []error) {
	cfg := ContainerConfig{}
	var errs []error

	cfg.Enable = labels[LabelEnable] == "true"
	cfg.NoAutoAllowlist = labels[LabelNoAutoAllowlist] == "true"

	if p, ok := labels[LabelDefaultPolicy]; ok {
		switch strings.ToUpper(p) {
		case "ACCEPT", "DROP", "RETURN":
			cfg.DefaultPolicy = strings.ToUpper(p)
		default:
			errs = append(errs, fmt.Errorf("label %q: unknown policy %q, must be DROP, RETURN or ACCEPT", LabelDefaultPolicy, p))
		}
	}

	type rawSet map[string]string
	sets := map[string]rawSet{}

	for k, v := range labels {
		if !strings.HasPrefix(k, firewallPrefix) {
			continue
		}
		rest := strings.TrimPrefix(k, firewallPrefix)
		dot := strings.Index(rest, ".")
		if dot < 0 {
			errs = append(errs, fmt.Errorf("label %q: missing param after rule set name", k))
			continue
		}
		name := rest[:dot]
		if name == "" {
			errs = append(errs, fmt.Errorf("label %q: empty rule set name", k))
			continue
		}
		param := rest[dot+1:]
		if sets[name] == nil {
			sets[name] = rawSet{}
		}
		sets[name][param] = v
	}

	for name, raw := range sets {
		rs, rsErrs := parseRuleSet(name, raw)
		errs = append(errs, rsErrs...)
		cfg.RuleSets = append(cfg.RuleSets, rs)
	}

	return cfg, errs
}

func parseRuleSet(name string, raw map[string]string) (FirewallRuleSet, []error) {
	rs := FirewallRuleSet{
		Name:     name,
		Protocol: raw["protocol"],
		Profile:  raw["profile"],
	}
	var errs []error
	prefix := firewallPrefix + name + "."

	if v, ok := raw["ports"]; ok {
		ports, err := parsePorts(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("label %q: %w", prefix+"ports", err))
		} else {
			rs.Ports = ports
		}
	}

	if v, ok := raw["allowlist"]; ok {
		cidrs, networks, err := parseIPListWithNetworks(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("label %q: %w", prefix+"allowlist", err))
		} else {
			rs.Allowlist = cidrs
			rs.AllowlistNetworks = networks
		}
	}

	if v, ok := raw["blocklist"]; ok {
		cidrs, networks, err := parseIPListWithNetworks(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("label %q: %w", prefix+"blocklist", err))
		} else {
			rs.Blocklist = cidrs
			rs.BlocklistNetworks = networks
		}
	}

	rateStr, hasRate := raw["ratelimit.rate"]
	burstStr, hasBurst := raw["ratelimit.burst"]
	if hasRate || hasBurst {
		rl := &RateLimitConfig{Burst: defaultRateBurst}
		if hasRate {
			r, err := strconv.ParseUint(rateStr, 10, 32)
			if err != nil {
				errs = append(errs, fmt.Errorf("label %q: %w", prefix+"ratelimit.rate", err))
			} else {
				rl.Rate = uint(r)
			}
		}
		if hasBurst {
			b, err := strconv.ParseUint(burstStr, 10, 32)
			if err != nil {
				errs = append(errs, fmt.Errorf("label %q: %w", prefix+"ratelimit.burst", err))
			} else {
				rl.Burst = uint(b)
			}
		}
		if rl.Rate == 0 {
			errs = append(errs, fmt.Errorf("label %q: ratelimit.rate must be > 0; ignoring ratelimit config", prefix+"ratelimit.rate"))
		} else {
			if rl.Burst == 0 {
				errs = append(errs, fmt.Errorf("label %q: ratelimit.burst is 0; traffic may be blocked immediately", prefix+"ratelimit.burst"))
			}
			rs.RateLimit = rl
		}
	}

	rs.Log = raw["log"] == "true"
	rs.LogPrefix = raw["log.prefix"]

	if v, ok := raw["geoblock"]; ok {
		rs.GeoBlock = splitTrimmed(v)
	}
	if v, ok := raw["geoallow"]; ok {
		rs.GeoAllow = splitTrimmed(v)
	}

	if v, ok := raw["schedule"]; ok {
		w, err := schedule.Parse(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("label %q: %w", prefix+"schedule", err))
		} else {
			rs.Schedule = &w
		}
	}

	return rs, errs
}

func parsePorts(s string) ([]uint16, error) {
	var ports []uint16
	for _, p := range splitTrimmed(s) {
		n, err := strconv.ParseUint(p, 10, 16)
		if err != nil {
			return nil, fmt.Errorf("invalid port %q: %w", p, err)
		}
		if n == 0 {
			return nil, fmt.Errorf("invalid port: 0")
		}
		ports = append(ports, uint16(n))
	}
	return ports, nil
}

func parseIPListWithNetworks(s string) (cidrs []net.IPNet, networks []string, err error) {
	for _, entry := range splitTrimmed(s) {
		if isNetworkName(entry) {
			networks = append(networks, entry)
			continue
		}
		parsed, parseErr := parseIPEntry(entry)
		if parseErr != nil {
			return nil, nil, parseErr
		}
		cidrs = append(cidrs, parsed...)
	}
	return cidrs, networks, nil
}

func isNetworkName(entry string) bool {
	return !strings.Contains(entry, "/") &&
		!strings.Contains(entry, "-") &&
		net.ParseIP(entry) == nil
}

func parseIPEntry(entry string) ([]net.IPNet, error) {
	if strings.Contains(entry, "/") {
		_, ipNet, err := net.ParseCIDR(entry)
		if err != nil {
			return nil, fmt.Errorf("invalid CIDR %q: %w", entry, err)
		}
		return []net.IPNet{*ipNet}, nil
	}

	if strings.Contains(entry, "-") {
		return parseRange(entry)
	}

	ip := net.ParseIP(entry)
	if ip == nil {
		return nil, fmt.Errorf("invalid IP %q", entry)
	}

	if ip4 := ip.To4(); ip4 != nil {
		return []net.IPNet{{IP: ip4, Mask: net.CIDRMask(32, 32)}}, nil
	}
	return []net.IPNet{{IP: ip, Mask: net.CIDRMask(128, 128)}}, nil
}

func parseRange(entry string) ([]net.IPNet, error) {
	parts := strings.SplitN(entry, "-", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid range %q", entry)
	}
	startStr, endStr := parts[0], parts[1]

	startIP := net.ParseIP(startStr)
	if startIP == nil {
		return nil, fmt.Errorf("invalid range start %q", startStr)
	}

	if ip4 := startIP.To4(); ip4 != nil {
		var endIP net.IP
		if !strings.Contains(endStr, ".") {
			n, err := strconv.ParseUint(endStr, 10, 8)
			if err != nil {
				return nil, fmt.Errorf("invalid range suffix %q: %w", endStr, err)
			}
			endIP = make(net.IP, 4)
			copy(endIP, ip4)
			endIP[3] = byte(n)
		} else {
			parsed := net.ParseIP(endStr)
			if parsed == nil {
				return nil, fmt.Errorf("invalid range end %q", endStr)
			}
			endIP = parsed.To4()
			if endIP == nil {
				return nil, fmt.Errorf("invalid range end %q (not IPv4)", endStr)
			}
		}
		return rangeToCIDRs(ip4, endIP)
	}

	start6 := startIP.To16()
	parsed := net.ParseIP(endStr)
	if parsed == nil {
		return nil, fmt.Errorf("invalid range end %q", endStr)
	}
	end6 := parsed.To16()
	if end6 == nil {
		return nil, fmt.Errorf("invalid range end %q", endStr)
	}
	return rangeToCIDRsV6(start6, end6)
}

func rangeToCIDRs(start, end net.IP) ([]net.IPNet, error) {
	s := ipToUint32(start)
	e := ipToUint32(end)
	if s > e {
		return nil, fmt.Errorf("range start %s is after end %s", start, end)
	}

	var result []net.IPNet
	for s <= e {
		bits := uint32(32)
		for bits > 0 {
			mask := ^((uint32(1) << (32 - bits)) - 1)
			if s&mask != s {
				break
			}
			next := s + (uint32(1) << (32 - bits))
			if next-1 > e {
				break
			}
			bits--
		}
		bits++
		ip := uint32ToIP(s)
		result = append(result, net.IPNet{
			IP:   ip,
			Mask: net.CIDRMask(int(bits), 32),
		})
		blockSize := uint32(1) << (32 - bits)
		s += blockSize
		if s == 0 {
			break
		}
	}
	return result, nil
}

func rangeToCIDRsV6(start, end net.IP) ([]net.IPNet, error) {
	s := new(big.Int).SetBytes(start.To16())
	e := new(big.Int).SetBytes(end.To16())
	if s.Cmp(e) > 0 {
		return nil, fmt.Errorf("range start %s is after end %s", start, end)
	}

	one := big.NewInt(1)
	var result []net.IPNet
	for s.Cmp(e) <= 0 {
		bits := 128
		for bits > 0 {
			mask := new(big.Int).Lsh(one, uint(128-bits))
			mask.Sub(mask, one)
			mask.Not(mask)
			if new(big.Int).And(s, mask).Cmp(s) != 0 {
				break
			}
			next := new(big.Int).Lsh(one, uint(128-bits))
			next.Add(s, next)
			next.Sub(next, one)
			if next.Cmp(e) > 0 {
				break
			}
			bits--
		}
		bits++

		ip := make(net.IP, 16)
		b := s.Bytes()
		copy(ip[16-len(b):], b)
		result = append(result, net.IPNet{
			IP:   ip,
			Mask: net.CIDRMask(bits, 128),
		})

		blockSize := new(big.Int).Lsh(one, uint(128-bits))
		s.Add(s, blockSize)
		if s.BitLen() > 128 {
			break
		}
	}
	return result, nil
}

func ipToUint32(ip net.IP) uint32 {
	ip = ip.To4()
	return uint32(ip[0])<<24 | uint32(ip[1])<<16 | uint32(ip[2])<<8 | uint32(ip[3])
}

func uint32ToIP(n uint32) net.IP {
	return net.IP{byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)} // #nosec G115 -- intentional octet extraction
}

func splitTrimmed(s string) []string {
	parts := strings.Split(s, ",")
	out := parts[:0]
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
