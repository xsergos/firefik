//go:build !linux

package rules

import (
	"fmt"
	"log/slog"
	"net"

	"firefik/internal/docker"
)

type NFTablesBackend struct{}

var _ Backend = (*NFTablesBackend)(nil)

func NewNFTablesBackend(chainName string, _ *slog.Logger) (*NFTablesBackend, error) {
	return nil, fmt.Errorf("nftables backend is only supported on Linux")
}

func (b *NFTablesBackend) SetupChains() error                  { return nil }
func (b *NFTablesBackend) Cleanup() error                      { return nil }
func (b *NFTablesBackend) SetStateful(v bool)                  {}
func (b *NFTablesBackend) SetDefaultDropLogRate(perSecond int) {}

func (b *NFTablesBackend) ApplyContainerRules(
	containerID, containerName string,
	containerIPs []net.IP,
	ruleSets []docker.FirewallRuleSet,
	defaultPolicy string,
	autoAllowlist []net.IPNet,
) error {
	return nil
}

func (b *NFTablesBackend) RemoveContainerChains(containerID string) error { return nil }

func (b *NFTablesBackend) ApplyHostRules(rules []HostRule, defaultPolicy string) error { return nil }

func (b *NFTablesBackend) RemoveHostChain() error { return nil }

func (b *NFTablesBackend) ListAppliedContainerIDs() ([]string, error) { return nil, nil }

func (b *NFTablesBackend) Healthy() (HealthReport, error) {
	return HealthReport{Backend: "nftables", Notes: []string{"non-linux build — kernel state unavailable"}}, nil
}

func DetectBackendType() string { return "iptables" }
