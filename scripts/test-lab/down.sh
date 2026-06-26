#!/usr/bin/env bash
# void test-lab — tear down the dev environment.
#
# Stops wrangler dev. Does NOT touch the OrbStack VM — that's
# expensive (~2 min to recreate) and the user usually wants to
# keep it around between dev sessions. To also nuke the VM:
#
#   scripts/test-lab/agent-vm.sh destroy --purge
#
# By default, leaves .test-lab/registration.json on disk so
# `up.sh` can re-attach to the same row in D1. Pass --full to
# also delete the scratch dir (next `up.sh` will re-register).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

LAB_VM_NAME="${VOID_LAB_VM_NAME:-void-lab}"

section "test-lab: tear down dev env"

# wrangler first (clean process shutdown).
wrangler_stop

# Scratch dir
if [ "${1:-}" = "--full" ]; then
	rm -rf "$LAB_DIR"
	ok "removed $LAB_DIR (--full)"
else
	log "leaving $LAB_DIR in place (use --full to also remove)"
fi

printf '\n%sVM kept:%s %s\n' "$C_DIM" "$LAB_VM_NAME" "$C_RESET"
printf '%sDelete the VM (when you'\''re done with the lab):%s\n' "$C_DIM" "$C_RESET"
printf '  scripts/test-lab/agent-vm.sh destroy --purge\n\n'

printf '%sBring the dev env back up:%s scripts/test-lab/up.sh\n' "$C_DIM" "$C_RESET"
