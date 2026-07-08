# syntax=docker/dockerfile:1.7

FROM node:26.4.0-alpine AS frontend-build
WORKDIR /app

ARG VITE_PANEL_MODE=
ENV VITE_PANEL_MODE=${VITE_PANEL_MODE}

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM golang:1.26.4-alpine AS caddy-build
ARG CADDY_VERSION=v2.11.3
RUN apk add --no-cache git
ENV CGO_ENABLED=0
RUN go install -trimpath -ldflags="-s -w" \
    github.com/caddyserver/caddy/v2/cmd/caddy@${CADDY_VERSION}

FROM alpine:3.24.1
ARG CADDY_CONFIG=Caddyfile
RUN apk add --no-cache wget ca-certificates \
    && apk upgrade --no-cache \
    && addgroup -S caddy && adduser -S -G caddy -H -h /var/lib/caddy caddy \
    && mkdir -p /var/lib/caddy /etc/caddy /srv \
    && chown -R caddy:caddy /var/lib/caddy

COPY --from=caddy-build /go/bin/caddy /usr/bin/caddy
COPY --from=frontend-build /app/dist /srv
COPY ${CADDY_CONFIG} /etc/caddy/Caddyfile

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --timeout=2 -O /dev/null http://127.0.0.1:80/health || exit 1

EXPOSE 80 443
ENTRYPOINT ["/usr/bin/caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
