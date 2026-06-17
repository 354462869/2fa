# syntax=docker/dockerfile:1.7
# ---- admin frontend ----
FROM node:20-alpine AS admin-builder

WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/admin/package.json ./apps/admin/package.json
COPY packages/api-client/package.json ./packages/api-client/package.json
COPY packages/api-types/package.json ./packages/api-types/package.json
RUN pnpm install --frozen-lockfile

COPY apps/admin ./apps/admin
COPY packages/api-client ./packages/api-client
COPY packages/api-types ./packages/api-types
RUN pnpm --filter @2fa/api-types build \
    && pnpm --filter @2fa/api-client build \
    && pnpm --filter @2fa/admin build

# ---- builder ----
FROM golang:1.22-alpine AS builder

WORKDIR /src
ENV CGO_ENABLED=1 \
    GOOS=linux

RUN apk add --no-cache build-base sqlite-dev

COPY go.mod go.sum* ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal
COPY docs ./docs

RUN go build -trimpath -ldflags="-s -w" -o /out/2fa-server ./cmd/server

# ---- runtime ----
FROM alpine:3.20 AS runtime

WORKDIR /app
RUN apk add --no-cache ca-certificates sqlite-libs && mkdir -p /data /app/admin
COPY --from=builder /out/2fa-server /app/2fa-server
COPY --from=admin-builder /src/apps/admin/dist /app/admin

ENV SERVER_ADDR=0.0.0.0:8080 \
    SERVER_DB_PATH=/data/2fa.sqlite \
    SERVER_ADMIN_ASSETS_DIR=/app/admin

EXPOSE 8080

ENTRYPOINT ["/app/2fa-server"]
