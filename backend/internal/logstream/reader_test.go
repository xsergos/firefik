package logstream

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
)

const ts = "2025-01-01T00:00:00Z"

func TestBuildLogEntry_NoFirefikPrefix(t *testing.T) {
	if _, ok := buildLogEntry("nope", nil, ts); ok {
		t.Errorf("expected no entry for non-firefik prefix")
	}
}

func TestBuildLogEntry_DropAction(t *testing.T) {
	entry, ok := buildLogEntry("FIREFIK DROP api", nil, ts)
	if !ok {
		t.Fatal("expected ok")
	}
	if entry.Action != "DROP" {
		t.Errorf("action=%q", entry.Action)
	}
	if entry.Raw != "FIREFIK DROP api" {
		t.Errorf("raw=%q", entry.Raw)
	}
}

func TestBuildLogEntry_AcceptAction(t *testing.T) {
	entry, ok := buildLogEntry("FIREFIK ACCEPT web", nil, ts)
	if !ok {
		t.Fatal("expected ok")
	}
	if entry.Action != "ACCEPT" {
		t.Errorf("action=%q", entry.Action)
	}
}

func TestBuildLogEntry_FirefikNoActionVerb(t *testing.T) {
	entry, ok := buildLogEntry("FIREFIK", nil, ts)
	if !ok {
		t.Fatal("expected ok")
	}
	if entry.Action != "" {
		t.Errorf("expected empty action")
	}
}

func TestBuildLogEntry_IPv4TCPPayload(t *testing.T) {
	payload := buildIPv4TCP(t, "10.0.0.1", "10.0.0.2", 12345, 443)
	entry, ok := buildLogEntry("FIREFIK DROP api", payload, ts)
	if !ok {
		t.Fatal("expected ok")
	}
	if entry.SrcIP != "10.0.0.1" {
		t.Errorf("src=%q", entry.SrcIP)
	}
	if entry.DstIP != "10.0.0.2" {
		t.Errorf("dst=%q", entry.DstIP)
	}
	if entry.DstPort != 443 {
		t.Errorf("port=%d", entry.DstPort)
	}
	if entry.Proto != "TCP" {
		t.Errorf("proto=%q", entry.Proto)
	}
}

func TestBuildLogEntry_IPv4UDPPayload(t *testing.T) {
	payload := buildIPv4UDP(t, "10.0.0.10", "10.0.0.20", 1000, 53)
	entry, ok := buildLogEntry("FIREFIK ACCEPT dns", payload, ts)
	if !ok {
		t.Fatal("expected ok")
	}
	if entry.DstPort != 53 {
		t.Errorf("port=%d", entry.DstPort)
	}
	if entry.Proto != "UDP" {
		t.Errorf("proto=%q", entry.Proto)
	}
}

func TestBuildLogEntry_IPv6TCPPayload(t *testing.T) {
	payload := buildIPv6TCP(t, "2001:db8::1", "2001:db8::2", 1111, 22)
	entry, ok := buildLogEntry("FIREFIK DROP ssh", payload, ts)
	if !ok {
		t.Fatal("expected ok")
	}
	if entry.SrcIP != "2001:db8::1" {
		t.Errorf("src=%q", entry.SrcIP)
	}
	if entry.DstPort != 22 {
		t.Errorf("port=%d", entry.DstPort)
	}
}

func TestBuildLogEntry_GarbagePayloadDoesNotPanic(t *testing.T) {
	entry, ok := buildLogEntry("FIREFIK DROP", []byte{0x00, 0x01, 0x02}, ts)
	if !ok {
		t.Fatal("expected ok")
	}
	if entry.Action != "DROP" {
		t.Errorf("action=%q", entry.Action)
	}
}

func TestParsePrefix(t *testing.T) {
	cases := []struct {
		prefix, action, rule string
	}{
		{"FIREFIK DROP", "DROP", ""},
		{"FIREFIK DROP default", "DROP", "default"},
		{"FIREFIK ACCEPT web-public@v4", "ACCEPT", "web-public@v4"},
		{"FIREFIK DROP host ssh", "DROP", "host ssh"},
		{"firefik-host-DROP", "DROP", "host"},
		{"FIREFIK custom", "", "custom"},
	}
	for _, tc := range cases {
		action, rule, ok := parsePrefix(tc.prefix)
		if !ok || action != tc.action || rule != tc.rule {
			t.Errorf("parsePrefix(%q) = %q, %q, %v; want %q, %q", tc.prefix, action, rule, ok, tc.action, tc.rule)
		}
	}
	if _, _, ok := parsePrefix("other-tool"); ok {
		t.Error("foreign prefix must be rejected")
	}
}

func TestAttachContainer(t *testing.T) {
	resolve := func(ip string) (string, string) {
		if ip == "10.0.0.2" {
			return "abc123", "web"
		}
		return "", ""
	}
	e := LogEntry{Rule: "default", SrcIP: "1.2.3.4", DstIP: "10.0.0.2"}
	attachContainer(&e, resolve)
	if e.Container != "web" || e.ContainerID != "abc123" {
		t.Errorf("dst resolve: %+v", e)
	}

	egress := LogEntry{Rule: "x", SrcIP: "10.0.0.2", DstIP: "8.8.8.8"}
	attachContainer(&egress, resolve)
	if egress.Container != "web" {
		t.Errorf("src resolve: %+v", egress)
	}

	host := LogEntry{Rule: "host ssh", DstIP: "10.0.0.2"}
	attachContainer(&host, resolve)
	if host.Container != HostContainer || host.ContainerID != "" {
		t.Errorf("host rule: %+v", host)
	}

	unknown := LogEntry{Rule: "x", DstIP: "9.9.9.9"}
	attachContainer(&unknown, nil)
	if unknown.Container != "" {
		t.Errorf("nil resolver: %+v", unknown)
	}
}

func TestStartNflogReader_OpenError(t *testing.T) {
	hub := NewHub(discardLogger())
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	err := StartNflogReader(ctx, 0, hub, discardLogger(), nil, nil, nil)
	if err == nil {
		t.Skip("nflog open succeeded — skipping (likely on Linux with privileges)")
	}
}

func buildIPv4TCP(t *testing.T, src, dst string, sport, dport int) []byte {
	t.Helper()
	ip := &layers.IPv4{
		Version:  4,
		IHL:      5,
		TTL:      64,
		Protocol: layers.IPProtocolTCP,
		SrcIP:    parseIP(t, src),
		DstIP:    parseIP(t, dst),
	}
	tcp := &layers.TCP{
		SrcPort: layers.TCPPort(sport),
		DstPort: layers.TCPPort(dport),
	}
	if err := tcp.SetNetworkLayerForChecksum(ip); err != nil {
		t.Fatal(err)
	}
	return serialize(t, ip, tcp)
}

func buildIPv4UDP(t *testing.T, src, dst string, sport, dport int) []byte {
	t.Helper()
	ip := &layers.IPv4{
		Version:  4,
		IHL:      5,
		TTL:      64,
		Protocol: layers.IPProtocolUDP,
		SrcIP:    parseIP(t, src),
		DstIP:    parseIP(t, dst),
	}
	udp := &layers.UDP{
		SrcPort: layers.UDPPort(sport),
		DstPort: layers.UDPPort(dport),
	}
	if err := udp.SetNetworkLayerForChecksum(ip); err != nil {
		t.Fatal(err)
	}
	return serialize(t, ip, udp)
}

func buildIPv6TCP(t *testing.T, src, dst string, sport, dport int) []byte {
	t.Helper()
	ip := &layers.IPv6{
		Version:    6,
		HopLimit:   64,
		NextHeader: layers.IPProtocolTCP,
		SrcIP:      parseIP(t, src),
		DstIP:      parseIP(t, dst),
	}
	tcp := &layers.TCP{
		SrcPort: layers.TCPPort(sport),
		DstPort: layers.TCPPort(dport),
	}
	if err := tcp.SetNetworkLayerForChecksum(ip); err != nil {
		t.Fatal(err)
	}
	return serialize(t, ip, tcp)
}

func parseIP(t *testing.T, s string) net.IP {
	t.Helper()
	ip := net.ParseIP(s)
	if ip == nil {
		t.Fatalf("bad ip %q", s)
	}
	return ip
}

func serialize(t *testing.T, ls ...gopacket.SerializableLayer) []byte {
	t.Helper()
	buf := gopacket.NewSerializeBuffer()
	opts := gopacket.SerializeOptions{ComputeChecksums: false, FixLengths: true}
	if err := gopacket.SerializeLayers(buf, opts, ls...); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
