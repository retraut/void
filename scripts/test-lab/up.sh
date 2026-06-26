#!/usr/bin/env bash
# void test-lab — bring up the dev environment (wrangler dev + control plane).
#
# Does NOT touch the OrbStack VM — that's `agent-vm.sh`'s job and
# it takes ~2 minutes. The dev env is fast: wrangler dev (already
# running?) + Bearer check + D1 ping.
#
# Lifecycle:
#   scripts/test-lab/provision.sh   # one-time: seed D1 user
#   scripts/test-lab/agent-vm.sh create   # one-time-ish: spawn VM (~2 min)
#   scripts/test-lab/up.sh          # bring up the dev env (idempotent)
#   ... hack on the worker, call void_deploy, etc ...
#   scripts/test-lab/down.sh        # stop wrangler dev (keep VM)
#
# Bring the VM back up after a `down` by re-running `up.sh` —
# registration is idempotent (the existing setup_token is reused,
# and the agent reconnects with the same session_token if it has
# one, or uses the setup_token for a fresh register).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

section "test-lab: preflight"
check_prereqs

# 1. D1 must have a user. Idempotent — provision.sh is a no-op if
#    the user already exists.
"$SCRIPT_DIR/provision.sh" > /dev/null

# 2. wrangler dev must be running so we can talk to the API.
section "test-lab: wrangler dev"
wrangler_start

# 3. The agent VM should exist; if not, point the user at
#    agent-vm.sh create (which is heavy — ~2 min — so we don't
#    do it automatically).
section "test-lab: agent VM"
if ! "$SCRIPT_DIR/agent-vm.sh" status > /dev/null 2>&1; then
	die "agent VM '$LAB_VM_NAME' is not running. Create it with:\n  scripts/test-lab/agent-vm.sh create"
fi
"$SCRIPT_DIR/agent-vm.sh" status

# 4. Sanity: the registered server row should still be in D1.
#    If the VM was created in a previous session, the registration
#    is in .test-lab/registration.json; we verify it still resolves
#    in D1 (idempotent if so). If not, re-register.
section "test-lab: registration"
if [ -f "$LAB_REG" ]; then
	SERVER_ID=$(jq -r .server_id "$LAB_REG")
	EXISTS=$(curl -fsS -H "Authorization: Bearer $(bearer_resolve)" "$LAB_API/api/servers" | jq --arg id "$SERVER_ID" '[.servers[] | select(.id == $id)] | length')
	if [ "$EXISTS" -gt 0 ]; then
		ok "registration for $SERVER_ID still in D1 (reusing)"
	else
		warn "registration file present but row missing from D1; re-registering"
		rm -f "$LAB_REG"
	fi
fi
if [ ! -f "$LAB_REG" ]; then
	log "registering $LAB_VM_NAME with the control plane..."
	REG_JSON="$(api_register "$LAB_VM_NAME")"
	printf '%s' "$REG_JSON" | jq . > "$LAB_REG"
	ok "registered $(printf '%s' "$REG_JSON" | jq -r .server_id)"
	# The control plane's /api/servers/register derives api_base
	# from the request URL, which is 127.0.0.1 (the loopback
	# wrangler dev is bound to). From inside the VM, 127.0.0.1
	# is the VM itself, not the host. Rewrite the api_base to
	# the host's OrbStack-bridge IP that the VM can actually reach.
	rewrite_registration_for_vm || true
fi

# 5. Final status.
section "test-lab: ready"
printf '%sDev environment:%s\n' "$C_BOLD" "$C_RESET"
printf '  • wrangler dev — %s\n' "$LAB_API"
printf '  • registration — %s\n' "$LAB_REG"
printf '\n%sAgent VM:%s\n' "$C_BOLD" "$C_RESET"
"$SCRIPT_DIR/agent-vm.sh" status
printf '\n%sUseful next steps:%s\n' "$C_BOLD" "$C_RESET"
printf '  • watch the agent register / log lines:\n'
printf '      %sorb -m %s journalctl -u void-agent -f%s\n' "$C_DIM" "$LAB_VM_NAME" "$C_RESET"
printf '  • see the bootstrap log inside the VM:\n'
	printf '      %sorb -m %s tail -f /var/log/void-bootstrap.log%s\n' "$C_DIM" "$LAB_VM_NAME" "$C_RESET"
printf '  • list registered servers on the panel:\n'
printf '      %sscripts/test-lab/servers.sh%s\n' "$C_DIM" "$C_RESET"
printf '  • trigger a deploy on the registered VM:\n'
printf '      %sscripts/test-lab/deploy.sh <server_id> <repo_url>%s\n' "$C_DIM" "$C_RESET"
printf '  • tear down the dev env (VM is kept):\n'
printf '      %sscripts/test-lab/down.sh%s\n' "$C_DIM" "$C_RESET"
printf '  • delete the VM (when you'\''re done with the lab):\n'
printf '      %sscripts/test-lab/agent-vm.sh destroy --purge%s\n' "$C_DIM" "$C_RESET"
