package controlplane

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (s *HTTPServer) handleTemplates(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		list, err := s.Registry.store.ListTemplates(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, list)
	case http.MethodPost:
		var t PolicyTemplate
		if err := json.NewDecoder(r.Body).Decode(&t); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if t.Name == "" {
			http.Error(w, "name required", http.StatusBadRequest)
			return
		}
		t.Publisher = callerFingerprint(r)
		out, err := s.Registry.store.PublishTemplate(r.Context(), t)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		s.recordChange(r, "template_published", "", map[string]string{
			"template": out.Name,
			"version":  strconv.FormatInt(out.Version, 10),
		})
		writeJSON(w, http.StatusOK, out)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *HTTPServer) handleTemplate(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/v1/templates/")
	if name == "" {
		http.Error(w, "name required", http.StatusBadRequest)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	t, err := s.Registry.store.GetTemplate(r.Context(), name)
	if err != nil {
		if errors.Is(err, ErrTemplateNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *HTTPServer) handleApprovals(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		statusFilter := ApprovalStatus(r.URL.Query().Get("status"))
		list, err := s.Registry.store.ListApprovals(r.Context(), statusFilter)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, list)
	case http.MethodPost:
		var p PendingApproval
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		p.RequesterFinger = callerFingerprint(r)
		if p.Requester == "" {
			p.Requester = "operator"
		}
		out, err := s.Registry.store.CreateApproval(r.Context(), p)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		s.recordAndEmit(r.Context(), "policy_approval_requested", out.ID, map[string]string{
			"approval_id":  out.ID,
			"policy_name":  out.PolicyName,
			"requester":    out.Requester,
			"requester_fp": out.RequesterFinger,
		})
		writeJSON(w, http.StatusOK, out)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *HTTPServer) emit(action string, metadata map[string]string) {
	if s.Audit == nil {
		return
	}
	s.Audit.Emit(action, metadata)
}

func (s *HTTPServer) recordAndEmit(ctx context.Context, action, refID string, metadata map[string]string) {
	if s.Registry != nil && s.Registry.store != nil {
		payload := map[string]any{"ref_id": refID}
		for k, v := range metadata {
			payload[k] = v
		}
		_ = s.Registry.store.RecordAudit(ctx, "", action, payload, time.Now().UTC())
	}
	s.emit(action, metadata)
}

func callerFingerprint(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	tok := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	return bearerFingerprint(tok)
}

func operatorFingerprint(r *http.Request) string {
	for _, h := range []string{"X-Auth-Subject", "X-Forwarded-User", "X-Auth-Request-User", "X-Forwarded-Email"} {
		if v := strings.TrimSpace(r.Header.Get(h)); v != "" {
			return v
		}
	}
	base := callerFingerprint(r)
	if ip := requestClientIP(r); ip != "" {
		return base + "@" + ip
	}
	return base
}

func (s *HTTPServer) attribute(r *http.Request) string {
	if sess, ok := s.sessionFromRequest(r); ok && sess.Username != "" {
		if ip := requestClientIP(r); ip != "" {
			return sess.Username + "@" + ip
		}
		return sess.Username
	}
	return operatorFingerprint(r)
}

func requestClientIP(r *http.Request) string {
	if v := strings.TrimSpace(r.Header.Get("X-Real-IP")); v != "" {
		return v
	}
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if i := strings.IndexByte(fwd, ','); i >= 0 {
			return strings.TrimSpace(fwd[:i])
		}
		return strings.TrimSpace(fwd)
	}
	if r.RemoteAddr == "" {
		return ""
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *HTTPServer) handleApproval(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/approvals/")
	if rest == "" {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	parts := strings.SplitN(rest, "/", 2)
	id := parts[0]
	action := ""
	if len(parts) == 2 {
		action = parts[1]
	}
	switch {
	case r.Method == http.MethodGet && action == "":
		p, err := s.Registry.store.GetApproval(r.Context(), id)
		if err != nil {
			if errors.Is(err, ErrApprovalNotFound) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, p)
	case r.Method == http.MethodPost && action == "approve":
		var body struct {
			Approver string `json:"approver"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		approver := body.Approver
		if approver == "" {
			approver = "operator"
		}
		out, err := s.Registry.store.ApproveApproval(r.Context(), id, approver, callerFingerprint(r))
		if err != nil {
			writeApprovalError(w, err)
			return
		}
		meta := map[string]string{
			"approval_id": out.ID,
			"policy_name": out.PolicyName,
			"approver":    out.Approver,
			"approver_fp": out.ApproverFinger,
		}
		s.recordAndEmit(r.Context(), "policy_approval_approved", out.ID, meta)
		writeJSON(w, http.StatusOK, out)
	case r.Method == http.MethodPost && action == "reject":
		var body struct {
			Approver string `json:"approver"`
			Comment  string `json:"comment"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		approver := body.Approver
		if approver == "" {
			approver = "operator"
		}
		out, err := s.Registry.store.RejectApproval(r.Context(), id, approver, callerFingerprint(r), body.Comment)
		if err != nil {
			writeApprovalError(w, err)
			return
		}
		meta := map[string]string{
			"approval_id": out.ID,
			"policy_name": out.PolicyName,
			"approver":    out.Approver,
			"approver_fp": out.ApproverFinger,
			"comment":     out.RejectionComment,
		}
		s.recordAndEmit(r.Context(), "policy_approval_rejected", out.ID, meta)
		writeJSON(w, http.StatusOK, out)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func writeApprovalError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrApprovalNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.Is(err, ErrSelfApprove):
		http.Error(w, "self-approve forbidden", http.StatusForbidden)
	case errors.Is(err, ErrApprovalNotPending):
		http.Error(w, "not pending", http.StatusConflict)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func bearerFingerprint(token string) string {
	if token == "" {
		return "anonymous"
	}
	sum := sha256.Sum256([]byte(token))
	return "fp:" + hex.EncodeToString(sum[:8])
}
