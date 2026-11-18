package agentdispatch

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"firefik/internal/audit"
	"firefik/internal/autogen"
	"firefik/internal/config"
	"firefik/internal/controlplane"
	"firefik/internal/docker"
	"firefik/internal/rules"
)

const proposalLookupMinAge = 15 * time.Minute

type Engine interface {
	ApplyContainer(ctx context.Context, id string, source audit.Source) error
	RemoveContainer(id string, source audit.Source) error
	Reconcile(ctx context.Context, source audit.Source) error
	GetApplied() map[string]docker.ContainerConfig
}

type Deps struct {
	Engine   Engine
	Docker   rules.DockerReader
	Config   *config.Config
	Traffic  TrafficSnapshotter
	Observer *autogen.Observer
	Audit    *audit.Logger
	Logger   *slog.Logger
}

type TrafficSnapshotter interface {
	Last(n int) []TrafficBucket
}

type TrafficBucket struct {
	Timestamp string
	Accepted  int64
	Dropped   int64
}

type Dispatcher struct {
	deps Deps
}

func New(deps Deps) *Dispatcher {
	return &Dispatcher{deps: deps}
}

func (d *Dispatcher) Dispatch(ctx context.Context, cmd controlplane.Command) controlplane.CommandAck {
	ack := controlplane.CommandAck{ID: cmd.ID}
	var err error
	switch cmd.Kind {
	case controlplane.CommandApply:
		if cmd.ContainerID == "" {
			err = fmt.Errorf("apply requires container_id")
			break
		}
		err = d.deps.Engine.ApplyContainer(ctx, cmd.ContainerID, audit.SourceAPI)
	case controlplane.CommandDisable:
		if cmd.ContainerID == "" {
			err = fmt.Errorf("disable requires container_id")
			break
		}
		err = d.deps.Engine.RemoveContainer(cmd.ContainerID, audit.SourceAPI)
	case controlplane.CommandReconcile:
		err = d.deps.Engine.Reconcile(ctx, audit.SourceConfigReload)
	case controlplane.CommandTokenRotate:
		err = fmt.Errorf("token-rotate is operator-driven via FIREFIK_API_TOKEN_FILE, not control-plane commands")
	case controlplane.CommandStatsCollect:
		payload, statsErr := d.collectStats(ctx)
		if statsErr != nil {
			err = statsErr
			break
		}
		ack.ResultPayload = payload
	case controlplane.CommandAutogenApprove:
		payload, autoErr := d.autogenApprove(ctx, cmd)
		if autoErr != nil {
			err = autoErr
			break
		}
		ack.ResultPayload = payload
	case controlplane.CommandAutogenReject:
		payload, autoErr := d.autogenReject(ctx, cmd)
		if autoErr != nil {
			err = autoErr
			break
		}
		ack.ResultPayload = payload
	default:
		err = fmt.Errorf("unknown command kind %q", cmd.Kind)
	}
	if err != nil {
		ack.Success = false
		ack.Error = err.Error()
		if d.deps.Logger != nil {
			d.deps.Logger.Warn("control-plane command failed", "kind", cmd.Kind, "error", err)
		}
	} else {
		ack.Success = true
	}
	return ack
}

func (d *Dispatcher) collectStats(ctx context.Context) (map[string]any, error) {
	if d.deps.Docker == nil {
		return nil, errors.New("docker client unavailable")
	}
	containers, err := d.deps.Docker.ListContainers(ctx)
	if err != nil {
		return nil, fmt.Errorf("list containers: %w", err)
	}
	var fileRules config.RulesFile
	if d.deps.Config != nil {
		fileRules, _ = config.LoadRulesFile(d.deps.Config.ConfigFile)
	}
	total, running, enabled := 0, 0, 0
	for _, ctr := range containers {
		total++
		if ctr.Status == "running" {
			running++
		}
		cfg, _ := docker.ParseLabels(ctr.Labels)
		cfg = rules.MergeFileRules(cfg, ctr.Name, fileRules)
		if cfg.Enable {
			enabled++
		}
	}
	out := map[string]any{
		"containers": map[string]any{
			"total":   total,
			"running": running,
			"enabled": enabled,
		},
	}
	if d.deps.Traffic != nil {
		buckets := d.deps.Traffic.Last(60)
		traffic := make([]any, 0, len(buckets))
		for _, b := range buckets {
			traffic = append(traffic, map[string]any{
				"ts":       b.Timestamp,
				"accepted": b.Accepted,
				"dropped":  b.Dropped,
			})
		}
		out["traffic"] = traffic
	}
	if d.deps.Engine != nil {
		applied := d.deps.Engine.GetApplied()
		out["rules_active_containers"] = len(applied)
	}
	out["at"] = time.Now().UTC().Format(time.RFC3339)
	return out, nil
}

func (d *Dispatcher) autogenApprove(ctx context.Context, cmd controlplane.Command) (map[string]any, error) {
	if d.deps.Observer == nil {
		return nil, errors.New("autogen disabled on agent")
	}
	containerID := cmd.ContainerID
	if containerID == "" {
		return nil, errors.New("container_id required")
	}
	mode, _ := cmd.Payload["mode"].(string)
	if mode == "" {
		mode = "labels"
	}
	if mode != "labels" && mode != "policy" {
		return nil, fmt.Errorf("invalid mode %q (expected labels or policy)", mode)
	}
	target := d.findProposal(ctx, containerID)
	if target == nil {
		return nil, errors.New("no pending proposal for this container")
	}
	snippet := autogenLabelsSnippet(*target)
	if mode == "policy" {
		snippet = autogenPolicySnippet(*target)
	}
	if store := d.deps.Observer.StoreHandle(); store != nil {
		if err := store.MarkProposal(ctx, target.ContainerID, autogen.StatusApproved, "control-plane", ""); err != nil {
			return nil, fmt.Errorf("mark approved: %w", err)
		}
	}
	if d.deps.Audit != nil {
		d.deps.Audit.AutogenApproved(target.ContainerID, "", target.Ports, target.Peers, mode, "control-plane")
	}
	return map[string]any{
		"mode":         mode,
		"snippet":      snippet,
		"container_id": target.ContainerID,
		"ports":        target.Ports,
		"peers":        target.Peers,
	}, nil
}

func (d *Dispatcher) autogenReject(ctx context.Context, cmd controlplane.Command) (map[string]any, error) {
	if d.deps.Observer == nil {
		return nil, errors.New("autogen disabled on agent")
	}
	containerID := cmd.ContainerID
	if containerID == "" {
		return nil, errors.New("container_id required")
	}
	reason, _ := cmd.Payload["reason"].(string)
	if store := d.deps.Observer.StoreHandle(); store != nil {
		if err := store.MarkProposal(ctx, containerID, autogen.StatusRejected, "control-plane", reason); err != nil {
			return nil, fmt.Errorf("mark rejected: %w", err)
		}
	}
	if d.deps.Audit != nil {
		d.deps.Audit.AutogenRejected(containerID, "", reason, "control-plane")
	}
	return map[string]any{
		"container_id": containerID,
		"reason":       reason,
	}, nil
}

func (d *Dispatcher) findProposal(ctx context.Context, containerID string) *autogen.Proposal {
	minSamples := 0
	if d.deps.Config != nil {
		minSamples = d.deps.Config.AutogenMinSamples
	}
	for _, p := range d.deps.Observer.Propose(minSamples, proposalLookupMinAge) {
		if p.ContainerID == containerID || strings.HasPrefix(p.ContainerID, containerID) {
			out := p
			return &out
		}
	}
	if store := d.deps.Observer.StoreHandle(); store != nil {
		records, _ := store.ListProposals(ctx, autogen.StatusPending)
		for _, rec := range records {
			if rec.ContainerID == containerID || strings.HasPrefix(rec.ContainerID, containerID) {
				return &autogen.Proposal{
					ContainerID: rec.ContainerID,
					Ports:       rec.Ports,
					Peers:       rec.Peers,
					Confidence:  rec.Confidence,
				}
			}
		}
	}
	return nil
}

func autogenLabelsSnippet(p autogen.Proposal) string {
	var b strings.Builder
	b.WriteString("labels:\n")
	b.WriteString("  firefik.enable: \"true\"\n")
	if len(p.Ports) > 0 {
		ports := make([]string, 0, len(p.Ports))
		for _, port := range p.Ports {
			ports = append(ports, fmt.Sprintf("%d", port))
		}
		b.WriteString(fmt.Sprintf("  firefik.firewall.auto.ports: %q\n", strings.Join(ports, ",")))
	}
	if len(p.Peers) > 0 {
		b.WriteString(fmt.Sprintf("  firefik.firewall.auto.allowlist: %q\n", strings.Join(p.Peers, ",")))
	}
	b.WriteString("  firefik.defaultpolicy: \"DROP\"\n")
	return b.String()
}

func autogenPolicySnippet(p autogen.Proposal) string {
	var b strings.Builder
	b.WriteString(fmt.Sprintf("policy %q {\n", p.ContainerID))
	b.WriteString("  default deny\n")
	for _, port := range p.Ports {
		b.WriteString(fmt.Sprintf("  allow tcp dport %d\n", port))
	}
	for _, peer := range p.Peers {
		b.WriteString(fmt.Sprintf("  allow from %s\n", peer))
	}
	b.WriteString("}\n")
	return b.String()
}

type ProposalSource struct {
	Observer *autogen.Observer
	Config   *config.Config
}

func (a *ProposalSource) Proposals(_ context.Context) []controlplane.AutogenProposal {
	if a.Observer == nil {
		return nil
	}
	min := 0
	if a.Config != nil {
		min = a.Config.AutogenMinSamples
	}
	props := a.Observer.Propose(min, proposalLookupMinAge)
	out := make([]controlplane.AutogenProposal, 0, len(props))
	for _, p := range props {
		ports := make([]uint32, 0, len(p.Ports))
		for _, port := range p.Ports {
			ports = append(ports, uint32(port))
		}
		out = append(out, controlplane.AutogenProposal{
			ContainerID: p.ContainerID,
			Ports:       ports,
			Peers:       append([]string(nil), p.Peers...),
			ObservedFor: p.ObservedFor,
			Confidence:  p.Confidence,
		})
	}
	return out
}
