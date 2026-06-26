#!/usr/bin/env bash
# void test-lab — shared library.
#
# Sourced by up.sh / down.sh / servers.sh / deploy.sh / logs.sh.
# Provides:
#   - logging helpers (info / ok / warn / die)
#   - prerequisite checks (orb, docker, wrangler, jq, cargo)
#   - paths (LAB_DIR, LAB_PID, LAB_LOG, API_BASE, BEARER)
#   - helpers for talking to the local wrangler dev

set -euo pipefail

# Resolve the repo root from wherever the script lives.
LAB_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAB_DIR="$LAB_REPO_ROOT/.test-lab"
LAB_PID="$LAB_DIR/wrangler.pid"
LAB_LOG="$LAB_DIR/wrangler.log"
LAB_REG="$LAB_DIR/registration.json"
LAB_CLOUD_INIT="$LAB_DIR/user-data.sh"
LAB_VM_NAME="${VOID_LAB_VM_NAME:-void-lab}"
LAB_AGENT_PORT="${VOID_LAB_AGENT_PORT:-8787}"

# API base URL (host where wrangler dev listens). Override with VOID_LAB_API.
LAB_API="${VOID_LAB_API:-http://127.0.0.1:$LAB_AGENT_PORT}"

# --- colors (only when stdout is a TTY) ---
if [ -t 1 ]; then
	C_RESET=$'\033[0m'
	C_DIM=$'\033[2m'
	C_BOLD=$'\033[1m'
	C_RED=$'\033[31m'
	C_GREEN=$'\033[32m'
	C_YELLOW=$'\033[33m'
	C_CYAN=$'\033[36m'
else
	C_RESET="" C_DIM="" C_BOLD="" C_RED="" C_GREEN="" C_YELLOW="" C_CYAN=""
fi

log()  { printf "%s•%s %s\n" "$C_CYAN"   "$C_RESET" "$*"; }
ok()   { printf "%s✓%s %s\n" "$C_GREEN"  "$C_RESET" "$*"; }
warn() { printf "%s!%s %s\n" "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf "%s✕%s %s\n" "$C_RED"    "$C_RESET" "$*" >&2; exit 1; }
section() { printf "\n%s%s%s\n" "$C_BOLD" "$*" "$C_RESET"; }

# --- prereqs ---

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "missing required command: $1 ($2)"
}

check_prereqs() {
	require_cmd orb     "brew install orbstack"
	require_cmd docker  "brew install --cask docker"
	require_cmd wrangler "pnpm install in worker/"
	require_cmd jq      "brew install jq"
	require_cmd cargo   "rustup toolchain install stable"
}

# --- wrangler lifecycle ---

wrangler_is_up() {
	# /health returns 200 from the worker even with no secrets set
	curl -fsS -o /dev/null -m 1 "$LAB_API/health" 2>/dev/null
}

wrangler_start() {
	mkdir -p "$LAB_DIR"
	if wrangler_is_up; then
		ok "wrangler dev already up at $LAB_API"
		return 0
	fi
	if [ -f "$LAB_PID" ] && kill -0 "$(cat "$LAB_PID")" 2>/dev/null; then
		warn "wrangler pidfile exists and process is alive but /health unreachable"
		warn "killing stale pid and starting a fresh one"
		kill "$(cat "$LAB_PID")" 2>/dev/null || true
	fi
	log "starting wrangler dev (logs: $LAB_LOG)..."
	(
		cd "$LAB_REPO_ROOT/worker"
		# nohup so the dev process survives us exiting
		nohup wrangler dev --port "$LAB_AGENT_PORT" --ip 0.0.0.0 \
			> "$LAB_LOG" 2>&1 &
		echo $! > "$LAB_PID"
	)
	# wait for /health
	for i in $(seq 1 60); do
		if wrangler_is_up; then
			ok "wrangler dev up after ${i}s"
			return 0
		fi
		sleep 1
	done
	die "wrangler dev did not respond to $LAB_API/health within 60s (see $LAB_LOG)"
}

wrangler_stop() {
	if [ -f "$LAB_PID" ]; then
		local pid
		pid="$(cat "$LAB_PID")"
		if kill -0 "$pid" 2>/dev/null; then
			log "stopping wrangler dev (pid $pid)..."
			kill "$pid" 2>/dev/null || true
			# give it a moment, then force
			sleep 1
			kill -9 "$pid" 2>/dev/null || true
			ok "wrangler dev stopped"
		fi
		rm -f "$LAB_PID"
	fi
}

# --- bearer token resolution ---

bearer_from_dev_vars() {
	# Read VOID_BEARER_TOKEN from worker/.dev.vars (gitignored, dev-only).
	# Format is `KEY = "value"` per wrangler's TOML env file.
	local f="$LAB_REPO_ROOT/worker/.dev.vars"
	[ -f "$f" ] || return 1
	awk -F'"' '/^VOID_BEARER_TOKEN[[:space:]]*=/ {print $2; exit}' "$f"
}

bearer_from_env() {
	[ -n "${VOID_BEARER_TOKEN:-}" ] && printf "%s" "$VOID_BEARER_TOKEN"
}

bearer_resolve() {
	bearer_from_env || bearer_from_dev_vars || die "no VOID_BEARER_TOKEN in env or worker/.dev.vars"
}

# --- API helpers ---

api_register() {
	local bearer
	bearer="$(bearer_resolve)"
	local name="${1:-}"
	local body
	if [ -n "$name" ]; then
		body=$(jq -nc --arg name "$name" '{name:$name}')
	else
		body='{}'
	fi
	curl -fsS -X POST "$LAB_API/api/servers/register" \
		-H "Authorization: Bearer $bearer" \
		-H "Content-Type: application/json" \
		-d "$body"
}

api_servers() {
	local bearer
	bearer="$(bearer_resolve)"
	curl -fsS -H "Authorization: Bearer $bearer" "$LAB_API/api/servers"
}
