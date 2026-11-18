package main

import (
	"context"
	"net"
	"testing"

	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/peer"
)

func peerCtx(addr string, md metadata.MD) context.Context {
	tcp, _ := net.ResolveTCPAddr("tcp", addr)
	ctx := peer.NewContext(context.Background(), &peer.Peer{Addr: tcp})
	if md != nil {
		ctx = metadata.NewIncomingContext(ctx, md)
	}
	return ctx
}

func TestPeerIPFromContext(t *testing.T) {
	cases := []struct {
		name string
		ctx  context.Context
		want string
	}{
		{"direct public peer", peerCtx("203.0.113.9:5000", nil), "203.0.113.9"},
		{"public peer ignores forwarded header", peerCtx("203.0.113.9:5000", metadata.Pairs("x-forwarded-for", "1.2.3.4")), "203.0.113.9"},
		{"private proxy forwards client", peerCtx("172.18.0.100:5000", metadata.Pairs("x-forwarded-for", "198.51.100.7, 172.18.0.100")), "198.51.100.7"},
		{"real ip wins", peerCtx("10.0.0.2:5000", metadata.Pairs("x-real-ip", "198.51.100.8", "x-forwarded-for", "198.51.100.7")), "198.51.100.8"},
		{"garbage header falls back", peerCtx("10.0.0.2:5000", metadata.Pairs("x-forwarded-for", "not-an-ip")), "10.0.0.2"},
		{"private proxy without headers", peerCtx("172.18.0.100:5000", nil), "172.18.0.100"},
		{"no peer", context.Background(), ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := peerIPFromContext(tc.ctx); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
