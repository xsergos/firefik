package controlplane

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newPanelTestRegistry(t *testing.T) *Registry {
	t.Helper()
	store := NewMemoryStore()
	return NewRegistryWithStore(slog.New(slog.NewTextHandler(io.Discard, nil)), store)
}

func panelServer(t *testing.T) *HTTPServer {
	t.Helper()
	reg := newPanelTestRegistry(t)
	return &HTTPServer{Registry: reg}
}

func TestFleetStatsAggregates(t *testing.T) {
	srv := panelServer(t)
	ctx := context.Background()
	now := time.Now().UTC()
	_ = srv.Registry.store.UpsertAgent(ctx, AgentIdentity{InstanceID: "a1", Hostname: "h1"})
	_ = srv.Registry.store.UpsertAgent(ctx, AgentIdentity{InstanceID: "a2", Hostname: "h2"})
	_ = srv.Registry.store.RecordSnapshot(ctx, AgentSnapshot{
		Agent: AgentIdentity{InstanceID: "a1"},
		At:    now,
		Containers: []ContainerState{
			{ID: "c1", Name: "x", Status: "running", FirewallStatus: "active"},
			{ID: "c2", Name: "y", Status: "exited", FirewallStatus: "disabled"},
		},
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/stats", nil)
	srv.handleFleetStats(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var resp fleetStatsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Agents.Total != 2 {
		t.Errorf("agents total: %d", resp.Agents.Total)
	}
	if resp.Containers.Total != 2 || resp.Containers.Running != 1 || resp.Containers.Enabled != 1 {
		t.Errorf("container counts wrong: %+v", resp.Containers)
	}
}

func TestFleetContainersFlatten(t *testing.T) {
	srv := panelServer(t)
	ctx := context.Background()
	_ = srv.Registry.store.UpsertAgent(ctx, AgentIdentity{InstanceID: "a1", Hostname: "h1"})
	_ = srv.Registry.store.RecordSnapshot(ctx, AgentSnapshot{
		Agent: AgentIdentity{InstanceID: "a1", Hostname: "h1"},
		Containers: []ContainerState{
			{ID: "c1", Name: "web", FirewallStatus: "active", RuleSetCount: 2},
		},
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/containers", nil)
	srv.handleFleetContainers(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d", rec.Code)
	}
	var out []fleetContainerDTO
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].AgentID != "a1" || out[0].Name != "web" {
		t.Fatalf("bad payload: %+v", out)
	}
}

func TestFleetRulesFiltersInactive(t *testing.T) {
	srv := panelServer(t)
	ctx := context.Background()
	_ = srv.Registry.store.UpsertAgent(ctx, AgentIdentity{InstanceID: "a1"})
	_ = srv.Registry.store.RecordSnapshot(ctx, AgentSnapshot{
		Agent: AgentIdentity{InstanceID: "a1"},
		Containers: []ContainerState{
			{ID: "c1", Name: "web", FirewallStatus: "active", RuleSetCount: 1},
			{ID: "c2", Name: "noop", FirewallStatus: "disabled", RuleSetCount: 0},
		},
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/rules", nil)
	srv.handleFleetRules(rec, req)
	var out []fleetRuleDTO
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out) != 1 || out[0].ContainerName != "web" {
		t.Fatalf("expected 1 rule entry, got %+v", out)
	}
}

func TestFleetAuditHistory(t *testing.T) {
	srv := panelServer(t)
	ctx := context.Background()
	_ = srv.Registry.store.RecordAudit(ctx, "a1", "rule_applied", map[string]any{"id": "c1"}, time.Now().UTC())
	_ = srv.Registry.store.RecordAudit(ctx, "a2", "rule_disabled", map[string]any{"id": "c2"}, time.Now().UTC())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/audit/history?limit=10", nil)
	srv.handleFleetAuditHistory(rec, req)
	var out []auditEventDTO
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out) != 2 {
		t.Fatalf("expected 2 events, got %d (%s)", len(out), rec.Body.String())
	}
}

func TestFleetAuditHistory_Filtered(t *testing.T) {
	srv := panelServer(t)
	ctx := context.Background()
	_ = srv.Registry.store.RecordAudit(ctx, "a1", "x", nil, time.Now().UTC())
	_ = srv.Registry.store.RecordAudit(ctx, "a2", "y", nil, time.Now().UTC())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/audit/history?agent_id=a1", nil)
	srv.handleFleetAuditHistory(rec, req)
	var out []auditEventDTO
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out) != 1 || out[0].AgentID != "a1" {
		t.Fatalf("expected only a1 event, got %+v", out)
	}
}

func TestPoliciesCRUD(t *testing.T) {
	srv := panelServer(t)

	rec := httptest.NewRecorder()
	dsl := `policy "web" { allow if port == 80 }`
	body, _ := json.Marshal(map[string]any{"dsl": dsl, "comment": "test"})
	req := httptest.NewRequest(http.MethodPut, "/v1/policies/web", bytes.NewReader(body))
	srv.handlePolicy(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("save: %d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/v1/policies/web", nil)
	srv.handlePolicy(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get: %d", rec.Code)
	}
	var detail policyDetailDTO
	_ = json.Unmarshal(rec.Body.Bytes(), &detail)
	if detail.Name != "web" || !strings.Contains(detail.DSL, "port == 80") {
		t.Fatalf("bad detail: %+v", detail)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/v1/policies", nil)
	srv.handlePoliciesIndex(rec, req)
	var list []policySummaryDTO
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 1 || list[0].Name != "web" {
		t.Fatalf("bad list: %+v", list)
	}
}

func TestPolicyValidate(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	dsl := `policy "web" { allow if port == 80 }`
	body := map[string]any{"dsl": dsl}
	bs, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/policies/web/validate", bytes.NewReader(bs))
	srv.handlePolicy(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("validate: %d body=%s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["ok"] != true {
		t.Fatalf("expected ok=true, got %v", resp)
	}
}

func TestPolicyValidate_BadDSL(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/policies/web/validate",
		bytes.NewBufferString(`{"dsl":"this is not valid policy syntax"}`))
	srv.handlePolicy(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("validate: %d body=%s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["ok"] != false {
		t.Fatalf("expected ok=false on bad DSL, got %v", resp)
	}
}

func TestPolicySimulate(t *testing.T) {
	srv := panelServer(t)
	dsl := `policy "web" { allow if port == 80 }`
	rec := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]any{"dsl": dsl})
	req := httptest.NewRequest(http.MethodPost, "/v1/policies/web/simulate", bytes.NewReader(body))
	srv.handlePolicy(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("simulate: %d body=%s", rec.Code, rec.Body.String())
	}
	var resp policySimulateResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.RuleSets) == 0 {
		t.Fatalf("expected at least one rendered ruleset, got %+v", resp)
	}
	if resp.DefaultPolicy != "DROP" {
		t.Fatalf("expected default DROP, got %q", resp.DefaultPolicy)
	}
}

func TestPolicySimulate_EmptyListsAreArraysNotNull(t *testing.T) {
	srv := panelServer(t)
	dsl := `policy "web" { block if geo in ["RU", "CN"] }`
	rec := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]any{"dsl": dsl})
	req := httptest.NewRequest(http.MethodPost, "/v1/policies/web/simulate", bytes.NewReader(body))
	srv.handlePolicy(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("simulate: %d body=%s", rec.Code, rec.Body.String())
	}
	raw := rec.Body.String()
	for _, field := range []string{`"ports":null`, `"allowlist":null`, `"blocklist":null`} {
		if strings.Contains(raw, field) {
			t.Fatalf("response contains %s: %s", field, raw)
		}
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	sets, _ := resp["ruleSets"].([]any)
	if len(sets) == 0 {
		t.Fatalf("expected rule sets, got %s", raw)
	}
	for _, s := range sets {
		m := s.(map[string]any)
		for _, key := range []string{"ports", "allowlist", "blocklist"} {
			if _, ok := m[key].([]any); !ok {
				t.Fatalf("%s should be an array, got %#v", key, m[key])
			}
		}
	}
}

func TestPolicySimulate_ContainerFromSnapshot(t *testing.T) {
	srv := panelServer(t)
	ctx := context.Background()
	_ = srv.Registry.store.UpsertAgent(ctx, AgentIdentity{InstanceID: "a1", Hostname: "h1"})
	_ = srv.Registry.store.RecordSnapshot(ctx, AgentSnapshot{
		Agent: AgentIdentity{InstanceID: "a1"},
		At:    time.Now().UTC(),
		Containers: []ContainerState{
			{ID: "abcdef0123456789", Name: "web", DefaultPolicy: "RETURN", Labels: map[string]string{"firefik.policy": "other, web"}},
			{ID: "1234567890abcdef", Name: "db", Labels: map[string]string{"firefik.enable": "true"}},
		},
	})
	dsl := `policy "web" { allow if port == 80 }`

	simulate := func(containerID, agentID string) policySimulateResponse {
		t.Helper()
		rec := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]any{"dsl": dsl, "containerID": containerID, "agentID": agentID})
		req := httptest.NewRequest(http.MethodPost, "/v1/policies/web/simulate", bytes.NewReader(body))
		srv.handlePolicy(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("simulate: %d body=%s", rec.Code, rec.Body.String())
		}
		var resp policySimulateResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &resp)
		return resp
	}

	resp := simulate("abcdef012345", "a1")
	if resp.Container != "abcdef0123456789" {
		t.Fatalf("container not resolved: %+v", resp)
	}
	if resp.DefaultPolicy != "RETURN" {
		t.Fatalf("expected container default policy, got %q", resp.DefaultPolicy)
	}
	if resp.LabelsSeen["firefik.policy"] != "other, web" {
		t.Fatalf("labels not echoed: %+v", resp.LabelsSeen)
	}
	if len(resp.Warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", resp.Warnings)
	}

	resp = simulate("1234567890ab", "")
	if len(resp.Warnings) != 1 || !strings.Contains(resp.Warnings[0], "firefik.policy=web") {
		t.Fatalf("expected missing-label warning, got %v", resp.Warnings)
	}

	resp = simulate("ffffffffffff", "")
	if len(resp.Warnings) != 1 || !strings.Contains(resp.Warnings[0], "not found") {
		t.Fatalf("expected not-found warning, got %v", resp.Warnings)
	}
}

func TestPolicySimulate_FallbackToStored(t *testing.T) {
	srv := panelServer(t)
	ctx := context.Background()
	dsl := `policy "web" { allow if port == 443 }`
	if _, err := srv.Registry.store.SetPolicyVersion(ctx, "web", dsl, "panel", ""); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/policies/web/simulate", bytes.NewBufferString(`{}`))
	srv.handlePolicy(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var resp policySimulateResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.RuleSets) == 0 {
		t.Fatalf("expected views from stored DSL: %+v", resp)
	}
}

func TestPolicySimulate_NotFound(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/policies/missing/simulate", bytes.NewBufferString(`{}`))
	srv.handlePolicy(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestContainerAction_Apply_Success(t *testing.T) {
	srv := panelServer(t)
	ctx := context.Background()
	_ = srv.Registry.store.UpsertAgent(ctx, AgentIdentity{InstanceID: "a1"})
	_ = srv.Registry.store.RecordSnapshot(ctx, AgentSnapshot{
		Agent:      AgentIdentity{InstanceID: "a1"},
		Containers: []ContainerState{{ID: "c1deadbeef", Name: "web"}},
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/containers/c1deadbeef/apply", bytes.NewBufferString(`{}`))
	done := make(chan struct{})
	go func() {
		srv.handleFleetContainerAction(rec, req)
		close(done)
	}()

	for i := 0; i < 50; i++ {
		srv.Registry.mu.Lock()
		var cmdID string
		for _, list := range srv.Registry.commands {
			for _, c := range list {
				if c.Kind == CommandApply {
					cmdID = c.ID
					break
				}
			}
		}
		srv.Registry.mu.Unlock()
		if cmdID != "" {
			srv.Registry.recordAck(CommandAck{ID: cmdID, Success: true})
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("hung")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestContainerAction_AgentNotFound(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/containers/unknown/apply", bytes.NewBufferString(`{}`))
	srv.handleFleetContainerAction(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestContainerAction_BadAction(t *testing.T) {
	srv := panelServer(t)
	ctx := context.Background()
	_ = srv.Registry.store.UpsertAgent(ctx, AgentIdentity{InstanceID: "a1"})
	_ = srv.Registry.store.RecordSnapshot(ctx, AgentSnapshot{
		Agent:      AgentIdentity{InstanceID: "a1"},
		Containers: []ContainerState{{ID: "c1", Name: "web"}},
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/containers/c1/somethingelse", bytes.NewBufferString(`{}`))
	srv.handleFleetContainerAction(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestContainerBulk_MixedResults(t *testing.T) {
	srv := panelServer(t)
	ctx := context.Background()
	_ = srv.Registry.store.UpsertAgent(ctx, AgentIdentity{InstanceID: "a1"})
	_ = srv.Registry.store.RecordSnapshot(ctx, AgentSnapshot{
		Agent:      AgentIdentity{InstanceID: "a1"},
		Containers: []ContainerState{{ID: "c1deadbeef", Name: "web"}},
	})

	rec := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]any{
		"actions": []map[string]any{
			{"id": "c1deadbeef", "action": "apply"},
			{"id": "doesnotexist", "action": "apply"},
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/containers/bulk", bytes.NewReader(body))
	done := make(chan struct{})
	go func() {
		srv.handleFleetContainerAction(rec, req)
		close(done)
	}()
	for i := 0; i < 50; i++ {
		srv.Registry.mu.Lock()
		var cmdID string
		for _, list := range srv.Registry.commands {
			for _, c := range list {
				if c.Kind == CommandApply {
					cmdID = c.ID
					break
				}
			}
		}
		srv.Registry.mu.Unlock()
		if cmdID != "" {
			srv.Registry.recordAck(CommandAck{ID: cmdID, Success: true})
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("hung")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var resp fleetContainerBulkResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Summary.Total != 2 {
		t.Errorf("total: %d", resp.Summary.Total)
	}
	if resp.Summary.Applied != 1 {
		t.Errorf("applied: %d", resp.Summary.Applied)
	}
	if resp.Summary.Failed != 1 {
		t.Errorf("failed: %d", resp.Summary.Failed)
	}
}

func TestAutogenProposalsList(t *testing.T) {
	srv := panelServer(t)
	ctx := context.Background()
	_ = srv.Registry.store.UpsertAgent(ctx, AgentIdentity{InstanceID: "a1", Hostname: "h1"})
	_ = srv.Registry.store.RecordProposals(ctx, []AutogenProposal{
		{AgentID: "a1", ContainerID: "c1", Ports: []uint32{80}, Peers: []string{"10.0.0.0/8"}},
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/autogen/proposals", nil)
	srv.handleAutogenProposals(rec, req)
	var out []autogenProposalDTO
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out) != 1 || out[0].AgentHostname != "h1" {
		t.Fatalf("bad list: %+v", out)
	}
}

func TestAgentStatsPull_Timeout(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/agents/a1/stats", nil)
	done := make(chan struct{})
	go func() {
		srv.handleAgentStatsPull(rec, req, "a1")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("did not respond in time")
	}
	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("expected 504 timeout, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAgentStatsPull_Success(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/agents/a1/stats", nil)
	done := make(chan struct{})
	go func() {
		srv.handleAgentStatsPull(rec, req, "a1")
		close(done)
	}()

	for i := 0; i < 50; i++ {
		srv.Registry.mu.Lock()
		var cmdID string
		for _, list := range srv.Registry.commands {
			for _, c := range list {
				if c.Kind == CommandStatsCollect {
					cmdID = c.ID
					break
				}
			}
		}
		srv.Registry.mu.Unlock()
		if cmdID != "" {
			srv.Registry.recordAck(CommandAck{
				ID:            cmdID,
				AgentID:       "a1",
				Success:       true,
				ResultPayload: map[string]any{"containers": map[string]any{"total": float64(3)}},
			})
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("handler hung")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestRegistryWaitForAck_AlreadyAcked(t *testing.T) {
	reg := newPanelTestRegistry(t)
	reg.recordAck(CommandAck{ID: "x", Success: true})
	a, err := reg.WaitForAck(context.Background(), "x", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !a.Success {
		t.Fatal("expected ack")
	}
}

func TestRegistryWaitForAck_Timeout(t *testing.T) {
	reg := newPanelTestRegistry(t)
	_, err := reg.WaitForAck(context.Background(), "missing", 100*time.Millisecond)
	if err == nil {
		t.Fatal("expected timeout")
	}
}

func TestRegistryRecordProposals_StoresAndLists(t *testing.T) {
	reg := newPanelTestRegistry(t)
	reg.RecordProposals([]AutogenProposal{
		{AgentID: "a1", ContainerID: "c1", Ports: []uint32{80}},
	})
	out, err := reg.store.ListProposals(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("expected 1 proposal, got %d", len(out))
	}
}

func TestPanelHandlers_MethodNotAllowed(t *testing.T) {
	srv := panelServer(t)
	cases := []struct {
		path string
		fn   http.HandlerFunc
	}{
		{"/v1/stats", srv.handleFleetStats},
		{"/v1/containers", srv.handleFleetContainers},
		{"/v1/rules", srv.handleFleetRules},
		{"/v1/audit/history", srv.handleFleetAuditHistory},
		{"/v1/policies", srv.handlePoliciesIndex},
		{"/v1/autogen/proposals", srv.handleAutogenProposals},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, c.path, nil)
		c.fn(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: expected 405, got %d", c.path, rec.Code)
		}
	}
}

func TestPolicyHandler_GetMissing(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/policies/nope", nil)
	srv.handlePolicy(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestPolicySave_BadJSON(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/v1/policies/web", strings.NewReader("not json"))
	srv.handlePolicy(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestPolicySave_EmptyDSL(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/v1/policies/web", bytes.NewBufferString(`{"dsl":"   "}`))
	srv.handlePolicy(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestPolicyValidate_Empty(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/policies/x/validate", bytes.NewBufferString(`{}`))
	srv.handlePolicy(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["ok"] != false {
		t.Fatalf("empty dsl should be ok=false: %v", resp)
	}
}

func TestPolicyHandler_BadPath(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/policies/", nil)
	srv.handlePolicy(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestAutogenAction_Reject_Success(t *testing.T) {
	srv := panelServer(t)
	ctx := context.Background()
	_ = srv.Registry.store.UpsertAgent(ctx, AgentIdentity{InstanceID: "a1"})
	_ = srv.Registry.store.RecordProposals(ctx, []AutogenProposal{
		{AgentID: "a1", ContainerID: "c1"},
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/autogen/proposals/c1/reject",
		bytes.NewBufferString(`{"agent_id":"a1","reason":"test"}`))
	done := make(chan struct{})
	go func() {
		srv.handleAutogenAction(rec, req)
		close(done)
	}()

	for i := 0; i < 50; i++ {
		srv.Registry.mu.Lock()
		var cmdID string
		for _, list := range srv.Registry.commands {
			for _, c := range list {
				if c.Kind == CommandAutogenReject {
					cmdID = c.ID
					break
				}
			}
		}
		srv.Registry.mu.Unlock()
		if cmdID != "" {
			srv.Registry.recordAck(CommandAck{ID: cmdID, Success: true})
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("handler hung")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	leftover, _ := srv.Registry.store.ListProposals(ctx, "")
	if len(leftover) != 0 {
		t.Fatalf("expected proposal deleted on success, got %d", len(leftover))
	}
}

func TestAutogenAction_BadAction(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/autogen/proposals/c1/somethingelse",
		bytes.NewBufferString(`{"agent_id":"a1"}`))
	srv.handleAutogenAction(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestAutogenAction_MissingAgentID(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/autogen/proposals/c1/approve",
		bytes.NewBufferString(`{}`))
	srv.handleAutogenAction(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestAutogenAction_BadJSON(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/autogen/proposals/c1/approve",
		strings.NewReader("{not json"))
	srv.handleAutogenAction(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestAutogenAction_BadPath(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/autogen/proposals/c1",
		bytes.NewBufferString(`{}`))
	srv.handleAutogenAction(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestToNativeAutogenProposals(t *testing.T) {
	out := toNativeAutogenProposals(nil)
	if out != nil {
		t.Errorf("nil input should yield nil")
	}
}

func TestPbKindFromStringExtras(t *testing.T) {
	cases := []struct {
		in  CommandKind
		any bool
	}{
		{CommandStatsCollect, true},
		{CommandAutogenApprove, true},
		{CommandAutogenReject, true},
	}
	for _, c := range cases {
		if got := pbKindFromString(string(c.in)); got == 0 {
			t.Errorf("%q mapped to UNSPECIFIED", c.in)
		}
	}
}

func TestCommandKindFromPB_Extras(t *testing.T) {
	mapping := []CommandKind{
		CommandStatsCollect,
		CommandAutogenApprove,
		CommandAutogenReject,
	}
	for _, k := range mapping {
		got := commandKindFromPB(pbKindFromString(string(k)))
		if got != k {
			t.Errorf("roundtrip %q != %q", got, k)
		}
	}
}

func TestSqliteProposalsCRUD(t *testing.T) {
	ctx := context.Background()
	store, err := NewSQLiteStore(ctx, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpsertAgent(ctx, AgentIdentity{InstanceID: "a1"}); err != nil {
		t.Fatal(err)
	}

	if err := store.RecordProposals(ctx, []AutogenProposal{
		{AgentID: "a1", ContainerID: "c1", Ports: []uint32{80, 443}, Peers: []string{"10.0.0.0/8"}, Confidence: "high"},
		{AgentID: "a1", ContainerID: "c2", Ports: []uint32{22}, Peers: []string{}, Confidence: "moderate"},
	}); err != nil {
		t.Fatal(err)
	}

	all, err := store.ListProposals(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("expected 2, got %d", len(all))
	}

	one, err := store.ListProposals(ctx, "a1")
	if err != nil {
		t.Fatal(err)
	}
	if len(one) != 2 {
		t.Fatalf("expected 2 for agent, got %d", len(one))
	}

	if err := store.RecordProposals(ctx, []AutogenProposal{
		{AgentID: "a1", ContainerID: "c1", Ports: []uint32{8080}, Peers: []string{"172.16.0.0/12"}, Confidence: "tentative"},
	}); err != nil {
		t.Fatal(err)
	}
	updated, _ := store.ListProposals(ctx, "a1")
	for _, p := range updated {
		if p.ContainerID == "c1" {
			if len(p.Ports) != 1 || p.Ports[0] != 8080 {
				t.Fatalf("expected upsert overwrite: %+v", p)
			}
		}
	}

	if err := store.DeleteProposal(ctx, "a1", "c2"); err != nil {
		t.Fatal(err)
	}
	left, _ := store.ListProposals(ctx, "a1")
	if len(left) != 1 || left[0].ContainerID != "c1" {
		t.Fatalf("expected only c1 left, got %+v", left)
	}
}

func TestSqliteListAuditEvents(t *testing.T) {
	ctx := context.Background()
	store, err := NewSQLiteStore(ctx, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Now().UTC()
	_ = store.RecordAudit(ctx, "a1", "k1", map[string]any{"x": 1}, now)
	_ = store.RecordAudit(ctx, "a2", "k2", map[string]any{"y": 2}, now)

	all, err := store.ListAuditEvents(ctx, "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("expected 2, got %d", len(all))
	}

	filtered, err := store.ListAuditEvents(ctx, "a1", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered) != 1 || filtered[0].AgentID != "a1" {
		t.Fatalf("filter wrong: %+v", filtered)
	}

	none, err := store.ListAuditEvents(ctx, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(none) != 2 {
		t.Fatalf("default limit returned %d", len(none))
	}
}

func TestAgentLoop_WithProposalSource(t *testing.T) {
	loop := &AgentLoop{}
	stub := &stubProposalSource{items: []AutogenProposal{{ContainerID: "c"}}}
	got := loop.WithProposalSource(stub)
	if got.proposalSource == nil {
		t.Fatal("proposal source not assigned")
	}
}

type stubProposalSource struct{ items []AutogenProposal }

func (s *stubProposalSource) Proposals(_ context.Context) []AutogenProposal { return s.items }

func TestAutogenAction_AgentTimeout(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/autogen/proposals/c1/approve",
		bytes.NewBufferString(`{"agent_id":"a1","mode":"labels"}`))
	done := make(chan struct{})
	go func() {
		srv.handleAutogenAction(rec, req)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("hung")
	}
	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("expected 504, got %d", rec.Code)
	}
}

func TestHandleFleetLogsWS_BadMethod(t *testing.T) {
	srv := panelServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/logs", nil)
	srv.handleFleetLogsWS(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}
