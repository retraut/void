#!/usr/bin/env bash
# Integration tests for apt module — all parameters
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0; FAIL=0
OK="  OK"; NO="  NO"; INFO="  ->"
pass() { PASS=$((PASS+1)); echo "$OK $1"; }
fail() { FAIL=$((FAIL+1)); echo "$NO $1"; }
info() { echo "$INFO $1"; }

VM="${VOID_TEST_VM:-void-lab}"
BINARY="void-agent"
PLAYBOOK="/tmp/apt-test.json"
exec_vm() { orb -m "$VM" "$@"; }
PB() {
  local fname="void-test-$$-$RANDOM.json"
  local local_path="$PROJECT_DIR/agent/$fname"
  local vm_path="/mnt/mac$PROJECT_DIR/agent/$fname"
  printf '%s' "$1" > "$local_path"
  exec_vm cp "$vm_path" "$PLAYBOOK"
  rm -f "$local_path"
}
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

# Use printf for proper JSON escaping
pkgs() { printf '{"name":"t","tasks":[{"module":"apt","packages":["%s"],"state":"%s"}]}' "$1" "$2"; }
pkgs_full() { printf '{"name":"t","tasks":[{"module":"apt","packages":["%s"],"state":"%s",%s}]}' "$1" "$2" "$3"; }

PKG1="sl"; PKG2="figlet"; PKG3="bsdgames"
NOOP='{"name":"t","tasks":[{"module":"apt","packages":["nonexistent-pkg-xyz"],"state":"latest","only_upgrade":true}]}'

# Helper: purge package (removes it so next install shows changed=1)
purge_pkg() { exec_vm sudo dpkg --purge "$1" 2>/dev/null || true; }

# ── 1-3. packages / name / pkg aliases ─────────────────────────
purge_pkg "$PKG1"
expect "packages: install $PKG1" 1 0 "$(pkgs "$PKG1" present)"
idem "packages:" "$(pkgs "$PKG1" present)"

purge_pkg "$PKG1"
expect "name alias: install $PKG1" 1 0 "$(printf '{"name":"t","tasks":[{"module":"apt","name":"%s","state":"present"}]}' "$PKG1")"
idem "name alias:" "$(printf '{"name":"t","tasks":[{"module":"apt","name":"%s","state":"present"}]}' "$PKG1")"

purge_pkg "$PKG1"
expect "pkg alias: install $PKG1" 1 0 "$(printf '{"name":"t","tasks":[{"module":"apt","pkg":"%s","state":"present"}]}' "$PKG1")"
idem "pkg alias:" "$(printf '{"name":"t","tasks":[{"module":"apt","pkg":"%s","state":"present"}]}' "$PKG1")"

# ── 4. state: absent ────────────────────────────────────────────
purge_pkg "$PKG1"
exec_vm sudo apt-get install -y -qq "$PKG1" 2>/dev/null
expect "state absent:" 1 0 "$(pkgs "$PKG1" absent)"
idem "state absent:" "$(pkgs "$PKG1" absent)"

# ── 5. state: latest ────────────────────────────────────────────
purge_pkg "$PKG1"
expect "state latest:" 1 0 "$(pkgs "$PKG1" latest)"

# ── 6-22. flag params (check only that they don't error) ──────
purge_pkg "$PKG1"; exec_vm sudo apt-get install -y -qq "$PKG1" 2>/dev/null

run_flag() {
  local desc="$1" json="$2"
  info "$desc"
  PB "$json"
  RESULT=$(run)
  [ "$(echo "$RESULT" | jq -r '.summary.failed')" = "0" ] && pass "$desc" || fail "$desc"
}

run_flag "update_cache:" "$(pkgs_full "$PKG1" present '"update_cache":true')"
run_flag "clean:" "$(pkgs_full "$PKG1" present '"clean":true')"
run_flag "autoclean:" "$(pkgs_full "$PKG1" present '"autoclean":true')"
run_flag "autoremove:" "$(pkgs_full "$PKG1" present '"autoremove":true')"
run_flag "allow_unauthenticated:" "$(pkgs_full "$PKG1" present '"allow_unauthenticated":true')"
run_flag "force:" "$(pkgs_full "$PKG1" present '"force":true')"
run_flag "install_recommends=false:" "$(pkgs_full "$PKG1" present '"install_recommends":false')"
run_flag "dpkg_options:" "$(pkgs_full "$PKG1" present '"dpkg_options":"force-confdef,force-confold"')"
run_flag "lock_timeout:" "$(pkgs_full "$PKG1" present '"lock_timeout":30')"
run_flag "cache_valid_time:" "$(pkgs_full "$PKG1" present '"cache_valid_time":0')"
run_flag "allow_downgrade:" "$(pkgs_full "$PKG1" present '"allow_downgrade":true')"
run_flag "default_release:" "$(pkgs_full "$PKG1" present '"default_release":"stable"')"
run_flag "fail_on_autoremove:" "$(pkgs_full "$PKG1" present '"fail_on_autoremove":true')"
run_flag "allow_change_held_packages:" "$(pkgs_full "$PKG1" present '"allow_change_held_packages":true')"

# ── upgrade: dist ───────────────────────────────────────────────
PB '{"name":"t","tasks":[{"module":"apt","upgrade":"dist"}]}'
RESULT=$(run)
[ "$(echo "$RESULT" | jq -r '.summary.failed')" = "0" ] && pass "upgrade dist: no error" || fail "upgrade dist: failed"

# ── purge ───────────────────────────────────────────────────────
purge_pkg "$PKG1"; exec_vm sudo apt-get install -y -qq "$PKG1" 2>/dev/null
expect "purge: remove $PKG1" 1 0 "$(pkgs_full "$PKG1" absent '"purge":true')"

echo "---" && echo "apt: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
