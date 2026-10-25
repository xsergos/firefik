package rules

import (
	"testing"

	"firefik/internal/config"
	"firefik/internal/docker"
)

func TestApplyTemplates_NoLabel(t *testing.T) {
	templates := map[string]config.RuleTemplate{
		"web": {Name: "web", Ports: []uint16{80}},
	}
	base := docker.ContainerConfig{Enable: true}
	got := ApplyTemplates(base, map[string]string{}, templates)
	if len(got.RuleSets) != 0 {
		t.Errorf("no template label should add no rule-sets: %+v", got.RuleSets)
	}
}

func TestApplyTemplates_SingleAndStack(t *testing.T) {
	templates := map[string]config.RuleTemplate{
		"web": {Name: "web", Version: "abcd1234ef567890", Ports: []uint16{80, 443}, Protocol: "tcp"},
		"ssh": {Name: "ssh", Version: "1111222233334444", Ports: []uint16{22}, Protocol: "tcp", Log: true},
	}
	base := docker.ContainerConfig{Enable: true}

	single := ApplyTemplates(base, map[string]string{config.TemplateLabel: "web"}, templates)
	if len(single.RuleSets) != 1 || single.RuleSets[0].Name != "tpl:web@abcd1234ef567890" {
		t.Errorf("single template: %+v", single.RuleSets)
	}

	stack := ApplyTemplates(base, map[string]string{config.TemplateLabel: "web,ssh"}, templates)
	if len(stack.RuleSets) != 2 {
		t.Errorf("stack: want 2 rule-sets, got %d", len(stack.RuleSets))
	}
	if !stack.RuleSets[1].Log {
		t.Errorf("ssh template should propagate Log=true")
	}
}

func TestApplyTemplates_MissingTemplateIgnored(t *testing.T) {
	templates := map[string]config.RuleTemplate{
		"web": {Name: "web", Version: "v1", Ports: []uint16{80}},
	}
	got := ApplyTemplates(docker.ContainerConfig{Enable: true},
		map[string]string{config.TemplateLabel: "web,does-not-exist"}, templates)
	if len(got.RuleSets) != 1 {
		t.Errorf("missing template should be skipped silently, got %d rule-sets", len(got.RuleSets))
	}
}

func TestParseRatelimitLenient(t *testing.T) {
	cases := map[string]struct {
		ok    bool
		rate  uint
		burst uint
	}{
		"100/s":         {true, 100, 200},
		"50":            {true, 50, 100},
		"30/s,burst=60": {true, 30, 60},
		"4294967295/s":  {true, 4294967295, 4294967295},
		"":              {false, 0, 0},
		"abc":           {false, 0, 0},
	}
	for in, want := range cases {
		got := parseRatelimitLenient(in)
		if !want.ok {
			if got != nil {
				t.Errorf("%q should parse as nil, got %+v", in, got)
			}
			continue
		}
		if got == nil || got.Rate != want.rate || got.Burst != want.burst {
			t.Errorf("%q: got %+v, want rate=%d burst=%d", in, got, want.rate, want.burst)
		}
	}
}

func TestParseCIDRLenient(t *testing.T) {
	cases := map[string]bool{
		"10.0.0.0/8":    true,
		"192.168.1.1":   true,
		"::1":           true,
		"2001:db8::/32": true,
		"":              false,
		"garbage":       false,
	}
	for in, want := range cases {
		got := parseCIDRLenient(in)
		if (got != nil) != want {
			t.Errorf("%q: got non-nil=%v, want=%v", in, got != nil, want)
		}
	}
}
