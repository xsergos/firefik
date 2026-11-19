//go:build linux

package rules

import (
	"errors"
	"fmt"
	"hash/fnv"
	"net"
	"strings"

	"github.com/coreos/go-iptables/iptables"

	"firefik/internal/docker"
)

const (
	filterTable         = "filter"
	ChainName           = "FIREFIK"
	ParentChain         = "DOCKER-USER"
	iptablesMaxChainLen = 28
)

type IPTablesBackend struct {
	ipt            *iptables.IPTables
	chainName      string
	parentChain    string
	stateful       bool
	defaultDropLog int
}

var _ Backend = (*IPTablesBackend)(nil)

func NewIPTablesBackend(chainName, parentChain string) (*IPTablesBackend, error) {
	ipt, err := iptables.New()
	if err != nil {
		return nil, fmt.Errorf("init iptables: %w", err)
	}
	return &IPTablesBackend{
		ipt:         ipt,
		chainName:   chainName,
		parentChain: parentChain,
		stateful:    true,
	}, nil
}

func (b *IPTablesBackend) SetStateful(v bool) { b.stateful = v }

func (b *IPTablesBackend) SetDefaultDropLogRate(perSecond int) { b.defaultDropLog = perSecond }

func defaultDropNflogArgs(perSecond int, label string) []string {
	rate := fmt.Sprintf("%d/second", perSecond)
	burst := fmt.Sprintf("%d", perSecond)
	return []string{
		"-m", "limit", "--limit", rate, "--limit-burst", burst,
		"-j", "NFLOG", "--nflog-group", fmt.Sprintf("%d", NflogGroup),
		"--nflog-prefix", NflogPrefix("DROP", label),
	}
}

var ctInvalidDropArgs = []string{"-m", "conntrack", "--ctstate", "INVALID", "-j", "DROP"}

func (b *IPTablesBackend) SetupChains() error {
	_ = b.ipt.NewChain(filterTable, b.chainName)

	exists, err := b.ipt.Exists(filterTable, b.parentChain, "-j", b.chainName)
	if err != nil {
		return fmt.Errorf("check jump rule: %w", err)
	}
	if !exists {
		if err := b.ipt.Insert(filterTable, b.parentChain, 1, "-j", b.chainName); err != nil {
			return fmt.Errorf("insert jump to %s: %w", b.chainName, err)
		}
	}

	if b.stateful {
		ctArgs := []string{"-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"}
		if exists, err := b.ipt.Exists(filterTable, b.chainName, ctArgs...); err == nil && !exists {
			if err := b.ipt.Insert(filterTable, b.chainName, 1, ctArgs...); err != nil {
				return fmt.Errorf("insert conntrack ESTABLISHED,RELATED accept: %w", err)
			}
		}
	}
	return nil
}

func (b *IPTablesBackend) Cleanup() error {
	_ = b.ipt.Delete(filterTable, b.parentChain, "-j", b.chainName)
	_ = b.ipt.ClearChain(filterTable, b.chainName)
	_ = b.ipt.DeleteChain(filterTable, b.chainName)
	return nil
}

func (b *IPTablesBackend) containerChainName(containerID string) string {
	id := containerID
	if len(id) > ContainerIDShortLen {
		id = id[:ContainerIDShortLen]
	}
	name := b.chainName + "-" + id
	if len(name) > iptablesMaxChainLen {
		name = name[:iptablesMaxChainLen]
	}
	return name
}

func (b *IPTablesBackend) ruleSetChainName(containerID, setName string) string {
	id := containerID
	if len(id) > ContainerIDShortLen {
		id = id[:ContainerIDShortLen]
	}
	name := b.chainName + "-" + id + "-" + setName
	if len(name) > iptablesMaxChainLen {
		h := fnv.New32a()
		h.Write([]byte(setName))
		suffix := fmt.Sprintf("%x", h.Sum32())
		prefix := b.chainName + "-" + id + "-"
		available := iptablesMaxChainLen - len(prefix) - len(suffix) - 1
		if available < 0 {
			available = 0
		}
		truncated := setName
		if len(truncated) > available {
			truncated = truncated[:available]
		}
		name = prefix + truncated + "-" + suffix
	}
	if len(name) > iptablesMaxChainLen {
		name = name[:iptablesMaxChainLen]
	}
	return name
}

func (b *IPTablesBackend) ApplyContainerRules(
	containerID, containerName string,
	containerIPs []net.IP,
	ruleSets []docker.FirewallRuleSet,
	defaultPolicy string,
	autoAllowlist []net.IPNet,
) error {
	mainChain := b.containerChainName(containerID)

	if err := b.ipt.NewChain(filterTable, mainChain); err != nil {
		_ = b.ipt.ClearChain(filterTable, mainChain)
	}

	if b.stateful {
		if err := b.ipt.AppendUnique(filterTable, mainChain, ctInvalidDropArgs...); err != nil {
			return fmt.Errorf("append conntrack INVALID drop: %w", err)
		}
	}

	for _, ip := range containerIPs {
		rule := []string{"-d", ip.String(), "-j", mainChain}
		if err := b.ipt.AppendUnique(filterTable, b.chainName, rule...); err != nil {
			return fmt.Errorf("append jump rule for %s: %w", ip, err)
		}
	}

	for _, rs := range ruleSets {
		rsChain := b.ruleSetChainName(containerID, rs.Name)
		_ = b.ipt.NewChain(filterTable, rsChain)
		_ = b.ipt.ClearChain(filterTable, rsChain)

		if err := b.fillRuleSetChain(rsChain, rs, autoAllowlist); err != nil {
			return fmt.Errorf("fill chain %s: %w", rsChain, err)
		}

		if err := b.ipt.AppendUnique(filterTable, mainChain, "-j", rsChain); err != nil {
			return fmt.Errorf("append jump to rule set chain %s: %w", rsChain, err)
		}
	}

	if b.defaultDropLog > 0 && strings.EqualFold(defaultPolicy, "DROP") {
		if err := b.ipt.AppendUnique(filterTable, mainChain, defaultDropNflogArgs(b.defaultDropLog, DefaultPolicyLogLabel)...); err != nil {
			return fmt.Errorf("append default policy log: %w", err)
		}
	}

	if err := b.ipt.AppendUnique(filterTable, mainChain, "-j", defaultPolicy); err != nil {
		return fmt.Errorf("append default policy %s: %w", defaultPolicy, err)
	}

	return nil
}

func (b *IPTablesBackend) fillRuleSetChain(chain string, rs docker.FirewallRuleSet, autoAllowlist []net.IPNet) error {
	proto := rs.Protocol
	if proto == "" {
		proto = "tcp"
	}

	allowlist := make([]net.IPNet, 0, len(rs.Allowlist)+len(autoAllowlist))
	for _, n := range rs.Allowlist {
		if n.IP != nil {
			allowlist = append(allowlist, n)
		}
	}
	allowlist = append(allowlist, autoAllowlist...)

	for _, port := range rs.Ports {
		portStr := fmt.Sprintf("%d", port)

		for _, bl := range rs.Blocklist {
			if bl.IP == nil {
				continue
			}
			src := bl.String()

			if rs.Log {
				logRule := buildNflogRule(proto, portStr, src, ruleLogLabel(rs.LogPrefix, rs.Name), "DROP")
				_ = b.ipt.AppendUnique(filterTable, chain, logRule...)
			}
			dropRule := buildRule(proto, portStr, src, "DROP")
			if err := b.ipt.AppendUnique(filterTable, chain, dropRule...); err != nil {
				return fmt.Errorf("append blocklist rule: %w", err)
			}
		}

		for _, al := range allowlist {
			src := al.String()
			if rs.RateLimit != nil {
				limitRule := buildRateLimitRule(proto, portStr, src, rs.Name, rs.RateLimit)
				if err := b.ipt.AppendUnique(filterTable, chain, limitRule...); err != nil {
					return fmt.Errorf("append rate limit rule: %w", err)
				}

				dropRule := buildRule(proto, portStr, src, "DROP")
				if err := b.ipt.AppendUnique(filterTable, chain, dropRule...); err != nil {
					return fmt.Errorf("append rate limit drop rule: %w", err)
				}
			} else {
				if rs.Log {
					logRule := buildNflogRule(proto, portStr, src, ruleLogLabel(rs.LogPrefix, rs.Name), "ACCEPT")
					_ = b.ipt.AppendUnique(filterTable, chain, logRule...)
				}
				acceptRule := buildRule(proto, portStr, src, "ACCEPT")
				if err := b.ipt.AppendUnique(filterTable, chain, acceptRule...); err != nil {
					return fmt.Errorf("append allowlist rule: %w", err)
				}
			}
		}

		if len(allowlist) > 0 {
			if rs.Log {
				logRule := buildNflogRule(proto, portStr, "", ruleLogLabel(rs.LogPrefix, rs.Name), "DROP")
				_ = b.ipt.AppendUnique(filterTable, chain, logRule...)
			} else if b.defaultDropLog > 0 {
				logRule := append([]string{"-p", proto, "--dport", portStr}, defaultDropNflogArgs(b.defaultDropLog, ruleLogLabel(rs.LogPrefix, rs.Name))...)
				_ = b.ipt.AppendUnique(filterTable, chain, logRule...)
			}
			dropRule := []string{"-p", proto, "--dport", portStr, "-j", "DROP"}
			if err := b.ipt.AppendUnique(filterTable, chain, dropRule...); err != nil {
				return fmt.Errorf("append port drop rule: %w", err)
			}
		}
	}

	_ = b.ipt.AppendUnique(filterTable, chain, "-j", "RETURN")
	return nil
}

func (b *IPTablesBackend) RemoveContainerChains(containerID string) error {
	mainChain := b.containerChainName(containerID)
	var errs []error

	rules, err := b.ipt.List(filterTable, b.chainName)
	if err != nil {
		errs = append(errs, fmt.Errorf("list rules in %s: %w", b.chainName, err))
	}
	for _, r := range rules {
		parts := strings.Fields(r)
		if len(parts) < 3 || parts[0] != "-A" || parts[1] != b.chainName {
			continue
		}
		if !ruleJumpsTo(parts, mainChain) {
			continue
		}
		if delErr := b.ipt.Delete(filterTable, b.chainName, parts[2:]...); delErr != nil {
			errs = append(errs, fmt.Errorf("delete jump rule for %s: %w", mainChain, delErr))
		}
	}

	chains, err := b.ipt.ListChains(filterTable)
	if err != nil {
		errs = append(errs, fmt.Errorf("list chains: %w", err))
	}
	subPrefix := mainChain + "-"
	for _, ch := range chains {
		if ch != mainChain && !strings.HasPrefix(ch, subPrefix) {
			continue
		}
		if clearErr := b.ipt.ClearChain(filterTable, ch); clearErr != nil {
			errs = append(errs, fmt.Errorf("clear chain %s: %w", ch, clearErr))
		}
		if delErr := b.ipt.DeleteChain(filterTable, ch); delErr != nil {
			errs = append(errs, fmt.Errorf("delete chain %s: %w", ch, delErr))
		}
	}

	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}

func (b *IPTablesBackend) Healthy() (HealthReport, error) {
	report := HealthReport{Backend: "iptables"}

	jumpOK, err := b.ipt.Exists(filterTable, b.parentChain, "-j", b.chainName)
	if err != nil {
		return report, fmt.Errorf("check parent jump: %w", err)
	}
	report.ParentJumpPresent = jumpOK
	if !jumpOK {
		report.Notes = append(report.Notes,
			fmt.Sprintf("parent chain %s has no jump to %s — traffic bypasses firefik", b.parentChain, b.chainName))
	}

	chains, err := b.ipt.ListChains(filterTable)
	if err != nil {
		return report, fmt.Errorf("list chains: %w", err)
	}
	prefix := b.chainName + "-"
	for _, ch := range chains {
		if ch == b.chainName {
			report.BaseChainPresent = true
			continue
		}
		if strings.HasPrefix(ch, prefix) {
			report.ContainerChainCount++
		}
	}
	if !report.BaseChainPresent {
		report.Notes = append(report.Notes, "base chain absent — run SetupChains or firefik itself")
	}
	return report, nil
}

func (b *IPTablesBackend) ListAppliedContainerIDs() ([]string, error) {
	chains, err := b.ipt.ListChains(filterTable)
	if err != nil {
		return nil, fmt.Errorf("list iptables chains: %w", err)
	}
	prefix := b.chainName + "-"
	seen := make(map[string]struct{})
	for _, ch := range chains {
		if !strings.HasPrefix(ch, prefix) {
			continue
		}
		suffix := strings.TrimPrefix(ch, prefix)
		id := suffix
		if i := strings.Index(suffix, "-"); i >= 0 {
			id = suffix[:i]
		}
		if id == "" {
			continue
		}
		seen[id] = struct{}{}
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	return ids, nil
}

func ruleJumpsTo(parts []string, target string) bool {
	for i := 0; i < len(parts)-1; i++ {
		if parts[i] == "-j" && parts[i+1] == target {
			return true
		}
	}
	return false
}

func buildNflogRule(proto, port, src, label, actionType string) []string {
	prefix := NflogPrefix(actionType, label)

	rule := []string{"-p", proto, "--dport", port}
	if src != "" && src != "0.0.0.0/0" && src != "::/0" {
		rule = append(rule, "-s", src)
	}

	rule = append(rule, "-j", "NFLOG", "--nflog-group", fmt.Sprintf("%d", NflogGroup), "--nflog-prefix", prefix)
	return rule
}

func buildRule(proto, port, src, action string) []string {
	rule := []string{"-p", proto, "--dport", port}
	if src != "" && src != "0.0.0.0/0" && src != "::/0" {
		rule = append(rule, "-s", src)
	}
	rule = append(rule, "-j", action)
	return rule
}

func buildRateLimitRule(proto, port, src, name string, rl *docker.RateLimitConfig) []string {
	limitName := "FF-" + name + "-" + port
	if len(limitName) > 15 {
		h := fnv.New32a()
		h.Write([]byte(name + "-" + port))
		limitName = fmt.Sprintf("FF-%x", h.Sum32())
	}
	rule := []string{"-p", proto, "--dport", port}
	if src != "" && src != "0.0.0.0/0" && src != "::/0" {
		rule = append(rule, "-s", src)
	}
	rule = append(rule,
		"-m", "hashlimit",
		"--hashlimit-name", limitName,
		"--hashlimit-mode", "srcip",
		"--hashlimit-upto", fmt.Sprintf("%d/sec", rl.Rate),
		"--hashlimit-burst", fmt.Sprintf("%d", rl.Burst),
		"-j", "ACCEPT",
	)
	return rule
}
