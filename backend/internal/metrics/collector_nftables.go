//go:build linux

package metrics

import (
	"strings"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"github.com/prometheus/client_golang/prometheus"
)

const nftTableName = "firefik"

type NFTablesCollector struct {
	conn      *nftables.Conn
	chainName string

	packetsDesc *prometheus.Desc
	bytesDesc   *prometheus.Desc
}

func NewNFTablesCollector(chainName string) (*NFTablesCollector, error) {
	conn, err := nftables.New()
	if err != nil {
		return nil, err
	}
	c := &NFTablesCollector{
		conn:      conn,
		chainName: chainName,
		packetsDesc: prometheus.NewDesc(
			"firefik_chain_packets_total",
			"Total packets matched by a firefik nftables chain rule.",
			[]string{"chain", "target"},
			nil,
		),
		bytesDesc: prometheus.NewDesc(
			"firefik_chain_bytes_total",
			"Total bytes matched by a firefik nftables chain rule.",
			[]string{"chain", "target"},
			nil,
		),
	}
	prometheus.MustRegister(c)
	return c, nil
}

func (c *NFTablesCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.packetsDesc
	ch <- c.bytesDesc
}

func (c *NFTablesCollector) Collect(ch chan<- prometheus.Metric) {
	chains, err := c.conn.ListChainsOfTableFamily(nftables.TableFamilyINet)
	if err != nil {
		return
	}

	prefix := strings.ToLower(c.chainName)

	for _, chain := range chains {
		if chain.Table == nil || chain.Table.Name != nftTableName {
			continue
		}
		if !strings.HasPrefix(chain.Name, prefix) {
			continue
		}

		rules, err := c.conn.GetRules(chain.Table, chain)
		if err != nil {
			continue
		}

		totals := map[string][2]uint64{}
		for _, rule := range rules {
			var packets, bytes uint64
			var target string

			for _, e := range rule.Exprs {
				switch v := e.(type) {
				case *expr.Counter:
					packets = v.Packets
					bytes = v.Bytes
				case *expr.Verdict:
					switch v.Kind {
					case expr.VerdictAccept:
						target = "ACCEPT"
					case expr.VerdictDrop:
						target = "DROP"
					case expr.VerdictReturn:
						target = "RETURN"
					case expr.VerdictJump:
						target = "JUMP"
					default:
						target = "OTHER"
					}
				}
			}

			if target == "" || target == "JUMP" {
				continue
			}

			t := totals[target]
			totals[target] = [2]uint64{t[0] + packets, t[1] + bytes}
		}

		for target, t := range totals {
			ch <- prometheus.MustNewConstMetric(c.packetsDesc, prometheus.CounterValue, float64(t[0]), chain.Name, target)
			ch <- prometheus.MustNewConstMetric(c.bytesDesc, prometheus.CounterValue, float64(t[1]), chain.Name, target)
		}
	}
}
