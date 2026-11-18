package logstream

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/florianl/go-nflog/v2"
	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
)

type LogEntry struct {
	Timestamp   string `json:"ts"`
	Raw         string `json:"raw"`
	Action      string `json:"action,omitempty"`
	Rule        string `json:"rule,omitempty"`
	SrcIP       string `json:"srcIP,omitempty"`
	DstIP       string `json:"dstIP,omitempty"`
	DstPort     int    `json:"dstPort,omitempty"`
	Container   string `json:"container,omitempty"`
	ContainerID string `json:"containerID,omitempty"`
	Proto       string `json:"proto,omitempty"`
}

type ContainerResolver func(ip string) (id, name string)

const HostContainer = "host"

type FlowEvent struct {
	Action  string
	SrcIP   string
	DstIP   string
	DstPort int
	Proto   string
}

func StartNflogReader(
	ctx context.Context,
	nflogGroup uint16,
	hub *Hub,
	logger *slog.Logger,
	onAction func(action string),
	onFlow func(FlowEvent),
	resolve ContainerResolver,
) error {
	config := nflog.Config{
		Group:    nflogGroup,
		Copymode: nflog.CopyPacket,
	}

	nfl, err := nflog.Open(&config)
	if err != nil {
		return fmt.Errorf("open nflog: %w", err)
	}
	defer nfl.Close()

	logger.Info("nflog reader started", slog.Int("group", int(nflogGroup)))

	hook := func(attrs nflog.Attribute) int {
		var prefix string
		if attrs.Prefix != nil {
			prefix = *attrs.Prefix
		}
		var payload []byte
		if attrs.Payload != nil {
			payload = *attrs.Payload
		}
		entry, ok := buildLogEntry(prefix, payload, time.Now().UTC().Format(time.RFC3339))
		if !ok {
			return 0
		}
		attachContainer(&entry, resolve)

		b, err := json.Marshal(entry)
		if err != nil {
			return 0
		}

		hub.Broadcast(b)
		if onAction != nil && entry.Action != "" {
			onAction(entry.Action)
		}
		if onFlow != nil && (entry.SrcIP != "" || entry.DstIP != "") {
			onFlow(FlowEvent{
				Action:  entry.Action,
				SrcIP:   entry.SrcIP,
				DstIP:   entry.DstIP,
				DstPort: entry.DstPort,
				Proto:   entry.Proto,
			})
		}

		return 0
	}

	errFunc := func(err error) int {
		logger.Error("nflog error", slog.String("error", err.Error()))
		return 0
	}

	if err := nfl.RegisterWithErrorFunc(ctx, hook, errFunc); err != nil {
		return fmt.Errorf("register nflog hook: %w", err)
	}

	<-ctx.Done()
	return nil
}

func buildLogEntry(prefix string, payload []byte, timestamp string) (LogEntry, bool) {
	action, rule, ok := parsePrefix(prefix)
	if !ok {
		return LogEntry{}, false
	}
	entry := LogEntry{
		Timestamp: timestamp,
		Raw:       prefix,
		Action:    action,
		Rule:      rule,
	}

	if len(payload) > 0 {
		decodePacket(payload, &entry)
	}
	return entry, true
}

func parsePrefix(prefix string) (action, rule string, ok bool) {
	idx := strings.Index(strings.ToUpper(prefix), "FIREFIK")
	if idx < 0 {
		return "", "", false
	}
	rest := strings.TrimLeft(prefix[idx+len("FIREFIK"):], " -")
	if upper := strings.ToUpper(rest); strings.HasPrefix(upper, "HOST-") {
		return actionWord(rest[len("HOST-"):]), "host", true
	}
	word, remainder, _ := strings.Cut(rest, " ")
	if a := actionWord(word); a != "" {
		return a, strings.TrimSpace(remainder), true
	}
	return "", strings.TrimSpace(rest), true
}

func actionWord(s string) string {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "DROP":
		return "DROP"
	case "ACCEPT":
		return "ACCEPT"
	}
	return ""
}

func attachContainer(entry *LogEntry, resolve ContainerResolver) {
	if entry.Rule == HostContainer || strings.HasPrefix(entry.Rule, HostContainer+" ") {
		entry.Container = HostContainer
		return
	}
	if resolve == nil {
		return
	}
	for _, ip := range []string{entry.DstIP, entry.SrcIP} {
		if ip == "" {
			continue
		}
		if id, name := resolve(ip); id != "" {
			entry.ContainerID = id
			entry.Container = name
			if entry.Container == "" {
				entry.Container = id
			}
			return
		}
	}
}

func decodePacket(payload []byte, entry *LogEntry) {
	firstLayer := layers.LayerTypeIPv4
	if payload[0]>>4 == 6 {
		firstLayer = layers.LayerTypeIPv6
	}
	packet := gopacket.NewPacket(payload, firstLayer, gopacket.NoCopy)

	if ipv4Layer := packet.Layer(layers.LayerTypeIPv4); ipv4Layer != nil {
		ipv4, _ := ipv4Layer.(*layers.IPv4)
		entry.SrcIP = ipv4.SrcIP.String()
		entry.DstIP = ipv4.DstIP.String()
		entry.Proto = ipv4.Protocol.String()
	} else if ipv6Layer := packet.Layer(layers.LayerTypeIPv6); ipv6Layer != nil {
		ipv6, _ := ipv6Layer.(*layers.IPv6)
		entry.SrcIP = ipv6.SrcIP.String()
		entry.DstIP = ipv6.DstIP.String()
		entry.Proto = ipv6.NextHeader.String()
	}

	if tcpLayer := packet.Layer(layers.LayerTypeTCP); tcpLayer != nil {
		tcp, _ := tcpLayer.(*layers.TCP)
		entry.DstPort = int(tcp.DstPort)
	} else if udpLayer := packet.Layer(layers.LayerTypeUDP); udpLayer != nil {
		udp, _ := udpLayer.(*layers.UDP)
		entry.DstPort = int(udp.DstPort)
	}
}
