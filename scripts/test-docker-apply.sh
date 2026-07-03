#!/usr/bin/env bash
# void-agent docker config_apply integration test
#
# Tests the Docker module: creates an nginx container, verifies,
# idempotency, then removes it.
#
# Usage:
#   scripts/test-docker-apply.sh [--no-build]
#
# Requires: Docker daemon running on the host.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

C_RED='\033[0;31m'; C_GREEN='\033[0;32m'; C_DIM='\033[2m'; C_RESET='\033[0m'
pass() { echo -e "  ${C_GREEN}✓${C_RESET} $1"; }
fail() { echo -e "  ${C_RED}✕${C_RESET} $1"; }
info() { echo -e "  ${C_DIM}→${C_RESET} $1"; }
die()  { echo -e "${C_RED}$*${C_RESET}" >&2; exit 1; }

CONTAINER_NAME="void-docker-test"
TEST_CONTAINER="void-agent-docker-test"

# ── Step 1: Build ──────────────────────────────────────────────
BINARY="$PROJECT_DIR/agent/target/release/void-agent"
if [ "${1:-}" != "--no-build" ]; then
  info "Building void-agent (release) with docker feature..."
  if [ "$(uname)" = "Darwin" ]; then
    docker run --rm -v "$PROJECT_DIR:/src" -w /src/agent \
      rust:latest cargo build --release --features docker 2>&1 | sed 's/^/  /'
  else
    (cd "$PROJECT_DIR/agent" && cargo build --release --features docker 2>&1 | sed 's/^/  /')
  fi
  pass "build complete"
fi

[ -f "$BINARY" ] || die "binary not found at $BINARY"
file "$BINARY" 2>/dev/null | grep -q ELF || die "binary is not a Linux ELF"

# ── Step 2: Cleanup any leftover test container ────────────────
info "Cleaning up leftover containers..."
docker rm -f "$TEST_CONTAINER" 2>/dev/null || true

# ── Step 3: Dry-run ───────────────────────────────────────────
PLAYBOOK_FILE="/tmp/ci-docker-playbook.json"
cat > "$PLAYBOOK_FILE" << 'PLAYBOOK'
{
  "name": "docker-test",
  "tasks": [
    {
      "module": "docker",
      "name": "Start nginx",
      "container_name": "void-agent-docker-test",
      "image": "nginx:alpine",
      "state": "running",
      "ports": ["8080:80"],
      "restart": "unless-stopped",
      "pull": true
    }
  ]
}
PLAYBOOK
pass "playbook written"

info "Running dry-run..."
DRY=$($BINARY --apply-playbook "$PLAYBOOK_FILE" --check --pretty 2>/dev/null)
echo "$DRY" | jq .
C=$(echo "$DRY" | jq '.summary.changed')
[ "$C" = "1" ] || die "dry-run: expected 1 changed, got $C"
pass "dry-run: 1 task would change"

# ── Step 4: Apply ──────────────────────────────────────────────
info "Running apply (this will pull nginx:alpine)..."
APPLY=$($BINARY --apply-playbook "$PLAYBOOK_FILE" --pretty 2>/dev/null)
echo "$APPLY" | jq .
C=$(echo "$APPLY" | jq '.summary.changed')
F=$(echo "$APPLY" | jq '.summary.failed')
[ "$C" = "1" ] && [ "$F" = "0" ] \
  || die "apply: expected 1 changed, 0 failed — got $C changed, $F failed"
pass "apply: container created"

# ── Step 5: Verify ─────────────────────────────────────────────
RUNNING=$(docker inspect "$TEST_CONTAINER" --format='{{.State.Status}}' 2>/dev/null || echo "")
[ "$RUNNING" = "running" ] || die "container not running (status: $RUNNING)"
pass "container is running"

IMAGE=$(docker inspect "$TEST_CONTAINER" --format='{{.Config.Image}}')
[ "$IMAGE" = "nginx:alpine" ] || die "wrong image: $IMAGE"
pass "correct image: $IMAGE"

# ── Step 6: Idempotency ───────────────────────────────────────
info "Re-running apply (idempotency)..."
IDEM=$($BINARY --apply-playbook "$PLAYBOOK_FILE" --pretty 2>/dev/null)
echo "$IDEM" | jq .
C=$(echo "$IDEM" | jq '.summary.changed')
F=$(echo "$IDEM" | jq '.summary.failed')
[ "$C" = "0" ] && [ "$F" = "0" ] \
  || die "idempotency: expected 0 changed, 0 failed — got $C changed, $F failed"
pass "idempotent: second apply changed nothing"

# ── Step 7: Dry-run after apply ───────────────────────────────
info "Running dry-run after apply..."
DRY2=$($BINARY --apply-playbook "$PLAYBOOK_FILE" --check --pretty 2>/dev/null)
C=$(echo "$DRY2" | jq '.summary.changed')
[ "$C" = "0" ] || die "dry-run after apply: expected 0 changed — got $C"
pass "dry-run after apply: all up-to-date"

# ── Step 8: Remove container ───────────────────────────────────
info "Removing via config_apply (state: absent)..."
cat > "$PLAYBOOK_FILE" << 'PLAYBOOK'
{
  "name": "docker-test-cleanup",
  "tasks": [
    {
      "module": "docker",
      "name": "Remove nginx",
      "container_name": "void-agent-docker-test",
      "image": "nginx:alpine",
      "state": "absent"
    }
  ]
}
PLAYBOOK
RM=$($BINARY --apply-playbook "$PLAYBOOK_FILE" --pretty 2>/dev/null)
echo "$RM" | jq .
C=$(echo "$RM" | jq '.summary.changed')
F=$(echo "$RM" | jq '.summary.failed')
[ "$C" = "1" ] && [ "$F" = "0" ] \
  || die "remove: expected 1 changed, 0 failed — got $C changed, $F failed"
pass "container removed"

docker inspect "$TEST_CONTAINER" >/dev/null 2>&1 && die "container still exists after removal" || true
pass "container confirmed gone"

# ── Step 9: Cleanup playbook ───────────────────────────────────
rm -f "$PLAYBOOK_FILE"

echo -e "\n${C_GREEN}All Docker checks passed!${C_RESET}"
