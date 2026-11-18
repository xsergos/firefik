package controlplane

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type agentDTO struct {
	InstanceID  string            `json:"instance_id"`
	Hostname    string            `json:"hostname"`
	Version     string            `json:"version"`
	Backend     string            `json:"backend"`
	Chain       string            `json:"chain"`
	Labels      map[string]string `json:"labels,omitempty"`
	FirstSeen   time.Time         `json:"first_seen"`
	LastSeen    time.Time         `json:"last_seen"`
	EventCount  int               `json:"event_count"`
	HasSnapshot bool              `json:"has_snapshot"`
	Status      string            `json:"status"`
}

const (
	staleThreshold = 90 * time.Second
	deadThreshold  = 5 * time.Minute
)

func agentStatus(lastSeen time.Time, now time.Time) string {
	if lastSeen.IsZero() {
		return "unknown"
	}
	since := now.Sub(lastSeen)
	switch {
	case since < staleThreshold:
		return "healthy"
	case since < deadThreshold:
		return "stale"
	default:
		return "dead"
	}
}

type agentDetailDTO struct {
	Agent    agentDTO       `json:"agent"`
	Snapshot *AgentSnapshot `json:"snapshot,omitempty"`
}

func toAgentDTO(rec AgentRecord) agentDTO {
	return agentDTO{
		InstanceID:  rec.Identity.InstanceID,
		Hostname:    rec.Identity.Hostname,
		Version:     rec.Identity.Version,
		Backend:     rec.Identity.Backend,
		Chain:       rec.Identity.Chain,
		Labels:      stripInternalLabels(rec.Identity.Labels),
		FirstSeen:   rec.FirstSeen,
		LastSeen:    rec.LastSeen,
		EventCount:  rec.EventCount,
		HasSnapshot: rec.HasSnapshot,
		Status:      agentStatus(rec.LastSeen, time.Now().UTC()),
	}
}

func (s *HTTPServer) handleAgents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	records, err := s.Registry.store.ListAgents(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]agentDTO, 0, len(records))
	for _, rec := range records {
		out = append(out, toAgentDTO(rec))
	}
	writeJSON(w, http.StatusOK, out)
}

type commandRequest struct {
	Action      string `json:"action"`
	ContainerID string `json:"container_id,omitempty"`
}

type commandResponse struct {
	ID      string `json:"id"`
	AgentID string `json:"agent_id"`
	Action  string `json:"action"`
}

func (s *HTTPServer) handleAgent(w http.ResponseWriter, r *http.Request) {
	id, sub := agentIDFromPath(r.URL.Path)
	if id == "" {
		http.Error(w, "agent id required", http.StatusBadRequest)
		return
	}

	rec, ok, err := s.Registry.store.GetAgent(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "agent not found", http.StatusNotFound)
		return
	}

	switch {
	case sub == "" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, agentDetailDTO{Agent: toAgentDTO(rec)})
	case sub == "" && r.Method == http.MethodDelete:
		s.deleteAgent(w, r, rec)
	case sub == "snapshot" && r.Method == http.MethodGet:
		snap, err := s.Registry.store.LatestSnapshot(r.Context(), id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, agentDetailDTO{Agent: toAgentDTO(rec), Snapshot: snap})
	case sub == "stats" && r.Method == http.MethodGet:
		s.handleAgentStatsPull(w, r, id)
	case sub == "commands" && r.Method == http.MethodPost:
		s.dispatchCommand(w, r, id)
	case sub == "logs" && r.Method == http.MethodGet:
		s.streamLogs(w, r, id)
	default:
		http.Error(w, "method or subresource not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *HTTPServer) deleteAgent(w http.ResponseWriter, r *http.Request, rec AgentRecord) {
	id := rec.Identity.InstanceID
	if agentStatus(rec.LastSeen, time.Now().UTC()) == "healthy" {
		http.Error(w, "agent is online and would re-register; stop it before deleting", http.StatusConflict)
		return
	}
	removed, err := s.Registry.RemoveAgent(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !removed {
		http.Error(w, "agent not found", http.StatusNotFound)
		return
	}
	s.recordChange(r, "agent_deleted", id, map[string]string{
		"hostname":  rec.Identity.Hostname,
		"last_seen": rec.LastSeen.UTC().Format(time.RFC3339),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (s *HTTPServer) dispatchCommand(w http.ResponseWriter, r *http.Request, agentID string) {
	var req commandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	kind, err := parseCommandAction(req.Action)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if (kind == CommandApply || kind == CommandDisable) && req.ContainerID == "" {
		http.Error(w, "container_id required for "+req.Action, http.StatusBadRequest)
		return
	}
	cmd := Command{
		ID:          newCommandID(),
		Kind:        kind,
		ContainerID: req.ContainerID,
		IssuedAt:    time.Now().UTC(),
	}
	s.Registry.Enqueue(agentID, cmd)
	s.recordChange(r, "agent_command", agentID, map[string]string{
		"command_id":   cmd.ID,
		"command":      string(kind),
		"container_id": req.ContainerID,
	})
	writeJSON(w, http.StatusAccepted, commandResponse{ID: cmd.ID, AgentID: agentID, Action: string(kind)})
}

func parseCommandAction(action string) (CommandKind, error) {
	switch strings.ToLower(action) {
	case "apply":
		return CommandApply, nil
	case "disable":
		return CommandDisable, nil
	case "reconcile":
		return CommandReconcile, nil
	case "token_rotate", "token-rotate":
		return CommandTokenRotate, nil
	default:
		return "", &actionError{action: action}
	}
}

type actionError struct{ action string }

func (e *actionError) Error() string {
	return "unsupported action: " + e.action + " (allowed: apply, disable, reconcile, token_rotate)"
}

func newCommandID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func agentIDFromPath(path string) (id, sub string) {
	rest := strings.TrimPrefix(path, "/v1/agents/")
	if rest == path || rest == "" {
		return "", ""
	}
	parts := strings.SplitN(rest, "/", 2)
	id = parts[0]
	if len(parts) == 2 {
		sub = parts[1]
	}
	return id, sub
}
