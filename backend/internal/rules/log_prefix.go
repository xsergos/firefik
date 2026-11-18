package rules

import (
	"regexp"
	"strings"
)

const (
	NflogTag              = "FIREFIK"
	DefaultPolicyLogLabel = "default"
	HostLogLabelPrefix    = "host"
	DefaultDropLogRate    = 10
)

var safePrefixRe = regexp.MustCompile(`[^A-Za-z0-9 _\-@.:]`)

func NflogPrefix(action, label string) string {
	prefix := NflogTag + " " + strings.ToUpper(action)
	label = strings.Join(strings.Fields(safePrefixRe.ReplaceAllString(label, "")), " ")
	if label != "" {
		prefix += " " + label
	}
	if len(prefix) > LogPrefixMaxLen {
		prefix = prefix[:LogPrefixMaxLen]
	}
	return prefix
}

func ruleLogLabel(customPrefix, ruleName string) string {
	if p := strings.TrimSpace(customPrefix); p != "" {
		return p
	}
	return ruleName
}

func hostLogLabel(customPrefix, ruleName string) string {
	if p := strings.TrimSpace(customPrefix); p != "" {
		return p
	}
	return HostLogLabelPrefix + " " + ruleName
}
