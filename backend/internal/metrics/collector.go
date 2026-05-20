//go:build linux

package metrics

import (
	"strings"

	"github.com/coreos/go-iptables/iptables"
	"github.com/prometheus/client_golang/prometheus"
)

type IPTablesCollector struct {
	ipt       *iptables.IPTables
	chainName string

	packetsDesc *prometheus.Desc
	bytesDesc   *prometheus.Desc
}

func NewIPTablesCollector(chainName string) (*IPTablesCollector, error) {
	ipt, err := iptables.New()
	if err != nil {
		return nil, err
	}
	c := &IPTablesCollector{
		ipt:       ipt,
		chainName: chainName,
		packetsDesc: prometheus.NewDesc(
			"firefik_chain_packets_total",
			"Total packets matched by a firefik iptables chain rule.",
			[]string{"chain", "target"},
			nil,
		),
		bytesDesc: prometheus.NewDesc(
			"firefik_chain_bytes_total",
			"Total bytes matched by a firefik iptables chain rule.",
			[]string{"chain", "target"},
			nil,
		),
	}
	prometheus.MustRegister(c)
	return c, nil
}

func (c *IPTablesCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.packetsDesc
	ch <- c.bytesDesc
}

func (c *IPTablesCollector) Collect(ch chan<- prometheus.Metric) {
	chains, err := c.ipt.ListChains("filter")
	if err != nil {
		return
	}
	for _, chain := range chains {
		if !strings.HasPrefix(chain, c.chainName) {
			continue
		}
		stats, err := c.ipt.Stats("filter", chain)
		if err != nil {
			continue
		}
		totals := map[string][2]float64{}
		for _, row := range stats {
			if len(row) < 3 {
				continue
			}
			target := row[2]
			if target == "" {
				target = "unknown"
			}

			t := totals[target]
			totals[target] = [2]float64{t[0] + parseCounter(row[0]), t[1] + parseCounter(row[1])}
		}

		for target, t := range totals {
			ch <- prometheus.MustNewConstMetric(c.packetsDesc, prometheus.CounterValue, t[0], chain, target)
			ch <- prometheus.MustNewConstMetric(c.bytesDesc, prometheus.CounterValue, t[1], chain, target)
		}
	}
}

func parseCounter(s string) float64 {
	s = strings.TrimSpace(s)
	multiplier := 1.0
	if strings.HasSuffix(s, "G") {
		multiplier = 1e9
		s = s[:len(s)-1]
	} else if strings.HasSuffix(s, "M") {
		multiplier = 1e6
		s = s[:len(s)-1]
	} else if strings.HasSuffix(s, "K") {
		multiplier = 1e3
		s = s[:len(s)-1]
	}
	var v float64
	for _, c := range s {
		if c >= '0' && c <= '9' {
			v = v*10 + float64(c-'0')
		}
	}
	return v * multiplier
}
