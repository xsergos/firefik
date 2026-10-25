package autogen

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type ProposalStatus string

const (
	StatusPending  ProposalStatus = "pending"
	StatusApproved ProposalStatus = "approved"
	StatusRejected ProposalStatus = "rejected"
	StatusExpired  ProposalStatus = "expired"
)

type ProposalRecord struct {
	ContainerID string
	Ports       []uint16
	Peers       []string
	Confidence  string
	ObservedFor string
	GeneratedAt time.Time
	Status      ProposalStatus
	DecidedAt   time.Time
	DecidedBy   string
	Reason      string
}

type Store interface {
	Observe(ctx context.Context, f Flow) error

	SnapshotByContainer(ctx context.Context, containerID string) (ContainerObservation, error)

	Snapshot(ctx context.Context) (map[string]ContainerObservation, error)

	UpsertProposal(ctx context.Context, p Proposal) error

	ListProposals(ctx context.Context, statuses ...ProposalStatus) ([]ProposalRecord, error)

	MarkProposal(ctx context.Context, containerID string, status ProposalStatus, decidedBy, reason string) error

	PruneObservations(ctx context.Context, olderThan time.Duration) (int, error)

	Close() error
}

type sqliteStore struct {
	db     *sql.DB
	logger *slog.Logger
}

func NewSQLiteStore(ctx context.Context, path string, logger *slog.Logger) (Store, error) {
	if path == "" {
		path = ":memory:"
	}
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("autogen sqlite open: %w", err)
	}
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("autogen sqlite ping: %w", err)
	}
	s := &sqliteStore{db: db, logger: logger}
	if err := s.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("autogen migrate: %w", err)
	}
	return s, nil
}

func (s *sqliteStore) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx,
		"CREATE TABLE IF NOT EXISTS autogen_schema_version (version INTEGER NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
	); err != nil {
		return err
	}
	entries, err := fs.Glob(migrationsFS, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(entries)
	var current int
	row := s.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(version), 0) FROM autogen_schema_version")
	if err := row.Scan(&current); err != nil {
		return err
	}
	for _, entry := range entries {
		name := strings.TrimSuffix(entry[len("migrations/"):], ".sql")
		digits := name
		if i := strings.Index(name, "_"); i > 0 {
			digits = name[:i]
		}
		v, err := strconv.Atoi(digits)
		if err != nil {
			return fmt.Errorf("autogen migration %q: %w", entry, err)
		}
		if v <= current {
			continue
		}
		body, err := migrationsFS.ReadFile(entry)
		if err != nil {
			return err
		}
		if _, err := s.db.ExecContext(ctx, string(body)); err != nil {
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := s.db.ExecContext(ctx,
			"INSERT INTO autogen_schema_version(version) VALUES (?)", v,
		); err != nil {
			return fmt.Errorf("record %s: %w", name, err)
		}
		if s.logger != nil {
			s.logger.Info("autogen db migration applied", "version", v)
		}
	}
	return nil
}

func (s *sqliteStore) Observe(ctx context.Context, f Flow) error {
	if f.ContainerID == "" {
		return errors.New("container_id required")
	}
	if f.At.IsZero() {
		f.At = time.Now().UTC()
	}

	_, err := s.db.ExecContext(ctx, `
        INSERT INTO observations (container_id, proto, port, peer_ip, count, first_at, last_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(container_id, proto, port, peer_ip) DO UPDATE SET
            count = count + 1,
            last_at = excluded.last_at
    `, f.ContainerID, f.Protocol, int(f.Port), f.PeerIP, f.At, f.At)
	return err
}

func (s *sqliteStore) SnapshotByContainer(ctx context.Context, cid string) (ContainerObservation, error) {
	out := ContainerObservation{
		Ports: map[string]*PortObservation{},
		Peers: map[string]*PeerObservation{},
	}
	rows, err := s.db.QueryContext(ctx, `
        SELECT proto, port, peer_ip, count, first_at, last_at
          FROM observations
         WHERE container_id = ?
    `, cid)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var proto, peer string
		var port, count int
		var first, last time.Time
		if err := rows.Scan(&proto, &port, &peer, &count, &first, &last); err != nil {
			return out, err
		}
		key := proto + "/" + portKey(uint16(port)) // #nosec G115 -- column is written from a uint16 port
		if p, ok := out.Ports[key]; ok {
			p.Count += count
			if last.After(p.LastAt) {
				p.LastAt = last
			}
			if first.Before(p.FirstAt) || p.FirstAt.IsZero() {
				p.FirstAt = first
			}
		} else {
			out.Ports[key] = &PortObservation{
				Protocol: proto, Port: uint16(port), Count: count, // #nosec G115 -- column is written from a uint16 port
				FirstAt: first, LastAt: last,
			}
		}
		if peer != "" {
			if pe, ok := out.Peers[peer]; ok {
				pe.Count += count
				if last.After(pe.LastAt) {
					pe.LastAt = last
				}
				if first.Before(pe.FirstAt) || pe.FirstAt.IsZero() {
					pe.FirstAt = first
				}
			} else {
				out.Peers[peer] = &PeerObservation{
					IP: peer, Count: count, FirstAt: first, LastAt: last,
				}
			}
		}
		if last.After(out.Updated) {
			out.Updated = last
		}
	}
	return out, rows.Err()
}

func (s *sqliteStore) Snapshot(ctx context.Context) (map[string]ContainerObservation, error) {
	rows, err := s.db.QueryContext(ctx, `
        SELECT container_id, proto, port, peer_ip, count, first_at, last_at
          FROM observations
    `)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]ContainerObservation{}
	for rows.Next() {
		var cid, proto, peer string
		var port, count int
		var first, last time.Time
		if err := rows.Scan(&cid, &proto, &port, &peer, &count, &first, &last); err != nil {
			return nil, err
		}
		co, ok := out[cid]
		if !ok {
			co = ContainerObservation{
				Ports: map[string]*PortObservation{},
				Peers: map[string]*PeerObservation{},
			}
		}
		key := proto + "/" + portKey(uint16(port)) // #nosec G115 -- column is written from a uint16 port
		co.Ports[key] = &PortObservation{
			Protocol: proto, Port: uint16(port), Count: count, // #nosec G115 -- column is written from a uint16 port
			FirstAt: first, LastAt: last,
		}
		if peer != "" {
			co.Peers[peer] = &PeerObservation{
				IP: peer, Count: count, FirstAt: first, LastAt: last,
			}
		}
		if last.After(co.Updated) {
			co.Updated = last
		}
		out[cid] = co
	}
	return out, rows.Err()
}

func (s *sqliteStore) UpsertProposal(ctx context.Context, p Proposal) error {
	portsJSON, _ := json.Marshal(p.Ports)
	peersJSON, _ := json.Marshal(p.Peers)
	_, err := s.db.ExecContext(ctx, `
        INSERT INTO proposals (container_id, ports_json, peers_json, confidence, observed_for, generated_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
        ON CONFLICT(container_id) DO UPDATE SET
            ports_json   = excluded.ports_json,
            peers_json   = excluded.peers_json,
            confidence   = excluded.confidence,
            observed_for = excluded.observed_for,
            generated_at = excluded.generated_at
            -- status NOT updated when operator already decided
    `, p.ContainerID, string(portsJSON), string(peersJSON), p.Confidence, p.ObservedFor, time.Now().UTC())
	return err
}

func (s *sqliteStore) ListProposals(ctx context.Context, statuses ...ProposalStatus) ([]ProposalRecord, error) {
	query := `SELECT container_id, ports_json, peers_json, confidence, observed_for,
                     generated_at, status, decided_at, decided_by, reason
                FROM proposals`
	var args []any
	if len(statuses) > 0 {
		placeholders := make([]string, 0, len(statuses))
		for _, s := range statuses {
			placeholders = append(placeholders, "?")
			args = append(args, string(s))
		}
		query += " WHERE status IN (" + strings.Join(placeholders, ",") + ")" // #nosec G202 -- only ? placeholders are concatenated
	}
	query += " ORDER BY generated_at DESC"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProposalRecord
	for rows.Next() {
		var (
			rec         ProposalRecord
			portsJSON   string
			peersJSON   string
			status      string
			decidedAt   sql.NullTime
			decidedBy   sql.NullString
			reason      sql.NullString
			observedFor sql.NullString
		)
		if err := rows.Scan(&rec.ContainerID, &portsJSON, &peersJSON, &rec.Confidence, &observedFor,
			&rec.GeneratedAt, &status, &decidedAt, &decidedBy, &reason); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(portsJSON), &rec.Ports)
		_ = json.Unmarshal([]byte(peersJSON), &rec.Peers)
		rec.Status = ProposalStatus(status)
		if observedFor.Valid {
			rec.ObservedFor = observedFor.String
		}
		if decidedAt.Valid {
			rec.DecidedAt = decidedAt.Time
		}
		if decidedBy.Valid {
			rec.DecidedBy = decidedBy.String
		}
		if reason.Valid {
			rec.Reason = reason.String
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

func (s *sqliteStore) MarkProposal(ctx context.Context, cid string, status ProposalStatus, decidedBy, reason string) error {
	if cid == "" {
		return errors.New("container_id required")
	}
	_, err := s.db.ExecContext(ctx, `
        UPDATE proposals
           SET status = ?, decided_at = ?, decided_by = ?, reason = ?
         WHERE container_id = ?
    `, string(status), time.Now().UTC(), decidedBy, reason, cid)
	return err
}

func (s *sqliteStore) PruneObservations(ctx context.Context, olderThan time.Duration) (int, error) {
	if olderThan <= 0 {
		return 0, nil
	}
	cutoff := time.Now().UTC().Add(-olderThan)
	res, err := s.db.ExecContext(ctx, "DELETE FROM observations WHERE last_at < ?", cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

func (s *sqliteStore) Close() error { return s.db.Close() }

type memStore struct {
	mu        sync.Mutex
	obs       map[string]ContainerObservation
	proposals map[string]ProposalRecord
}

func NewMemoryStore() Store {
	return &memStore{
		obs:       map[string]ContainerObservation{},
		proposals: map[string]ProposalRecord{},
	}
}

func (m *memStore) Observe(_ context.Context, f Flow) error {
	if f.ContainerID == "" {
		return errors.New("container_id required")
	}
	if f.At.IsZero() {
		f.At = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	co, ok := m.obs[f.ContainerID]
	if !ok {
		co = ContainerObservation{
			Ports: map[string]*PortObservation{},
			Peers: map[string]*PeerObservation{},
		}
	}
	co.Updated = f.At
	if f.Port > 0 {
		key := f.Protocol + "/" + portKey(f.Port)
		p, ok := co.Ports[key]
		if !ok {
			p = &PortObservation{Protocol: f.Protocol, Port: f.Port, FirstAt: f.At}
			co.Ports[key] = p
		}
		p.Count++
		p.LastAt = f.At
	}
	if f.PeerIP != "" {
		pe, ok := co.Peers[f.PeerIP]
		if !ok {
			pe = &PeerObservation{IP: f.PeerIP, FirstAt: f.At}
			co.Peers[f.PeerIP] = pe
		}
		pe.Count++
		pe.LastAt = f.At
	}
	m.obs[f.ContainerID] = co
	return nil
}

func (m *memStore) SnapshotByContainer(_ context.Context, cid string) (ContainerObservation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return cloneObservation(m.obs[cid]), nil
}

func (m *memStore) Snapshot(_ context.Context) (map[string]ContainerObservation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]ContainerObservation, len(m.obs))
	for k, v := range m.obs {
		out[k] = cloneObservation(v)
	}
	return out, nil
}

func (m *memStore) UpsertProposal(_ context.Context, p Proposal) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	existing, ok := m.proposals[p.ContainerID]
	rec := ProposalRecord{
		ContainerID: p.ContainerID,
		Ports:       append([]uint16{}, p.Ports...),
		Peers:       append([]string{}, p.Peers...),
		Confidence:  p.Confidence,
		ObservedFor: p.ObservedFor,
		GeneratedAt: time.Now().UTC(),
		Status:      StatusPending,
	}
	if ok && existing.Status != "" {
		rec.Status = existing.Status
		rec.DecidedAt = existing.DecidedAt
		rec.DecidedBy = existing.DecidedBy
		rec.Reason = existing.Reason
	}
	m.proposals[p.ContainerID] = rec
	return nil
}

func (m *memStore) ListProposals(_ context.Context, statuses ...ProposalStatus) ([]ProposalRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	want := func(s ProposalStatus) bool {
		if len(statuses) == 0 {
			return true
		}
		for _, st := range statuses {
			if st == s {
				return true
			}
		}
		return false
	}
	var out []ProposalRecord
	for _, rec := range m.proposals {
		if want(rec.Status) {
			out = append(out, rec)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GeneratedAt.After(out[j].GeneratedAt) })
	return out, nil
}

func (m *memStore) MarkProposal(_ context.Context, cid string, status ProposalStatus, decidedBy, reason string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.proposals[cid]
	if !ok {
		return errors.New("proposal not found")
	}
	rec.Status = status
	rec.DecidedAt = time.Now().UTC()
	rec.DecidedBy = decidedBy
	rec.Reason = reason
	m.proposals[cid] = rec
	return nil
}

func (m *memStore) PruneObservations(_ context.Context, _ time.Duration) (int, error) {

	return 0, nil
}

func (m *memStore) Close() error { return nil }

func cloneObservation(in ContainerObservation) ContainerObservation {
	out := ContainerObservation{
		Updated: in.Updated,
		Ports:   make(map[string]*PortObservation, len(in.Ports)),
		Peers:   make(map[string]*PeerObservation, len(in.Peers)),
	}
	for k, v := range in.Ports {
		dup := *v
		out.Ports[k] = &dup
	}
	for k, v := range in.Peers {
		dup := *v
		out.Peers[k] = &dup
	}
	return out
}
