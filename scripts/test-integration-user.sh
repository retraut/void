#!/usr/bin/env bash
# Integration tests for user module
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
PLAYBOOK="/tmp/user-test.json"
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

U="testuser${RANDOM}"
UHOME="/home/$U"

# Cleanup before
exec_vm sudo userdel -rf "$U" 2>/dev/null || true

# ── 1. create user ──────────────────────────────────────────────
expect "create: $U" 1 0 \
  '{"name":"t","tasks":[{"module":"user","name":"'"$U"'","shell":"/bin/bash","create_home":true}]}'
idem "create:" \
  '{"name":"t","tasks":[{"module":"user","name":"'"$U"'","shell":"/bin/bash"}]}'

# ── 2. uid ──────────────────────────────────────────────────────
expect "uid: set" 1 0 \
  '{"name":"t","tasks":[{"module":"user","name":"'"$U"'","uid":2042}]}'

# ── 3. comment ──────────────────────────────────────────────────
expect "comment: set" 1 0 \
  '{"name":"t","tasks":[{"module":"user","name":"'"$U"'","comment":"Test User"}]}'

# ── 4. shell ────────────────────────────────────────────────────
expect "shell: change" 1 0 \
  '{"name":"t","tasks":[{"module":"user","name":"'"$U"'","shell":"/bin/zsh"}]}'
idem "shell:" \
  '{"name":"t","tasks":[{"module":"user","name":"'"$U"'","shell":"/bin/zsh"}]}'

# ── 5. home ─────────────────────────────────────────────────────
expect "home: change" 1 0 \
  '{"name":"t","tasks":[{"module":"user","name":"'"$U"'","home":"'"$UHOME"'","move_home":true}]}'

# ── 6. group ────────────────────────────────────────────────────
expect "group: primary" 1 0 \
  '{"name":"t","tasks":[{"module":"user","name":"'"$U"'","group":"root"}]}'

# ── 7. groups + append ──────────────────────────────────────────
expect "groups: append" 1 0 \
  '{"name":"t","tasks":[{"module":"user","name":"'"$U"'","groups":["sudo","adm"],"append":true}]}'

# ── 8. system (create new) ─────────────────────────────────────
USYS="sysuser${RANDOM}"
exec_vm sudo userdel -rf "$USYS" 2>/dev/null || true
expect "system: create" 1 0 \
  '{"name":"t","tasks":[{"module":"user","name":"'"$USYS"'","system":true}]}'
idem "system:" \
  '{"name":"t","tasks":[{"module":"user","name":"'"$USYS"'","system":true}]}'

# ── 9. remove user ──────────────────────────────────────────────
expect "remove: $U" 1 0 \
  '{"name":"t","tasks":[{"module":"user","name":"'"$U"'","state":"absent","remove":true}]}'
idem "remove:" \
  '{"name":"t","tasks":[{"module":"user","name":"'"$U"'","state":"absent"}]}'

# ── Summary ─────────────────────────────────────────────────────
echo "---"
echo "user: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
