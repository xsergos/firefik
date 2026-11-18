package main

import (
	"strconv"
	"time"

	"firefik/internal/audit"
)

type cpAuditBridge struct {
	out chan map[string]any
}

func newCPAuditBridge() *cpAuditBridge {
	return &cpAuditBridge{out: make(chan map[string]any, 256)}
}

func (b *cpAuditBridge) Audits() <-chan map[string]any { return b.out }

func (b *cpAuditBridge) Write(ev audit.Event) error {
	select {
	case b.out <- auditEventToMap(ev):
	default:
	}
	return nil
}

func (b *cpAuditBridge) Close() error { return nil }

func auditEventToMap(ev audit.Event) map[string]any {
	ts := ev.Timestamp
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	m := map[string]any{
		"ts":     ts.UTC().Format(time.RFC3339Nano),
		"action": ev.Action,
		"source": string(ev.Source),
	}
	if ev.ContainerID != "" {
		m["container_id"] = ev.ContainerID
	}
	if ev.ContainerName != "" {
		m["container_name"] = ev.ContainerName
	}
	if ev.RuleSets > 0 {
		m["rule_sets"] = strconv.Itoa(ev.RuleSets)
	}
	if ev.DefaultPolicy != "" {
		m["default_policy"] = ev.DefaultPolicy
	}
	for k, v := range ev.Metadata {
		if _, taken := m[k]; !taken {
			m[k] = v
		}
	}
	return m
}
