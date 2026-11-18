package controlplane

import (
	"context"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultFlowRetention     = 7 * 24 * time.Hour
	DefaultFlowFlushInterval = 10 * time.Second
	flowBucket               = time.Hour
	maxFlowQueryLimit        = 1000
	defaultFlowQueryLimit    = 200
	maxPendingFlowKeys       = 50000
)

type FlowRecord struct {
	Bucket    time.Time
	AgentID   string
	Action    string
	Container string
	SrcIP     string
	DstPort   int
	Proto     string
	Rule      string
	Count     int64
	FirstSeen time.Time
	LastSeen  time.Time
}

type flowKey struct {
	bucket    int64
	agentID   string
	action    string
	container string
	srcIP     string
	dstPort   int
	proto     string
	rule      string
}

func (r FlowRecord) key() flowKey {
	return flowKey{
		bucket:    r.Bucket.Unix(),
		agentID:   r.AgentID,
		action:    r.Action,
		container: r.Container,
		srcIP:     r.SrcIP,
		dstPort:   r.DstPort,
		proto:     r.Proto,
		rule:      r.Rule,
	}
}

type FlowQuery struct {
	AgentID   string
	Container string
	Src       string
	Action    string
	Port      int
	Since     time.Time
	Limit     int
}

type FlowRow struct {
	AgentID   string    `json:"agent_id"`
	Action    string    `json:"action"`
	Container string    `json:"container"`
	SrcIP     string    `json:"src_ip"`
	DstPort   int       `json:"dst_port"`
	Proto     string    `json:"proto"`
	Rule      string    `json:"rule"`
	Count     int64     `json:"count"`
	FirstSeen time.Time `json:"first_seen"`
	LastSeen  time.Time `json:"last_seen"`
}

type FlowSummary struct {
	Total         int64 `json:"total"`
	UniqueSources int   `json:"unique_sources"`
	TopPort       int   `json:"top_port"`
	TopPortCount  int64 `json:"top_port_count"`
}

type FlowHour struct {
	At    time.Time `json:"at"`
	Count int64     `json:"count"`
}

type FlowResult struct {
	Rows    []FlowRow   `json:"rows"`
	Summary FlowSummary `json:"summary"`
	Hourly  []FlowHour  `json:"hourly"`
}

func (q FlowQuery) normalisedLimit() int {
	switch {
	case q.Limit <= 0:
		return defaultFlowQueryLimit
	case q.Limit > maxFlowQueryLimit:
		return maxFlowQueryLimit
	}
	return q.Limit
}

func (q FlowQuery) matches(r FlowRecord) bool {
	if !q.Since.IsZero() && r.Bucket.Before(q.Since.Truncate(flowBucket)) {
		return false
	}
	if q.AgentID != "" && r.AgentID != q.AgentID {
		return false
	}
	if q.Container != "" && r.Container != q.Container {
		return false
	}
	if q.Action != "" && !strings.EqualFold(r.Action, q.Action) {
		return false
	}
	if q.Port > 0 && r.DstPort != q.Port {
		return false
	}
	if q.Src != "" && !strings.HasPrefix(r.SrcIP, q.Src) {
		return false
	}
	return true
}

func aggregateFlows(records []FlowRecord, q FlowQuery) FlowResult {
	type rowKey struct {
		agentID, action, container, srcIP, proto, rule string
		dstPort                                        int
	}
	rows := map[rowKey]*FlowRow{}
	hours := map[int64]int64{}
	ports := map[int]int64{}
	sources := map[string]struct{}{}
	var total int64
	for _, r := range records {
		if !q.matches(r) {
			continue
		}
		total += r.Count
		hours[r.Bucket.Unix()] += r.Count
		ports[r.DstPort] += r.Count
		if r.SrcIP != "" {
			sources[r.SrcIP] = struct{}{}
		}
		k := rowKey{r.AgentID, r.Action, r.Container, r.SrcIP, r.Proto, r.Rule, r.DstPort}
		row, ok := rows[k]
		if !ok {
			row = &FlowRow{
				AgentID: r.AgentID, Action: r.Action, Container: r.Container, SrcIP: r.SrcIP,
				DstPort: r.DstPort, Proto: r.Proto, Rule: r.Rule,
				FirstSeen: r.FirstSeen, LastSeen: r.LastSeen,
			}
			rows[k] = row
		}
		row.Count += r.Count
		if r.FirstSeen.Before(row.FirstSeen) {
			row.FirstSeen = r.FirstSeen
		}
		if r.LastSeen.After(row.LastSeen) {
			row.LastSeen = r.LastSeen
		}
	}
	out := FlowResult{Rows: make([]FlowRow, 0, len(rows)), Hourly: make([]FlowHour, 0, len(hours))}
	for _, row := range rows {
		out.Rows = append(out.Rows, *row)
	}
	sort.Slice(out.Rows, func(i, j int) bool {
		if !out.Rows[i].LastSeen.Equal(out.Rows[j].LastSeen) {
			return out.Rows[i].LastSeen.After(out.Rows[j].LastSeen)
		}
		return out.Rows[i].Count > out.Rows[j].Count
	})
	if limit := q.normalisedLimit(); len(out.Rows) > limit {
		out.Rows = out.Rows[:limit]
	}
	for at, c := range hours {
		out.Hourly = append(out.Hourly, FlowHour{At: time.Unix(at, 0).UTC(), Count: c})
	}
	sort.Slice(out.Hourly, func(i, j int) bool { return out.Hourly[i].At.Before(out.Hourly[j].At) })
	out.Summary.Total = total
	out.Summary.UniqueSources = len(sources)
	for port, c := range ports {
		if c > out.Summary.TopPortCount || (c == out.Summary.TopPortCount && port < out.Summary.TopPort) {
			out.Summary.TopPort = port
			out.Summary.TopPortCount = c
		}
	}
	return out
}

func flowRecordFromFields(agentID string, at time.Time, fields map[string]string) (FlowRecord, bool) {
	if fields == nil || fields["event"] != "" {
		return FlowRecord{}, false
	}
	if at.IsZero() {
		at = time.Now().UTC()
	}
	at = at.UTC()
	port, _ := strconv.Atoi(fields["dstPort"])
	rec := FlowRecord{
		Bucket:    at.Truncate(flowBucket),
		AgentID:   agentID,
		Action:    strings.ToUpper(fields["action"]),
		Container: fields["container"],
		SrcIP:     fields["srcIP"],
		DstPort:   port,
		Proto:     strings.ToUpper(fields["proto"]),
		Rule:      fields["rule"],
		Count:     1,
		FirstSeen: at,
		LastSeen:  at,
	}
	if rec.SrcIP == "" && rec.DstPort == 0 && rec.Action == "" {
		return FlowRecord{}, false
	}
	return rec, true
}

type FlowAggregator struct {
	mu      sync.Mutex
	pending map[flowKey]*FlowRecord
	store   Store
	logger  *slog.Logger
	dropped int64
}

func NewFlowAggregator(store Store, logger *slog.Logger) *FlowAggregator {
	return &FlowAggregator{pending: map[flowKey]*FlowRecord{}, store: store, logger: logger}
}

func (a *FlowAggregator) Add(rec FlowRecord) {
	a.mu.Lock()
	defer a.mu.Unlock()
	k := rec.key()
	if cur, ok := a.pending[k]; ok {
		cur.Count += rec.Count
		if rec.LastSeen.After(cur.LastSeen) {
			cur.LastSeen = rec.LastSeen
		}
		if rec.FirstSeen.Before(cur.FirstSeen) {
			cur.FirstSeen = rec.FirstSeen
		}
		return
	}
	if len(a.pending) >= maxPendingFlowKeys {
		a.dropped++
		return
	}
	r := rec
	a.pending[k] = &r
}

func (a *FlowAggregator) Flush(ctx context.Context) error {
	a.mu.Lock()
	if len(a.pending) == 0 {
		a.mu.Unlock()
		return nil
	}
	batch := make([]FlowRecord, 0, len(a.pending))
	for _, r := range a.pending {
		batch = append(batch, *r)
	}
	a.pending = map[flowKey]*FlowRecord{}
	dropped := a.dropped
	a.dropped = 0
	a.mu.Unlock()
	if dropped > 0 && a.logger != nil {
		a.logger.Warn("flow log aggregator overflow; events dropped", "count", dropped)
	}
	return a.store.RecordFlows(ctx, batch)
}

func (a *FlowAggregator) Run(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = DefaultFlowFlushInterval
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := a.Flush(flushCtx); err != nil && a.logger != nil {
				a.logger.Warn("flow log final flush failed", "error", err)
			}
			cancel()
			return
		case <-t.C:
			if err := a.Flush(ctx); err != nil && a.logger != nil {
				a.logger.Warn("flow log flush failed", "error", err)
			}
		}
	}
}
