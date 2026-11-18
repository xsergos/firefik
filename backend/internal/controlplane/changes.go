package controlplane

import (
	"net/http"
	"time"
)

const changeSourcePanel = "panel"

func (s *HTTPServer) recordChange(r *http.Request, action, agentID string, fields map[string]string) {
	actor := s.attribute(r)
	meta := make(map[string]string, len(fields)+2)
	for k, v := range fields {
		if v != "" {
			meta[k] = v
		}
	}
	meta["actor"] = actor
	if _, ok := meta["source"]; !ok {
		meta["source"] = changeSourcePanel
	}
	if agentID != "" {
		meta["agent_id"] = agentID
	}
	if s.Registry != nil && s.Registry.store != nil {
		payload := make(map[string]any, len(meta))
		for k, v := range meta {
			payload[k] = v
		}
		if err := s.Registry.store.RecordAudit(r.Context(), agentID, action, payload, time.Now().UTC()); err != nil && s.Registry.logger != nil {
			s.Registry.logger.Warn("record change failed", "action", action, "error", err)
		}
	}
	s.emit(action, meta)
}
