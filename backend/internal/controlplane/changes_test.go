package controlplane

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func historyFor(t *testing.T, srv *HTTPServer) []auditEventDTO {
	t.Helper()
	rec := doReq(t, srv.Handler(), http.MethodGet, "/v1/audit/history?limit=50", "", "secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("history: %d %s", rec.Code, rec.Body.String())
	}
	var out []auditEventDTO
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func findEvent(events []auditEventDTO, action string) *auditEventDTO {
	for i := range events {
		if events[i].Action == action {
			return &events[i]
		}
	}
	return nil
}

func TestRecordChange_PolicySaveStoresActorAndVersions(t *testing.T) {
	srv, _ := newTestHTTPServer(t)
	h := srv.Handler()
	save := func(dsl, comment string) {
		body, _ := json.Marshal(map[string]any{"dsl": dsl, "comment": comment})
		req := httptest.NewRequest(http.MethodPut, "/v1/policies/web", strings.NewReader(string(body)))
		req.Header.Set("Authorization", "Bearer secret")
		req.Header.Set("X-Forwarded-For", "198.51.100.7")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
		}
	}
	save(`policy "web" { allow if port == 80 }`, "first")
	time.Sleep(10 * time.Millisecond)
	save(`policy "web" { allow if port in [80, 443] }`, "add tls")
	save(`policy "web" { allow if port in [80, 443] }`, "no-op resave")

	events := historyFor(t, srv)
	saved := 0
	for _, ev := range events {
		if ev.Action == "policy_saved" {
			saved++
		}
	}
	if saved != 2 {
		t.Fatalf("expected 2 policy_saved events (identical resave skipped), got %d: %+v", saved, events)
	}
	latest := findEvent(events, "policy_saved")
	if latest.Actor == "" || !strings.Contains(latest.Actor, "198.51.100.7") {
		t.Fatalf("actor not recorded: %+v", latest)
	}
	if latest.Metadata["policy_name"] != "web" || latest.Metadata["previous_version"] == "" || latest.Metadata["comment"] != "add tls" {
		t.Fatalf("metadata: %+v", latest.Metadata)
	}

	rec := doReq(t, h, http.MethodGet, "/v1/policies/web/versions", "", "secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("versions: %d %s", rec.Code, rec.Body.String())
	}
	var versions []policyVersionDTO
	_ = json.Unmarshal(rec.Body.Bytes(), &versions)
	if len(versions) != 2 || !strings.Contains(versions[0].DSL, "443") || versions[1].Comment != "first" {
		t.Fatalf("versions: %+v", versions)
	}
	if !strings.Contains(versions[0].Author, "198.51.100.7") {
		t.Fatalf("author should default to the caller, got %q", versions[0].Author)
	}
}

func TestRecordChange_AgentDeleteAndTokens(t *testing.T) {
	srv, store := newTestHTTPServer(t)
	ctx := context.Background()
	_ = store.UpsertAgent(ctx, AgentIdentity{InstanceID: "old", Hostname: "old"})
	backdateMemAgent(t, store, "old", time.Hour)

	if rec := doReq(t, srv.Handler(), http.MethodDelete, "/v1/agents/old", "", "secret"); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Code)
	}
	rec := doReq(t, srv.Handler(), http.MethodPost, "/v1/agent-tokens", `{"name":"edge-1"}`, "secret")
	if rec.Code != http.StatusCreated {
		t.Fatalf("token create: %d %s", rec.Code, rec.Body.String())
	}
	var issued AgentTokenIssued
	_ = json.Unmarshal(rec.Body.Bytes(), &issued)
	if rec := doReq(t, srv.Handler(), http.MethodDelete, "/v1/agent-tokens/"+issued.ID, "", "secret"); rec.Code != http.StatusNoContent {
		t.Fatalf("token revoke: %d", rec.Code)
	}

	events := historyFor(t, srv)
	del := findEvent(events, "agent_deleted")
	if del == nil || del.AgentID != "old" || del.Source != "panel" || del.Actor == "" {
		t.Fatalf("agent_deleted: %+v", del)
	}
	revoked := findEvent(events, "agent_token_revoked")
	if revoked == nil || revoked.Metadata["name"] != "edge-1" {
		t.Fatalf("agent_token_revoked: %+v", revoked)
	}
	if findEvent(events, "agent_token_created") == nil {
		t.Fatal("agent_token_created missing")
	}
}

func TestHTTP_PanelConfig(t *testing.T) {
	srv, _ := newTestHTTPServer(t)
	srv.PanelConfig = PanelConfig{EnrollURL: "https://fw.example", GRPCEndpoint: "fw.example:8444"}
	rec := doReq(t, srv.Handler(), http.MethodGet, "/v1/panel-config", "", "secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d", rec.Code)
	}
	var out PanelConfig
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out != srv.PanelConfig {
		t.Fatalf("got %+v", out)
	}
	if rec := doReq(t, srv.Handler(), http.MethodGet, "/v1/panel-config", "", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no auth: %d", rec.Code)
	}
	if rec := doReq(t, srv.Handler(), http.MethodPost, "/v1/panel-config", "", "secret"); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("post: %d", rec.Code)
	}
}
