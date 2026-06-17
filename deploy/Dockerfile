# syntax=docker/dockerfile:1.7
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
RUN apk add --no-cache ca-certificates sqlite-libs && mkdir -p /data
COPY --from=builder /out/2fa-server /app/2fa-server

ENV SERVER_ADDR=0.0.0.0:8080 \
    SERVER_DB_PATH=/data/2fa.sqlite

EXPOSE 8080

ENTRYPOINT ["/app/2fa-server"]
