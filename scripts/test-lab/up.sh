#!/usr/bin/env bash
# void test-lab — bring up the full local dev environment end-to-end.
#
# This is the ONE command that stands up the test-lab:
#   1. wrangler dev (local Cloudflare Worker = the control plane / panel)
#   2. the OrbStack VM (created on first run, reused afterwards)
#   3. a freshly cross-compiled void-agent from the local agent/ tree,
#      pushed into the VM (no GitHub release download)
#   4. registration of the agent with the local control plane
#
# The heavy VM creation (~2 min) only runs when the VM is missing.
# Re-running up.sh is idempotent: it reuses the VM + server row,
# rebuilds the agent from local sources, and verifies it is active.
#
# Lifecycle:
#   scripts/test-lab/up.sh             # full bring-up (this script)
#   scripts/test-lab/deploy.sh ...     # trigger a deploy on the VM
#   scripts/test-lab/down.sh           # stop wrangler dev (keep VM)
#   scripts/test-lab/agent-vm.sh destroy --purge   # delete the VM

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

section "test-lab: preflight"
check_prereqs

# 1. D1 must have a user. Idempotent — provision.sh is a no-op if
#    the user already exists.
"$SCRIPT_DIR/provision.sh" > /dev/null

# 2. wrangler dev must be running so we can talk to the API and
#    the agent can register against it.
section "test-lab: panel (wrangler dev)"
wrangler_start

# 3. The agent VM. Create it on first run (~2 min); reuse it on
#    subsequent runs. agent-vm.sh create also registers the server
#    (writes .test-lab/registration.json with a one-time setup_token),
#    so a fresh create hands us everything up.sh needs.
section "test-lab: agent VM"
if ! "$SCRIPT_DIR/agent-vm.sh" status > /dev/null 2>&1; then
	"$SCRIPT_DIR/agent-vm.sh" create
else
	"$SCRIPT_DIR/agent-vm.sh" status
fi

# 4. Registration. The agent registers over a Durable Object (VoidCell)
#    using a single-use setup_token. That DO state is IN-MEMORY in the
#    wrangler dev process and is reset on every `wrangler dev` restart —
#    but the D1 `servers` row (status, last_seen) survives, and the
#    panel does NOT eagerly flip it to `disconnected` on restart, so the
#    row keeps reporting `active` even though its token is now dead.
#    Reusing a stale token makes the agent loop forever on
#    `invalid_token`. So we ALWAYS fetch a fresh registration (new
#    setup_token) — reusing the same server row when it still exists so
#    the panel doesn't accumulate dead rows. agent-build.sh then
#    rewrites the VM's config with the fresh token and restarts the
#    agent, which registers cleanly against the fresh DO state.
if [ -f "$LAB_REG" ]; then
	SERVER_ID=$(jq -r .server_id "$LAB_REG")
	EXISTS=$(curl -fsS -H "Authorization: Bearer $(bearer_resolve)" "$LAB_API/api/servers" \
		| jq --arg id "$SERVER_ID" '[.servers[] | select(.id == $id)] | length')
	if [ "$EXISTS" -gt 0 ]; then
		# Same server row, fresh token. The DO state (consumed
		# setup_token) reset on wrangler restart, so delete the
		# stale row and register a clean one with a fresh token.
		log "deleting stale row $SERVER_ID and re-registering with a fresh setup_token (DO state resets on wrangler restart)"
		api_deregister "$SERVER_ID"
		rm -f "$LAB_REG"
		REG_JSON="$(api_register "$LAB_VM_NAME")"
		printf '%s' "$REG_JSON" | jq . > "$LAB_REG"
		ok "re-registered $(printf '%s' "$REG_JSON" | jq -r .server_id)"
	else
		warn "registration file present but row missing from D1; will register fresh"
		rm -f "$LAB_REG"
		log "registering $LAB_VM_NAME with the control plane..."
		REG_JSON="$(api_register "$LAB_VM_NAME")"
		printf '%s' "$REG_JSON" | jq . > "$LAB_REG"
		ok "registered $(printf '%s' "$REG_JSON" | jq -r .server_id)"
	fi
elif [ ! -f "$LAB_REG" ]; then
	# No registration at all (e.g. create wrote it but it was wiped):
	# register now so agent-build.sh has a token to push.
	log "registering $LAB_VM_NAME with the control plane..."
	REG_JSON="$(api_register "$LAB_VM_NAME")"
	printf '%s' "$REG_JSON" | jq . > "$LAB_REG"
	ok "registered $(printf '%s' "$REG_JSON" | jq -r .server_id)"
fi

# 5. Build the local agent, push it into the VM, push the fresh
#    config (with the host-reachable api_base), start it, and verify
#    it reaches state=active. This is the core "new agent + register".
section "test-lab: agent build + register"
"$SCRIPT_DIR/agent-build.sh"

# 6. Final status.
section "test-lab: ready"
printf '%sDev environment:%s\n' "$C_BOLD" "$C_RESET"
printf '  • wrangler dev — %s\n' "$LAB_API"
printf '  • registration — %s\n' "$LAB_REG"
printf '\n%sAgent VM:%s\n' "$C_BOLD" "$C_RESET"
"$SCRIPT_DIR/agent-vm.sh" status
printf '\n%sUseful next steps:%s\n' "$C_BOLD" "$C_RESET"
printf '  • watch the agent register / log lines:\n'
printf '      %sorb -m %s tail -f /var/lib/void/agent.run.log%s\n' "$C_DIM" "$LAB_VM_NAME" "$C_RESET"
printf '  • see the bootstrap log inside the VM:\n'
	printf '      %sorb -m %s tail -f /tmp/void-bootstrap.log%s\n' "$C_DIM" "$LAB_VM_NAME" "$C_RESET"
printf '  • list registered servers on the panel:\n'
printf '      %sscripts/test-lab/servers.sh%s\n' "$C_DIM" "$C_RESET"
printf '  • trigger a deploy on the registered VM:\n'
printf '      %sscripts/test-lab/deploy.sh <server_id> <repo_url>%s\n' "$C_DIM" "$C_RESET"
printf '  • tear down the dev env (VM is kept):\n'
printf '      %sscripts/test-lab/down.sh%s\n' "$C_DIM" "$C_RESET"
printf '  • delete the VM (when you'\''re done with the lab):\n'
printf '      %sscripts/test-lab/agent-vm.sh destroy --purge%s\n' "$C_DIM" "$C_RESET"
