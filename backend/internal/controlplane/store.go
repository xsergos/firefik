package controlplane

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type PolicyVersion struct {
	SHA         string
	Name        string
	DSL         string
	Author      string
	Comment     string
	CommittedAt time.Time
}

type AgentRecord struct {
	Identity  AgentIdentity
	FirstSeen time.Time
	LastSeen  time.Time

	EventCount int

	HasSnapshot bool
}

type Store interface {
	UpsertAgent(ctx context.Context, id AgentIdentity) error
	RecordSnapshot(ctx context.Context, snap AgentSnapshot) error
	RecordAudit(ctx context.Context, agentID string, kind string, payload map[string]any, at time.Time) error
	EnqueueCommand(ctx context.Context, agentID string, cmd Command) error
	TakeCommands(ctx context.Context, agentID string) ([]Command, error)
	RecordAck(ctx context.Context, ack CommandAck) error
	ListAgents(ctx context.Context) ([]AgentRecord, error)
	GetAgent(ctx context.Context, agentID string) (AgentRecord, bool, error)
	LatestSnapshot(ctx context.Context, agentID string) (*AgentSnapshot, error)
	SetPolicyVersion(ctx context.Context, name, dsl, author, comment string) (PolicyVersion, error)
	GetPolicyVersion(ctx context.Context, name string) (PolicyVersion, error)
	ListPolicyVersions(ctx context.Context, name string, limit int) ([]PolicyVersion, error)
	ExpireCommands(ctx context.Context, olderThan time.Duration) (int, error)
	PruneAudit(ctx context.Context, olderThan time.Duration) (int, error)
	TrimSnapshots(ctx context.Context, keepPerAgent int) (int, error)
	BytesOnDisk(ctx context.Context) (int64, error)
	PublishTemplate(ctx context.Context, t PolicyTemplate) (PolicyTemplate, error)
	GetTemplate(ctx context.Context, name string) (PolicyTemplate, error)
	ListTemplates(ctx context.Context) ([]PolicyTemplate, error)
	CreateApproval(ctx context.Context, p PendingApproval) (PendingApproval, error)
	GetApproval(ctx context.Context, id string) (PendingApproval, error)
	ListApprovals(ctx context.Context, status ApprovalStatus) ([]PendingApproval, error)
	ApproveApproval(ctx context.Context, id, approver, approverFinger string) (PendingApproval, error)
	RejectApproval(ctx context.Context, id, approver, approverFinger, comment string) (PendingApproval, error)
	CreateEnrollmentToken(ctx context.Context, token EnrollmentToken) error
	ConsumeEnrollmentToken(ctx context.Context, token, ip string) (EnrollmentToken, error)
	ListEnrollmentTokens(ctx context.Context, includeUsed bool) ([]EnrollmentToken, error)
	RevokeEnrollmentToken(ctx context.Context, token string) error
	RecordCertRenew(ctx context.Context, serial, agentID string, at time.Time) error
	LastCertRenew(ctx context.Context, serial string) (time.Time, bool, error)
	PruneCertRenewHistory(ctx context.Context, serials []string) error
	RecordProposals(ctx context.Context, items []AutogenProposal) error
	ListProposals(ctx context.Context, agentID string) ([]AutogenProposal, error)
	DeleteProposal(ctx context.Context, agentID, containerID string) error
	ListAuditEvents(ctx context.Context, agentID string, limit int) ([]AuditRecord, error)
	CreateAgentToken(ctx context.Context, name, description, issuedBy string) (AgentTokenIssued, error)
	ListAgentTokens(ctx context.Context, includeRevoked bool) ([]AgentToken, error)
	GetAgentToken(ctx context.Context, id string) (AgentToken, bool, error)
	RevokeAgentToken(ctx context.Context, id string) error
	ValidateAgentToken(ctx context.Context, plaintext string) (AgentToken, error)
	TouchAgentToken(ctx context.Context, id, ip string) error
	Close() error
}

type AuditRecord struct {
	AgentID string
	Kind    string
	Payload map[string]any
	At      time.Time
}

type sqliteStore struct {
	db     *sql.DB
	path   string
	logger *slog.Logger
}

func NewSQLiteStore(ctx context.Context, path string, logger *slog.Logger) (Store, error) {
	dsn := path
	if dsn == "" {
		dsn = ":memory:"
	}

	dsn = "file:" + dsn + "?_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("sqlite open %s: %w", path, err)
	}

	db.SetMaxOpenConns(1)

	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("sqlite ping: %w", err)
	}

	s := &sqliteStore{db: db, path: path, logger: logger}
	if err := s.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("sqlite migrate: %w", err)
	}
	return s, nil
}

func (s *sqliteStore) migrate(ctx context.Context) error {
	entries, err := fs.Glob(migrationsFS, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(entries)

	current, err := s.currentVersion(ctx)
	if err != nil {
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
			return fmt.Errorf("migration %q: bad version prefix: %w", entry, err)
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
			"INSERT INTO schema_version(version) VALUES (?)", v,
		); err != nil {
			return fmt.Errorf("record %s: %w", name, err)
		}
		if s.logger != nil {
			s.logger.Info("control-plane db migration applied", "version", v, "file", name)
		}
	}
	return nil
}

func (s *sqliteStore) currentVersion(ctx context.Context) (int, error) {

	if _, err := s.db.ExecContext(ctx,
		"CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
	); err != nil {
		return 0, err
	}
	row := s.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(version), 0) FROM schema_version")
	var v int
	if err := row.Scan(&v); err != nil {
		return 0, err
	}
	return v, nil
}

func (s *sqliteStore) UpsertAgent(ctx context.Context, id AgentIdentity) error {
	labels, _ := json.Marshal(id.Labels)
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
        INSERT INTO agents (id, hostname, version, backend, chain, labels_json, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            hostname=excluded.hostname,
            version=excluded.version,
            backend=excluded.backend,
            chain=excluded.chain,
            labels_json=excluded.labels_json,
            last_seen=excluded.last_seen
    `, id.InstanceID, id.Hostname, id.Version, id.Backend, id.Chain, string(labels), now, now)
	return err
}

func (s *sqliteStore) RecordSnapshot(ctx context.Context, snap AgentSnapshot) error {
	if err := s.UpsertAgent(ctx, snap.Agent); err != nil {
		return err
	}
	payload, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	at := snap.At
	if at.IsZero() {
		at = time.Now().UTC()
	}
	_, err = s.db.ExecContext(ctx,
		"INSERT INTO snapshots (agent_id, at, payload_json) VALUES (?, ?, ?)",
		snap.Agent.InstanceID, at, string(payload),
	)
	return err
}

func (s *sqliteStore) RecordAudit(ctx context.Context, agentID, kind string, payload map[string]any, at time.Time) error {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		"INSERT INTO audit_events (agent_id, at, kind, payload_json) VALUES (?, ?, ?, ?)",
		nullIfEmpty(agentID), at, nullIfEmpty(kind), string(body),
	)
	return err
}

func (s *sqliteStore) EnqueueCommand(ctx context.Context, agentID string, cmd Command) error {
	if cmd.ID == "" {
		return errors.New("command id required")
	}
	payload, _ := json.Marshal(cmd.Payload)
	issued := cmd.IssuedAt
	if issued.IsZero() {
		issued = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, `
        INSERT INTO commands (id, agent_id, kind, container_id, payload_json, issued_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `, cmd.ID, agentID, string(cmd.Kind), nullIfEmpty(cmd.ContainerID), string(payload), issued)
	return err
}

func (s *sqliteStore) TakeCommands(ctx context.Context, agentID string) ([]Command, error) {
	rows, err := s.db.QueryContext(ctx, `
        SELECT id, kind, container_id, payload_json, issued_at
          FROM commands
         WHERE agent_id = ? AND delivered_at IS NULL AND expired = 0
         ORDER BY issued_at ASC
    `, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Command
	var claimIDs []string
	for rows.Next() {
		var id, kind, payloadJSON string
		var container sql.NullString
		var issued time.Time
		if err := rows.Scan(&id, &kind, &container, &payloadJSON, &issued); err != nil {
			return nil, err
		}
		cmd := Command{
			ID:       id,
			Kind:     CommandKind(kind),
			IssuedAt: issued,
		}
		if container.Valid {
			cmd.ContainerID = container.String
		}
		if payloadJSON != "" && payloadJSON != "null" {
			var payload map[string]any
			if err := json.Unmarshal([]byte(payloadJSON), &payload); err == nil {
				cmd.Payload = payload
			}
		}
		out = append(out, cmd)
		claimIDs = append(claimIDs, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(claimIDs) == 0 {
		return out, nil
	}

	placeholders := strings.Repeat("?,", len(claimIDs))
	placeholders = strings.TrimSuffix(placeholders, ",")
	args := make([]any, 0, len(claimIDs)+1)
	args = append(args, time.Now().UTC())
	for _, id := range claimIDs {
		args = append(args, id)
	}
	_, err = s.db.ExecContext(ctx,
		"UPDATE commands SET delivered_at = ? WHERE id IN ("+placeholders+")", // #nosec G202 -- only ? placeholders are concatenated
		args...,
	)
	return out, err
}

func (s *sqliteStore) RecordAck(ctx context.Context, ack CommandAck) error {
	if ack.ID == "" {
		return errors.New("ack id required")
	}
	completed := ack.CompletedAt
	if completed.IsZero() {
		completed = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, `
        UPDATE commands
           SET acked_at = ?, success = ?, error = ?
         WHERE id = ?
    `, completed, boolInt(ack.Success), ack.Error, ack.ID)
	return err
}

func (s *sqliteStore) ListAgents(ctx context.Context) ([]AgentRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
        SELECT id, hostname, version, backend, chain, labels_json, first_seen, last_seen,
               (SELECT COUNT(*) FROM audit_events WHERE agent_id = a.id) AS events,
               EXISTS(SELECT 1 FROM snapshots WHERE agent_id = a.id) AS has_snap
          FROM agents a
         ORDER BY id ASC
    `)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AgentRecord
	for rows.Next() {
		var (
			rec      AgentRecord
			labels   sql.NullString
			hasSnap  int
			events   int
			version  sql.NullString
			backend  sql.NullString
			chain    sql.NullString
			hostname string
		)
		if err := rows.Scan(
			&rec.Identity.InstanceID,
			&hostname,
			&version, &backend, &chain,
			&labels,
			&rec.FirstSeen, &rec.LastSeen,
			&events, &hasSnap,
		); err != nil {
			return nil, err
		}
		rec.Identity.Hostname = hostname
		if version.Valid {
			rec.Identity.Version = version.String
		}
		if backend.Valid {
			rec.Identity.Backend = backend.String
		}
		if chain.Valid {
			rec.Identity.Chain = chain.String
		}
		if labels.Valid && labels.String != "" && labels.String != "null" {
			var lbl map[string]string
			if err := json.Unmarshal([]byte(labels.String), &lbl); err == nil {
				rec.Identity.Labels = lbl
			}
		}
		rec.EventCount = events
		rec.HasSnapshot = hasSnap == 1
		out = append(out, rec)
	}
	return out, rows.Err()
}

func (s *sqliteStore) GetAgent(ctx context.Context, agentID string) (AgentRecord, bool, error) {
	row := s.db.QueryRowContext(ctx, `
        SELECT id, hostname, version, backend, chain, labels_json, first_seen, last_seen,
               (SELECT COUNT(*) FROM audit_events WHERE agent_id = a.id) AS events,
               EXISTS(SELECT 1 FROM snapshots WHERE agent_id = a.id) AS has_snap
          FROM agents a
         WHERE a.id = ?
    `, agentID)
	var (
		rec      AgentRecord
		labels   sql.NullString
		hasSnap  int
		events   int
		version  sql.NullString
		backend  sql.NullString
		chain    sql.NullString
		hostname string
	)
	if err := row.Scan(
		&rec.Identity.InstanceID,
		&hostname,
		&version, &backend, &chain,
		&labels,
		&rec.FirstSeen, &rec.LastSeen,
		&events, &hasSnap,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return AgentRecord{}, false, nil
		}
		return AgentRecord{}, false, err
	}
	rec.Identity.Hostname = hostname
	if version.Valid {
		rec.Identity.Version = version.String
	}
	if backend.Valid {
		rec.Identity.Backend = backend.String
	}
	if chain.Valid {
		rec.Identity.Chain = chain.String
	}
	if labels.Valid && labels.String != "" && labels.String != "null" {
		var lbl map[string]string
		if err := json.Unmarshal([]byte(labels.String), &lbl); err == nil {
			rec.Identity.Labels = lbl
		}
	}
	rec.EventCount = events
	rec.HasSnapshot = hasSnap == 1
	return rec, true, nil
}

func (s *sqliteStore) LatestSnapshot(ctx context.Context, agentID string) (*AgentSnapshot, error) {
	row := s.db.QueryRowContext(ctx,
		"SELECT payload_json FROM snapshots WHERE agent_id = ? ORDER BY at DESC LIMIT 1",
		agentID,
	)
	var payload string
	if err := row.Scan(&payload); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	var snap AgentSnapshot
	if err := json.Unmarshal([]byte(payload), &snap); err != nil {
		return nil, err
	}
	return &snap, nil
}

func (s *sqliteStore) SetPolicyVersion(ctx context.Context, name, dsl, author, comment string) (PolicyVersion, error) {
	sha := sha256.Sum256([]byte(dsl))
	shaHex := hex.EncodeToString(sha[:])
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
        INSERT INTO policy_versions (sha, name, dsl, author, comment, committed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(sha) DO UPDATE SET committed_at = excluded.committed_at
    `, shaHex, name, dsl, nullIfEmpty(author), nullIfEmpty(comment), now)
	if err != nil {
		return PolicyVersion{}, err
	}
	return PolicyVersion{
		SHA:         shaHex,
		Name:        name,
		DSL:         dsl,
		Author:      author,
		Comment:     comment,
		CommittedAt: now,
	}, nil
}

func (s *sqliteStore) GetPolicyVersion(ctx context.Context, name string) (PolicyVersion, error) {
	row := s.db.QueryRowContext(ctx, `
        SELECT sha, name, dsl, COALESCE(author,''), COALESCE(comment,''), committed_at
          FROM policy_versions
         WHERE name = ?
         ORDER BY committed_at DESC
         LIMIT 1
    `, name)
	var pv PolicyVersion
	if err := row.Scan(&pv.SHA, &pv.Name, &pv.DSL, &pv.Author, &pv.Comment, &pv.CommittedAt); err != nil {
		return PolicyVersion{}, err
	}
	return pv, nil
}

func (s *sqliteStore) ListPolicyVersions(ctx context.Context, name string, limit int) ([]PolicyVersion, error) {
	if limit <= 0 {
		limit = 50
	}
	var (
		rows *sql.Rows
		err  error
	)
	if name == "" {
		rows, err = s.db.QueryContext(ctx, `
        SELECT sha, name, dsl, COALESCE(author,''), COALESCE(comment,''), committed_at
          FROM policy_versions
         ORDER BY committed_at DESC
         LIMIT ?
    `, limit)
	} else {
		rows, err = s.db.QueryContext(ctx, `
        SELECT sha, name, dsl, COALESCE(author,''), COALESCE(comment,''), committed_at
          FROM policy_versions
         WHERE name = ?
         ORDER BY committed_at DESC
         LIMIT ?
    `, name, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PolicyVersion
	for rows.Next() {
		var pv PolicyVersion
		if err := rows.Scan(&pv.SHA, &pv.Name, &pv.DSL, &pv.Author, &pv.Comment, &pv.CommittedAt); err != nil {
			return nil, err
		}
		out = append(out, pv)
	}
	return out, rows.Err()
}

func (s *sqliteStore) ExpireCommands(ctx context.Context, olderThan time.Duration) (int, error) {
	if olderThan <= 0 {
		return 0, nil
	}
	cutoff := time.Now().UTC().Add(-olderThan)
	res, err := s.db.ExecContext(ctx, `
        UPDATE commands
           SET expired = 1
         WHERE expired = 0
           AND acked_at IS NULL
           AND issued_at < ?
    `, cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

func (s *sqliteStore) PruneAudit(ctx context.Context, olderThan time.Duration) (int, error) {
	if olderThan <= 0 {
		return 0, nil
	}
	cutoff := time.Now().UTC().Add(-olderThan)
	res, err := s.db.ExecContext(ctx, `DELETE FROM audit_events WHERE at < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

func (s *sqliteStore) TrimSnapshots(ctx context.Context, keepPerAgent int) (int, error) {
	if keepPerAgent <= 0 {
		return 0, nil
	}

	res, err := s.db.ExecContext(ctx, `
        DELETE FROM snapshots
         WHERE id IN (
             SELECT id FROM (
                 SELECT id,
                        ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY at DESC) AS rn
                   FROM snapshots
             ) WHERE rn > ?
         )
    `, keepPerAgent)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

func (s *sqliteStore) BytesOnDisk(ctx context.Context) (int64, error) {
	if s.path == "" || s.path == ":memory:" {

		row := s.db.QueryRowContext(ctx, "PRAGMA page_count")
		var pages int64
		if err := row.Scan(&pages); err != nil {
			return 0, err
		}
		rowSize := s.db.QueryRowContext(ctx, "PRAGMA page_size")
		var size int64
		if err := rowSize.Scan(&size); err != nil {
			return 0, err
		}
		return pages * size, nil
	}
	info, err := os.Stat(s.path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

func (s *sqliteStore) CreateEnrollmentToken(ctx context.Context, t EnrollmentToken) error {
	if t.Token == "" {
		return errors.New("token required")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO enrollment_tokens (token, agent_id, ttl_seconds, expires_at, issued_by, issued_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`, t.Token, t.AgentID, t.TTLSeconds, t.ExpiresAt, t.IssuedBy, t.IssuedAt)
	return err
}

func (s *sqliteStore) ConsumeEnrollmentToken(ctx context.Context, token, ip string) (EnrollmentToken, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return EnrollmentToken{}, err
	}
	defer func() { _ = tx.Rollback() }()

	row := tx.QueryRowContext(ctx, `
		SELECT token, agent_id, ttl_seconds, expires_at, issued_by, issued_at, consumed_at, consumer_ip
		FROM enrollment_tokens WHERE token = ?
	`, token)
	var et EnrollmentToken
	var consumedAt sql.NullTime
	var consumerIP sql.NullString
	if err := row.Scan(&et.Token, &et.AgentID, &et.TTLSeconds, &et.ExpiresAt, &et.IssuedBy, &et.IssuedAt, &consumedAt, &consumerIP); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return EnrollmentToken{}, fmt.Errorf("enrollment token not found")
		}
		return EnrollmentToken{}, err
	}
	if consumedAt.Valid {
		return EnrollmentToken{}, fmt.Errorf("enrollment token already used")
	}
	if time.Now().UTC().After(et.ExpiresAt) {
		return EnrollmentToken{}, fmt.Errorf("enrollment token expired")
	}
	now := time.Now().UTC()
	if _, err := tx.ExecContext(ctx,
		`UPDATE enrollment_tokens SET consumed_at = ?, consumer_ip = ? WHERE token = ?`,
		now, nullIfEmpty(ip), token,
	); err != nil {
		return EnrollmentToken{}, err
	}
	if err := tx.Commit(); err != nil {
		return EnrollmentToken{}, err
	}
	et.ConsumedAt = &now
	et.ConsumerIP = ip
	return et, nil
}

func (s *sqliteStore) ListEnrollmentTokens(ctx context.Context, includeUsed bool) ([]EnrollmentToken, error) {
	q := `SELECT token, agent_id, ttl_seconds, expires_at, issued_by, issued_at, consumed_at, consumer_ip
	      FROM enrollment_tokens`
	if !includeUsed {
		q += ` WHERE consumed_at IS NULL`
	}
	q += ` ORDER BY issued_at DESC`
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EnrollmentToken
	for rows.Next() {
		var et EnrollmentToken
		var consumedAt sql.NullTime
		var consumerIP sql.NullString
		if err := rows.Scan(&et.Token, &et.AgentID, &et.TTLSeconds, &et.ExpiresAt, &et.IssuedBy, &et.IssuedAt, &consumedAt, &consumerIP); err != nil {
			return nil, err
		}
		if consumedAt.Valid {
			t := consumedAt.Time
			et.ConsumedAt = &t
		}
		if consumerIP.Valid {
			et.ConsumerIP = consumerIP.String
		}
		out = append(out, et)
	}
	return out, rows.Err()
}

func (s *sqliteStore) RevokeEnrollmentToken(ctx context.Context, token string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE enrollment_tokens SET consumed_at = ?, consumer_ip = 'revoked' WHERE token = ? AND consumed_at IS NULL`,
		time.Now().UTC(), token,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("enrollment token not found or already used")
	}
	return nil
}

func (s *sqliteStore) RecordCertRenew(ctx context.Context, serial, agentID string, at time.Time) error {
	if serial == "" {
		return errors.New("empty serial")
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO cert_renew_history (serial, agent_id, last_renew_at) VALUES (?, ?, ?)
		 ON CONFLICT(serial) DO UPDATE SET agent_id = excluded.agent_id, last_renew_at = excluded.last_renew_at`,
		strings.ToLower(serial), agentID, at.UTC(),
	)
	return err
}

func (s *sqliteStore) LastCertRenew(ctx context.Context, serial string) (time.Time, bool, error) {
	if serial == "" {
		return time.Time{}, false, nil
	}
	row := s.db.QueryRowContext(ctx, `SELECT last_renew_at FROM cert_renew_history WHERE serial = ?`, strings.ToLower(serial))
	var ts time.Time
	if err := row.Scan(&ts); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return time.Time{}, false, nil
		}
		return time.Time{}, false, err
	}
	return ts, true, nil
}

func (s *sqliteStore) PruneCertRenewHistory(ctx context.Context, serials []string) error {
	if len(serials) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.PrepareContext(ctx, `DELETE FROM cert_renew_history WHERE serial = ?`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, s := range serials {
		if _, err := stmt.ExecContext(ctx, strings.ToLower(s)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *sqliteStore) RecordProposals(ctx context.Context, items []AutogenProposal) error {
	if len(items) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.PrepareContext(ctx,
		`INSERT INTO autogen_proposals (agent_id, container_id, ports_json, peers_json, observed_for, confidence, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(agent_id, container_id) DO UPDATE SET
		   ports_json   = excluded.ports_json,
		   peers_json   = excluded.peers_json,
		   observed_for = excluded.observed_for,
		   confidence   = excluded.confidence,
		   updated_at   = excluded.updated_at`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, p := range items {
		ports, err := json.Marshal(p.Ports)
		if err != nil {
			return err
		}
		peers, err := json.Marshal(p.Peers)
		if err != nil {
			return err
		}
		ts := p.UpdatedAt
		if ts.IsZero() {
			ts = time.Now().UTC()
		}
		if _, err := stmt.ExecContext(ctx,
			p.AgentID, p.ContainerID, string(ports), string(peers),
			p.ObservedFor, p.Confidence, ts.UnixNano(),
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *sqliteStore) ListProposals(ctx context.Context, agentID string) ([]AutogenProposal, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if agentID == "" {
		rows, err = s.db.QueryContext(ctx,
			`SELECT agent_id, container_id, ports_json, peers_json, observed_for, confidence, updated_at
			 FROM autogen_proposals ORDER BY agent_id, container_id`)
	} else {
		rows, err = s.db.QueryContext(ctx,
			`SELECT agent_id, container_id, ports_json, peers_json, observed_for, confidence, updated_at
			 FROM autogen_proposals WHERE agent_id = ? ORDER BY container_id`,
			agentID)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AutogenProposal
	for rows.Next() {
		var p AutogenProposal
		var portsJSON, peersJSON string
		var ts int64
		if err := rows.Scan(&p.AgentID, &p.ContainerID, &portsJSON, &peersJSON, &p.ObservedFor, &p.Confidence, &ts); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(portsJSON), &p.Ports)
		_ = json.Unmarshal([]byte(peersJSON), &p.Peers)
		p.UpdatedAt = time.Unix(0, ts).UTC()
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *sqliteStore) DeleteProposal(ctx context.Context, agentID, containerID string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM autogen_proposals WHERE agent_id = ? AND container_id = ?`,
		agentID, containerID)
	return err
}

func (s *sqliteStore) ListAuditEvents(ctx context.Context, agentID string, limit int) ([]AuditRecord, error) {
	if limit <= 0 {
		limit = 100
	}
	var (
		rows *sql.Rows
		err  error
	)
	if agentID == "" {
		rows, err = s.db.QueryContext(ctx,
			`SELECT agent_id, kind, payload_json, at FROM audit_events ORDER BY at DESC LIMIT ?`, limit)
	} else {
		rows, err = s.db.QueryContext(ctx,
			`SELECT agent_id, kind, payload_json, at FROM audit_events WHERE agent_id = ? ORDER BY at DESC LIMIT ?`,
			agentID, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditRecord
	for rows.Next() {
		var rec AuditRecord
		var agent sql.NullString
		var kind sql.NullString
		var payload sql.NullString
		if err := rows.Scan(&agent, &kind, &payload, &rec.At); err != nil {
			return nil, err
		}
		if agent.Valid {
			rec.AgentID = agent.String
		}
		if kind.Valid {
			rec.Kind = kind.String
		}
		if payload.Valid && payload.String != "" {
			_ = json.Unmarshal([]byte(payload.String), &rec.Payload)
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

func (s *sqliteStore) Close() error { return s.db.Close() }

type memStore struct {
	mu          sync.Mutex
	agents      map[string]AgentRecord
	cmds        map[string][]Command
	acks        map[string]CommandAck
	policies    map[string]PolicyVersion
	templates   map[string]PolicyTemplate
	approvals   map[string]PendingApproval
	snapshots   map[string]AgentSnapshot
	enrollments map[string]EnrollmentToken
	renewals    map[string]memRenewRow
	proposals   map[string]map[string]AutogenProposal
	auditLog    []AuditRecord
	agentTokens map[string]memAgentToken
}

func NewMemoryStore() Store {
	return &memStore{
		agents:      map[string]AgentRecord{},
		cmds:        map[string][]Command{},
		acks:        map[string]CommandAck{},
		policies:    map[string]PolicyVersion{},
		templates:   map[string]PolicyTemplate{},
		approvals:   map[string]PendingApproval{},
		snapshots:   map[string]AgentSnapshot{},
		enrollments: map[string]EnrollmentToken{},
		renewals:    map[string]memRenewRow{},
		proposals:   map[string]map[string]AutogenProposal{},
		agentTokens: map[string]memAgentToken{},
	}
}

func (m *memStore) UpsertAgent(_ context.Context, id AgentIdentity) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.agents[id.InstanceID]
	now := time.Now().UTC()
	if !ok {
		rec = AgentRecord{Identity: id, FirstSeen: now}
	}
	rec.Identity = id
	rec.LastSeen = now
	m.agents[id.InstanceID] = rec
	return nil
}
func (m *memStore) RecordSnapshot(_ context.Context, snap AgentSnapshot) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec := m.agents[snap.Agent.InstanceID]
	rec.Identity = snap.Agent
	if rec.FirstSeen.IsZero() {
		rec.FirstSeen = time.Now().UTC()
	}
	rec.LastSeen = time.Now().UTC()
	rec.HasSnapshot = true
	m.agents[snap.Agent.InstanceID] = rec
	m.snapshots[snap.Agent.InstanceID] = snap
	return nil
}

func (m *memStore) LatestSnapshot(_ context.Context, agentID string) (*AgentSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	snap, ok := m.snapshots[agentID]
	if !ok {
		return nil, nil
	}
	out := snap
	return &out, nil
}
func (m *memStore) RecordAudit(_ context.Context, agentID, kind string, payload map[string]any, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.agents[agentID]
	if ok {
		rec.EventCount++
		m.agents[agentID] = rec
	}
	if at.IsZero() {
		at = time.Now().UTC()
	}
	m.auditLog = append(m.auditLog, AuditRecord{AgentID: agentID, Kind: kind, Payload: payload, At: at})
	return nil
}

func (m *memStore) RecordProposals(_ context.Context, items []AutogenProposal) error {
	if len(items) == 0 {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range items {
		if p.AgentID == "" || p.ContainerID == "" {
			continue
		}
		bucket := m.proposals[p.AgentID]
		if bucket == nil {
			bucket = map[string]AutogenProposal{}
			m.proposals[p.AgentID] = bucket
		}
		if p.UpdatedAt.IsZero() {
			p.UpdatedAt = time.Now().UTC()
		}
		bucket[p.ContainerID] = p
	}
	return nil
}

func (m *memStore) ListProposals(_ context.Context, agentID string) ([]AutogenProposal, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []AutogenProposal
	if agentID != "" {
		for _, p := range m.proposals[agentID] {
			out = append(out, p)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].ContainerID < out[j].ContainerID })
		return out, nil
	}
	for _, bucket := range m.proposals {
		for _, p := range bucket {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].AgentID != out[j].AgentID {
			return out[i].AgentID < out[j].AgentID
		}
		return out[i].ContainerID < out[j].ContainerID
	})
	return out, nil
}

func (m *memStore) DeleteProposal(_ context.Context, agentID, containerID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if bucket := m.proposals[agentID]; bucket != nil {
		delete(bucket, containerID)
	}
	return nil
}

func (m *memStore) ListAuditEvents(_ context.Context, agentID string, limit int) ([]AuditRecord, error) {
	if limit <= 0 {
		limit = 100
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var matches []AuditRecord
	for i := len(m.auditLog) - 1; i >= 0; i-- {
		rec := m.auditLog[i]
		if agentID != "" && rec.AgentID != agentID {
			continue
		}
		matches = append(matches, rec)
		if len(matches) >= limit {
			break
		}
	}
	return matches, nil
}
func (m *memStore) EnqueueCommand(_ context.Context, agentID string, cmd Command) error {
	if cmd.ID == "" {
		return errors.New("command id required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cmds[agentID] = append(m.cmds[agentID], cmd)
	return nil
}
func (m *memStore) TakeCommands(_ context.Context, agentID string) ([]Command, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := m.cmds[agentID]
	delete(m.cmds, agentID)
	return out, nil
}
func (m *memStore) RecordAck(_ context.Context, ack CommandAck) error {
	if ack.ID == "" {
		return errors.New("ack id required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.acks[ack.ID] = ack
	return nil
}
func (m *memStore) GetAgent(_ context.Context, agentID string) (AgentRecord, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.agents[agentID]
	return rec, ok, nil
}

func (m *memStore) ListAgents(_ context.Context) ([]AgentRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]AgentRecord, 0, len(m.agents))
	for _, r := range m.agents {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Identity.InstanceID < out[j].Identity.InstanceID
	})
	return out, nil
}
func (m *memStore) SetPolicyVersion(_ context.Context, name, dsl, author, comment string) (PolicyVersion, error) {
	sha := sha256.Sum256([]byte(dsl))
	shaHex := hex.EncodeToString(sha[:])
	pv := PolicyVersion{
		SHA: shaHex, Name: name, DSL: dsl, Author: author, Comment: comment,
		CommittedAt: time.Now().UTC(),
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.policies[shaHex] = pv
	return pv, nil
}
func (m *memStore) GetPolicyVersion(_ context.Context, name string) (PolicyVersion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var best PolicyVersion
	for _, pv := range m.policies {
		if pv.Name != name {
			continue
		}
		if best.SHA == "" || pv.CommittedAt.After(best.CommittedAt) {
			best = pv
		}
	}
	if best.SHA == "" {
		return PolicyVersion{}, sql.ErrNoRows
	}
	return best, nil
}
func (m *memStore) ListPolicyVersions(_ context.Context, name string, limit int) ([]PolicyVersion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []PolicyVersion
	for _, pv := range m.policies {
		if name == "" || pv.Name == name {
			out = append(out, pv)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CommittedAt.After(out[j].CommittedAt) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
func (m *memStore) ExpireCommands(_ context.Context, _ time.Duration) (int, error) { return 0, nil }
func (m *memStore) PruneAudit(_ context.Context, _ time.Duration) (int, error)     { return 0, nil }
func (m *memStore) TrimSnapshots(_ context.Context, _ int) (int, error)            { return 0, nil }
func (m *memStore) BytesOnDisk(_ context.Context) (int64, error)                   { return 0, nil }

func (m *memStore) PublishTemplate(_ context.Context, t PolicyTemplate) (PolicyTemplate, error) {
	if t.Name == "" {
		return PolicyTemplate{}, errors.New("template name required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now().UTC()
	prev, ok := m.templates[t.Name]
	if ok {
		t.Version = prev.Version + 1
		t.CreatedAt = prev.CreatedAt
	} else {
		t.Version = 1
		t.CreatedAt = now
	}
	t.UpdatedAt = now
	m.templates[t.Name] = t
	return t, nil
}

func (m *memStore) GetTemplate(_ context.Context, name string) (PolicyTemplate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.templates[name]
	if !ok {
		return PolicyTemplate{}, ErrTemplateNotFound
	}
	return t, nil
}

func (m *memStore) ListTemplates(_ context.Context) ([]PolicyTemplate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]PolicyTemplate, 0, len(m.templates))
	for _, t := range m.templates {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (m *memStore) CreateApproval(_ context.Context, p PendingApproval) (PendingApproval, error) {
	if p.PolicyName == "" || p.ProposedBody == "" {
		return PendingApproval{}, errors.New("policy_name and proposed_body required")
	}
	if p.Requester == "" || p.RequesterFinger == "" {
		return PendingApproval{}, errors.New("requester and requester_fingerprint required")
	}
	if p.ID == "" {
		p.ID = newApprovalID(p.PolicyName, p.ProposedBody, p.RequesterFinger)
	}
	if p.RequestedAt.IsZero() {
		p.RequestedAt = time.Now().UTC()
	}
	if p.Status == "" {
		p.Status = ApprovalPending
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.approvals[p.ID] = p
	return p, nil
}

func (m *memStore) GetApproval(_ context.Context, id string) (PendingApproval, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.approvals[id]
	if !ok {
		return PendingApproval{}, ErrApprovalNotFound
	}
	return p, nil
}

func (m *memStore) ListApprovals(_ context.Context, status ApprovalStatus) ([]PendingApproval, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]PendingApproval, 0, len(m.approvals))
	for _, p := range m.approvals {
		if status != "" && p.Status != status {
			continue
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RequestedAt.After(out[j].RequestedAt) })
	return out, nil
}

func (m *memStore) ApproveApproval(_ context.Context, id, approver, approverFinger string) (PendingApproval, error) {
	if approver == "" || approverFinger == "" {
		return PendingApproval{}, errors.New("approver and approver_fingerprint required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.approvals[id]
	if !ok {
		return PendingApproval{}, ErrApprovalNotFound
	}
	if p.Status != ApprovalPending {
		return PendingApproval{}, ErrApprovalNotPending
	}
	if approverFinger == p.RequesterFinger {
		return PendingApproval{}, ErrSelfApprove
	}
	now := time.Now().UTC()
	p.Approver = approver
	p.ApproverFinger = approverFinger
	p.ApprovedAt = &now
	p.Status = ApprovalApproved
	m.approvals[id] = p
	return p, nil
}

func (m *memStore) RejectApproval(_ context.Context, id, approver, approverFinger, comment string) (PendingApproval, error) {
	if approver == "" || approverFinger == "" {
		return PendingApproval{}, errors.New("approver and approver_fingerprint required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.approvals[id]
	if !ok {
		return PendingApproval{}, ErrApprovalNotFound
	}
	if p.Status != ApprovalPending {
		return PendingApproval{}, ErrApprovalNotPending
	}
	if approverFinger == p.RequesterFinger {
		return PendingApproval{}, ErrSelfApprove
	}
	now := time.Now().UTC()
	p.Approver = approver
	p.ApproverFinger = approverFinger
	p.ApprovedAt = &now
	p.Status = ApprovalRejected
	p.RejectionComment = comment
	m.approvals[id] = p
	return p, nil
}

func (m *memStore) CreateEnrollmentToken(_ context.Context, t EnrollmentToken) error {
	if t.Token == "" {
		return errors.New("token required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.enrollments[t.Token] = t
	return nil
}

func (m *memStore) ConsumeEnrollmentToken(_ context.Context, token, ip string) (EnrollmentToken, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	et, ok := m.enrollments[token]
	if !ok {
		return EnrollmentToken{}, errors.New("enrollment token not found")
	}
	if et.ConsumedAt != nil {
		return EnrollmentToken{}, errors.New("enrollment token already used")
	}
	if time.Now().UTC().After(et.ExpiresAt) {
		return EnrollmentToken{}, errors.New("enrollment token expired")
	}
	now := time.Now().UTC()
	et.ConsumedAt = &now
	et.ConsumerIP = ip
	m.enrollments[token] = et
	return et, nil
}

func (m *memStore) ListEnrollmentTokens(_ context.Context, includeUsed bool) ([]EnrollmentToken, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]EnrollmentToken, 0, len(m.enrollments))
	for _, et := range m.enrollments {
		if !includeUsed && et.ConsumedAt != nil {
			continue
		}
		out = append(out, et)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].IssuedAt.After(out[j].IssuedAt) })
	return out, nil
}

func (m *memStore) RevokeEnrollmentToken(_ context.Context, token string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	et, ok := m.enrollments[token]
	if !ok || et.ConsumedAt != nil {
		return errors.New("enrollment token not found or already used")
	}
	now := time.Now().UTC()
	et.ConsumedAt = &now
	et.ConsumerIP = "revoked"
	m.enrollments[token] = et
	return nil
}

type memRenewRow struct {
	agentID string
	at      time.Time
}

func (m *memStore) RecordCertRenew(_ context.Context, serial, agentID string, at time.Time) error {
	if serial == "" {
		return errors.New("empty serial")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.renewals == nil {
		m.renewals = map[string]memRenewRow{}
	}
	m.renewals[strings.ToLower(serial)] = memRenewRow{agentID: agentID, at: at.UTC()}
	return nil
}

func (m *memStore) LastCertRenew(_ context.Context, serial string) (time.Time, bool, error) {
	if serial == "" {
		return time.Time{}, false, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.renewals[strings.ToLower(serial)]
	if !ok {
		return time.Time{}, false, nil
	}
	return row.at, true, nil
}

func (m *memStore) PruneCertRenewHistory(_ context.Context, serials []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range serials {
		delete(m.renewals, strings.ToLower(s))
	}
	return nil
}

func (m *memStore) Close() error { return nil }

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
