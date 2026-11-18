package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"firefik/internal/policy"
)

type ruleSetView struct {
	Name      string   `json:"name"`
	Ports     []uint16 `json:"ports"`
	Allowlist []string `json:"allowlist"`
	Blocklist []string `json:"blocklist"`
	Protocol  string   `json:"protocol,omitempty"`
	Profile   string   `json:"profile,omitempty"`
	Log       bool     `json:"log,omitempty"`
	LogPrefix string   `json:"logPrefix,omitempty"`
	GeoBlock  []string `json:"geoBlock,omitempty"`
	GeoAllow  []string `json:"geoAllow,omitempty"`
}

func cidrsToStrings(in []net.IPNet) []string {
	if len(in) == 0 {
		return []string{}
	}
	out := make([]string, 0, len(in))
	for _, n := range in {
		out = append(out, n.String())
	}
	return out
}

const (
	defaultRemotePullTimeout = 5 * time.Second
	defaultAuditHistoryLimit = 100
	maxAuditHistoryLimit     = 1000
)

type fleetStatsAgentCounts struct {
	Total   int `json:"total"`
	Healthy int `json:"healthy"`
	Stale   int `json:"stale"`
	Dead    int `json:"dead"`
	Unknown int `json:"unknown"`
}

type fleetStatsContainerCounts struct {
	Total   int `json:"total"`
	Running int `json:"running"`
	Enabled int `json:"enabled"`
}

type fleetStatsTrafficBucket struct {
	Timestamp string `json:"ts"`
	Accepted  int64  `json:"accepted"`
	Dropped   int64  `json:"dropped"`
}

type fleetStatsResponse struct {
	Agents     fleetStatsAgentCounts     `json:"agents"`
	Containers fleetStatsContainerCounts `json:"containers"`
	Traffic    []fleetStatsTrafficBucket `json:"traffic"`
}

func (s *HTTPServer) handleFleetStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	records, err := s.Registry.store.ListAgents(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	now := time.Now().UTC()
	resp := fleetStatsResponse{Traffic: []fleetStatsTrafficBucket{}}
	traffic := map[string]*fleetStatsTrafficBucket{}
	for _, rec := range records {
		resp.Agents.Total++
		switch agentStatus(rec.LastSeen, now) {
		case "healthy":
			resp.Agents.Healthy++
		case "stale":
			resp.Agents.Stale++
		case "dead":
			resp.Agents.Dead++
		default:
			resp.Agents.Unknown++
		}
		snap, err := s.Registry.store.LatestSnapshot(r.Context(), rec.Identity.InstanceID)
		if err != nil || snap == nil {
			continue
		}
		for _, c := range snap.Containers {
			resp.Containers.Total++
			if strings.EqualFold(c.Status, "running") {
				resp.Containers.Running++
			}
			if c.FirewallStatus == "active" {
				resp.Containers.Enabled++
			}
		}
		for _, b := range snap.Traffic {
			cur, ok := traffic[b.Timestamp]
			if !ok {
				cur = &fleetStatsTrafficBucket{Timestamp: b.Timestamp}
				traffic[b.Timestamp] = cur
			}
			cur.Accepted += b.Accepted
			cur.Dropped += b.Dropped
		}
	}
	keys := make([]string, 0, len(traffic))
	for k := range traffic {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		resp.Traffic = append(resp.Traffic, *traffic[k])
	}
	writeJSON(w, http.StatusOK, resp)
}

type fleetContainerDTO struct {
	AgentID        string            `json:"agent_id"`
	AgentHostname  string            `json:"agent_hostname"`
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Status         string            `json:"status"`
	Enabled        bool              `json:"enabled"`
	FirewallStatus string            `json:"firewallStatus"`
	DefaultPolicy  string            `json:"defaultPolicy,omitempty"`
	Labels         map[string]string `json:"labels"`
	RuleSets       []any             `json:"ruleSets"`
	RuleSetCount   int               `json:"rule_set_count"`
	Sources        []string          `json:"sources,omitempty"`
}

func (s *HTTPServer) handleFleetContainers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	records, err := s.Registry.store.ListAgents(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]fleetContainerDTO, 0, 32)
	for _, rec := range records {
		snap, err := s.Registry.store.LatestSnapshot(r.Context(), rec.Identity.InstanceID)
		if err != nil || snap == nil {
			continue
		}
		for _, c := range snap.Containers {
			labels := stripInternalLabels(c.Labels)
			if labels == nil {
				labels = map[string]string{}
			}
			fwStatus := normaliseFirewallStatus(c.FirewallStatus)
			defPol := normaliseDefaultPolicy(c.DefaultPolicy)
			out = append(out, fleetContainerDTO{
				AgentID:        rec.Identity.InstanceID,
				AgentHostname:  rec.Identity.Hostname,
				ID:             c.ID,
				Name:           c.Name,
				Status:         c.Status,
				Enabled:        fwStatus == "active",
				FirewallStatus: fwStatus,
				DefaultPolicy:  defPol,
				Labels:         labels,
				RuleSets:       sanitizeRuleSets(decodeRuleSetsFromLabels(c.Labels)),
				RuleSetCount:   c.RuleSetCount,
				Sources:        c.Sources,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].AgentID != out[j].AgentID {
			return out[i].AgentID < out[j].AgentID
		}
		return out[i].Name < out[j].Name
	})
	writeJSON(w, http.StatusOK, out)
}

func normaliseFirewallStatus(s string) string {
	switch s {
	case "active", "inactive", "disabled":
		return s
	case "":
		return "disabled"
	default:
		return s
	}
}

func normaliseDefaultPolicy(s string) string {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "DROP":
		return "DROP"
	case "ACCEPT":
		return "ACCEPT"
	case "RETURN":
		return "RETURN"
	default:
		return "RETURN"
	}
}

func sanitizeRuleSets(in []any) []any {
	if in == nil {
		return []any{}
	}
	for _, rs := range in {
		m, ok := rs.(map[string]any)
		if !ok {
			continue
		}
		if v, exists := m["ports"]; !exists || v == nil {
			m["ports"] = []any{}
		}
		if v, exists := m["allowlist"]; !exists || v == nil {
			m["allowlist"] = []any{}
		}
		if v, exists := m["blocklist"]; !exists || v == nil {
			m["blocklist"] = []any{}
		}
	}
	return in
}

type fleetRuleDTO struct {
	AgentID       string `json:"agent_id"`
	AgentHostname string `json:"agent_hostname"`
	ContainerID   string `json:"containerID"`
	ContainerName string `json:"containerName"`
	Status        string `json:"status"`
	DefaultPolicy string `json:"defaultPolicy"`
	RuleSets      []any  `json:"ruleSets"`
	RuleSetCount  int    `json:"rule_set_count"`
}

func decodeRuleSetsFromLabels(labels map[string]string) []any {
	raw, ok := labels[RuleSetsLabelKey]
	if !ok || raw == "" {
		return []any{}
	}
	var out []any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return []any{}
	}
	if out == nil {
		return []any{}
	}
	return out
}

func decodeHostRulesFromLabels(labels map[string]string) (HostRulesPayload, bool) {
	raw, ok := labels[HostRulesLabelKey]
	if !ok || raw == "" {
		return HostRulesPayload{}, false
	}
	var payload HostRulesPayload
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return HostRulesPayload{}, false
	}
	if len(payload.Rules) == 0 && strings.TrimSpace(payload.Default) == "" {
		return HostRulesPayload{}, false
	}
	return payload, true
}

func stripInternalLabels(labels map[string]string) map[string]string {
	_, hasRS := labels[RuleSetsLabelKey]
	_, hasHR := labels[HostRulesLabelKey]
	if !hasRS && !hasHR {
		return labels
	}
	out := make(map[string]string, len(labels))
	for k, v := range labels {
		if k == RuleSetsLabelKey || k == HostRulesLabelKey {
			continue
		}
		out[k] = v
	}
	return out
}

func (s *HTTPServer) handleFleetRules(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	records, err := s.Registry.store.ListAgents(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]fleetRuleDTO, 0, 32)
	for _, rec := range records {
		snap, err := s.Registry.store.LatestSnapshot(r.Context(), rec.Identity.InstanceID)
		if err != nil || snap == nil {
			continue
		}
		for _, c := range snap.Containers {
			if c.RuleSetCount == 0 && c.FirewallStatus != "active" {
				continue
			}
			defPol := normaliseDefaultPolicy(c.DefaultPolicy)
			out = append(out, fleetRuleDTO{
				AgentID:       rec.Identity.InstanceID,
				AgentHostname: rec.Identity.Hostname,
				ContainerID:   c.ID,
				ContainerName: c.Name,
				Status:        c.Status,
				DefaultPolicy: defPol,
				RuleSets:      sanitizeRuleSets(decodeRuleSetsFromLabels(c.Labels)),
				RuleSetCount:  c.RuleSetCount,
			})
		}
		if payload, ok := decodeHostRulesFromLabels(snap.Agent.Labels); ok {
			defPol := strings.ToUpper(strings.TrimSpace(payload.Default))
			if defPol == "" {
				defPol = "ACCEPT"
			}
			ruleSets := make([]any, 0, len(payload.Rules))
			for _, hr := range payload.Rules {
				ports := hr.Ports
				if ports == nil {
					ports = []uint16{}
				}
				allow := hr.Allowlist
				if allow == nil {
					allow = []string{}
				}
				block := hr.Blocklist
				if block == nil {
					block = []string{}
				}
				ruleSets = append(ruleSets, map[string]any{
					"name":      hr.Name,
					"protocol":  hr.Protocol,
					"ports":     ports,
					"allowlist": allow,
					"blocklist": block,
					"log":       hr.Log,
					"logPrefix": hr.LogPrefix,
				})
			}
			out = append(out, fleetRuleDTO{
				AgentID:       rec.Identity.InstanceID,
				AgentHostname: rec.Identity.Hostname,
				ContainerID:   "(host)",
				ContainerName: "host firewall",
				Status:        "host",
				DefaultPolicy: defPol,
				RuleSets:      ruleSets,
				RuleSetCount:  len(payload.Rules),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].AgentID != out[j].AgentID {
			return out[i].AgentID < out[j].AgentID
		}
		return out[i].ContainerName < out[j].ContainerName
	})
	writeJSON(w, http.StatusOK, out)
}

type auditEventDTO struct {
	AgentID       string            `json:"agent_id"`
	AgentHostname string            `json:"agent_hostname,omitempty"`
	Action        string            `json:"action"`
	Source        string            `json:"source"`
	Actor         string            `json:"actor,omitempty"`
	ContainerID   string            `json:"container_id,omitempty"`
	ContainerName string            `json:"container_name,omitempty"`
	Metadata      map[string]string `json:"metadata,omitempty"`
	Timestamp     string            `json:"ts"`
}

func (s *HTTPServer) handleFleetAuditHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	limit := defaultAuditHistoryLimit
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
			if limit > maxAuditHistoryLimit {
				limit = maxAuditHistoryLimit
			}
		}
	}
	agentID := strings.TrimSpace(r.URL.Query().Get("agent_id"))
	events, err := s.Registry.store.ListAuditEvents(r.Context(), agentID, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	hosts := s.hostnamesByAgent(r.Context())
	out := make([]auditEventDTO, 0, len(events))
	for _, ev := range events {
		dto := auditEventDTO{
			AgentID:       ev.AgentID,
			AgentHostname: hosts[ev.AgentID],
			Action:        nonEmptyOr(ev.Kind, "unknown"),
			Source:        "control-plane",
			Timestamp:     ev.At.UTC().Format(time.RFC3339Nano),
		}
		if ev.Payload != nil {
			if v, ok := ev.Payload["container_id"].(string); ok {
				dto.ContainerID = v
			}
			if v, ok := ev.Payload["container_name"].(string); ok {
				dto.ContainerName = v
			}
			if v, ok := ev.Payload["source"].(string); ok && v != "" {
				dto.Source = v
			}
			if v, ok := ev.Payload["actor"].(string); ok {
				dto.Actor = v
			}
			meta := map[string]string{}
			for k, v := range ev.Payload {
				switch k {
				case "container_id", "container_name", "source", "action", "actor", "agent_id", "ts":
					continue
				}
				if s, ok := v.(string); ok {
					meta[k] = s
				}
			}
			if len(meta) > 0 {
				dto.Metadata = meta
			}
		}
		out = append(out, dto)
	}
	writeJSON(w, http.StatusOK, out)
}

func nonEmptyOr(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

type policySummaryDTO struct {
	Name        string    `json:"name"`
	Version     string    `json:"version"`
	Source      string    `json:"source,omitempty"`
	Rules       int       `json:"rules"`
	Author      string    `json:"author,omitempty"`
	Comment     string    `json:"comment,omitempty"`
	SHA         string    `json:"sha"`
	CommittedAt time.Time `json:"committedAt"`
}

type policyDetailDTO struct {
	Name        string        `json:"name"`
	Version     string        `json:"version"`
	Source      string        `json:"source,omitempty"`
	DSL         string        `json:"dsl"`
	RuleSets    []ruleSetView `json:"ruleSets"`
	Author      string        `json:"author,omitempty"`
	Comment     string        `json:"comment,omitempty"`
	SHA         string        `json:"sha"`
	CommittedAt time.Time     `json:"committedAt"`
}

type policyValidateRequest struct {
	DSL string `json:"dsl"`
}

type policyValidateResponse struct {
	OK       bool     `json:"ok"`
	Errors   []string `json:"errors,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

type policySaveRequest struct {
	DSL     string `json:"dsl"`
	Comment string `json:"comment,omitempty"`
	Author  string `json:"author,omitempty"`
}

type policySimulateRequest struct {
	ContainerID string            `json:"containerID,omitempty"`
	AgentID     string            `json:"agentID,omitempty"`
	DSL         string            `json:"dsl,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
}

const containerPolicyLabel = "firefik.policy"

type policySimulateResponse struct {
	Policy        string            `json:"policy"`
	Container     string            `json:"container,omitempty"`
	DefaultPolicy string            `json:"defaultPolicy,omitempty"`
	RuleSets      []ruleSetView     `json:"ruleSets"`
	Warnings      []string          `json:"warnings,omitempty"`
	Errors        []string          `json:"errors,omitempty"`
	LabelsSeen    map[string]string `json:"labelsSeen,omitempty"`
}

func (s *HTTPServer) handlePoliciesIndex(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	versions, err := s.Registry.store.ListPolicyVersions(r.Context(), "", 0)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	latest := map[string]PolicyVersion{}
	for _, v := range versions {
		if cur, ok := latest[v.Name]; !ok || v.CommittedAt.After(cur.CommittedAt) {
			latest[v.Name] = v
		}
	}
	out := make([]policySummaryDTO, 0, len(latest))
	for _, v := range latest {
		out = append(out, policySummaryDTO{
			Name:        v.Name,
			Version:     shortSHA(v.SHA),
			Source:      "control-plane",
			Rules:       countRulesInDSL(v.DSL),
			Author:      v.Author,
			Comment:     v.Comment,
			SHA:         v.SHA,
			CommittedAt: v.CommittedAt,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	writeJSON(w, http.StatusOK, out)
}

func (s *HTTPServer) handlePolicy(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/policies/")
	if rest == r.URL.Path || rest == "" {
		http.Error(w, "policy name required", http.StatusBadRequest)
		return
	}
	if rest == "validate" && r.Method == http.MethodPost {
		s.handlePolicyValidate(w, r)
		return
	}
	parts := strings.SplitN(rest, "/", 2)
	name := parts[0]
	sub := ""
	if len(parts) == 2 {
		sub = parts[1]
	}
	switch {
	case sub == "validate" && r.Method == http.MethodPost:
		s.handlePolicyValidate(w, r)
	case sub == "simulate" && r.Method == http.MethodPost:
		s.handlePolicySimulate(w, r, name)
	case sub == "" && r.Method == http.MethodGet:
		s.handlePolicyGet(w, r, name)
	case sub == "" && r.Method == http.MethodPut:
		s.handlePolicySave(w, r, name)
	case sub == "versions" && r.Method == http.MethodGet:
		s.handlePolicyVersions(w, r, name)
	default:
		http.Error(w, "method or subresource not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *HTTPServer) handlePolicyGet(w http.ResponseWriter, r *http.Request, name string) {
	v, err := s.Registry.store.GetPolicyVersion(r.Context(), name)
	if err != nil {
		http.Error(w, "policy not found", http.StatusNotFound)
		return
	}
	rules := evaluatePolicyRules(v.DSL)
	writeJSON(w, http.StatusOK, policyDetailDTO{
		Name: v.Name, Version: shortSHA(v.SHA), Source: "control-plane",
		DSL: v.DSL, RuleSets: rules, Author: v.Author, Comment: v.Comment,
		SHA: v.SHA, CommittedAt: v.CommittedAt,
	})
}

type policyVersionDTO struct {
	Version     string    `json:"version"`
	SHA         string    `json:"sha"`
	DSL         string    `json:"dsl"`
	Author      string    `json:"author,omitempty"`
	Comment     string    `json:"comment,omitempty"`
	CommittedAt time.Time `json:"committedAt"`
}

const maxPolicyVersions = 50

func (s *HTTPServer) handlePolicyVersions(w http.ResponseWriter, r *http.Request, name string) {
	versions, err := s.Registry.store.ListPolicyVersions(r.Context(), name, maxPolicyVersions)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]policyVersionDTO, 0, len(versions))
	for _, v := range versions {
		if v.Name != name {
			continue
		}
		out = append(out, policyVersionDTO{
			Version: shortSHA(v.SHA), SHA: v.SHA, DSL: v.DSL,
			Author: v.Author, Comment: v.Comment, CommittedAt: v.CommittedAt,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CommittedAt.After(out[j].CommittedAt) })
	writeJSON(w, http.StatusOK, out)
}

func (s *HTTPServer) handlePolicySave(w http.ResponseWriter, r *http.Request, name string) {
	var req policySaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.DSL) == "" {
		http.Error(w, "dsl required", http.StatusBadRequest)
		return
	}
	if _, err := policy.Parse(req.DSL); err != nil {
		http.Error(w, "policy parse: "+err.Error(), http.StatusBadRequest)
		return
	}
	author := req.Author
	if author == "" {
		author = s.attribute(r)
	}
	previous, prevErr := s.Registry.store.GetPolicyVersion(r.Context(), name)
	v, err := s.Registry.store.SetPolicyVersion(r.Context(), name, req.DSL, author, req.Comment)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	changeFields := map[string]string{
		"policy_name": name,
		"version":     shortSHA(v.SHA),
		"sha":         v.SHA,
		"comment":     req.Comment,
		"rules":       strconv.Itoa(countRulesInDSL(v.DSL)),
	}
	if prevErr == nil && previous.SHA != "" {
		changeFields["previous_version"] = shortSHA(previous.SHA)
		changeFields["previous_sha"] = previous.SHA
	}
	if prevErr != nil || previous.SHA != v.SHA {
		s.recordChange(r, "policy_saved", "", changeFields)
	}
	writeJSON(w, http.StatusOK, policySummaryDTO{
		Name:        v.Name,
		Version:     shortSHA(v.SHA),
		Source:      "control-plane",
		Rules:       countRulesInDSL(v.DSL),
		Author:      v.Author,
		Comment:     v.Comment,
		SHA:         v.SHA,
		CommittedAt: v.CommittedAt,
	})
}

func (s *HTTPServer) handlePolicyValidate(w http.ResponseWriter, r *http.Request) {
	var req policyValidateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	resp := policyValidateResponse{OK: true}
	if strings.TrimSpace(req.DSL) == "" {
		resp.OK = false
		resp.Errors = []string{"empty dsl"}
		writeJSON(w, http.StatusOK, resp)
		return
	}
	if _, err := policy.Parse(req.DSL); err != nil {
		resp.OK = false
		resp.Errors = []string{err.Error()}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *HTTPServer) handlePolicySimulate(w http.ResponseWriter, r *http.Request, name string) {
	var req policySimulateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	dsl := req.DSL
	if strings.TrimSpace(dsl) == "" {
		v, err := s.Registry.store.GetPolicyVersion(r.Context(), name)
		if err != nil {
			http.Error(w, "policy not found", http.StatusNotFound)
			return
		}
		dsl = v.DSL
	}
	resp := policySimulateResponse{
		Policy:    name,
		Container: req.ContainerID,
		RuleSets:  []ruleSetView{},
	}
	if req.Labels != nil {
		resp.LabelsSeen = req.Labels
	}
	parsed, err := policy.Parse(dsl)
	if err != nil {
		resp.Errors = []string{err.Error()}
		writeJSON(w, http.StatusOK, resp)
		return
	}
	views, warns, _ := renderPolicyViews(parsed)
	resp.RuleSets = views
	resp.Warnings = warns
	resp.DefaultPolicy = "DROP"
	if req.ContainerID != "" {
		if ctr, ok := s.findSnapshotContainer(r.Context(), req.AgentID, req.ContainerID); ok {
			resp.Container = ctr.ID
			if resp.LabelsSeen == nil && len(ctr.Labels) > 0 {
				resp.LabelsSeen = ctr.Labels
			}
			if ctr.DefaultPolicy != "" {
				resp.DefaultPolicy = ctr.DefaultPolicy
			}
			if !labelListsPolicy(ctr.Labels[containerPolicyLabel], name) {
				label := ctr.Name
				if label == "" {
					label = ctr.ID
				}
				resp.Warnings = append(resp.Warnings, fmt.Sprintf(
					"container %s has no label %s=%s, so this policy does not apply to it",
					label, containerPolicyLabel, name))
			}
		} else {
			resp.Warnings = append(resp.Warnings, "container "+req.ContainerID+" was not found in the latest agent reports")
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *HTTPServer) findSnapshotContainer(ctx context.Context, agentID, containerID string) (ContainerState, bool) {
	agents := []string{}
	if agentID != "" {
		agents = append(agents, agentID)
	} else {
		records, err := s.Registry.store.ListAgents(ctx)
		if err != nil {
			return ContainerState{}, false
		}
		for _, rec := range records {
			agents = append(agents, rec.Identity.InstanceID)
		}
	}
	for _, id := range agents {
		snap, err := s.Registry.store.LatestSnapshot(ctx, id)
		if err != nil || snap == nil {
			continue
		}
		for _, c := range snap.Containers {
			if c.ID == containerID || strings.HasPrefix(c.ID, containerID) || c.Name == containerID {
				return c, true
			}
		}
	}
	return ContainerState{}, false
}

func labelListsPolicy(raw, name string) bool {
	for _, part := range strings.Split(raw, ",") {
		if strings.TrimSpace(part) == name {
			return true
		}
	}
	return false
}

func evaluatePolicyRules(dsl string) []ruleSetView {
	if strings.TrimSpace(dsl) == "" {
		return []ruleSetView{}
	}
	parsed, err := policy.Parse(dsl)
	if err != nil {
		return []ruleSetView{}
	}
	views, _, _ := renderPolicyViews(parsed)
	return views
}

func renderPolicyViews(parsed []*policy.Policy) ([]ruleSetView, []string, error) {
	views := []ruleSetView{}
	var warnings []string
	for _, pol := range parsed {
		compiled, err := policy.Compile(pol)
		if err != nil {
			return nil, warnings, err
		}
		warnings = append(warnings, compiled.Warnings...)
		for _, rs := range compiled.RuleSets {
			views = append(views, ruleSetView{
				Name:      rs.Name,
				Ports:     append([]uint16{}, rs.Ports...),
				Allowlist: cidrsToStrings(rs.Allowlist),
				Blocklist: cidrsToStrings(rs.Blocklist),
				Protocol:  rs.Protocol,
				Profile:   rs.Profile,
				Log:       rs.Log,
				LogPrefix: rs.LogPrefix,
				GeoBlock:  append([]string(nil), rs.GeoBlock...),
				GeoAllow:  append([]string(nil), rs.GeoAllow...),
			})
		}
	}
	return views, warnings, nil
}

func countRulesInDSL(dsl string) int {
	views := evaluatePolicyRules(dsl)
	total := 0
	for _, v := range views {
		total += len(v.Ports) + len(v.Allowlist) + len(v.Blocklist)
	}
	return total
}

func shortSHA(sha string) string {
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}

type autogenProposalDTO struct {
	AgentID       string   `json:"agent_id"`
	AgentHostname string   `json:"agent_hostname,omitempty"`
	ContainerID   string   `json:"container_id"`
	Ports         []uint32 `json:"ports"`
	Peers         []string `json:"peers"`
	ObservedFor   string   `json:"observed_for,omitempty"`
	Confidence    string   `json:"confidence,omitempty"`
	Status        string   `json:"status,omitempty"`
	UpdatedAt     string   `json:"updated_at"`
}

func (s *HTTPServer) handleAutogenProposals(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	items, err := s.Registry.store.ListProposals(r.Context(), "")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	hosts := s.hostnamesByAgent(r.Context())
	out := make([]autogenProposalDTO, 0, len(items))
	for _, p := range items {
		out = append(out, autogenProposalDTO{
			AgentID:       p.AgentID,
			AgentHostname: hosts[p.AgentID],
			ContainerID:   p.ContainerID,
			Ports:         p.Ports,
			Peers:         p.Peers,
			ObservedFor:   p.ObservedFor,
			Confidence:    p.Confidence,
			Status:        "pending",
			UpdatedAt:     p.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

type autogenActionRequest struct {
	AgentID string `json:"agent_id"`
	Mode    string `json:"mode,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

func (s *HTTPServer) handleAutogenAction(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/autogen/proposals/")
	if rest == r.URL.Path || rest == "" {
		http.Error(w, "container id and action required", http.StatusBadRequest)
		return
	}
	parts := strings.Split(rest, "/")
	if len(parts) != 2 {
		http.Error(w, "container id and action required", http.StatusBadRequest)
		return
	}
	containerID := parts[0]
	action := parts[1]
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req autogenActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	agentID := req.AgentID
	if agentID == "" {
		agentID = s.resolveProposalAgent(r.Context(), containerID)
	}
	if agentID == "" {
		http.Error(w, "agent_id required (no proposal found for this container)", http.StatusBadRequest)
		return
	}

	var kind CommandKind
	payload := map[string]any{"container_id": containerID}
	switch action {
	case "approve":
		kind = CommandAutogenApprove
		mode := req.Mode
		if mode == "" {
			mode = "labels"
		}
		payload["mode"] = mode
	case "reject":
		kind = CommandAutogenReject
		payload["reason"] = req.Reason
	default:
		http.Error(w, "unsupported action: "+action, http.StatusBadRequest)
		return
	}

	cmd := Command{
		ID:          newCommandID(),
		Kind:        kind,
		ContainerID: containerID,
		Payload:     payload,
		IssuedAt:    time.Now().UTC(),
	}
	s.Registry.Enqueue(agentID, cmd)

	ctx, cancel := context.WithTimeout(r.Context(), defaultRemotePullTimeout)
	defer cancel()
	ack, err := s.Registry.WaitForAck(ctx, cmd.ID, defaultRemotePullTimeout)
	if err != nil {
		writeJSON(w, http.StatusGatewayTimeout, map[string]any{"id": cmd.ID, "error": "timeout waiting for agent ack"})
		return
	}
	if !ack.Success {
		writeJSON(w, http.StatusBadGateway, map[string]any{"id": cmd.ID, "error": ack.Error})
		return
	}
	_ = s.Registry.store.DeleteProposal(r.Context(), agentID, containerID)
	changeFields := map[string]string{"container_id": containerID}
	if mode, ok := payload["mode"].(string); ok {
		changeFields["mode"] = mode
	}
	if reason, ok := payload["reason"].(string); ok {
		changeFields["reason"] = reason
	}
	s.recordChange(r, "autogen_"+action+"d", agentID, changeFields)
	resp := map[string]any{
		"id":      cmd.ID,
		"agent":   agentID,
		"action":  action,
		"success": true,
	}
	if ack.ResultPayload != nil {
		for k, v := range ack.ResultPayload {
			resp[k] = v
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *HTTPServer) resolveProposalAgent(ctx context.Context, containerID string) string {
	items, err := s.Registry.store.ListProposals(ctx, "")
	if err != nil {
		return ""
	}
	for _, p := range items {
		if p.ContainerID == containerID || strings.HasPrefix(p.ContainerID, containerID) {
			return p.AgentID
		}
	}
	return ""
}

func (s *HTTPServer) hostnamesByAgent(ctx context.Context) map[string]string {
	out := map[string]string{}
	records, err := s.Registry.store.ListAgents(ctx)
	if err != nil {
		return out
	}
	for _, rec := range records {
		out[rec.Identity.InstanceID] = rec.Identity.Hostname
	}
	return out
}

func (s *HTTPServer) handleAgentStatsPull(w http.ResponseWriter, r *http.Request, agentID string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cmd := Command{
		ID:       newCommandID(),
		Kind:     CommandStatsCollect,
		IssuedAt: time.Now().UTC(),
	}
	s.Registry.Enqueue(agentID, cmd)

	ctx, cancel := context.WithTimeout(r.Context(), defaultRemotePullTimeout)
	defer cancel()
	ack, err := s.Registry.WaitForAck(ctx, cmd.ID, defaultRemotePullTimeout)
	if err != nil {
		http.Error(w, "timeout waiting for agent ack", http.StatusGatewayTimeout)
		return
	}
	if !ack.Success {
		errMsg := ack.Error
		if errMsg == "" {
			errMsg = "agent reported failure"
		}
		http.Error(w, errMsg, http.StatusBadGateway)
		return
	}
	if ack.ResultPayload == nil {
		writeJSON(w, http.StatusOK, map[string]any{})
		return
	}
	writeJSON(w, http.StatusOK, ack.ResultPayload)
}

type fleetContainerActionResult struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

type fleetContainerBulkResponse struct {
	Results []fleetContainerActionResult `json:"results"`
	Summary struct {
		Total    int `json:"total"`
		Applied  int `json:"applied"`
		Disabled int `json:"disabled"`
		Failed   int `json:"failed"`
	} `json:"summary"`
}

type fleetContainerActionRequest struct {
	AgentID string `json:"agent_id,omitempty"`
}

type fleetContainerBulkRequest struct {
	Actions []struct {
		ID      string `json:"id"`
		Action  string `json:"action"`
		AgentID string `json:"agent_id,omitempty"`
	} `json:"actions"`
}

func (s *HTTPServer) handleFleetContainerAction(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/containers/")
	if rest == r.URL.Path || rest == "" {
		http.Error(w, "container id required", http.StatusBadRequest)
		return
	}
	parts := strings.Split(rest, "/")
	if len(parts) == 1 && parts[0] == "bulk" {
		s.handleFleetContainerBulk(w, r)
		return
	}
	if len(parts) != 2 {
		http.Error(w, "container id and action required", http.StatusBadRequest)
		return
	}
	containerID := parts[0]
	action := parts[1]
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req fleetContainerActionRequest
	if r.ContentLength > 0 {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	agentID := req.AgentID
	if agentID == "" {
		agentID = s.resolveContainerAgent(r.Context(), containerID)
	}
	if agentID == "" {
		http.Error(w, "agent_id required (no agent owns this container)", http.StatusBadRequest)
		return
	}
	kind, err := containerCommandKind(action)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.runContainerCommand(r.Context(), agentID, containerID, kind); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	s.recordChange(r, containerChangeAction(action), agentID, map[string]string{"container_id": containerID})
	writeJSON(w, http.StatusOK, map[string]any{"id": containerID, "action": action, "status": "ok"})
}

func (s *HTTPServer) handleFleetContainerBulk(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req fleetContainerBulkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	resp := fleetContainerBulkResponse{Results: []fleetContainerActionResult{}}
	for _, a := range req.Actions {
		res := fleetContainerActionResult{ID: a.ID, Action: a.Action}
		agentID := a.AgentID
		if agentID == "" {
			agentID = s.resolveContainerAgent(r.Context(), a.ID)
		}
		if agentID == "" {
			res.Status = "error"
			res.Error = "agent not found"
			resp.Results = append(resp.Results, res)
			resp.Summary.Failed++
			continue
		}
		kind, err := containerCommandKind(a.Action)
		if err != nil {
			res.Status = "error"
			res.Error = err.Error()
			resp.Results = append(resp.Results, res)
			resp.Summary.Failed++
			continue
		}
		if err := s.runContainerCommand(r.Context(), agentID, a.ID, kind); err != nil {
			res.Status = "error"
			res.Error = err.Error()
			resp.Summary.Failed++
		} else {
			res.Status = "ok"
			s.recordChange(r, containerChangeAction(a.Action), agentID, map[string]string{"container_id": a.ID, "bulk": "true"})
			if a.Action == "apply" {
				resp.Summary.Applied++
			} else {
				resp.Summary.Disabled++
			}
		}
		resp.Results = append(resp.Results, res)
	}
	resp.Summary.Total = len(resp.Results)
	writeJSON(w, http.StatusOK, resp)
}

func (s *HTTPServer) runContainerCommand(ctx context.Context, agentID, containerID string, kind CommandKind) error {
	cmd := Command{
		ID:          newCommandID(),
		Kind:        kind,
		ContainerID: containerID,
		IssuedAt:    time.Now().UTC(),
	}
	s.Registry.Enqueue(agentID, cmd)
	waitCtx, cancel := context.WithTimeout(ctx, defaultRemotePullTimeout)
	defer cancel()
	ack, err := s.Registry.WaitForAck(waitCtx, cmd.ID, defaultRemotePullTimeout)
	if err != nil {
		return errors.New("timeout waiting for agent ack")
	}
	if !ack.Success {
		if ack.Error != "" {
			return errors.New(ack.Error)
		}
		return errors.New("agent reported failure")
	}
	return nil
}

func (s *HTTPServer) resolveContainerAgent(ctx context.Context, containerID string) string {
	records, err := s.Registry.store.ListAgents(ctx)
	if err != nil {
		return ""
	}
	for _, rec := range records {
		snap, err := s.Registry.store.LatestSnapshot(ctx, rec.Identity.InstanceID)
		if err != nil || snap == nil {
			continue
		}
		for _, c := range snap.Containers {
			if c.ID == containerID || strings.HasPrefix(c.ID, containerID) {
				return rec.Identity.InstanceID
			}
		}
	}
	return ""
}

func containerCommandKind(action string) (CommandKind, error) {
	switch action {
	case "apply":
		return CommandApply, nil
	case "disable":
		return CommandDisable, nil
	}
	return "", errors.New("unsupported action: " + action)
}

func containerChangeAction(action string) string {
	if action == "apply" {
		return "container_firewall_applied"
	}
	return "container_firewall_disabled"
}
