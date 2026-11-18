package main

import (
	"io"
	"log/slog"
	"testing"
	"time"

	"firefik/internal/audit"
	"firefik/internal/config"
)

func TestCPAuditBridge(t *testing.T) {
	b := newCPAuditBridge()
	ev := audit.Event{
		Timestamp:     time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC),
		Action:        "apply",
		Source:        audit.Source("api"),
		ContainerID:   "abc",
		ContainerName: "web",
		RuleSets:      2,
		DefaultPolicy: "DROP",
		Metadata:      map[string]string{"policy": "web-public", "action": "spoofed"},
	}
	if err := b.Write(ev); err != nil {
		t.Fatal(err)
	}
	got := <-b.Audits()
	if got["action"] != "apply" || got["container_name"] != "web" || got["rule_sets"] != "2" || got["policy"] != "web-public" {
		t.Fatalf("unexpected map: %+v", got)
	}
	if got["ts"] != "2026-11-18T10:00:00Z" {
		t.Fatalf("ts = %v", got["ts"])
	}
	for i := 0; i < 300; i++ {
		_ = b.Write(ev)
	}
	if len(b.Audits()) != cap(b.out) {
		t.Fatalf("bridge should drop when full, len=%d", len(b.Audits()))
	}
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestBuildAuditSinkAlwaysKeepsHistory(t *testing.T) {
	cfg := &config.Config{}
	hist := audit.NewHistoryBuffer(10)
	s, err := buildAuditSink(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), "v", hist)
	if err != nil || s == nil {
		t.Fatalf("expected history sink, got %v %v", s, err)
	}
	_ = s.Write(audit.Event{Action: "apply"})
	if len(hist.Snapshot()) != 1 {
		t.Fatal("history buffer did not receive the event")
	}
}
