package rules

import (
	"strings"
	"testing"
)

func TestNflogPrefix(t *testing.T) {
	cases := []struct {
		action, label, want string
	}{
		{"DROP", "", "FIREFIK DROP"},
		{"accept", "web", "FIREFIK ACCEPT web"},
		{"DROP", "web-public@v4", "FIREFIK DROP web-public@v4"},
		{"DROP", "host  ssh", "FIREFIK DROP host ssh"},
		{"DROP", "bad*&^chars", "FIREFIK DROP badchars"},
	}
	for _, tc := range cases {
		if got := NflogPrefix(tc.action, tc.label); got != tc.want {
			t.Errorf("NflogPrefix(%q, %q) = %q, want %q", tc.action, tc.label, got, tc.want)
		}
	}
	if got := NflogPrefix("DROP", strings.Repeat("a", 200)); len(got) != LogPrefixMaxLen {
		t.Errorf("expected truncation to %d, got %d", LogPrefixMaxLen, len(got))
	}
}

func TestLogLabels(t *testing.T) {
	if got := ruleLogLabel("", "web"); got != "web" {
		t.Errorf("rule label default: %q", got)
	}
	if got := ruleLogLabel(" custom ", "web"); got != "custom" {
		t.Errorf("rule label custom: %q", got)
	}
	if got := hostLogLabel("", "ssh"); got != "host ssh" {
		t.Errorf("host label default: %q", got)
	}
	if got := hostLogLabel("edge", "ssh"); got != "edge" {
		t.Errorf("host label custom: %q", got)
	}
}
