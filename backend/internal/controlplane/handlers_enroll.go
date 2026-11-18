package controlplane

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"time"
)

type createEnrollmentTokenRequest struct {
	AgentID    string `json:"agent_id"`
	TTLSeconds int    `json:"ttl_seconds,omitempty"`
}

type createEnrollmentTokenResponse struct {
	Token     string    `json:"token"`
	AgentID   string    `json:"agent_id"`
	ExpiresAt time.Time `json:"expires_at"`
	IssuedAt  time.Time `json:"issued_at"`
}

const (
	defaultTokenTTL = 15 * time.Minute
	maxTokenTTL     = 24 * time.Hour
)

func (s *HTTPServer) handleEnrollmentTokens(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		s.createEnrollmentToken(w, r)
	case http.MethodGet:
		s.listEnrollmentTokens(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *HTTPServer) createEnrollmentToken(w http.ResponseWriter, r *http.Request) {
	var req createEnrollmentTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if !validInstanceID(req.AgentID) {
		http.Error(w, "agent_id must match [a-z0-9-]{3,63}", http.StatusBadRequest)
		return
	}
	ttl := time.Duration(req.TTLSeconds) * time.Second
	if ttl <= 0 {
		ttl = defaultTokenTTL
	}
	if ttl > maxTokenTTL {
		http.Error(w, "ttl_seconds exceeds maximum", http.StatusBadRequest)
		return
	}
	token := newEnrollmentTokenID()
	now := time.Now().UTC()
	et := EnrollmentToken{
		Token:      token,
		AgentID:    req.AgentID,
		TTLSeconds: int(ttl.Seconds()),
		ExpiresAt:  now.Add(ttl),
		IssuedBy:   operatorFingerprint(r),
		IssuedAt:   now,
	}
	if err := s.Registry.store.CreateEnrollmentToken(r.Context(), et); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.recordChange(r, "enrollment_token_created", "", map[string]string{
		"for_agent":  req.AgentID,
		"token":      token[:8] + "…",
		"expires_at": et.ExpiresAt.Format(time.RFC3339),
	})
	writeJSON(w, http.StatusCreated, createEnrollmentTokenResponse{
		Token:     token,
		AgentID:   req.AgentID,
		ExpiresAt: et.ExpiresAt,
		IssuedAt:  et.IssuedAt,
	})
}

func (s *HTTPServer) listEnrollmentTokens(w http.ResponseWriter, r *http.Request) {
	includeUsed := r.URL.Query().Get("include_used") == "1"
	out, err := s.Registry.store.ListEnrollmentTokens(r.Context(), includeUsed)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if out == nil {
		out = []EnrollmentToken{}
	}
	writeJSON(w, http.StatusOK, out)
}

func newEnrollmentTokenID() string {
	var b [24]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func validInstanceID(id string) bool {
	if len(id) < 3 || len(id) > 63 {
		return false
	}
	for _, c := range id {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' {
			continue
		}
		return false
	}
	return true
}
