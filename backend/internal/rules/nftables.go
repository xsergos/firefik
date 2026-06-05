//go:build linux

package rules

import (
	"encoding/binary"
	"fmt"
	"hash/fnv"
	"log/slog"
	"net"
	"strings"
	"time"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"golang.org/x/sys/unix"

	"firefik/internal/docker"
)

const nftTableName = "firefik"

type NFTablesBackend struct {
	conn      *nftables.Conn
	table     *nftables.Table
	fwdChain  *nftables.Chain
	chainName string
	logger    *slog.Logger
	stateful  bool
}

var _ Backend = (*NFTablesBackend)(nil)

func NewNFTablesBackend(chainName string, logger *slog.Logger) (*NFTablesBackend, error) {
	conn, err := nftables.New()
	if err != nil {
		return nil, fmt.Errorf("nftables conn: %w", err)
	}
	return &NFTablesBackend{conn: conn, chainName: chainName, logger: logger, stateful: true}, nil
}

func (b *NFTablesBackend) SetStateful(v bool) { b.stateful = v }

func (b *NFTablesBackend) SetupChains() error {
	b.table = b.conn.AddTable(&nftables.Table{
		Family: nftables.TableFamilyINet,
		Name:   nftTableName,
	})
	if err := b.conn.Flush(); err != nil {
		return fmt.Errorf("flush after add table: %w", err)
	}

	existing, err := b.conn.ListChainsOfTableFamily(nftables.TableFamilyINet)
	if err != nil {
		return fmt.Errorf("list existing chains: %w", err)
	}
	var found *nftables.Chain
	for _, ch := range existing {
		if ch.Table != nil && ch.Table.Name == nftTableName && ch.Name == "forward" {
			found = ch
			break
		}
	}

	if found != nil {
		b.fwdChain = found
		if b.stateful {
			if err := b.ensureCTStateAccept(); err != nil {
				return err
			}
		}
		return nil
	}

	prio := nftables.ChainPriorityFilter
	accept := nftables.ChainPolicyAccept
	b.fwdChain = b.conn.AddChain(&nftables.Chain{
		Name:     "forward",
		Table:    b.table,
		Type:     nftables.ChainTypeFilter,
		Hooknum:  nftables.ChainHookForward,
		Priority: prio,
		Policy:   &accept,
	})
	if err := b.conn.Flush(); err != nil {
		return err
	}
	if b.stateful {
		if err := b.ensureCTStateAccept(); err != nil {
			return err
		}
	}
	return nil
}

func (b *NFTablesBackend) ensureCTStateAccept() error {
	rules, err := b.conn.GetRules(b.table, b.fwdChain)
	if err == nil {
		for _, r := range rules {
			if hasCTStateAcceptExprs(r.Exprs) {
				return nil
			}
		}
	}
	b.conn.InsertRule(&nftables.Rule{
		Table: b.table,
		Chain: b.fwdChain,
		Exprs: ctStateEstablishedRelatedAcceptExprs(),
	})
	return b.conn.Flush()
}

func hasCTStateAcceptExprs(exprs []expr.Any) bool {
	var sawCT, sawAccept bool
	for _, e := range exprs {
		switch v := e.(type) {
		case *expr.Ct:
			if v.Key == expr.CtKeySTATE {
				sawCT = true
			}
		case *expr.Verdict:
			if v.Kind == expr.VerdictAccept {
				sawAccept = true
			}
		}
	}
	return sawCT && sawAccept
}

func ctStateEstablishedRelatedAcceptExprs() []expr.Any {
	mask := uint32(expr.CtStateBitESTABLISHED | expr.CtStateBitRELATED)
	return []expr.Any{
		&expr.Ct{Register: 1, Key: expr.CtKeySTATE},
		&expr.Bitwise{
			SourceRegister: 1,
			DestRegister:   1,
			Len:            4,
			Mask:           binaryUint32(mask),
			Xor:            binaryUint32(0),
		},
		&expr.Cmp{
			Op:       expr.CmpOpNeq,
			Register: 1,
			Data:     binaryUint32(0),
		},
		&expr.Verdict{Kind: expr.VerdictAccept},
	}
}

func iifLoopbackAcceptExprs() []expr.Any {
	return []expr.Any{
		&expr.Meta{Key: expr.MetaKeyIIFNAME, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte("lo\x00")},
		&expr.Verdict{Kind: expr.VerdictAccept},
	}
}

func binaryUint32(v uint32) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, v)
	return b
}

func (b *NFTablesBackend) Cleanup() error {
	if b.table == nil {
		return nil
	}

	prefix := strings.ToLower(b.chainName) + "-"
	chains, err := b.conn.ListChainsOfTableFamily(nftables.TableFamilyINet)
	if err != nil {
		return fmt.Errorf("list nftables chains: %w", err)
	}

	mine := make(map[string]*nftables.Chain)
	var mineMain, mineSubs []*nftables.Chain
	myShortIDs := make(map[string]struct{})
	var otherContainerChains int
	for _, ch := range chains {
		if ch.Table == nil || ch.Table.Name != nftTableName {
			continue
		}
		if ch.Name == "forward" {
			continue
		}
		id, rsSub, ok := parseInstanceChainName(ch.Name, prefix)
		if ok {
			mine[ch.Name] = ch
			if rsSub {
				mineSubs = append(mineSubs, ch)
			} else {
				mineMain = append(mineMain, ch)
				myShortIDs[id] = struct{}{}
			}
			continue
		}
		otherContainerChains++
	}

	if b.fwdChain != nil {
		rules, err := b.conn.GetRules(b.table, b.fwdChain)
		if err == nil {
			deleted := false
			for _, r := range rules {
				for _, e := range r.Exprs {
					v, ok := e.(*expr.Verdict)
					if !ok {
						continue
					}
					if _, matched := mine[v.Chain]; matched {
						_ = b.conn.DelRule(r)
						deleted = true
						break
					}
				}
			}
			if deleted {
				if err := b.conn.Flush(); err != nil {
					return fmt.Errorf("flush forward rule deletions: %w", err)
				}
			}
		}
	}

	for _, ch := range mineMain {
		b.conn.DelChain(ch)
	}
	if len(mineMain) > 0 {
		if err := b.conn.Flush(); err != nil {
			return fmt.Errorf("flush main chain deletions: %w", err)
		}
	}

	for _, ch := range mineSubs {
		b.conn.DelChain(ch)
	}

	if sets, err := b.conn.GetSets(b.table); err == nil {
		for _, s := range sets {
			for id := range myShortIDs {
				if strings.HasPrefix(s.Name, "rl-"+id+"-") {
					b.conn.DelSet(s)
					break
				}
			}
		}
	}

	if otherContainerChains == 0 && b.fwdChain != nil {
		b.conn.DelChain(b.fwdChain)
		b.conn.DelTable(b.table)
		b.fwdChain = nil
		b.table = nil
	}

	return b.conn.Flush()
}

func parseInstanceChainName(name, prefix string) (shortID string, rsSub bool, ok bool) {
	if !strings.HasPrefix(name, prefix) {
		return "", false, false
	}
	rest := strings.TrimPrefix(name, prefix)
	if len(rest) < ContainerIDShortLen {
		return "", false, false
	}
	id := rest[:ContainerIDShortLen]
	if !isShortDockerID(id) {
		return "", false, false
	}
	tail := rest[ContainerIDShortLen:]
	if tail == "" {
		return id, false, true
	}
	if strings.HasPrefix(tail, "-") && len(tail) > 1 {
		return id, true, true
	}
	return "", false, false
}

func isShortDockerID(s string) bool {
	if len(s) != ContainerIDShortLen {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func (b *NFTablesBackend) nftContainerChain(containerID string) string {
	id := containerID
	if len(id) > ContainerIDShortLen {
		id = id[:ContainerIDShortLen]
	}
	name := strings.ToLower(b.chainName) + "-" + id
	if len(name) > 30 {
		name = name[:30]
	}
	return name
}

func (b *NFTablesBackend) perSourceLimitSetName(containerID, ruleSetName, family string) string {
	id := containerID
	if len(id) > ContainerIDShortLen {
		id = id[:ContainerIDShortLen]
	}
	base := fmt.Sprintf("rl-%s-%s-%s", id, ruleSetName, family)
	if len(base) <= 30 {
		return base
	}
	h := fnv.New32a()
	h.Write([]byte(ruleSetName))
	return fmt.Sprintf("rl-%s-%x-%s", id, h.Sum32(), family)
}

func (b *NFTablesBackend) addPerSourceLimitRules(
	rsChain *nftables.Chain,
	al net.IPNet,
	proto string,
	port uint16,
	containerID string,
	ruleSetName string,
	rl *docker.RateLimitConfig,
	logPrefix string,
	logEnabled bool,
) error {
	var (
		family       string
		keyType      nftables.SetDatatype
		saddrPayload *expr.Payload
	)
	if al.IP.To4() != nil {
		family = "v4"
		keyType = nftables.TypeIPAddr
		saddrPayload = &expr.Payload{DestRegister: 1, Base: expr.PayloadBaseNetworkHeader, Offset: 12, Len: 4}
	} else {
		family = "v6"
		keyType = nftables.TypeIP6Addr
		saddrPayload = &expr.Payload{DestRegister: 1, Base: expr.PayloadBaseNetworkHeader, Offset: 8, Len: 16}
	}

	setName := b.perSourceLimitSetName(containerID, ruleSetName, family)
	set := &nftables.Set{
		Name:       setName,
		Table:      b.table,
		KeyType:    keyType,
		Dynamic:    true,
		HasTimeout: true,
		Timeout:    time.Minute,
	}
	if err := b.conn.AddSet(set, nil); err != nil {
		return fmt.Errorf("add per-source limit set %q: %w", setName, err)
	}

	acceptExprs := srcNetMatchExprs(al)
	acceptExprs = append(acceptExprs, protoPortExprs(proto, port)...)
	acceptExprs = append(acceptExprs, saddrPayload)
	acceptExprs = append(acceptExprs, &expr.Dynset{
		SrcRegKey: 1,
		SetName:   setName,
		Operation: uint32(unix.NFT_DYNSET_OP_UPDATE),
		Timeout:   time.Minute,
		Exprs: []expr.Any{&expr.Limit{
			Type:  expr.LimitTypePkts,
			Rate:  uint64(rl.Rate),
			Unit:  expr.LimitTimeSecond,
			Burst: uint32(rl.Burst),
		}},
	})
	acceptExprs = append(acceptExprs, &expr.Counter{}, &expr.Verdict{Kind: expr.VerdictAccept})
	b.conn.AddRule(&nftables.Rule{Table: b.table, Chain: rsChain, Exprs: acceptExprs})

	dropExprs := srcNetMatchExprs(al)
	dropExprs = append(dropExprs, protoPortExprs(proto, port)...)
	if logEnabled {
		dropExprs = append(dropExprs, nflogExpr(logPrefix, "DROP"))
	}
	dropExprs = append(dropExprs, &expr.Counter{}, &expr.Verdict{Kind: expr.VerdictDrop})
	b.conn.AddRule(&nftables.Rule{Table: b.table, Chain: rsChain, Exprs: dropExprs})

	return nil
}

func (b *NFTablesBackend) nftRuleSetChain(containerID, setName string) string {
	id := containerID
	if len(id) > ContainerIDShortLen {
		id = id[:ContainerIDShortLen]
	}
	name := strings.ToLower(b.chainName) + "-" + id + "-" + setName
	if len(name) > 30 {
		h := fnv.New32a()
		h.Write([]byte(setName))
		suffix := fmt.Sprintf("%x", h.Sum32())
		prefix := strings.ToLower(b.chainName) + "-" + id + "-"
		available := 30 - len(prefix) - len(suffix) - 1
		if available < 0 {
			available = 0
		}
		truncated := setName
		if len(truncated) > available {
			truncated = truncated[:available]
		}
		name = prefix + truncated + "-" + suffix
	}
	return name
}

func (b *NFTablesBackend) ApplyContainerRules(
	containerID, containerName string,
	containerIPs []net.IP,
	ruleSets []docker.FirewallRuleSet,
	defaultPolicy string,
	autoAllowlist []net.IPNet,
) error {
	if err := b.RemoveContainerChains(containerID); err != nil {
		return fmt.Errorf("pre-cleanup existing nftables chains for %s: %w", containerID, err)
	}

	mainChainName := b.nftContainerChain(containerID)

	mainChain := b.conn.AddChain(&nftables.Chain{
		Name:  mainChainName,
		Table: b.table,
	})

	for _, ip := range containerIPs {
		exprs := dstIPMatchExprs(ip)
		exprs = append(exprs, &expr.Verdict{Kind: expr.VerdictJump, Chain: mainChainName})
		b.conn.AddRule(&nftables.Rule{Table: b.table, Chain: b.fwdChain, Exprs: exprs})
	}

	for _, rs := range ruleSets {
		rsChainName := b.nftRuleSetChain(containerID, rs.Name)
		rsChain := b.conn.AddChain(&nftables.Chain{Name: rsChainName, Table: b.table})

		allowlist := make([]net.IPNet, 0, len(rs.Allowlist)+len(autoAllowlist))
		for _, n := range rs.Allowlist {
			if n.IP != nil {
				allowlist = append(allowlist, n)
			}
		}
		allowlist = append(allowlist, autoAllowlist...)

		proto := rs.Protocol
		if proto == "" {
			proto = "tcp"
		}

		for _, port := range rs.Ports {
			for _, bl := range rs.Blocklist {
				if bl.IP == nil {
					continue
				}
				exprs := srcNetMatchExprs(bl)
				exprs = append(exprs, protoPortExprs(proto, port)...)
				if rs.Log {
					exprs = append(exprs, nflogExpr(rs.LogPrefix, "DROP"))
				}
				exprs = append(exprs, &expr.Counter{}, &expr.Verdict{Kind: expr.VerdictDrop})
				b.conn.AddRule(&nftables.Rule{Table: b.table, Chain: rsChain, Exprs: exprs})
			}

			for _, al := range allowlist {
				if rs.RateLimit != nil {
					if err := b.addPerSourceLimitRules(rsChain, al, proto, port, containerID, rs.Name, rs.RateLimit, rs.LogPrefix, rs.Log); err != nil {
						return fmt.Errorf("rate-limit rule for %s/%d: %w", rs.Name, port, err)
					}
				} else {
					exprs := srcNetMatchExprs(al)
					exprs = append(exprs, protoPortExprs(proto, port)...)
					if rs.Log {
						exprs = append(exprs, nflogExpr(rs.LogPrefix, "ACCEPT"))
					}
					exprs = append(exprs, &expr.Counter{}, &expr.Verdict{Kind: expr.VerdictAccept})
					b.conn.AddRule(&nftables.Rule{Table: b.table, Chain: rsChain, Exprs: exprs})
				}
			}

			if len(allowlist) > 0 {
				exprs := protoPortExprs(proto, port)
				if rs.Log {
					exprs = append(exprs, nflogExpr(rs.LogPrefix, "DROP"))
				}
				exprs = append(exprs, &expr.Counter{}, &expr.Verdict{Kind: expr.VerdictDrop})
				b.conn.AddRule(&nftables.Rule{Table: b.table, Chain: rsChain, Exprs: exprs})
			}
		}

		b.conn.AddRule(&nftables.Rule{
			Table: b.table, Chain: rsChain,
			Exprs: []expr.Any{&expr.Verdict{Kind: expr.VerdictReturn}},
		})

		b.conn.AddRule(&nftables.Rule{
			Table: b.table, Chain: mainChain,
			Exprs: []expr.Any{&expr.Verdict{Kind: expr.VerdictJump, Chain: rsChainName}},
		})
	}

	var verdict expr.VerdictKind

	switch strings.ToUpper(defaultPolicy) {
	case "ACCEPT":
		verdict = expr.VerdictAccept
	case "RETURN":
		verdict = expr.VerdictReturn
	default:
		verdict = expr.VerdictDrop
	}
	b.conn.AddRule(&nftables.Rule{
		Table: b.table, Chain: mainChain,
		Exprs: []expr.Any{&expr.Counter{}, &expr.Verdict{Kind: verdict}},
	})

	return b.conn.Flush()
}

func (b *NFTablesBackend) RemoveContainerChains(containerID string) error {
	mainChain := b.nftContainerChain(containerID)
	subPrefix := mainChain + "-"

	rules, err := b.conn.GetRules(b.table, b.fwdChain)
	if err == nil {
		for _, r := range rules {
			for _, e := range r.Exprs {
				if v, ok := e.(*expr.Verdict); ok && v.Chain == mainChain {
					_ = b.conn.DelRule(r)
					break
				}
			}
		}
	}

	chains, err := b.conn.ListChainsOfTableFamily(nftables.TableFamilyINet)
	if err == nil {
		for _, ch := range chains {
			if ch.Table == nil || ch.Table.Name != nftTableName {
				continue
			}
			if ch.Name == mainChain || strings.HasPrefix(ch.Name, subPrefix) {
				b.conn.DelChain(ch)
			}
		}
	}

	shortID := containerID
	if len(shortID) > ContainerIDShortLen {
		shortID = shortID[:ContainerIDShortLen]
	}
	setPrefix := "rl-" + shortID + "-"
	if sets, err := b.conn.GetSets(b.table); err == nil {
		for _, s := range sets {
			if strings.HasPrefix(s.Name, setPrefix) {
				b.conn.DelSet(s)
			}
		}
	}

	return b.conn.Flush()
}

func (b *NFTablesBackend) Healthy() (HealthReport, error) {
	report := HealthReport{Backend: "nftables"}

	tables, err := b.conn.ListTables()
	if err != nil {
		return report, fmt.Errorf("list nftables tables: %w", err)
	}
	var table *nftables.Table
	for _, t := range tables {
		if t.Family == nftables.TableFamilyINet && t.Name == nftTableName {
			table = t
			break
		}
	}
	if table == nil {
		report.Notes = append(report.Notes, "firefik table absent — traffic bypasses firefik")
		return report, nil
	}

	chains, err := b.conn.ListChainsOfTableFamily(nftables.TableFamilyINet)
	if err != nil {
		return report, fmt.Errorf("list nftables chains: %w", err)
	}
	prefix := strings.ToLower(b.chainName) + "-"
	for _, ch := range chains {
		if ch.Table == nil || ch.Table.Name != nftTableName {
			continue
		}
		if ch.Name == "forward" {
			report.BaseChainPresent = true
			report.ParentJumpPresent = true
			continue
		}
		if strings.HasPrefix(ch.Name, prefix) {
			report.ContainerChainCount++
		}
	}
	if !report.BaseChainPresent {
		report.Notes = append(report.Notes, "base forward chain absent in firefik table")
	}
	return report, nil
}

func (b *NFTablesBackend) ListAppliedContainerIDs() ([]string, error) {
	chains, err := b.conn.ListChainsOfTableFamily(nftables.TableFamilyINet)
	if err != nil {
		return nil, fmt.Errorf("list nftables chains: %w", err)
	}
	prefix := strings.ToLower(b.chainName) + "-"
	seen := make(map[string]struct{})
	for _, ch := range chains {
		if ch.Table == nil || ch.Table.Name != nftTableName {
			continue
		}
		id, _, ok := parseInstanceChainName(ch.Name, prefix)
		if !ok {
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

func DetectBackendType() string {
	c, err := nftables.New()
	if err != nil {
		return "iptables"
	}
	if _, err := c.ListChains(); err != nil {
		return "iptables"
	}
	return "nftables"
}

func dstIPMatchExprs(ip net.IP) []expr.Any {
	if ip4 := ip.To4(); ip4 != nil {
		return []expr.Any{
			&expr.Meta{Key: expr.MetaKeyNFPROTO, Register: 1},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{unix.NFPROTO_IPV4}},
			&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseNetworkHeader, Offset: 16, Len: 4},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: ip4},
		}
	}
	ip6 := ip.To16()
	return []expr.Any{
		&expr.Meta{Key: expr.MetaKeyNFPROTO, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{unix.NFPROTO_IPV6}},
		&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseNetworkHeader, Offset: 24, Len: 16},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: ip6},
	}
}

func srcNetMatchExprs(n net.IPNet) []expr.Any {
	if ip4 := n.IP.To4(); ip4 != nil {
		mask := []byte(n.Mask)
		if len(mask) == 16 {
			mask = mask[12:]
		}
		return []expr.Any{
			&expr.Meta{Key: expr.MetaKeyNFPROTO, Register: 1},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{unix.NFPROTO_IPV4}},
			&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseNetworkHeader, Offset: 12, Len: 4},
			&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 4, Mask: mask, Xor: []byte{0, 0, 0, 0}},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: ip4.Mask(n.Mask)},
		}
	}
	ip6 := n.IP.To16()
	mask := []byte(n.Mask)
	if len(mask) == 4 {
		full := make(net.IPMask, 16)
		copy(full[12:], mask)
		mask = full
	}
	return []expr.Any{
		&expr.Meta{Key: expr.MetaKeyNFPROTO, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{unix.NFPROTO_IPV6}},
		&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseNetworkHeader, Offset: 8, Len: 16},
		&expr.Bitwise{SourceRegister: 1, DestRegister: 1, Len: 16, Mask: mask, Xor: make([]byte, 16)},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: ip6.Mask(n.Mask)},
	}
}

func nflogExpr(logPrefix, actionType string) *expr.Log {
	prefix := logPrefix
	if prefix == "" {
		prefix = "FIREFIK " + actionType
	}
	if len(prefix) > LogPrefixMaxLen {
		prefix = prefix[:LogPrefixMaxLen]
	}
	return &expr.Log{
		Key:   (1 << unix.NFTA_LOG_PREFIX) | (1 << unix.NFTA_LOG_GROUP),
		Group: uint16(NflogGroup),
		Data:  []byte(prefix),
	}
}

func protoPortExprs(proto string, port uint16) []expr.Any {
	var protoNum uint8
	if strings.ToLower(proto) == "udp" {
		protoNum = unix.IPPROTO_UDP
	} else {
		protoNum = unix.IPPROTO_TCP
	}
	portBytes := make([]byte, 2)
	binary.BigEndian.PutUint16(portBytes, port)
	return []expr.Any{
		&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{protoNum}},
		&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseTransportHeader, Offset: 2, Len: 2},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: portBytes},
	}
}
