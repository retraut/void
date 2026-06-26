#!/usr/bin/env bash
# void test-lab — bring up the local dev environment.
#
# Steps:
#   1. Check prerequisites (orb, docker, wrangler, jq, cargo).
#   2. Start `wrangler dev` in the background (if not already up).
#   3. Call POST /api/servers/register to get server_id + setup_token.
#   4. Render cloud-init user_data that writes the agent config and
#      installs + starts void-agent on the OrbStack VM.
#   5. `orb create --user-data <file> ubuntu:24.04 void-lab` to boot
#      the VM and run the bootstrap.
#   6. Print next steps (how to tail logs, list servers, deploy).
#
# Usage:
#   scripts/test-lab/up.sh                     # default name: void-lab
#   VOID_LAB_VM_NAME=void-lab-2 up.sh          # custom VM name
#   VOID_BEARER_TOKEN=... up.sh                # override Bearer token
#
# Requires:
#   - worker/.dev.vars with VOID_BEARER_TOKEN (or env override)
#   - OrbStack installed (brew install orbstack)
#   - wrangler available (pnpm install in worker/)
#   - a real void-agent release published (v0.4.0+) so the bootstrap
#     script can `curl` the tarball

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

section "test-lab: preflight"
check_prereqs
mkdir -p "$LAB_DIR"

# Refuse to start if a previous registration is still in flight
# (caller should run down.sh first to clean up).
if [ -f "$LAB_REG" ]; then
	die "existing registration file at $LAB_REG — run scripts/test-lab/down.sh first to clean up"
fi

section "test-lab: start wrangler dev"
wrangler_start

section "test-lab: register server"
log "calling POST $LAB_API/api/servers/register ..."
REG_JSON="$(api_register "$LAB_VM_NAME")"
printf '%s' "$REG_JSON" | jq . > "$LAB_REG"
SERVER_ID="$(printf '%s' "$REG_JSON" | jq -r .server_id)"
SETUP_TOKEN="$(printf '%s' "$REG_JSON" | jq -r .setup_token)"
API_BASE="$(printf '%s' "$REG_JSON" | jq -r .api_base)"
ok "registered $SERVER_ID"
ok "setup_token: ${SETUP_TOKEN:0:8}..."
ok "api_base: $API_BASE"

section "test-lab: render cloud-init user_data"
# Mirrors buildCloudInit() in worker/src/hetzner.ts — same agent
# bootstrap, same systemd unit, same /etc/void/config.toml fields.
# Kept as bash here (not TS) so up.sh is self-contained and doesn't
# need the wrangler dev server to render the cloud-init.
#
# v0.4.0+ uses void-agent-v{tag}.tar.gz (the v is in the tag).
AGENT_TAG="${VOID_AGENT_RELEASE_TAG:-v0.4.0}"
AGENT_REPO="${VOID_AGENT_REPO:-retraut/void}"
AGENT_URL="https://github.com/${AGENT_REPO}/releases/download/${AGENT_TAG}/void-agent-${AGENT_TAG}.tar.gz"

# Render the cloud-init. The config.toml block is the one the
# API gave us in the registration response (already includes the
# api_base, server_id, and setup_token).
{
	printf '#!/bin/bash\n'
	printf 'set -e\n'
	printf 'exec > >(tee -a /var/log/void-bootstrap.log) 2>&1\n'
	printf 'echo "=== void-agent bootstrap starting at $(date) ==="\n'
	printf 'echo "via test-lab/up.sh, server_id=%s"\n' "$SERVER_ID"
	printf 'ARCH=$(uname -m)\n'
	printf 'if [ "$ARCH" = "x86_64" ]; then CFD_ARCH="amd64"\n'
	printf 'elif [ "$ARCH" = "aarch64" ]; then CFD_ARCH="arm64"\n'
	printf 'else echo "unsupported arch: $ARCH"; exit 1; fi\n'
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
	printf '# Config rendered by the control plane (/api/servers/register)\n'
	jq -r .config_toml "$LAB_REG" | sed 's/^/  /'
	printf 'echo "config written"\n'
	printf 'cat > /etc/systemd/system/void-agent.service <<SVC\n'
	printf '[Unit]\nDescription=void agent\nAfter=network-online.target\nWants=network-online.target\n'
	printf '[Service]\nExecStart=/usr/local/bin/void-agent\nRestart=always\nRestartSec=5\n'
	printf '[Install]\nWantedBy=multi-user.target\nSVC\n'
	printf 'systemctl daemon-reload\n'
	printf 'systemctl enable --now void-agent.service\n'
	printf 'echo "void-agent service started"\n'
	printf 'echo "=== void-agent bootstrap complete at $(date) ==="\n'
} > "$LAB_CLOUD_INIT"
ok "wrote $LAB_CLOUD_INIT"

section "test-lab: create OrbStack VM"
if orb list 2>/dev/null | awk '{print $1}' | grep -qx "$LAB_VM_NAME"; then
	die "orb VM '$LAB_VM_NAME' already exists. Run scripts/test-lab/down.sh first."
fi
log "orb create $LAB_VM_NAME (ubuntu:24.04) with user-data..."
# orb's --user-data path is relative to the current dir, so cd first.
(
	cd "$LAB_DIR"
	# We use ubuntu:24.04 (noble) — same family as the cloud-init smoke
	# test, with the same systemd and apt-get install behaviours. 26.04
	# is also available but newer and may have transient apt issues.
	orb create --user-data "$LAB_CLOUD_INIT" --cpus 2 --memory 2G --disk 20G \
		ubuntu:24.04 "$LAB_VM_NAME" 2>&1 | sed 's/^/  /'
)
ok "VM created. Bootstrap runs in the background."

section "test-lab: ready"
printf '%sWhat got created:%s\n' "$C_BOLD" "$C_RESET"
printf '  • wrangler dev — pid %s, logs at %s\n' "$(cat "$LAB_PID")" "$LAB_LOG"
printf '  • registration — %s\n' "$LAB_REG"
printf '  • cloud-init  — %s\n' "$LAB_CLOUD_INIT"
printf '  • orb VM      — %s\n' "$LAB_VM_NAME"
printf '\n%sUseful next steps:%s\n' "$C_BOLD" "$C_RESET"
printf '  • watch the agent register:\n'
printf '      %sorb -m %s journalctl -u void-agent -f%s\n' "$C_DIM" "$LAB_VM_NAME" "$C_RESET"
printf '  • see the bootstrap log inside the VM:\n'
printf '      %sorb -m %s tail -f /var/log/void-bootstrap.log%s\n' "$C_DIM" "$LAB_VM_NAME" "$C_RESET"
printf '  • list servers on the panel:\n'
printf '      %sscripts/test-lab/servers.sh%s\n' "$C_DIM" "$C_RESET"
printf '  • tear everything down:\n'
printf '      %sscripts/test-lab/down.sh%s\n' "$C_DIM" "$C_RESET"
