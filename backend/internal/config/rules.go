package config

import (
	"bytes"
	"fmt"
	"net"
	"os"
	"strings"

	"github.com/goccy/go-yaml"
)

type FileRuleSet struct {
	Container     string   `yaml:"container"`
	Name          string   `yaml:"name"`
	Ports         []uint16 `yaml:"ports"`
	Allowlist     []string `yaml:"allowlist"`
	Blocklist     []string `yaml:"blocklist"`
	DefaultPolicy string   `yaml:"defaultPolicy"`
	Protocol      string   `yaml:"protocol"`
	Profile       string   `yaml:"profile"`
	Log           bool     `yaml:"log"`
	LogPrefix     string   `yaml:"logPrefix"`
}

type FileHostRuleSet struct {
	Name      string   `yaml:"name"`
	Protocol  string   `yaml:"protocol"`
	Ports     []uint16 `yaml:"ports"`
	Allowlist []string `yaml:"allowlist"`
	Blocklist []string `yaml:"blocklist"`
	Log       bool     `yaml:"log"`
	LogPrefix string   `yaml:"logPrefix"`
}

type RulesFile struct {
	Rules       []FileRuleSet     `yaml:"rules"`
	HostRules   []FileHostRuleSet `yaml:"host_rules"`
	HostDefault string            `yaml:"host_default"`
}

func LoadRulesFile(path string) (RulesFile, error) {
	if path == "" {
		return RulesFile{}, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return RulesFile{}, nil
		}
		return RulesFile{}, fmt.Errorf("read rules file %q: %w", path, err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return RulesFile{}, nil
	}
	var rf RulesFile
	if err := yaml.Unmarshal(data, &rf); err != nil {
		return RulesFile{}, fmt.Errorf("parse rules file %q: %w", path, err)
	}
	return rf, nil
}

func ParseFileAllowlist(entries []string) ([]net.IPNet, []error) {
	var nets []net.IPNet
	var errs []error
	for _, e := range entries {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		if !strings.Contains(e, "/") {
			if strings.Contains(e, ":") {
				e = e + "/128"
			} else {
				e = e + "/32"
			}
		}
		_, ipNet, err := net.ParseCIDR(e)
		if err != nil {
			errs = append(errs, fmt.Errorf("invalid allowlist entry %q: %w", e, err))
			continue
		}
		nets = append(nets, *ipNet)
	}
	return nets, errs
}
