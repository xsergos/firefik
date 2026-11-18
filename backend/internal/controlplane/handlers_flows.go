package controlplane

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const defaultFlowWindow = 24 * time.Hour

func parseFlowSince(raw string, now time.Time) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return now.Add(-defaultFlowWindow), nil
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC(), nil
	}
	if days, ok := strings.CutSuffix(raw, "d"); ok {
		n, err := strconv.Atoi(days)
		if err != nil || n <= 0 {
			return time.Time{}, fmt.Errorf("invalid since %q", raw)
		}
		return now.Add(-time.Duration(n) * 24 * time.Hour), nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return time.Time{}, fmt.Errorf("invalid since %q (use 1h, 24h, 7d or RFC3339)", raw)
	}
	return now.Add(-d), nil
}

func (s *HTTPServer) handleFlows(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.Registry == nil || s.Registry.store == nil {
		http.Error(w, "flow log unavailable", http.StatusServiceUnavailable)
		return
	}
	qs := r.URL.Query()
	since, err := parseFlowSince(qs.Get("since"), time.Now().UTC())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	q := FlowQuery{
		AgentID:   qs.Get("agent_id"),
		Container: qs.Get("container"),
		Src:       strings.TrimSpace(qs.Get("src")),
		Action:    strings.ToUpper(strings.TrimSpace(qs.Get("action"))),
		Since:     since,
	}
	if q.Action != "" && q.Action != "DROP" && q.Action != "ACCEPT" {
		http.Error(w, "action must be DROP or ACCEPT", http.StatusBadRequest)
		return
	}
	if p := qs.Get("port"); p != "" {
		port, err := strconv.Atoi(p)
		if err != nil || port <= 0 || port > 65535 {
			http.Error(w, "invalid port", http.StatusBadRequest)
			return
		}
		q.Port = port
	}
	if l := qs.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n <= 0 {
			http.Error(w, "invalid limit", http.StatusBadRequest)
			return
		}
		q.Limit = n
	}
	if err := s.Registry.FlushFlows(r.Context()); err != nil && s.Registry.logger != nil {
		s.Registry.logger.Warn("flow log flush before query failed", "error", err)
	}
	res, err := s.Registry.store.QueryFlows(r.Context(), q)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, res)
}
