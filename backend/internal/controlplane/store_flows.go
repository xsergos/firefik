package controlplane

import (
	"context"
	"strings"
	"time"
)

func (s *sqliteStore) RecordFlows(ctx context.Context, batch []FlowRecord) error {
	if len(batch) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.PrepareContext(ctx, `
        INSERT INTO flow_log (bucket, agent_id, action, container, src_ip, dst_port, proto, rule, count, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bucket, agent_id, action, container, src_ip, dst_port, proto, rule) DO UPDATE SET
            count = count + excluded.count,
            first_seen = MIN(first_seen, excluded.first_seen),
            last_seen = MAX(last_seen, excluded.last_seen)
    `)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, r := range batch {
		if _, err := stmt.ExecContext(ctx,
			r.Bucket.Unix(), r.AgentID, r.Action, r.Container, r.SrcIP, r.DstPort, r.Proto, r.Rule,
			r.Count, r.FirstSeen.Unix(), r.LastSeen.Unix(),
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *sqliteStore) QueryFlows(ctx context.Context, q FlowQuery) (FlowResult, error) {
	where := []string{"bucket >= ?"}
	args := []any{q.Since.Truncate(flowBucket).Unix()}
	if q.AgentID != "" {
		where = append(where, "agent_id = ?")
		args = append(args, q.AgentID)
	}
	if q.Container != "" {
		where = append(where, "container = ?")
		args = append(args, q.Container)
	}
	if q.Action != "" {
		where = append(where, "action = ?")
		args = append(args, strings.ToUpper(q.Action))
	}
	if q.Port > 0 {
		where = append(where, "dst_port = ?")
		args = append(args, q.Port)
	}
	if q.Src != "" {
		where = append(where, "substr(src_ip, 1, ?) = ?")
		args = append(args, len(q.Src), q.Src)
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT bucket, agent_id, action, container, src_ip, dst_port, proto, rule, count, first_seen, last_seen
           FROM flow_log WHERE `+strings.Join(where, " AND "), // #nosec G202 -- only fixed column predicates with ? placeholders are joined
		args...,
	)
	if err != nil {
		return FlowResult{}, err
	}
	defer rows.Close()
	var records []FlowRecord
	for rows.Next() {
		var (
			r                   FlowRecord
			bucket, first, last int64
		)
		if err := rows.Scan(&bucket, &r.AgentID, &r.Action, &r.Container, &r.SrcIP, &r.DstPort, &r.Proto, &r.Rule, &r.Count, &first, &last); err != nil {
			return FlowResult{}, err
		}
		r.Bucket = time.Unix(bucket, 0).UTC()
		r.FirstSeen = time.Unix(first, 0).UTC()
		r.LastSeen = time.Unix(last, 0).UTC()
		records = append(records, r)
	}
	if err := rows.Err(); err != nil {
		return FlowResult{}, err
	}
	return aggregateFlows(records, q), nil
}

func (s *sqliteStore) PruneFlows(ctx context.Context, olderThan time.Duration) (int, error) {
	if olderThan <= 0 {
		return 0, nil
	}
	cutoff := time.Now().UTC().Add(-olderThan).Unix()
	res, err := s.db.ExecContext(ctx, `DELETE FROM flow_log WHERE last_seen < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}

func (m *memStore) RecordFlows(_ context.Context, batch []FlowRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.flows == nil {
		m.flows = map[flowKey]FlowRecord{}
	}
	for _, r := range batch {
		k := r.key()
		cur, ok := m.flows[k]
		if !ok {
			m.flows[k] = r
			continue
		}
		cur.Count += r.Count
		if r.FirstSeen.Before(cur.FirstSeen) {
			cur.FirstSeen = r.FirstSeen
		}
		if r.LastSeen.After(cur.LastSeen) {
			cur.LastSeen = r.LastSeen
		}
		m.flows[k] = cur
	}
	return nil
}

func (m *memStore) QueryFlows(_ context.Context, q FlowQuery) (FlowResult, error) {
	m.mu.Lock()
	records := make([]FlowRecord, 0, len(m.flows))
	for _, r := range m.flows {
		records = append(records, r)
	}
	m.mu.Unlock()
	return aggregateFlows(records, q), nil
}

func (m *memStore) PruneFlows(_ context.Context, olderThan time.Duration) (int, error) {
	if olderThan <= 0 {
		return 0, nil
	}
	cutoff := time.Now().UTC().Add(-olderThan)
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for k, r := range m.flows {
		if r.LastSeen.Before(cutoff) {
			delete(m.flows, k)
			n++
		}
	}
	return n, nil
}
