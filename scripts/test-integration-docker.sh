#!/usr/bin/env bash
# Integration tests for docker module
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0; FAIL=0
OK="  OK"; NO="  NO"; INFO="  ->"
pass() { PASS=$((PASS+1)); echo "$OK $1"; }
fail() { FAIL=$((FAIL+1)); echo "$NO $1"; }
info() { echo "$INFO $1"; }

VM="void-lab"
BINARY="void-agent"
PLAYBOOK="/tmp/docker-test.json"
exec_vm() { orb -m "$VM" "$@"; }
PB() { printf '%s' "$1" > "$PROJECT_DIR/agent/_test_pb.json"; exec_vm cp /mnt/mac/Users/retraut/Documents/null.sh/agent/_test_pb.json "$PLAYBOOK"; }
run() { exec_vm sudo "$BINARY" --apply-playbook "$PLAYBOOK" --pretty 2>/dev/null; }

expect() {
  local desc="$1" exp_changed="$2" exp_failed="$3" json="$4"
  info "$desc"
  PB "$json"
  RESULT=$(run)
  CHANGED=$(echo "$RESULT" | jq -r '.summary.changed')
  FAILED=$(echo "$RESULT" | jq -r '.summary.failed')
  if [ "$CHANGED" = "$exp_changed" ] && [ "$FAILED" = "$exp_failed" ]; then
    pass "$desc"
  else
    fail "$desc (expected changed=$exp_changed failed=$exp_failed, got changed=$CHANGED failed=$FAILED)"
    echo "$RESULT" | jq .
  fi
}
idem() { expect "$1 (idempotent)" 0 0 "$2"; }

CID="void-test-ctr-$$"
# Cleanup
exec_vm sudo docker rm -f "$CID" 2>/dev/null || true

# ── 1. create container ─────────────────────────────────────────
expect "create: nginx:alpine" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID"'","image":"nginx:alpine","state":"running","ports":["8080:80"],"pull":true}]}'
idem "create:" \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID"'","image":"nginx:alpine","state":"running"}]}'

# ── 2. env ──────────────────────────────────────────────────────
exec_vm sudo docker rm -f "$CID" 2>/dev/null || true
expect "env: set vars" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID"'","image":"nginx:alpine","state":"running","env":{"MYVAR":"hello"},"pull":false}]}'

# ── 3. restart policy ───────────────────────────────────────────
exec_vm sudo docker rm -f "$CID" 2>/dev/null || true
expect "restart: always" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID"'","image":"nginx:alpine","state":"running","restart":"always","pull":false}]}'

# ── 4. read_only ────────────────────────────────────────────────
exec_vm sudo docker rm -f "$CID" 2>/dev/null || true
expect "read_only: true" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID"'","image":"nginx:alpine","state":"running","read_only":true,"pull":false}]}'

# ── 5. privileged ───────────────────────────────────────────────
exec_vm sudo docker rm -f "$CID" 2>/dev/null || true
expect "privileged: true" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID"'","image":"nginx:alpine","state":"running","privileged":true,"pull":false}]}'

# ── 6. auto_remove ──────────────────────────────────────────────
exec_vm sudo docker rm -f "$CID" 2>/dev/null || true
expect "auto_remove: true" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID"'","image":"nginx:alpine","state":"running","auto_remove":true,"pull":false}]}'

# ── 7. state: stopped ───────────────────────────────────────────
exec_vm sudo docker rm -f "$CID" 2>/dev/null || true
exec_vm sudo docker run -d --name "$CID" nginx:alpine sleep 30 2>/dev/null || true
expect "state stopped: stop container" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID"'","image":"nginx:alpine","state":"stopped"}]}'
exec_vm sudo docker rm -f "$CID" 2>/dev/null || true

# ── 8. state: absent ────────────────────────────────────────────
exec_vm sudo docker run -d --name "$CID" nginx:alpine sleep 5 2>/dev/null || true
expect "state absent: remove" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID"'","image":"nginx:alpine","state":"absent"}]}'
idem "state absent:" \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID"'","image":"nginx:alpine","state":"absent"}]}'

# ── Summary ─────────────────────────────────────────────────────
echo "---"
echo "docker: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
