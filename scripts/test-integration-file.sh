#!/usr/bin/env bash
# Integration tests for file module — all parameters
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
PLAYBOOK="/tmp/file-test.json"
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
run_fail() {
  local desc="$1" json="$2"
  info "$desc"
  PB "$json"
  RESULT=$(run)
  FAILED=$(echo "$RESULT" | jq -r '.summary.failed')
  [ "$FAILED" != "0" ] && pass "$desc" || { fail "$desc (expected failure)"; echo "$RESULT" | jq .; }
}

TMP="/tmp/filetest"
exec_vm rm -rf "$TMP"
exec_vm mkdir -p "$TMP"

# ── 1. path ─────────────────────────────────────────────────────
expect "path: write file" 1 0 \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/a.txt","content":"hello","mode":"0644"}]}'
idem "path:" \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/a.txt","content":"hello","mode":"0644"}]}'

# ── 2. dest (alias) ─────────────────────────────────────────────
expect "dest alias: write" 1 0 \
  '{"name":"t","tasks":[{"module":"file","dest":"'"$TMP"'/b.txt","content":"world"}]}'

# ── 3. content ──────────────────────────────────────────────────
expect "content: change existing" 1 0 \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/a.txt","content":"changed content"}]}'

# ── 4. state: absent ────────────────────────────────────────────
echo "test" > "$PROJECT_DIR/agent/_test_pb.json"; exec_vm cp /mnt/mac/Users/retraut/Documents/null.sh/agent/_test_pb.json "$TMP/delete-me.txt"
expect "state absent: remove file" 1 0 \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/delete-me.txt","state":"absent"}]}'
idem "state absent:" \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/delete-me.txt","state":"absent"}]}'

# ── 5. state: directory ─────────────────────────────────────────
expect "state directory: create" 1 0 \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/subdir","state":"directory","mode":"0755"}]}'
idem "state directory:" \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/subdir","state":"directory"}]}'

# ── 6. state: touch ─────────────────────────────────────────────
expect "state touch: create new" 1 0 \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/touched.txt","state":"touch"}]}'
idem "state touch: existing" \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/touched.txt","state":"touch"}]}'

# ── 7. state: link ──────────────────────────────────────────────
exec_vm sh -c "echo target > $TMP/link-target.txt"
expect "state link: create symlink" 1 0 \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/mylink","src":"'"$TMP"'/link-target.txt","state":"link"}]}'
idem "state link:" \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/mylink","src":"'"$TMP"'/link-target.txt","state":"link"}]}'

# ── 8. state: hard ──────────────────────────────────────────────
expect "state hard: create hardlink" 1 0 \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/hard1","src":"'"$TMP"'/link-target.txt","state":"hard"}]}'
idem "state hard:" \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/hard1","src":"'"$TMP"'/link-target.txt","state":"hard"}]}'

# ── 9. mode (octal) ─────────────────────────────────────────────
expect "mode octal: 0600" 1 0 \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/a.txt","content":"x","mode":"0600"}]}'
idem "mode octal:" \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/a.txt","content":"x","mode":"0600"}]}'

# ── 10. mode (symbolic) ──────────────────────────────────────────
expect "mode symbolic: u=rw,g=r,o=r" 1 0 \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/a.txt","mode":"u=rw,g=r,o=r"}]}'

# ── 11. owner ───────────────────────────────────────────────────
expect "owner: daemon" 1 0 \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/a.txt","owner":"daemon"}]}'

# ── 12. group ───────────────────────────────────────────────────
expect "group: daemon" 1 0 \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/a.txt","group":"daemon"}]}'

# ── 13. force ───────────────────────────────────────────────────
expect "force: overwrite link" 1 0 \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/overwrite-link","src":"'"$TMP"'/link-target.txt","state":"link","force":true}]}'

# ── 14. template + vars ─────────────────────────────────────────
expect "template + vars" 1 0 \
  '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/rendered.txt","template":"Hello {{ name }}!","vars":{"name":"world"}}]}'

# ── 15. modification_time ───────────────────────────────────────
PB '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/a.txt","modification_time":"now"}]}'
RESULT=$(run)
[ "$(echo "$RESULT" | jq -r '.summary.failed')" = "0" ] && pass "modification_time: no error" || fail "modification_time: failed"

# ── 16. access_time ─────────────────────────────────────────────
PB '{"name":"t","tasks":[{"module":"file","path":"'"$TMP"'/a.txt","access_time":"now"}]}'
RESULT=$(run)
[ "$(echo "$RESULT" | jq -r '.summary.failed')" = "0" ] && pass "access_time: no error" || fail "access_time: failed"

# ── Summary ─────────────────────────────────────────────────────
echo "---"
echo "file: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
