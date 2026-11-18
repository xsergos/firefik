package controlplane

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func backdateMemAgent(t *testing.T, store Store, id string, ago time.Duration) {
	t.Helper()
	m := store.(*memStore)
	m.mu.Lock()
	defer m.mu.Unlock()
	rec := m.agents[id]
	rec.LastSeen = time.Now().UTC().Add(-ago)
	m.agents[id] = rec
}

func TestHTTP_AgentDelete_RejectsHealthy(t *testing.T) {
	srv, store := newTestHTTPServer(t)
	if err := store.UpsertAgent(context.Background(), AgentIdentity{InstanceID: "host-a", Hostname: "host-a"}); err != nil {
		t.Fatal(err)
	}
	rec := doReq(t, srv.Handler(), http.MethodDelete, "/v1/agents/host-a", "", "secret")
	if rec.Code != http.StatusConflict {
		t.Fatalf("got %d want 409 body=%s", rec.Code, rec.Body.String())
	}
	if _, ok, _ := store.GetAgent(context.Background(), "host-a"); !ok {
		t.Fatal("healthy agent must not be deleted")
	}
}

func TestHTTP_AgentDelete_RemovesDeadAgent(t *testing.T) {
	srv, store := newTestHTTPServer(t)
	audit := &recordingAudit{}
	srv.Audit = audit
	ctx := context.Background()
	id := AgentIdentity{InstanceID: "sl-jump-01", Hostname: "sl-jump-01"}
	if err := store.RecordSnapshot(ctx, AgentSnapshot{Agent: id, At: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	srv.Registry.Enqueue("sl-jump-01", Command{ID: "c1", Kind: CommandReconcile})
	backdateMemAgent(t, store, "sl-jump-01", time.Hour)

	rec := doReq(t, srv.Handler(), http.MethodDelete, "/v1/agents/sl-jump-01", "", "secret")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("got %d want 204 body=%s", rec.Code, rec.Body.String())
	}
	if _, ok, _ := store.GetAgent(ctx, "sl-jump-01"); ok {
		t.Fatal("agent still in store")
	}
	if snap, _ := store.LatestSnapshot(ctx, "sl-jump-01"); snap != nil {
		t.Fatal("snapshot not removed")
	}
	if cmds, _ := store.TakeCommands(ctx, "sl-jump-01"); len(cmds) != 0 {
		t.Fatalf("pending commands not removed: %+v", cmds)
	}
	for _, a := range srv.Registry.Agents() {
		if a.Identity.InstanceID == "sl-jump-01" {
			t.Fatal("agent still in registry")
		}
	}
	if len(audit.events) != 1 || audit.events[0].action != "agent_deleted" || audit.events[0].meta["agent_id"] != "sl-jump-01" {
		t.Fatalf("audit not emitted: %+v", audit.events)
	}

	rec = doReq(t, srv.Handler(), http.MethodGet, "/v1/agents/sl-jump-01", "", "secret")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d want 404 after delete", rec.Code)
	}
}

func TestHTTP_AgentDelete_NotFound(t *testing.T) {
	srv, _ := newTestHTTPServer(t)
	rec := doReq(t, srv.Handler(), http.MethodDelete, "/v1/agents/missing", "", "secret")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d want 404", rec.Code)
	}
}

func TestHTTP_AgentDelete_RequiresAuth(t *testing.T) {
	srv, _ := newTestHTTPServer(t)
	rec := doReq(t, srv.Handler(), http.MethodDelete, "/v1/agents/host-a", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401", rec.Code)
	}
}

func TestSQLiteStore_DeleteAgent(t *testing.T) {
	ctx := context.Background()
	s, err := NewSQLiteStore(ctx, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	id := AgentIdentity{InstanceID: "ptv-01", Hostname: "ptv-01"}
	if err := s.RecordSnapshot(ctx, AgentSnapshot{Agent: id, At: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	if err := s.EnqueueCommand(ctx, "ptv-01", Command{ID: "c1", Kind: CommandReconcile}); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordProposals(ctx, []AutogenProposal{{AgentID: "ptv-01", ContainerID: "c1"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordAudit(ctx, "ptv-01", "rule_applied", map[string]any{"x": 1}, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertAgent(ctx, AgentIdentity{InstanceID: "keep", Hostname: "keep"}); err != nil {
		t.Fatal(err)
	}

	removed, err := s.DeleteAgent(ctx, "ptv-01")
	if err != nil || !removed {
		t.Fatalf("DeleteAgent = %v, %v", removed, err)
	}
	if _, ok, _ := s.GetAgent(ctx, "ptv-01"); ok {
		t.Fatal("agent row left")
	}
	if snap, _ := s.LatestSnapshot(ctx, "ptv-01"); snap != nil {
		t.Fatal("snapshot left")
	}
	if cmds, _ := s.TakeCommands(ctx, "ptv-01"); len(cmds) != 0 {
		t.Fatalf("commands left: %+v", cmds)
	}
	if props, _ := s.ListProposals(ctx, "ptv-01"); len(props) != 0 {
		t.Fatalf("proposals left: %+v", props)
	}
	if events, _ := s.ListAuditEvents(ctx, "ptv-01", 10); len(events) != 1 {
		t.Fatalf("audit history must be kept, got %d", len(events))
	}
	if _, ok, _ := s.GetAgent(ctx, "keep"); !ok {
		t.Fatal("unrelated agent removed")
	}

	removed, err = s.DeleteAgent(ctx, "ptv-01")
	if err != nil || removed {
		t.Fatalf("second DeleteAgent = %v, %v", removed, err)
	}
}
