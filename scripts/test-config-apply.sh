#!/usr/bin/env bash
# void-agent config_apply integration test
#
# Builds the agent (or uses an existing binary), runs it inside a
# Docker Ubuntu container, applies a playbook, verifies idempotency.
#
# Usage:
#   scripts/test-config-apply.sh [--no-build]
#     --no-build  skip cargo build (use existing binary at agent/target/release/)
#
# On macOS the binary must be a Linux x86_64 ELF.  Use Docker to build:
#   docker run --rm -v "$PWD:/src" -w /src/agent rust:latest cargo build --release
# or use the OrbStack test-lab VM directly.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

C_RED='\033[0;31m'; C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'
C_DIM='\033[2m'; C_RESET='\033[0m'
pass() { echo -e "  ${C_GREEN}✓${C_RESET} $1"; }
fail() { echo -e "  ${C_RED}✕${C_RESET} $1"; }
info() { echo -e "  ${C_DIM}→${C_RESET} $1"; }
die()  { echo -e "${C_RED}$*${C_RESET}" >&2; exit 1; }

CONTAINER_NAME="void-config-apply-test"

# ── Step 1: Build ──────────────────────────────────────────────
BINARY="$PROJECT_DIR/agent/target/release/void-agent"
if [ "${1:-}" != "--no-build" ]; then
  info "Building void-agent (release)..."
  # macOS binary won't run in Linux container — build via Docker.
  if [ "$(uname)" = "Darwin" ]; then
    mkdir -p "$PROJECT_DIR/agent/target/release"
    docker run --rm -v "$PROJECT_DIR:/src" -w /src/agent \
      rust:latest cargo build --release 2>&1 | sed 's/^/  /'
  else
    (cd "$PROJECT_DIR/agent" && cargo build --release 2>&1 | sed 's/^/  /')
  fi
  pass "build complete"
fi

[ -f "$BINARY" ] || die "binary not found at $BINARY"
file "$BINARY" | grep -q ELF || die "binary is not a Linux ELF — build with Docker:\n  docker run --rm -v \"$PWD:/src\" -w /src/agent rust:latest cargo build --release"

# ── Step 2: CI playbook ───────────────────────────────────────
PLAYBOOK_FILE="/tmp/ci-playbook.json"
cat > "$PLAYBOOK_FILE" << 'PLAYBOOK'
{
  "name": "ci-test",
  "tasks": [
    {
      "module": "apt",
      "name": "Install tree",
      "packages": ["tree"],
      "state": "present"
    },
    {
      "module": "file",
      "name": "Write /etc/hello",
      "path": "/etc/hello.txt",
      "content": "Hello from void-agent config_apply!\nCI test\n",
      "mode": "0644"
    }
  ]
}
PLAYBOOK
pass "playbook written"

# ── Step 3: Docker container ───────────────────────────────────
info "Cleaning up any leftover container..."
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

info "Starting Ubuntu container..."
docker run -d --name "$CONTAINER_NAME" \
  -v "$BINARY:/usr/local/bin/void-agent:ro" \
  -v "$PLAYBOOK_FILE:$PLAYBOOK_FILE:ro" \
  ubuntu:latest sleep 3600 > /dev/null
pass "container running"

docker exec "$CONTAINER_NAME" apt-get update -qq 2>&1 | tail -1
docker exec "$CONTAINER_NAME" apt-get install -y -qq jq 2>&1 | tail -1
pass "apt ready"

# ── Step 4: Dry-run ───────────────────────────────────────────
info "Running dry-run..."
DRY=$(docker exec "$CONTAINER_NAME" \
  void-agent --apply-playbook "$PLAYBOOK_FILE" --check --pretty 2>/dev/null)
echo "$DRY" | jq .
CHANGED=$(echo "$DRY" | jq '.summary.changed')
[ "$CHANGED" = "2" ] || die "dry-run: expected 2 changed, got $CHANGED"
pass "dry-run: 2 tasks would change"

# ── Step 5: Apply ─────────────────────────────────────────────
info "Running apply..."
APPLY=$(docker exec "$CONTAINER_NAME" \
  void-agent --apply-playbook "$PLAYBOOK_FILE" --pretty 2>/dev/null)
echo "$APPLY" | jq .
CHANGED=$(echo "$APPLY" | jq '.summary.changed')
FAILED=$(echo "$APPLY" | jq '.summary.failed')
[ "$CHANGED" = "2" ] && [ "$FAILED" = "0" ] \
  || die "apply: expected 2 changed, 0 failed — got $CHANGED changed, $FAILED failed"
pass "apply: 2 tasks succeeded"

# ── Step 6: Verify ────────────────────────────────────────────
docker exec "$CONTAINER_NAME" which tree >/dev/null \
  || die "'tree' not found — apt install may have failed"
pass "'tree' package is installed"

docker exec "$CONTAINER_NAME" grep -q "Hello from void-agent" /etc/hello.txt \
  || die "/etc/hello.txt content mismatch"
pass "/etc/hello.txt has correct content"

MODE=$(docker exec "$CONTAINER_NAME" stat -c '%a' /etc/hello.txt)
[ "$MODE" = "644" ] || die "expected mode 644, got $MODE"
pass "/etc/hello.txt mode is 644"

# ── Step 7: Idempotency ──────────────────────────────────────
info "Re-running apply (idempotency)..."
IDEM=$(docker exec "$CONTAINER_NAME" \
  void-agent --apply-playbook "$PLAYBOOK_FILE" --pretty 2>/dev/null)
echo "$IDEM" | jq .
C=$(echo "$IDEM" | jq '.summary.changed')
F=$(echo "$IDEM" | jq '.summary.failed')
[ "$C" = "0" ] && [ "$F" = "0" ] \
  || die "idempotency: expected 0 changed, 0 failed — got $C changed, $F failed"
pass "idempotent: second apply changed nothing"

# ── Step 8: Dry-run after apply ──────────────────────────────
info "Running dry-run after apply..."
DRY2=$(docker exec "$CONTAINER_NAME" \
  void-agent --apply-playbook "$PLAYBOOK_FILE" --check --pretty 2>/dev/null)
C=$(echo "$DRY2" | jq '.summary.changed')
[ "$C" = "0" ] || die "dry-run after apply: expected 0 changed — got $C"
pass "dry-run after apply: all up-to-date"

# ── Cleanup ───────────────────────────────────────────────────
docker rm -f "$CONTAINER_NAME" > /dev/null
pass "container cleaned up"

echo -e "\n${C_GREEN}All checks passed!${C_RESET}"
