//go:build !linux

package rules

import (
	"fmt"
	"net"

	"firefik/internal/docker"
)

type IPTablesBackend struct{}

var _ Backend = (*IPTablesBackend)(nil)

func NewIPTablesBackend(chainName, parentChain string) (*IPTablesBackend, error) {
	return nil, fmt.Errorf("iptables backend is only supported on Linux")
}

func NewIP6TablesBackend(chainName, parentChain string) (*IPTablesBackend, error) {
	return nil, fmt.Errorf("ip6tables backend is only supported on Linux")
}

func (b *IPTablesBackend) SetupChains() error                  { return nil }
func (b *IPTablesBackend) Cleanup() error                      { return nil }
func (b *IPTablesBackend) SetStateful(v bool)                  {}
func (b *IPTablesBackend) SetDefaultDropLogRate(perSecond int) {}

func (b *IPTablesBackend) ApplyContainerRules(
	containerID, containerName string,
	containerIPs []net.IP,
	ruleSets []docker.FirewallRuleSet,
	defaultPolicy string,
	autoAllowlist []net.IPNet,
) error {
	return nil
}

func (b *IPTablesBackend) RemoveContainerChains(containerID string) error { return nil }

func (b *IPTablesBackend) ApplyHostRules(rules []HostRule, defaultPolicy string) error { return nil }

func (b *IPTablesBackend) RemoveHostChain() error { return nil }

func (b *IPTablesBackend) ListAppliedContainerIDs() ([]string, error) { return nil, nil }

func (b *IPTablesBackend) Healthy() (HealthReport, error) {
	return HealthReport{Backend: "iptables", Notes: []string{"non-linux build — kernel state unavailable"}}, nil
}
