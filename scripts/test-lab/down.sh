#!/usr/bin/env bash
# void test-lab — tear down the local dev environment.
#
# Steps:
#   1. Stop wrangler dev (if up.sh started one).
#   2. Delete the OrbStack VM.
#   3. Remove the .test-lab/ scratch dir.
#
# Note: we do NOT touch D1. The test-lab server row stays in the
# database so you can re-attach to it with `up.sh` if you want,
# or clean it up with the panel "Delete" button. Re-registering
# creates a new row (different server_id).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

LAB_VM_NAME="${VOID_LAB_VM_NAME:-void-lab}"

section "test-lab: tear down"

# VM first (so its WS connection drops and the panel marks it offline
# before we kill wrangler — cleaner logs on the worker side).
if orb list 2>/dev/null | awk '{print $1}' | grep -qx "$LAB_VM_NAME"; then
	log "deleting orb VM $LAB_VM_NAME..."
	orb delete --force "$LAB_VM_NAME" 2>&1 | sed 's/^/  /'
	ok "VM deleted"
else
	log "orb VM $LAB_VM_NAME not present, skipping"
fi

# wrangler
wrangler_stop

# Scratch dir (config_toml etc.) — keep the registration.json on disk
# in case you want to inspect it; remove only on --full.
if [ "${1:-}" = "--full" ]; then
	rm -rf "$LAB_DIR"
	ok "removed $LAB_DIR (--full)"
else
	log "leaving $LAB_DIR in place (use --full to remove)"
fi

printf '%s✓%s test-lab torn down\n' "$C_GREEN" "$C_RESET"
printf '%sdatabase rows%s were not touched — clean up via the panel or /api/servers.\n' "$C_DIM" "$C_RESET"
