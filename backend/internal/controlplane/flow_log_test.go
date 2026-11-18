package controlplane

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func flowFields(action, src, port, container, rule string) map[string]string {
	return map[string]string{
		"action": action, "srcIP": src, "dstPort": port, "container": container,
		"rule": rule, "proto": "TCP", "ts": "2026-11-18T10:00:00Z",
	}
}

func TestFlowRecordFromFields(t *testing.T) {
	at := time.Date(2026, 11, 18, 10, 42, 7, 0, time.UTC)
	rec, ok := flowRecordFromFields("a1", at, flowFields("drop", "1.2.3.4", "22", "host", "host ssh"))
	if !ok {
		t.Fatal("expected record")
	}
	if rec.Action != "DROP" || rec.DstPort != 22 || rec.Count != 1 || rec.Rule != "host ssh" {
		t.Fatalf("unexpected record: %+v", rec)
	}
	if !rec.Bucket.Equal(time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("bucket = %v", rec.Bucket)
	}
	if _, ok := flowRecordFromFields("a1", at, map[string]string{"event": "dropped", "count": "3"}); ok {
		t.Fatal("control events must be skipped")
	}
	if _, ok := flowRecordFromFields("a1", at, nil); ok {
		t.Fatal("nil fields must be skipped")
	}
}

func TestRegistryPublishLogFeedsFlowLog(t *testing.T) {
	store := NewMemoryStore()
	reg := NewRegistryWithStore(nil, store)
	now := time.Now().UTC()
	for i := 0; i < 3; i++ {
		reg.PublishLog(LogLine{
			Agent: AgentIdentity{InstanceID: "a1"}, At: now, Source: "nflog",
			Fields: flowFields("DROP", "185.220.101.7", "22", "host", "host ssh"),
		})
	}
	reg.PublishLog(LogLine{Agent: AgentIdentity{InstanceID: "a1"}, At: now, Source: "stdout", Line: "hello"})
	if err := reg.FlushFlows(context.Background()); err != nil {
		t.Fatal(err)
	}
	res, err := store.QueryFlows(context.Background(), FlowQuery{Since: now.Add(-time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Rows) != 1 || res.Rows[0].Count != 3 || res.Summary.Total != 3 {
		t.Fatalf("unexpected result: %+v", res)
	}
}

func seedFlows(t *testing.T, s Store, now time.Time) {
	t.Helper()
	recs := []FlowRecord{}
	add := func(agent, action, container, src string, port int, rule string, count int64, at time.Time) {
		recs = append(recs, FlowRecord{
			Bucket: at.Truncate(flowBucket), AgentID: agent, Action: action, Container: container,
			SrcIP: src, DstPort: port, Proto: "TCP", Rule: rule, Count: count, FirstSeen: at, LastSeen: at,
		})
	}
	add("a1", "DROP", "host", "185.220.101.7", 22, "host ssh", 40, now.Add(-10*time.Minute))
	add("a1", "DROP", "host", "185.220.101.9", 22, "host ssh", 2, now.Add(-2*time.Hour))
	add("a2", "DROP", "web", "45.155.205.233", 8080, "default", 9, now.Add(-30*time.Minute))
	add("a2", "ACCEPT", "web", "10.0.0.5", 443, "web", 5, now.Add(-5*time.Minute))
	add("a1", "DROP", "host", "1.1.1.1", 22, "host ssh", 100, now.Add(-10*24*time.Hour))
	if err := s.RecordFlows(context.Background(), recs); err != nil {
		t.Fatal(err)
	}
}

func testFlowStore(t *testing.T, s Store) {
	ctx := context.Background()
	now := time.Now().UTC()
	seedFlows(t, s, now)

	if err := s.RecordFlows(ctx, []FlowRecord{{
		Bucket: now.Add(-10 * time.Minute).Truncate(flowBucket), AgentID: "a1", Action: "DROP", Container: "host",
		SrcIP: "185.220.101.7", DstPort: 22, Proto: "TCP", Rule: "host ssh", Count: 2,
		FirstSeen: now.Add(-10 * time.Minute), LastSeen: now.Add(-time.Minute),
	}}); err != nil {
		t.Fatal(err)
	}

	res, err := s.QueryFlows(ctx, FlowQuery{Since: now.Add(-24 * time.Hour), Action: "DROP"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Summary.Total != 53 || res.Summary.UniqueSources != 3 || res.Summary.TopPort != 22 || res.Summary.TopPortCount != 44 {
		t.Fatalf("summary: %+v", res.Summary)
	}
	if len(res.Rows) != 3 || res.Rows[0].SrcIP != "185.220.101.7" || res.Rows[0].Count != 42 {
		t.Fatalf("rows: %+v", res.Rows)
	}
	if len(res.Hourly) == 0 {
		t.Fatal("expected hourly buckets")
	}

	byPrefix, _ := s.QueryFlows(ctx, FlowQuery{Since: now.Add(-24 * time.Hour), Src: "185.220."})
	if byPrefix.Summary.Total != 44 {
		t.Fatalf("src prefix total = %d", byPrefix.Summary.Total)
	}
	byAgent, _ := s.QueryFlows(ctx, FlowQuery{Since: now.Add(-24 * time.Hour), AgentID: "a2", Port: 8080})
	if byAgent.Summary.Total != 9 || len(byAgent.Rows) != 1 || byAgent.Rows[0].Rule != "default" {
		t.Fatalf("agent+port: %+v", byAgent)
	}
	week, _ := s.QueryFlows(ctx, FlowQuery{Since: now.Add(-14 * 24 * time.Hour), Container: "host"})
	if week.Summary.Total != 144 {
		t.Fatalf("14d host total = %d", week.Summary.Total)
	}
	limited, _ := s.QueryFlows(ctx, FlowQuery{Since: now.Add(-24 * time.Hour), Limit: 1})
	if len(limited.Rows) != 1 || limited.Summary.Total != 58 {
		t.Fatalf("limit must cut rows but not totals: %+v", limited)
	}

	n, err := s.PruneFlows(ctx, 7*24*time.Hour)
	if err != nil || n != 1 {
		t.Fatalf("prune = %d, %v", n, err)
	}
	if n, _ := s.PruneFlows(ctx, 0); n != 0 {
		t.Fatalf("zero retention must keep rows, pruned %d", n)
	}
}

func TestMemoryStoreFlows(t *testing.T) {
	testFlowStore(t, NewMemoryStore())
}

func TestSQLiteStoreFlows(t *testing.T) {
	s, err := NewSQLiteStore(context.Background(), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	testFlowStore(t, s)
}

func TestParseFlowSince(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	cases := map[string]time.Time{
		"":                     now.Add(-24 * time.Hour),
		"1h":                   now.Add(-time.Hour),
		"7d":                   now.Add(-7 * 24 * time.Hour),
		"2026-11-17T00:00:00Z": time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC),
	}
	for in, want := range cases {
		got, err := parseFlowSince(in, now)
		if err != nil || !got.Equal(want) {
			t.Errorf("parseFlowSince(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, bad := range []string{"x", "-1h", "0d", "abcd"} {
		if _, err := parseFlowSince(bad, now); err == nil {
			t.Errorf("parseFlowSince(%q) should fail", bad)
		}
	}
}

func TestHTTP_Flows(t *testing.T) {
	srv, store := newTestHTTPServer(t)
	seedFlows(t, store, time.Now().UTC())

	rec := doReq(t, srv.Handler(), http.MethodGet, "/v1/flows?action=drop&since=24h", "", "secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d body=%s", rec.Code, rec.Body.String())
	}
	var out FlowResult
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Summary.Total != 51 {
		t.Fatalf("total = %d", out.Summary.Total)
	}

	for _, q := range []string{"action=reject", "port=0", "port=x", "since=bogus", "limit=-1"} {
		rec := doReq(t, srv.Handler(), http.MethodGet, "/v1/flows?"+q, "", "secret")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d want 400", q, rec.Code)
		}
	}
	if rec := doReq(t, srv.Handler(), http.MethodGet, "/v1/flows", "", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("no auth: got %d", rec.Code)
	}
	if rec := doReq(t, srv.Handler(), http.MethodPost, "/v1/flows", "", "secret"); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("post: got %d", rec.Code)
	}
}
