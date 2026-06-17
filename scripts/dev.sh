#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  cat <<'USAGE'
用法：
  scripts/dev.sh
  make dev
  pnpm dev

作用：
  启动本地开发模式：Go 后端、管理后台 Vite、插件弹窗 Vite 预览。

可覆盖的环境变量：
  SERVER_ADDR                         默认 127.0.0.1:8080
  SERVER_DB_PATH                      默认 ./data/2fa-dev.sqlite
  SERVER_BOOTSTRAP_ADMIN_USERNAME     默认 admin
  SERVER_BOOTSTRAP_ADMIN_PASSWORD     默认 AdminPassword123!
  ADMIN_DEV_PORT                      默认 5173
  EXTENSION_DEV_PORT                  默认 5174

说明：
  如果根目录存在 .env，会先加载 .env，再补齐开发默认值。
  管理员账号只会在数据库为空时自动创建。
USAGE
  exit 0
fi

load_env_file() {
  local file=$1
  local line key value
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*$ ]] && continue
    [[ $line =~ ^[[:space:]]*# ]] && continue
    [[ $line != *=* ]] && continue
    key=${line%%=*}
    value=${line#*=}
    key=${key##+([[:space:]])}
    key=${key%%+([[:space:]])}
    [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [[ -z ${!key+x} ]]; then
      export "$key=$value"
    fi
  done < "$file"
}

shopt -s extglob
if [[ -f .env ]]; then
  load_env_file .env
fi
shopt -u extglob

: "${SERVER_ADDR:=127.0.0.1:8080}"
: "${SERVER_ENV:=development}"
: "${SERVER_DB_PATH:=./data/2fa-dev.sqlite}"
: "${SERVER_PUBLIC_ORIGIN:=http://127.0.0.1:8080}"
: "${SERVER_SESSION_TTL:=720h}"
: "${SERVER_BOOTSTRAP_ADMIN_USERNAME:=admin}"
: "${SERVER_BOOTSTRAP_ADMIN_PASSWORD:=AdminPassword123!}"
: "${SERVER_RATE_LIMIT_AUTH_PER_MIN:=120}"
: "${SERVER_RATE_LIMIT_SYNC_PER_MIN:=1200}"
: "${ADMIN_DEV_PORT:=5173}"
: "${EXTENSION_DEV_PORT:=5174}"
: "${SERVER_ALLOWED_ORIGINS:=http://127.0.0.1:${ADMIN_DEV_PORT},http://localhost:${ADMIN_DEV_PORT},http://127.0.0.1:${EXTENSION_DEV_PORT},http://localhost:${EXTENSION_DEV_PORT}}"

if [[ ${SERVER_BOOTSTRAP_ADMIN_PASSWORD} != "" && ${#SERVER_BOOTSTRAP_ADMIN_PASSWORD} -lt 12 ]]; then
  printf '开发管理员密码至少需要 12 个字符：SERVER_BOOTSTRAP_ADMIN_PASSWORD\n' >&2
  exit 2
fi

mkdir -p "$(dirname "$SERVER_DB_PATH")"

export SERVER_ADDR
export SERVER_ENV
export SERVER_DB_PATH
export SERVER_PUBLIC_ORIGIN
export SERVER_SESSION_TTL
export SERVER_BOOTSTRAP_ADMIN_USERNAME
export SERVER_BOOTSTRAP_ADMIN_PASSWORD
export SERVER_RATE_LIMIT_AUTH_PER_MIN
export SERVER_RATE_LIMIT_SYNC_PER_MIN
export SERVER_ALLOWED_ORIGINS

pids=()

cleanup() {
  local code=$?
  local pid
  trap - INT TERM EXIT
  if ((${#pids[@]} > 0)); then
    printf '\n正在停止开发服务...\n'
    for pid in "${pids[@]}"; do
      kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    done
    sleep 0.5
    for pid in "${pids[@]}"; do
      kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    done
    wait "${pids[@]}" 2>/dev/null || true
  fi
  exit "$code"
}
trap cleanup INT TERM EXIT

start_service() {
  local name=$1
  shift
  printf '启动 %s...\n' "$name"
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" &
  else
    "$@" &
  fi
  pids+=("$!")
}

start_service "后端 API (${SERVER_ADDR})" go run ./cmd/server
start_service "管理后台 (http://127.0.0.1:${ADMIN_DEV_PORT})" pnpm --filter @2fa/admin exec vite --host 127.0.0.1 --port "$ADMIN_DEV_PORT"
start_service "插件预览 (http://127.0.0.1:${EXTENSION_DEV_PORT}/popup.html)" pnpm --filter @2fa/extension exec vite --host 127.0.0.1 --port "$EXTENSION_DEV_PORT"

cat <<INFO

开发模式已启动：
  后端 API：      http://${SERVER_ADDR}
  健康检查：      http://${SERVER_ADDR}/v1/meta/health
  管理后台：      http://127.0.0.1:${ADMIN_DEV_PORT}
  插件预览：      http://127.0.0.1:${EXTENSION_DEV_PORT}/popup.html
  SQLite：        ${SERVER_DB_PATH}

默认管理员（仅数据库为空时创建）：
  用户名：${SERVER_BOOTSTRAP_ADMIN_USERNAME}
  密码：  ${SERVER_BOOTSTRAP_ADMIN_PASSWORD}

按 Ctrl+C 停止全部开发服务。

INFO

wait -n "${pids[@]}"
