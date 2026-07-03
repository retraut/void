#!/usr/bin/env bash
# void test-lab — OrbStack VM lifecycle.
#
# The test-lab runs the void-agent inside an OrbStack VM. That VM
# is heavy to create (~2 minutes — orb's hardcoded 30s "didn't
# start" timeout always fires, even on a healthy run), so we keep
# it around between dev sessions. The dev environment (wrangler
# dev, register, etc.) is what `up.sh` / `down.sh` bring up and
# tear down — see README.md for the two-phase model.
#
# Subcommands:
#   status   — show whether the VM exists and is running
#   create   — create the VM and apply the cloud-init bootstrap.
#              Safe to re-run: if the VM exists, prints status and
#              does nothing. (Belt-and-braces: use --force to
#              destroy-and-recreate.)
#   destroy  — stop the VM (kept on disk). Add --purge to also
#              remove the disk image.
#   ssh      — print SSH details (use this from your SSH config)
#   ip       — print the VM's IP (so you can curl it from macOS)
#
# Usage:
#   scripts/test-lab/agent-vm.sh status
#   scripts/test-lab/agent-vm.sh create
#   scripts/test-lab/agent-vm.sh destroy         # stop, keep on disk
#   scripts/test-lab/agent-vm.sh destroy --purge # stop, delete image
#   scripts/test-lab/agent-vm.sh ssh
#   scripts/test-lab/agent-vm.sh ip

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

LAB_VM_NAME="${VOID_LAB_VM_NAME:-void-lab}"
LAB_AGENT_ARCH="${VOID_LAB_ARCH:-amd64}" # x86_64 release runs on amd64 VM
LAB_AGENT_DISK_GIB="${VOID_LAB_DISK_GIB:-20}"
LAB_AGENT_CPUS="${VOID_LAB_CPUS:-2}"
LAB_AGENT_MEM_GIB="${VOID_LAB_MEM_GIB:-2}"

# How long to wait for the VM to come up after `orb create`. The
# `orb` CLI hardcodes a 30s "didn't start" check that always
# fires on a fresh ubuntu:26.04 — the VM keeps booting and we
# can resume it with `orb start` once orbctl sees it on disk.
# But we've seen that sometimes `orb create` rolls back the
# machine entirely on timeout, so the safer path is to wait for
# the machine to actually appear in `orb list` after create.
LAB_VM_BOOT_TIMEOUT_SEC="${LAB_VM_BOOT_TIMEOUT_SEC:-300}" # 5 min

cmd_status() {
	if orb list 2>/dev/null | awk '$1 != "" {print $1}' | grep -qx "$LAB_VM_NAME"; then
		local state ip
		state=$(orb list 2>/dev/null | awk -v name="$LAB_VM_NAME" '$1 == name {print $2}')
		ip=$(orb list 2>/dev/null | awk -v name="$LAB_VM_NAME" '$1 == name {print $8}')
		printf "  name:   %s\n" "$LAB_VM_NAME"
		printf "  state:  %s\n" "$state"
		printf "  ip:     %s\n" "${ip:-<no ip>}"
		printf "  arch:   %s\n" "$LAB_AGENT_ARCH"
		return 0
	else
		printf "  vm:     %s (does not exist)\n" "$LAB_VM_NAME"
		return 1
	fi
}

cmd_create() {
	# Pre-flight: refuse to clobber an existing VM unless --force.
	if cmd_status >/dev/null 2>&1; then
		if [ "${1:-}" = "--force" ]; then
			warn "VM already exists — destroying and recreating (--force)"
			cmd_destroy --purge
		else
			warn "VM '$LAB_VM_NAME' already exists. Use --force to recreate."
			cmd_status
			printf '\n%sNothing to do.%s\n' "$C_DIM" "$C_RESET"
			return 0
		fi
	fi

	# Pre-flight: ensure D1 has a user + wrangler dev is up so we
	# can call /api/servers/register.
	"$SCRIPT_DIR/provision.sh" > /dev/null
	wrangler_start

	log "registering server (one-time setup_token)..."
	REG_JSON="$(api_register "$LAB_VM_NAME")"
	printf '%s' "$REG_JSON" | jq . > "$LAB_REG"
	ok "registered $(printf '%s' "$REG_JSON" | jq -r .server_id)"

	# Render the bootstrap script locally. We'll copy it to the VM
	# after it boots and run it via SSH. We don't use orb's
	# --user-data flag because on Apple Silicon the orb CLI has
	# a hardcoded 30s "didn't start" check that always fires
	# when --user-data is set, regardless of distro.
	AGENT_TAG="${VOID_AGENT_RELEASE_TAG:-v0.4.0}"
	AGENT_REPO="${VOID_AGENT_REPO:-retraut/void}"
	AGENT_URL="https://github.com/${AGENT_REPO}/releases/download/${AGENT_TAG}/void-agent-${AGENT_TAG}.tar.gz"

	{
		printf '#!/bin/bash\n'
		printf 'set -e\n'
		printf 'exec > >(tee -a /var/log/void-bootstrap.log) 2>&1\n'
		printf 'echo "=== void-agent bootstrap starting at $(date) ==="\n'
		printf 'ARCH=$(uname -m)\n'
		printf 'if [ "$ARCH" = "x86_64" ]; then CFD_ARCH="amd64"\n'
		printf 'elif [ "$ARCH" = "aarch64" ]; then CFD_ARCH="arm64"\n'
		printf 'else echo "unsupported arch: $ARCH"; exit 1; fi\n'
		# Build deps (git for clone, build-essential for cargo).
		# apt-get update is needed on a fresh ubuntu:26.04.
		printf 'export DEBIAN_FRONTEND=noninteractive\n'
		printf 'apt-get update >/dev/null 2>&1\n'
		printf 'apt-get install -y --no-install-recommends curl ca-certificates git build-essential >/dev/null 2>&1\n'
		printf 'echo "apt: git=$(git --version) make=$(make --version | head -1)"\n'
		printf 'curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CFD_ARCH}" -o /usr/local/bin/cloudflared\n'
		printf 'chmod +x /usr/local/bin/cloudflared\n'
		printf 'echo "cloudflared: $(/usr/local/bin/cloudflared --version 2>&1 | head -1)"\n'
		printf 'cd /tmp\n'
		printf 'curl -fsSL "%s" -o void-agent.tar.gz\n' "$AGENT_URL"
		printf 'tar -xzf void-agent.tar.gz\n'
		printf 'mv void-agent /usr/local/bin/void-agent\n'
		printf 'chmod +x /usr/local/bin/void-agent\n'
		printf 'echo "void-agent: $(/usr/local/bin/void-agent --version 2>&1 | head -1)"\n'
		printf 'mkdir -p /var/lib/void /etc/void\n'
		printf 'cat > /etc/void/config.toml <<CFG\n'
		printf '# Config rendered by the control plane (/api/servers/register)\n'
		jq -r .config_toml "$LAB_REG"
		printf 'CFG\n'
		printf 'echo "config written"\n'
		printf 'cat > /etc/systemd/system/void-agent.service <<SVC\n'
		printf '[Unit]\nDescription=void agent\nAfter=network-online.target\nWants=network-online.target\n'
		printf '[Service]\nExecStart=/usr/local/bin/void-agent\nRestart=always\nRestartSec=5\n'
		printf '[Install]\nWantedBy=multi-user.target\n'
		printf 'SVC\n'
		printf 'systemctl daemon-reload\n'
		printf 'systemctl enable --now void-agent.service\n'
		printf 'echo "void-agent service started"\n'
		printf 'echo "=== void-agent bootstrap complete at $(date) ==="\n'
	} > "$LAB_CLOUD_INIT"
	ok "wrote $LAB_CLOUD_INIT"

	# Create the VM WITHOUT --user-data. As of orb on Apple Silicon,
	# --user-data triggers a 30s "didn't start" check that always
	# fails. We poll for the VM to appear instead.
	log "orb create --arch $LAB_AGENT_ARCH (ubuntu:26.04) — ~90s, polling..."
	nohup orb create --arch "$LAB_AGENT_ARCH" \
		--cpus "$LAB_AGENT_CPUS" --memory "${LAB_AGENT_MEM_GIB}G" --disk "${LAB_AGENT_DISK_GIB}G" \
		ubuntu:26.04 "$LAB_VM_NAME" \
		> "$LAB_DIR/orb-create.log" 2>&1 &
	ORB_PID=$!
	disown $ORB_PID 2>/dev/null || true

	deadline=$((SECONDS + LAB_VM_BOOT_TIMEOUT_SEC))
	while [ $SECONDS -lt $deadline ]; do
		if cmd_status > /dev/null 2>&1; then
			wait $ORB_PID 2>/dev/null || true
			ok "VM appeared in orb list after $((SECONDS - (deadline - LAB_VM_BOOT_TIMEOUT_SEC)))s"
			cmd_status
			break
		fi
		sleep 5
	done
	if ! cmd_status > /dev/null 2>&1; then
		kill $ORB_PID 2>/dev/null || true
		die "VM '$LAB_VM_NAME' did not appear in orb list within ${LAB_VM_BOOT_TIMEOUT_SEC}s. See $LAB_DIR/orb-create.log"
	fi

	# Wait for the VM to actually be "running" (not just "provisioning").
	# Sometimes `orb list` shows the VM while it's still booting.
	log "waiting for $LAB_VM_NAME to reach 'running' state..."
	while [ $SECONDS -lt $deadline ]; do
		STATE=$(orb list 2>/dev/null | awk -v name="$LAB_VM_NAME" '$1 == name {print $2}')
		if [ "$STATE" = "running" ]; then
			ok "VM is running"
			break
		fi
		sleep 3
	done
	if [ "$STATE" != "running" ]; then
		die "VM $LAB_VM_NAME is stuck in state '$STATE'"
	fi

	# Copy the bootstrap script into the VM and run it. We use
	# `orb push` (no SSH config needed) to stage, then `orb run`
	# to execute.
	log "pushing bootstrap script..."
	orb push "$LAB_CLOUD_INIT" "$LAB_VM_NAME:/tmp/void-bootstrap.sh" || die "orb push failed"
	log "running bootstrap (this takes ~30s: downloads + installs + registers)..."
	if ! orb run -- bash -x /tmp/void-bootstrap.sh 2>&1 | sed 's/^/  /'; then
		die "bootstrap failed inside the VM. Tail /var/log/void-bootstrap.log:\n  orb run -- sudo tail -f /var/log/void-bootstrap.log"
	fi

	# The agent should have already registered with the control
	# plane via WS. Verify.
	sleep 3
	SERVER_ID=$(jq -r .server_id "$LAB_REG")
	STATE=$(curl -fsS -H "Authorization: Bearer $(bearer_resolve)" "$LAB_API/api/servers" | jq -r --arg id "$SERVER_ID" '.servers[] | select(.id == $id) | .status')
	if [ "$STATE" = "active" ]; then
		ok "$SERVER_ID reached state=active"
	else
		warn "$SERVER_ID is in state '$STATE' (expected 'active'). Check: orb -m $LAB_VM_NAME journalctl -u void-agent -f"
	fi
	cmd_status
}

cmd_destroy() {
	local purge=false
	if [ "${1:-}" = "--purge" ]; then purge=true; fi
	if ! cmd_status > /dev/null 2>&1; then
		log "VM $LAB_VM_NAME not present, nothing to do"
		return 0
	fi
	# orb stop = graceful shutdown, keeps the disk image
	# orb delete = stop + remove the image
	if [ "$purge" = true ]; then
		log "orb delete --force $LAB_VM_NAME..."
		orb delete --force "$LAB_VM_NAME" 2>&1 | sed 's/^/  /'
		# also remove the local registration so up.sh can re-register
		rm -f "$LAB_REG"
		ok "VM deleted (image gone, registration cleared)"
	else
		log "orb stop $LAB_VM_NAME..."
		orb stop "$LAB_VM_NAME" 2>&1 | sed 's/^/  /' || warn "orb stop failed (VM may already be stopped)"
		ok "VM stopped (image kept on disk — use destroy --purge to delete)"
	fi
}

cmd_ssh() {
	orb ssh "$LAB_VM_NAME"
}

cmd_ip() {
	orb -m "$LAB_VM_NAME" ip 2>/dev/null
}

# --- entrypoint ---
check_prereqs
sub="${1:-status}"
shift || true
case "$sub" in
	status)  cmd_status ;;
	create)  cmd_create "$@" ;;
	destroy) cmd_destroy "$@" ;;
	ssh)     cmd_ssh ;;
	ip)      cmd_ip ;;
	*)
		echo "usage: $0 {status|create|destroy|ssh|ip} [...]" >&2
		echo "  status                            show VM state" >&2
		echo "  create [--force]                  create + cloud-init" >&2
		echo "  destroy [--purge]                 stop; --purge also deletes image" >&2
		echo "  ssh                               SSH into the VM" >&2
		echo "  ip                                print VM IP" >&2
		exit 2
		;;
esac
