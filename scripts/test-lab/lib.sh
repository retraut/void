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

# Cross-compile target for the amd64 OrbStack VM. Matches release.yml
# (which builds on ubuntu-latest, no zig needed there — system gcc).
LAB_AGENT_TARGET="${VOID_LAB_AGENT_TARGET:-x86_64-unknown-linux-gnu}"

# API base URL (host where wrangler dev listens). Override with VOID_LAB_API.
LAB_API="${VOID_LAB_API:-http://127.0.0.1:$LAB_AGENT_PORT}"

# Strip // and /* */ comments from a jsonc file so jq can parse it.
strip_jsonc_comments() {
	perl -0777 -pe 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g' "$1"
}

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
	# Cross-compile the agent for the amd64 VM without a gcc
	# toolchain: zig provides the linker, cargo-zigbuild drives it.
	require_cmd zig     "brew install zig"
	# cargo-zigbuild ships as a standalone binary (not a `cargo`
	# subcommand in PATH here), so check for it directly.
	command -v cargo-zigbuild >/dev/null 2>&1 || die "cargo-zigbuild not installed. Run: cargo install cargo-zigbuild"
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
		nohup wrangler dev --config wrangler.dev.jsonc --port "$LAB_AGENT_PORT" --ip 0.0.0.0 \
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

# Delete a stale server row directly from the local D1 SQLite.
# The panel's delete route needs a session cookie; for the test-lab
# we can delete via wrangler d1 (which talks to the same local DB).
# Used by up.sh to avoid accumulating dead 'active' rows across
# wrangler dev restarts (each restart needs a fresh setup_token).
api_deregister() {
	local sid="$1"
	[ -n "$sid" ] || return 0
	local db
	db="$(strip_jsonc_comments "$LAB_REPO_ROOT/worker/wrangler.dev.jsonc" 2>/dev/null \
		| jq -r '.d1_databases[0].database_name // "void-db"')"
	( cd "$LAB_REPO_ROOT/worker" \
		&& wrangler d1 execute "$db" --local --yes \
			--command "DELETE FROM servers WHERE id = '$sid';" > /dev/null 2>&1 ) || true
}

# Resolve the host IP that an OrbStack VM should use to reach
# the wrangler dev. The control plane's /api/servers/register
# derives api_base from the request URL, which is 127.0.0.1
# (because that's where wrangler dev is bound locally). But from
# inside the VM, 127.0.0.1 is the VM itself, not the host.
#
# We rewrite the api_base in the registration response to point
# at the host's OrbStack-bridge IP. The host lives in the same
# /24 subnet as the VM (e.g. VM=192.168.139.118, host=192.168.139.3).
# Scan the subnet for the address that actually answers on
# $LAB_AGENT_PORT — that's the macOS host running wrangler dev.
# Try the common OrbStack host offsets (.3/.2) first, then the
# whole /24 in parallel to bound the worst-case runtime.
host_ip_for_vm() {
	orb run -m "$LAB_VM_NAME" sh -c '
		vm_ip=$(ip -4 addr show eth0 | awk "/inet / {print \$2}")
		base=$(echo "$vm_ip" | cut -d. -f1-3)
		vm_last=$(echo "$vm_ip" | cut -d. -f4)
		for last in 3 2 1; do
			[ "$last" = "$vm_last" ] && continue
			ip="$base.$last"
			code=$(curl -s -o /dev/null -w "%{http_code}" \
				--connect-timeout 1 "http://$ip:'"$LAB_AGENT_PORT"'/health" 2>/dev/null)
			[ "$code" = "200" ] && echo "$ip" && exit 0
		done
		for last in $(seq 1 254); do
			[ "$last" = "$vm_last" ] && continue
			ip="$base.$last"
			curl -s -o /dev/null --connect-timeout 1 \
				"http://$ip:'"$LAB_AGENT_PORT"'/health" 2>/dev/null && echo "$ip" &
		done
		wait
	' 2>/dev/null | head -1
}

# Rewrite a registration.json in-place to swap the api_base
# from 127.0.0.1 (where wrangler dev is bound) to the host IP
# the VM can actually reach. Also patches the embedded config_toml
# so it matches the rewritten api_base and server_id.
rewrite_registration_for_vm() {
	local host_ip
	host_ip="$(host_ip_for_vm)"
	if [ -z "$host_ip" ]; then
		warn "could not detect host IP from inside the VM; api_base will be 127.0.0.1 (broken)"
		return 1
	fi
	local port="${LAB_AGENT_PORT:-8787}"
	local sid
	sid=$(jq -r .server_id "$LAB_REG")
	local st
	st=$(jq -r .setup_token "$LAB_REG")

	# /api/servers/register returned wss://127.0.0.1:8787 (or
	# whatever requestUrl was). Swap host to $host_ip, keep port.
	local new_api_base="ws://${host_ip}:${port}"
	local new_config_toml
	new_config_toml=$(cat <<TOML
# void-agent config
# Written by test-lab on $(date -u +%Y-%m-%dT%H:%M:%SZ)

api_base = "${new_api_base}"
server_id = "${sid}"
setup_token = "${st}"
state_dir = "/var/lib/void"
TOML
)

	jq \
		--arg api "$new_api_base" \
		--arg toml "$new_config_toml" \
		'.api_base = $api | .config_toml = $toml' \
		"$LAB_REG" > "$LAB_REG.tmp" && mv "$LAB_REG.tmp" "$LAB_REG"
	ok "rewrote api_base → $new_api_base (host IP from VM's perspective)"
}
