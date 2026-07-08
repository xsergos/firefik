//go:build linux

package rules

import (
	"fmt"
	"net"
	"strings"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"golang.org/x/sys/unix"
)

const nftHostChainName = "firefik_host"

func (b *NFTablesBackend) ApplyHostRules(rules []HostRule, defaultPolicy string) error {
	if b.table == nil {
		if err := b.SetupChains(); err != nil {
			return fmt.Errorf("ensure table: %w", err)
		}
	}

	chain, err := b.ensureHostChain(defaultPolicy)
	if err != nil {
		return err
	}

	if err := b.flushHostChainRules(chain); err != nil {
		return fmt.Errorf("flush host chain: %w", err)
	}

	if b.stateful {
		b.conn.AddRule(&nftables.Rule{
			Table: b.table,
			Chain: chain,
			Exprs: ctStateEstablishedRelatedAcceptExprs(),
		})
	}

	if NormaliseHostDefault(defaultPolicy) == "DROP" {
		b.conn.AddRule(&nftables.Rule{
			Table: b.table,
			Chain: chain,
			Exprs: iifLoopbackAcceptExprs(),
		})
	}

	for _, rule := range rules {
		proto := strings.ToLower(strings.TrimSpace(rule.Protocol))
		if !nftHostProtoSupported(proto) {
			if b.logger != nil {
				b.logger.Warn("host rule protocol unsupported on nftables backend; rule NOT applied",
					"rule", rule.Name, "protocol", proto)
			}
			continue
		}
		for _, peer := range rule.Blocklist {
			if rule.Log {
				if err := b.addHostNflog(chain, proto, rule.Ports, peer, rule.LogPrefix, "DROP"); err != nil {
					return fmt.Errorf("host rule %q blocklist log %s: %w", rule.Name, peer.String(), err)
				}
			}
			if err := b.addHostMatch(chain, proto, rule.Ports, peer, expr.VerdictDrop); err != nil {
				return fmt.Errorf("host rule %q blocklist %s: %w", rule.Name, peer.String(), err)
			}
		}
		for _, peer := range rule.Allowlist {
			if rule.Log {
				if err := b.addHostNflog(chain, proto, rule.Ports, peer, rule.LogPrefix, "ACCEPT"); err != nil {
					return fmt.Errorf("host rule %q allowlist log %s: %w", rule.Name, peer.String(), err)
				}
			}
			if err := b.addHostMatch(chain, proto, rule.Ports, peer, expr.VerdictAccept); err != nil {
				return fmt.Errorf("host rule %q allowlist %s: %w", rule.Name, peer.String(), err)
			}
		}
		if len(rule.Allowlist) == 0 && len(rule.Blocklist) == 0 {
			if rule.Log {
				if err := b.addHostNflog(chain, proto, rule.Ports, net.IPNet{}, rule.LogPrefix, "ACCEPT"); err != nil {
					return fmt.Errorf("host rule %q bare allow log: %w", rule.Name, err)
				}
			}
			if err := b.addHostMatch(chain, proto, rule.Ports, net.IPNet{}, expr.VerdictAccept); err != nil {
				return fmt.Errorf("host rule %q bare allow: %w", rule.Name, err)
			}
		}
	}

	return b.conn.Flush()
}

func (b *NFTablesBackend) RemoveHostChain() error {
	if b.table == nil {
		return nil
	}
	chains, err := b.conn.ListChainsOfTableFamily(nftables.TableFamilyINet)
	if err != nil {
		return fmt.Errorf("list chains: %w", err)
	}
	for _, ch := range chains {
		if ch.Table != nil && ch.Table.Name == nftTableName && ch.Name == nftHostChainName {
			b.conn.DelChain(ch)
			return b.conn.Flush()
		}
	}
	return nil
}

func (b *NFTablesBackend) ensureHostChain(defaultPolicy string) (*nftables.Chain, error) {
	existing, err := b.conn.ListChainsOfTableFamily(nftables.TableFamilyINet)
	if err != nil {
		return nil, fmt.Errorf("list chains: %w", err)
	}
	policy := nftables.ChainPolicyAccept
	if NormaliseHostDefault(defaultPolicy) == "DROP" {
		policy = nftables.ChainPolicyDrop
	}
	for _, ch := range existing {
		if ch.Table != nil && ch.Table.Name == nftTableName && ch.Name == nftHostChainName {
			if ch.Policy == nil || *ch.Policy != policy {
				b.conn.DelChain(ch)
				if err := b.conn.Flush(); err != nil {
					return nil, fmt.Errorf("delete stale host chain: %w", err)
				}
				break
			}
			return ch, nil
		}
	}

	prio := nftables.ChainPriorityFilter
	chain := b.conn.AddChain(&nftables.Chain{
		Name:     nftHostChainName,
		Table:    b.table,
		Type:     nftables.ChainTypeFilter,
		Hooknum:  nftables.ChainHookInput,
		Priority: prio,
		Policy:   &policy,
	})
	if err := b.conn.Flush(); err != nil {
		return nil, fmt.Errorf("create host chain: %w", err)
	}
	return chain, nil
}

func (b *NFTablesBackend) flushHostChainRules(chain *nftables.Chain) error {
	rules, err := b.conn.GetRules(b.table, chain)
	if err != nil {
		return err
	}
	for _, r := range rules {
		if err := b.conn.DelRule(r); err != nil {
			return err
		}
	}
	return b.conn.Flush()
}

func (b *NFTablesBackend) addHostNflog(
	chain *nftables.Chain,
	proto string,
	ports []uint16,
	peer net.IPNet,
	logPrefix, actionType string,
) error {
	prefix := strings.TrimSpace(logPrefix)
	if prefix == "" {
		prefix = "firefik-host-" + actionType
	}
	if len(prefix) > LogPrefixMaxLen {
		prefix = prefix[:LogPrefixMaxLen]
	}
	build := func(matchExtra []expr.Any) {
		exprs := make([]expr.Any, 0, 8+len(matchExtra))
		if peer.IP != nil {
			exprs = append(exprs, srcNetMatchExprs(peer)...)
		}
		exprs = append(exprs, matchExtra...)
		exprs = append(exprs, nflogExpr(prefix, actionType))
		b.conn.AddRule(&nftables.Rule{Table: b.table, Chain: chain, Exprs: exprs})
	}
	if proto == "tcp" || proto == "udp" {
		if len(ports) == 0 {
			build(protoAnyPortExprs(proto))
			return nil
		}
		for _, port := range ports {
			build(protoPortExprs(proto, port))
		}
		return nil
	}
	if protoNum, ok := icmpL4ProtoNum(proto); ok {
		build(l4ProtoMatchExprs(protoNum))
		return nil
	}
	build(nil)
	return nil
}

func (b *NFTablesBackend) addHostMatch(
	chain *nftables.Chain,
	proto string,
	ports []uint16,
	peer net.IPNet,
	verdict expr.VerdictKind,
) error {
	base := make([]expr.Any, 0, 8)
	if peer.IP != nil {
		base = append(base, srcNetMatchExprs(peer)...)
	}
	if proto == "tcp" || proto == "udp" {
		if len(ports) == 0 {
			exprs := append(append([]expr.Any(nil), base...), protoAnyPortExprs(proto)...)
			exprs = append(exprs, &expr.Verdict{Kind: verdict})
			b.conn.AddRule(&nftables.Rule{Table: b.table, Chain: chain, Exprs: exprs})
			return nil
		}
		for _, port := range ports {
			exprs := append(append([]expr.Any(nil), base...), protoPortExprs(proto, port)...)
			exprs = append(exprs, &expr.Verdict{Kind: verdict})
			b.conn.AddRule(&nftables.Rule{Table: b.table, Chain: chain, Exprs: exprs})
		}
		return nil
	}
	if protoNum, ok := icmpL4ProtoNum(proto); ok {
		base = append(base, l4ProtoMatchExprs(protoNum)...)
	}
	base = append(base, &expr.Verdict{Kind: verdict})
	b.conn.AddRule(&nftables.Rule{Table: b.table, Chain: chain, Exprs: base})
	return nil
}

func protoAnyPortExprs(proto string) []expr.Any {
	var protoNum uint8
	if strings.ToLower(proto) == "udp" {
		protoNum = 17
	} else {
		protoNum = 6
	}
	return []expr.Any{
		&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{protoNum}},
	}
}

func nftHostProtoSupported(proto string) bool {
	switch proto {
	case "", "any", "tcp", "udp", "icmp", "icmpv6", "ipv6-icmp":
		return true
	}
	return false
}

func icmpL4ProtoNum(proto string) (uint8, bool) {
	switch proto {
	case "icmp":
		return uint8(unix.IPPROTO_ICMP), true
	case "icmpv6", "ipv6-icmp":
		return uint8(unix.IPPROTO_ICMPV6), true
	}
	return 0, false
}

func l4ProtoMatchExprs(protoNum uint8) []expr.Any {
	return []expr.Any{
		&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{protoNum}},
	}
}
