package controlplane

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"sync"
	"time"

	pb "firefik/internal/controlplane/gen/controlplanev1"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	backoffMin      = 250 * time.Millisecond
	backoffMax      = 30 * time.Second
	backoffJitterPc = 0.2
)

type CommandDispatcher interface {
	Dispatch(ctx context.Context, cmd Command) CommandAck
}

type GRPCClientConfig struct {
	Endpoint    string
	Token       string
	Identity    AgentIdentity
	TLSConfig   *tls.Config
	DialTimeout time.Duration
	Dispatcher  CommandDispatcher
	Logger      *slog.Logger
}

type GRPCClient struct {
	cfg GRPCClientConfig

	mu     sync.Mutex
	stream pb.ControlPlane_StreamClient
}

func NewGRPCClient(cfg GRPCClientConfig) *GRPCClient {
	if cfg.DialTimeout == 0 {
		cfg.DialTimeout = 5 * time.Second
	}
	return &GRPCClient{cfg: cfg}
}

func (c *GRPCClient) Run(ctx context.Context) error {
	peer := c.cfg.Endpoint
	ConnectionState.WithLabelValues(peer, "grpc").Set(0)
	defer ConnectionState.DeleteLabelValues(peer, "grpc")

	backoff := backoffMin
	for ctx.Err() == nil {
		ConnectionState.WithLabelValues(peer, "grpc").Set(0.5)
		err := c.runOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if err == nil {

			backoff = backoffMin
			continue
		}
		if c.cfg.Logger != nil {
			c.cfg.Logger.Warn("control-plane gRPC disconnected; will retry",
				"peer", peer, "error", err, "backoff", backoff)
		}
		ConnectionState.WithLabelValues(peer, "grpc").Set(0)
		if !sleepWithContext(ctx, jitter(backoff)) {
			return nil
		}
		backoff = nextBackoff(backoff)
	}
	return nil
}

func (c *GRPCClient) SendSnapshot(snap AgentSnapshot) error {
	c.mu.Lock()
	st := c.stream
	c.mu.Unlock()
	if st == nil {
		return ErrStreamDown
	}
	if snap.Agent.Labels == nil {
		snap.Agent.Labels = c.cfg.Identity.Labels
	} else if c.cfg.Identity.Labels != nil {
		merged := make(map[string]string, len(c.cfg.Identity.Labels)+len(snap.Agent.Labels))
		for k, v := range c.cfg.Identity.Labels {
			merged[k] = v
		}
		for k, v := range snap.Agent.Labels {
			merged[k] = v
		}
		snap.Agent.Labels = merged
	}
	snap.Agent.InstanceID = c.cfg.Identity.InstanceID
	snap.Agent.Hostname = c.cfg.Identity.Hostname
	snap.Agent.Version = c.cfg.Identity.Version
	snap.Agent.Backend = c.cfg.Identity.Backend
	snap.Agent.Chain = c.cfg.Identity.Chain
	if snap.At.IsZero() {
		snap.At = time.Now().UTC()
	}
	return st.Send(&pb.AgentEvent{
		Kind: &pb.AgentEvent_Snapshot{Snapshot: toPBSnapshot(snap)},
	})
}

func (c *GRPCClient) SendAudit(event map[string]any) error {
	c.mu.Lock()
	st := c.stream
	c.mu.Unlock()
	if st == nil {
		return ErrStreamDown
	}
	payload, err := structpb.NewStruct(event)
	if err != nil {
		return fmt.Errorf("audit struct: %w", err)
	}
	return st.Send(&pb.AgentEvent{
		Kind: &pb.AgentEvent_Audit{
			Audit: &pb.AuditEvent{Agent: toPBIdentity(c.cfg.Identity), Event: payload},
		},
	})
}

func (c *GRPCClient) SendLog(line LogLine) error {
	c.mu.Lock()
	st := c.stream
	c.mu.Unlock()
	if st == nil {
		return ErrStreamDown
	}
	if line.At.IsZero() {
		line.At = time.Now().UTC()
	}
	return st.Send(&pb.AgentEvent{
		Kind: &pb.AgentEvent_Log{
			Log: &pb.LogLine{
				Agent:  toPBIdentity(c.cfg.Identity),
				At:     timestamppb.New(line.At),
				Level:  line.Level,
				Source: line.Source,
				Line:   line.Line,
				Fields: copyLabels(line.Fields),
			},
		},
	})
}

func (c *GRPCClient) SendHeartbeat() error {
	c.mu.Lock()
	st := c.stream
	c.mu.Unlock()
	if st == nil {
		return ErrStreamDown
	}
	return st.Send(&pb.AgentEvent{
		Kind: &pb.AgentEvent_Heartbeat{
			Heartbeat: &pb.Heartbeat{
				Agent: toPBIdentity(c.cfg.Identity),
				At:    timestamppb.Now(),
			},
		},
	})
}

func (c *GRPCClient) SendAutogenProposals(items []AutogenProposal) error {
	if len(items) == 0 {
		return nil
	}
	c.mu.Lock()
	st := c.stream
	c.mu.Unlock()
	if st == nil {
		return ErrStreamDown
	}
	pbItems := make([]*pb.AutogenProposal, 0, len(items))
	for _, p := range items {
		pbItems = append(pbItems, &pb.AutogenProposal{
			ContainerId: p.ContainerID,
			Ports:       append([]uint32(nil), p.Ports...),
			Peers:       append([]string(nil), p.Peers...),
			ObservedFor: p.ObservedFor,
			Confidence:  p.Confidence,
		})
	}
	return st.Send(&pb.AgentEvent{
		Kind: &pb.AgentEvent_AutogenProposals{
			AutogenProposals: &pb.AutogenProposals{
				Agent:     toPBIdentity(c.cfg.Identity),
				Proposals: pbItems,
				At:        timestamppb.Now(),
			},
		},
	})
}

var ErrStreamDown = errors.New("control-plane gRPC stream is down")

func (c *GRPCClient) runOnce(ctx context.Context) error {
	var tc credentials.TransportCredentials
	if c.cfg.TLSConfig != nil {
		tc = credentials.NewTLS(c.cfg.TLSConfig)
	} else {
		tc = insecure.NewCredentials()
	}

	dialCtx, cancel := context.WithTimeout(ctx, c.cfg.DialTimeout)
	defer cancel()
	conn, err := grpc.DialContext(dialCtx, c.cfg.Endpoint,
		grpc.WithTransportCredentials(tc),
		grpc.WithBlock(),
	)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	cli := pb.NewControlPlaneClient(conn)

	regCtx := withAuth(ctx, c.cfg.Token)
	if _, err := cli.Register(regCtx, &pb.RegisterRequest{
		Identity: toPBIdentity(c.cfg.Identity),
	}); err != nil {
		return fmt.Errorf("register: %w", err)
	}

	streamCtx, streamCancel := context.WithCancel(withAuth(ctx, c.cfg.Token))
	defer streamCancel()
	stream, err := cli.Stream(streamCtx)
	if err != nil {
		return fmt.Errorf("stream open: %w", err)
	}

	if err := stream.Send(&pb.AgentEvent{
		Kind: &pb.AgentEvent_Heartbeat{
			Heartbeat: &pb.Heartbeat{
				Agent: toPBIdentity(c.cfg.Identity),
				At:    timestamppb.Now(),
			},
		},
	}); err != nil {
		return fmt.Errorf("initial heartbeat: %w", err)
	}

	c.mu.Lock()
	c.stream = stream
	c.mu.Unlock()
	peer := c.cfg.Endpoint
	ConnectionState.WithLabelValues(peer, "grpc").Set(1)
	if c.cfg.Logger != nil {
		c.cfg.Logger.Info("control-plane gRPC connected", "peer", peer)
	}
	defer func() {
		c.mu.Lock()
		c.stream = nil
		c.mu.Unlock()
		ConnectionState.WithLabelValues(peer, "grpc").Set(0)
	}()

	for {
		cmd, err := stream.Recv()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if c.cfg.Dispatcher == nil {
			continue
		}
		ack := c.cfg.Dispatcher.Dispatch(ctx, toNativeCommand(cmd))
		if ack.CompletedAt.IsZero() {
			ack.CompletedAt = time.Now().UTC()
		}
		if ack.AgentID == "" {
			ack.AgentID = c.cfg.Identity.InstanceID
		}

		ackCtx, ackCancel := context.WithTimeout(withAuth(ctx, c.cfg.Token), 5*time.Second)
		if _, err := cli.Ack(ackCtx, toPBAck(ack)); err != nil && c.cfg.Logger != nil {
			c.cfg.Logger.Warn("control-plane ack failed", "peer", peer, "cmd_id", ack.ID, "error", err)
		}
		ackCancel()
	}
}

func withAuth(ctx context.Context, token string) context.Context {
	if token == "" {
		return ctx
	}
	return metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token)
}

func sleepWithContext(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func nextBackoff(d time.Duration) time.Duration {
	next := d * 2
	if next > backoffMax {
		return backoffMax
	}
	return next
}

func jitter(d time.Duration) time.Duration {
	delta := float64(d) * backoffJitterPc
	offset := (rand.Float64()*2 - 1) * delta // #nosec G404 -- backoff jitter, not a secret
	out := time.Duration(float64(d) + offset)
	if out < backoffMin {
		return backoffMin
	}
	return out
}

func toPBIdentity(in AgentIdentity) *pb.AgentIdentity {
	return &pb.AgentIdentity{
		InstanceId: in.InstanceID,
		Hostname:   in.Hostname,
		Version:    in.Version,
		Backend:    in.Backend,
		Chain:      in.Chain,
		Labels:     copyLabels(in.Labels),
	}
}

func toPBSnapshot(in AgentSnapshot) *pb.AgentSnapshot {
	out := &pb.AgentSnapshot{Agent: toPBIdentity(in.Agent), At: timestamppb.New(in.At)}
	for _, c := range in.Containers {
		out.Containers = append(out.Containers, &pb.ContainerState{
			Id:             c.ID,
			Name:           c.Name,
			Status:         c.Status,
			FirewallStatus: c.FirewallStatus,
			DefaultPolicy:  c.DefaultPolicy,
			Labels:         copyLabels(c.Labels),
			RuleSetCount:   int32(c.RuleSetCount), // #nosec G115 -- rule set count is far below MaxInt32
			Sources:        append([]string(nil), c.Sources...),
		})
	}
	for _, b := range in.Traffic {
		out.Traffic = append(out.Traffic, &pb.TrafficBucket{
			Ts:       b.Timestamp,
			Accepted: b.Accepted,
			Dropped:  b.Dropped,
		})
	}
	return out
}

func toPBAck(in CommandAck) *pb.CommandAck {
	out := &pb.CommandAck{
		Id:          in.ID,
		AgentId:     in.AgentID,
		Success:     in.Success,
		Error:       in.Error,
		CompletedAt: timestamppb.New(in.CompletedAt),
	}
	if len(in.ResultPayload) > 0 {
		if p, err := structpb.NewStruct(in.ResultPayload); err == nil {
			out.ResultPayload = p
		}
	}
	return out
}

func toNativeCommand(in *pb.ServerCommand) Command {
	out := Command{
		ID:          in.Id,
		Kind:        commandKindFromPB(in.Kind),
		ContainerID: in.ContainerId,
	}
	if in.IssuedAt != nil {
		out.IssuedAt = in.IssuedAt.AsTime()
	}
	if in.Payload != nil {
		out.Payload = in.Payload.AsMap()
	}
	return out
}

func commandKindFromPB(k pb.CommandKind) CommandKind {
	switch k {
	case pb.CommandKind_COMMAND_KIND_APPLY:
		return CommandApply
	case pb.CommandKind_COMMAND_KIND_DISABLE:
		return CommandDisable
	case pb.CommandKind_COMMAND_KIND_RECONCILE:
		return CommandReconcile
	case pb.CommandKind_COMMAND_KIND_TOKEN_ROTATE:
		return CommandTokenRotate
	case pb.CommandKind_COMMAND_KIND_STATS_COLLECT:
		return CommandStatsCollect
	case pb.CommandKind_COMMAND_KIND_AUTOGEN_APPROVE:
		return CommandAutogenApprove
	case pb.CommandKind_COMMAND_KIND_AUTOGEN_REJECT:
		return CommandAutogenReject
	default:
		return CommandKind("")
	}
}
