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

VM="void-lab"
BINARY="void-agent"
PLAYBOOK="/tmp/apt-test.json"
exec_vm() { orb -m "$VM" "$@"; }

PB() { printf '%s' "$1" > "$PROJECT_DIR/agent/_test_pb.json"; exec_vm cp /mnt/mac/Users/retraut/Documents/null.sh/agent/_test_pb.json "$PLAYBOOK"; }
run() { exec_vm sudo "$BINARY" --apply-playbook "$PLAYBOOK" --pretty 2>/dev/null; }
run_check() { exec_vm sudo "$BINARY" --apply-playbook "$PLAYBOOK" --check --pretty 2>/dev/null; }

# Each test expects changed=$2, failed=$3
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

# Use uncommon apt packages for clean tests
PKG1="sl"        # trains — small, unlikely pre-installed
PKG2="figlet"    # ASCII art — small
PKG3="bsdgames"  # small games

# Helper: purge before test
purge() {
  local pkg="$1"
  exec_vm sudo dpkg --purge "$pkg" 2>/dev/null || true
}

# ── 1. packages (list) ──────────────────────────────────────────
purge "$PKG1"
expect "packages: install $PKG1" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"state":"present"}]}'
idem "packages:" \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"state":"present"}]}'

# ── 2. name (alias) ─────────────────────────────────────────────
purge "$PKG2"
expect "name alias: install $PKG2" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","name":"'"$PKG2"'","state":"present"}]}'
idem "name alias:" \
  '{"name":"t","tasks":[{"module":"apt","name":"'"$PKG2"'","state":"present"}]}'

# ── 3. pkg (alias) ─────────────────────────────────────────────
purge "$PKG3"
expect "pkg alias: install $PKG3" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","pkg":"'"$PKG3"'","state":"present"}]}'
idem "pkg alias:" \
  '{"name":"t","tasks":[{"module":"apt","pkg":"'"$PKG3"'","state":"present"}]}'

# ── 4. state: absent ────────────────────────────────────────────
expect "state absent: remove $PKG1" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"state":"absent"]}'
idem "state absent:" \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"state":"absent"]}'

# ── 5. state: latest ────────────────────────────────────────────
purge "$PKG1"
expect "state latest: $PKG1" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"state":"latest"]}'

# ── 6. update_cache ─────────────────────────────────────────────
expect "update_cache: true" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"state":"present","update_cache":true}]}'

# ── 7. clean ────────────────────────────────────────────────────
expect "clean: apt-get clean" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"clean":true}]}'

# ── 8. autoclean ────────────────────────────────────────────────
expect "autoclean:" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"autoclean":true}]}'

# ── 9. autoremove ───────────────────────────────────────────────
expect "autoremove:" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"autoremove":true}]}'

# ── 10. allow_unauthenticated ───────────────────────────────────
expect "allow_unauthenticated:" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"state":"present","allow_unauthenticated":true}]}'

# ── 11. only_upgrade ────────────────────────────────────────────
expect "only_upgrade: skip missing pkg" 0 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["nonexistent-pkg-xyz"],"state":"latest","only_upgrade":true}]}'

# ── 12. force ───────────────────────────────────────────────────
expect "force:" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"state":"present","force":true}]}'

# ── 13. install_recommends=false ─────────────────────────────────
expect "install_recommends=false:" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"state":"present","install_recommends":false}]}'

# ── 14. dpkg_options ────────────────────────────────────────────
expect "dpkg_options:" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"state":"present","dpkg_options":"force-confdef,force-confold"}]}'

# ── 15. lock_timeout ────────────────────────────────────────────
expect "lock_timeout: 30s" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"state":"present","lock_timeout":30}]}'

# ── 16. cache_valid_time ────────────────────────────────────────
expect "cache_valid_time:" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"state":"present","cache_valid_time":0}]}'

# ── 17. allow_downgrade ─────────────────────────────────────────
expect "allow_downgrade:" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"state":"present","allow_downgrade":true}]}'

# ── 18. purge ───────────────────────────────────────────────────
expect "purge: remove $PKG1" 1 0 \
  '{"name":"t","tasks":[{"module":"apt","packages":["'"$PKG1"'"],"state":"absent","purge":true}]}'

# ── Summary ─────────────────────────────────────────────────────
echo "---" && echo "apt: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
