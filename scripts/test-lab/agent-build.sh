#!/usr/bin/env bash
# void test-lab — cross-compile the local agent and push it to the VM.
#
# Replaces the old "download a GitHub release tarball" step. We build
# the agent from the local agent/ tree on the macOS host, targeting
# the amd64 OrbStack VM, and push the freshly-built binary into the VM.
# This means uncommitted local agent changes are actually exercised by
# the test-lab, not a stale published release.
#
# Usage:
#   scripts/test-lab/agent-build.sh          # build + push + restart
#   scripts/test-lab/agent-build.sh --check  # skip restart; just verify active
#
# The binary lands at the same path the VM's systemd unit expects:
#   /usr/local/bin/void-agent

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

# optional --check: don't rebuild/restart, just assert active
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

cmd_build_and_push() {
	check_prereqs

	if ! "$SCRIPT_DIR/agent-vm.sh" status > /dev/null 2>&1; then
		die "agent VM '$LAB_VM_NAME' not running. Create it with:\n  scripts/test-lab/agent-vm.sh create"
	fi

	if [ "$CHECK_ONLY" -eq 0 ]; then
		# 1. Cross-compile on the host (zig provides the linker).
		log "cross-compiling agent → $LAB_AGENT_TARGET (cargo zigbuild --release)"
		# `agent/` is the repo's agent crate root.
		( cd "$LAB_REPO_ROOT/agent" && cargo zigbuild --release --target "$LAB_AGENT_TARGET" )
		BIN="$LAB_REPO_ROOT/agent/target/$LAB_AGENT_TARGET/release/void-agent"
		[ -x "$BIN" ] || die "build failed: expected $BIN"
		ok "built $(file "$BIN" | sed 's/,.*//')"

		# 2. Push the binary into the VM, overwriting whatever was
		#    there before (this is the "delete then deploy" step).
		# `orb push` is unreliable in some setups (read-only
		# container mounts), so stream the binary over stdin as
		# base64 and decode inside the VM.
		log "pushing $BIN → $LAB_VM_NAME:/usr/local/bin/void-agent"
		base64 -i "$BIN" \
			| orb run -m "$LAB_VM_NAME" -u root bash -c 'base64 -d > /usr/local/bin/void-agent' \
			|| die "push failed"
		orb run -m "$LAB_VM_NAME" -u root chmod +x /usr/local/bin/void-agent \
			|| die "chmod failed"

		# 2b. Rewrite api_base to the host IP the VM can reach, then
		#     push the fresh config into the VM. The VM is running
		#     here (unlike during up.sh's register step), so the
		#     subnet scan in host_ip_for_vm actually finds the host.
		rewrite_registration_for_vm || true
		SID_NEW=$(jq -r .server_id "$LAB_REG")
		ST_NEW=$(jq -r .setup_token "$LAB_REG")
		AB_NEW=$(jq -r .api_base "$LAB_REG")
		log "pushing config to $LAB_VM_NAME (api_base=$AB_NEW)..."
		orb run -m "$LAB_VM_NAME" -u root bash -c 'cat > /etc/void/config.toml' <<VMCFG
# void-agent config
# Written by test-lab/agent-build.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)

api_base = "${AB_NEW}"
server_id = "${SID_NEW}"
setup_token = "${ST_NEW}"
state_dir = "/var/lib/void"
VMCFG

		# 3. Clear any stale session_token so the agent re-registers
		#    with the (possibly new) setup_token from up.sh, then
		#    (re)start the agent.
		#
		# NOTE: OrbStack's systemd cannot actually start units
		# (`systemctl start` hangs on a never-finishing job), so we
		# Launch the agent. On real VMs (Hetzner) the bootstrap's
		# `systemctl enable --now void-agent.service` starts it as a
		# proper systemd unit (Restart=always, Nice=-20, OOMScoreAdjust=
		# -1000). Under OrbStack, `systemctl start` hangs on the start
		# job for long-lived services and `systemd-run --scope` needs a
		# PTY it doesn't get over `orb run`, so we launch directly here
		# and apply the SAME priority (highest nice, lowest OOM score =
		# dies last) ourselves. The unit file is still written by the
		# bootstrap for parity/documentation.
		orb run -m "$LAB_VM_NAME" -u root systemctl disable --now void-agent 2>/dev/null || true
		orb run -m "$LAB_VM_NAME" -u root rm -f /var/lib/void/session_token || true
		log "starting void-agent on $LAB_VM_NAME (Nice=-20, OOM=-1000)"
		orb run -m "$LAB_VM_NAME" -u root bash -c '
			pkill -9 void-agent 2>/dev/null || true
			sleep 1
			nohup bash -c "echo -1000 > /proc/self/oom_score_adj; exec nice -n -20 /usr/local/bin/void-agent" \
				> /var/lib/void/agent.run.log 2>&1 &
			echo "started pid $!"
		' || die "failed to start agent"
	fi

	# 4. Verify the agent registered with the local control plane.
	if [ ! -f "$LAB_REG" ]; then
		warn "no registration.json — run up.sh first to register the server, then this script"
		return 1
	fi
	SERVER_ID=$(jq -r .server_id "$LAB_REG")
	# Give the agent a moment to connect.
	for i in $(seq 1 20); do
		STATE=$(curl -fsS -H "Authorization: Bearer $(bearer_resolve)" "$LAB_API/api/servers" \
			| jq -r --arg id "$SERVER_ID" '.servers[] | select(.id == $id) | .status' 2>/dev/null || true)
		[ "$STATE" = "active" ] && break
		sleep 1
	done
	if [ "$STATE" = "active" ]; then
		ok "$SERVER_ID reached state=active"
	else
		warn "$SERVER_ID is in state '${STATE:-unknown}' (expected 'active'). Check:\n  orb -m $LAB_VM_NAME journalctl -u void-agent -f"
		return 1
	fi
}

cmd_build_and_push
