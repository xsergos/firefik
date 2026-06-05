//go:build linux

package rules

import (
	"fmt"
	"net"
	"strconv"
	"strings"
)

const hostParentChain = "INPUT"

func (b *IPTablesBackend) ApplyHostRules(rules []HostRule, defaultPolicy string) error {
	if err := b.ipt.NewChain(filterTable, hostChainName); err != nil && !isChainExistsError(err) {
		return fmt.Errorf("create %s chain: %w", hostChainName, err)
	}
	if err := b.ipt.ClearChain(filterTable, hostChainName); err != nil {
		return fmt.Errorf("clear %s chain: %w", hostChainName, err)
	}

	exists, err := b.ipt.Exists(filterTable, hostParentChain, "-j", hostChainName)
	if err != nil {
		return fmt.Errorf("check INPUT jump: %w", err)
	}
	if !exists {
		if err := b.ipt.Insert(filterTable, hostParentChain, 1, "-j", hostChainName); err != nil {
			return fmt.Errorf("insert %s jump from INPUT: %w", hostChainName, err)
		}
	}

	if b.stateful {
		if err := b.ipt.Append(filterTable, hostChainName,
			"-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT",
		); err != nil {
			return fmt.Errorf("host: append ct accept: %w", err)
		}
	}

	if NormaliseHostDefault(defaultPolicy) == "DROP" {
		if err := b.ipt.Append(filterTable, hostChainName, "-i", "lo", "-j", "ACCEPT"); err != nil {
			return fmt.Errorf("host: append loopback accept: %w", err)
		}
	}

	for _, rule := range rules {
		proto := rule.protoNormalised()
		for _, peer := range rule.Blocklist {
			if rule.Log {
				if err := b.appendHostNflog(proto, rule.Ports, peer, rule.LogPrefix, "DROP"); err != nil {
					return fmt.Errorf("host rule %q blocklist log %s: %w", rule.Name, peer.String(), err)
				}
			}
			if err := b.appendHostRule(proto, rule.Ports, peer, "DROP"); err != nil {
				return fmt.Errorf("host rule %q blocklist %s: %w", rule.Name, peer.String(), err)
			}
		}
		for _, peer := range rule.Allowlist {
			if rule.Log {
				if err := b.appendHostNflog(proto, rule.Ports, peer, rule.LogPrefix, "ACCEPT"); err != nil {
					return fmt.Errorf("host rule %q allowlist log %s: %w", rule.Name, peer.String(), err)
				}
			}
			if err := b.appendHostRule(proto, rule.Ports, peer, "ACCEPT"); err != nil {
				return fmt.Errorf("host rule %q allowlist %s: %w", rule.Name, peer.String(), err)
			}
		}
		if len(rule.Allowlist) == 0 && len(rule.Blocklist) == 0 {
			if rule.Log {
				if err := b.appendHostNflog(proto, rule.Ports, net.IPNet{}, rule.LogPrefix, "ACCEPT"); err != nil {
					return fmt.Errorf("host rule %q bare allow log: %w", rule.Name, err)
				}
			}
			if err := b.appendHostRule(proto, rule.Ports, net.IPNet{}, "ACCEPT"); err != nil {
				return fmt.Errorf("host rule %q bare allow: %w", rule.Name, err)
			}
		}
	}

	target := NormaliseHostDefault(defaultPolicy)
	if err := b.ipt.Append(filterTable, hostChainName, "-j", target); err != nil {
		return fmt.Errorf("append default policy %s: %w", target, err)
	}
	return nil
}

func (b *IPTablesBackend) RemoveHostChain() error {
	_ = b.ipt.Delete(filterTable, hostParentChain, "-j", hostChainName)
	_ = b.ipt.ClearChain(filterTable, hostChainName)
	_ = b.ipt.DeleteChain(filterTable, hostChainName)
	return nil
}

func (b *IPTablesBackend) appendHostRule(proto string, ports []uint16, peer net.IPNet, target string) error {
	args := make([]string, 0, 12)
	if peer.IP != nil {
		args = append(args, "-s", peer.String())
	}
	if proto != "" {
		args = append(args, "-p", proto)
		if len(ports) > 0 && (proto == "tcp" || proto == "udp") {
			args = append(args, "-m", "multiport", "--dports", joinPorts(ports))
		}
	}
	args = append(args, "-j", target)
	return b.ipt.Append(filterTable, hostChainName, args...)
}

func (b *IPTablesBackend) appendHostNflog(proto string, ports []uint16, peer net.IPNet, logPrefix, actionType string) error {
	prefix := strings.TrimSpace(logPrefix)
	if prefix == "" {
		prefix = "firefik-host-" + actionType
	}
	if len(prefix) > LogPrefixMaxLen {
		prefix = prefix[:LogPrefixMaxLen]
	}
	args := make([]string, 0, 14)
	if peer.IP != nil {
		args = append(args, "-s", peer.String())
	}
	if proto != "" {
		args = append(args, "-p", proto)
		if len(ports) > 0 && (proto == "tcp" || proto == "udp") {
			args = append(args, "-m", "multiport", "--dports", joinPorts(ports))
		}
	}
	args = append(args, "-j", "NFLOG", "--nflog-group", strconv.Itoa(NflogGroup), "--nflog-prefix", prefix)
	return b.ipt.Append(filterTable, hostChainName, args...)
}

func joinPorts(ports []uint16) string {
	parts := make([]string, 0, len(ports))
	for _, p := range ports {
		parts = append(parts, strconv.Itoa(int(p)))
	}
	return strings.Join(parts, ",")
}

func isChainExistsError(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "Chain already exists") || strings.Contains(s, "iptables: Chain already exists")
}
