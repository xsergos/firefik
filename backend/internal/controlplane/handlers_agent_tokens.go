package controlplane

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type createAgentTokenRequest struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

func (s *HTTPServer) handleAgentTokens(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		s.createAgentToken(w, r)
	case http.MethodGet:
		s.listAgentTokens(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *HTTPServer) createAgentToken(w http.ResponseWriter, r *http.Request) {
	var req createAgentTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		http.Error(w, "name is required", http.StatusBadRequest)
		return
	}
	issued, err := s.Registry.store.CreateAgentToken(r.Context(), req.Name, req.Description, s.attribute(r))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.recordChange(r, "agent_token_created", "", map[string]string{
		"id":   issued.ID,
		"name": issued.Name,
	})
	writeJSON(w, http.StatusCreated, issued)
}

func (s *HTTPServer) listAgentTokens(w http.ResponseWriter, r *http.Request) {
	includeRevoked := r.URL.Query().Get("include_revoked") == "1"
	out, err := s.Registry.store.ListAgentTokens(r.Context(), includeRevoked)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if out == nil {
		out = []AgentToken{}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *HTTPServer) handleAgentTokenItem(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/v1/agent-tokens/")
	if id == "" || strings.Contains(id, "/") {
		http.Error(w, "invalid token id", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodDelete:
		err := s.Registry.store.RevokeAgentToken(r.Context(), id)
		if errors.Is(err, ErrAgentTokenUnknown) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		fields := map[string]string{"id": id}
		if tok, ok, _ := s.Registry.store.GetAgentToken(r.Context(), id); ok {
			fields["name"] = tok.Name
		}
		s.recordChange(r, "agent_token_revoked", "", fields)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
