package controlplane

import (
	"context"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Registry struct {
	mu         sync.RWMutex
	agents     map[string]*agentEntry
	commands   map[string][]Command
	acks       map[string]CommandAck
	ackWaiters map[string]chan CommandAck
	logger     *slog.Logger
	store      Store
	logHub     *LogHub
}

type agentEntry struct {
	Identity AgentIdentity
	LastSeen time.Time
	Snapshot *AgentSnapshot
	Events   int
}

func NewRegistry(logger *slog.Logger) *Registry {
	return NewRegistryWithStore(logger, NewMemoryStore())
}

func NewRegistryWithStore(logger *slog.Logger, store Store) *Registry {
	r := &Registry{
		agents:     make(map[string]*agentEntry),
		commands:   make(map[string][]Command),
		acks:       make(map[string]CommandAck),
		ackWaiters: make(map[string]chan CommandAck),
		logger:     logger,
		store:      store,
		logHub:     NewLogHub(),
	}
	r.hydrate(context.Background())
	return r
}

func (r *Registry) LogHub() *LogHub { return r.logHub }

func (r *Registry) PublishLog(line LogLine) {
	if r.logHub != nil {
		r.logHub.Publish(line)
	}
}

func (r *Registry) hydrate(ctx context.Context) {
	if r.store == nil {
		return
	}
	records, err := r.store.ListAgents(ctx)
	if err != nil {
		if r.logger != nil {
			r.logger.Warn("registry hydrate failed", "error", err)
		}
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, rec := range records {
		r.agents[rec.Identity.InstanceID] = &agentEntry{
			Identity: rec.Identity,
			LastSeen: rec.LastSeen,
			Events:   rec.EventCount,
		}
	}
	if r.logger != nil && len(records) > 0 {
		r.logger.Info("registry hydrated from store", "agents", len(records))
	}
}

func (r *Registry) upsertAgent(id AgentIdentity) *agentEntry {
	r.mu.Lock()
	e, ok := r.agents[id.InstanceID]
	if !ok {
		e = &agentEntry{Identity: id, LastSeen: time.Now().UTC()}
		r.agents[id.InstanceID] = e
		if r.logger != nil {
			r.logger.Info("agent registered", "instance_id", id.InstanceID, "hostname", id.Hostname)
		}
	} else {
		e.Identity = id
		e.LastSeen = time.Now().UTC()
	}
	r.mu.Unlock()

	if r.store != nil {
		if err := r.store.UpsertAgent(context.Background(), id); err != nil && r.logger != nil {
			r.logger.Warn("store upsert failed", "error", err)
		}
	}
	return e
}

func (r *Registry) Agents() []agentEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]agentEntry, 0, len(r.agents))
	for _, a := range r.agents {
		out = append(out, *a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Identity.InstanceID < out[j].Identity.InstanceID })
	return out
}

func (r *Registry) Enqueue(agentID string, cmd Command) {
	r.mu.Lock()
	r.commands[agentID] = append(r.commands[agentID], cmd)
	r.mu.Unlock()
	if r.store != nil {
		if err := r.store.EnqueueCommand(context.Background(), agentID, cmd); err != nil && r.logger != nil {
			r.logger.Warn("store enqueue failed", "error", err)
		}
	}
	cpAgentCommandsEnqueued.WithLabelValues(string(cmd.Kind)).Inc()
}

func (r *Registry) takeCommands(agentID string) []Command {
	r.mu.Lock()
	cmds := r.commands[agentID]
	delete(r.commands, agentID)
	r.mu.Unlock()

	if r.store != nil {
		if _, err := r.store.TakeCommands(context.Background(), agentID); err != nil && r.logger != nil {
			r.logger.Debug("store claim failed", "error", err)
		}
	}
	return cmds
}

func (r *Registry) recordAck(a CommandAck) {
	r.mu.Lock()
	r.acks[a.ID] = a
	w := r.ackWaiters[a.ID]
	delete(r.ackWaiters, a.ID)
	r.mu.Unlock()
	if w != nil {
		select {
		case w <- a:
		default:
		}
	}
	if r.store != nil {
		if err := r.store.RecordAck(context.Background(), a); err != nil && r.logger != nil {
			r.logger.Warn("store ack failed", "error", err)
		}
	}
}

func (r *Registry) Store() Store { return r.store }

func (r *Registry) RecordSnapshot(snap AgentSnapshot) {
	if r.store == nil {
		return
	}
	if err := r.store.RecordSnapshot(context.Background(), snap); err != nil && r.logger != nil {
		r.logger.Warn("store snapshot failed", "error", err)
	}
}

func (r *Registry) WaitForAck(ctx context.Context, commandID string, timeout time.Duration) (CommandAck, error) {
	r.mu.Lock()
	if a, ok := r.acks[commandID]; ok {
		r.mu.Unlock()
		return a, nil
	}
	ch := make(chan CommandAck, 1)
	r.ackWaiters[commandID] = ch
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		delete(r.ackWaiters, commandID)
		r.mu.Unlock()
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case a := <-ch:
		return a, nil
	case <-timer.C:
		return CommandAck{}, context.DeadlineExceeded
	case <-ctx.Done():
		return CommandAck{}, ctx.Err()
	}
}

func (r *Registry) RecordProposals(items []AutogenProposal) {
	if len(items) == 0 || r.store == nil {
		return
	}
	if err := r.store.RecordProposals(context.Background(), items); err != nil && r.logger != nil {
		r.logger.Warn("store autogen proposals failed", "error", err)
	}
}

func (r *Registry) RecordAuditEvent(env AuditEventEnvelope) {
	if r.store == nil {
		return
	}
	kind := ""
	if v, ok := env.Event["action"].(string); ok {
		kind = v
	}
	if err := r.store.RecordAudit(context.Background(), env.Agent.InstanceID, kind, env.Event, time.Now().UTC()); err != nil && r.logger != nil {
		r.logger.Warn("store audit failed", "error", err)
	}
	cpAuditEventsTotal.Inc()
}

func (r *Registry) RunRetentionLoop(ctx context.Context, interval time.Duration, cmdTTL time.Duration, auditTTL time.Duration, snapshotsPerAgent int) error {
	if r.store == nil || interval <= 0 {
		return nil
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			if n, err := r.store.ExpireCommands(ctx, cmdTTL); err == nil && n > 0 && r.logger != nil {
				r.logger.Info("control-plane commands expired", "count", n)
			}
			if n, err := r.store.PruneAudit(ctx, auditTTL); err == nil && n > 0 && r.logger != nil {
				r.logger.Info("control-plane audit pruned", "count", n)
			}
			if n, err := r.store.TrimSnapshots(ctx, snapshotsPerAgent); err == nil && n > 0 && r.logger != nil {
				r.logger.Debug("control-plane snapshots trimmed", "count", n)
			}
			if size, err := r.store.BytesOnDisk(ctx); err == nil {
				cpDBBytes.Set(float64(size))
			}
		}
	}
}

type EnrollHandler func(w http.ResponseWriter, r *http.Request)

type AuditEmitter interface {
	Emit(action string, metadata map[string]string)
}

type HTTPServer struct {
	EnrollHandle  EnrollHandler
	Registry      *Registry
	Token         string
	OperatorToken string
	Audit         AuditEmitter
	Authenticator OperatorAuthenticator
	Sessions      *SessionStore
}

func (s *HTTPServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	if s.EnrollHandle != nil {
		mux.HandleFunc("/v1/enroll", s.EnrollHandle)
	}
	if s.Registry != nil && s.Registry.store != nil {
		mux.HandleFunc("/v1/templates", s.requireBearer(s.handleTemplates))
		mux.HandleFunc("/v1/templates/", s.requireBearer(s.handleTemplate))
		mux.HandleFunc("/v1/approvals", s.requireBearer(s.handleApprovals))
		mux.HandleFunc("/v1/approvals/", s.requireBearer(s.handleApproval))
		mux.HandleFunc("/v1/agents", s.requireBearer(s.handleAgents))
		mux.HandleFunc("/v1/agents/", s.requireBearer(s.handleAgent))
		mux.HandleFunc("/v1/enrollment-tokens", s.requireBearer(s.handleEnrollmentTokens))
		mux.HandleFunc("/v1/stats", s.requireBearer(s.handleFleetStats))
		mux.HandleFunc("/v1/containers", s.requireBearer(s.handleFleetContainers))
		mux.HandleFunc("/v1/containers/", s.requireBearer(s.handleFleetContainerAction))
		mux.HandleFunc("/v1/rules", s.requireBearer(s.handleFleetRules))
		mux.HandleFunc("/v1/audit/history", s.requireBearer(s.handleFleetAuditHistory))
		mux.HandleFunc("/v1/policies", s.requireBearer(s.handlePoliciesIndex))
		mux.HandleFunc("/v1/policies/", s.requireBearer(s.handlePolicy))
		mux.HandleFunc("/v1/autogen/proposals", s.requireBearer(s.handleAutogenProposals))
		mux.HandleFunc("/v1/autogen/proposals/", s.requireBearer(s.handleAutogenAction))
		mux.HandleFunc("/v1/agent-tokens", s.requireBearer(s.handleAgentTokens))
		mux.HandleFunc("/v1/agent-tokens/", s.requireBearer(s.handleAgentTokenItem))
		if s.Registry.LogHub() != nil {
			mux.HandleFunc("/v1/logs", s.requireBearer(s.handleFleetLogsWS))
		}
	}
	if s.Authenticator != nil && s.Sessions != nil {
		mux.HandleFunc("/v1/login", s.handleLogin)
		mux.HandleFunc("/v1/logout", s.handleLogout)
	}
	mux.HandleFunc("/v1/whoami", s.handleWhoami)
	mux.Handle("/metrics", http.HandlerFunc(s.requireBearer(promhttp.Handler().ServeHTTP)))
	return mux
}

func (s *HTTPServer) operatorBearer() string {
	if s.OperatorToken != "" {
		return s.OperatorToken
	}
	return s.Token
}

func (s *HTTPServer) requireBearer(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		expected := s.operatorBearer()
		if expected != "" && r.Header.Get("Authorization") == "Bearer "+expected {
			next(w, r)
			return
		}
		if _, ok := s.sessionFromRequest(r); ok {
			next(w, r)
			return
		}
		if expected == "" && s.Authenticator == nil {
			next(w, r)
			return
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}
}
