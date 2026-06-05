# syntax=docker/dockerfile:1.7

FROM golang:1.26.4-alpine AS builder
WORKDIR /app

RUN apk add --no-cache iptables-dev build-base git

COPY go.mod go.sum ./
RUN go mod download

COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w -X main.version=${VERSION}" \
    -o firefik ./cmd/firefik
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w" \
    -o firefik-admin ./cmd/firefik-admin
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w" \
    -o firefik-server ./cmd/firefik-server

FROM alpine:3.23.4

RUN apk add --no-cache iptables ip6tables nftables wget ca-certificates tzdata \
    && apk upgrade --no-cache \
    && mkdir -p /run/firefik /var/lib/firefik /var/lib/firefik-server

WORKDIR /app
COPY --from=builder /app/firefik .
COPY --from=builder /app/firefik-admin /usr/local/bin/firefik-admin
COPY --from=builder /app/firefik-server /usr/local/bin/firefik-server

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --timeout=2 -q -O- \
        http://127.0.0.1:9999/live 2>/dev/null || \
        test -S /run/firefik/api.sock || exit 1

EXPOSE 8080
CMD ["./firefik"]
