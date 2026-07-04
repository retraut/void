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

VM="${VOID_TEST_VM:-void-lab}"
BINARY="void-agent"
PLAYBOOK="/tmp/docker-test.json"
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

# ── 8. volumes ──────────────────────────────────────────────────
CID2="void-vol-$$"
exec_vm sudo docker rm -f "$CID2" 2>/dev/null || true
exec_vm sh -c "echo test > /tmp/voltest.txt"
expect "volumes: bind mount" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID2"'","image":"nginx:alpine","state":"running","volumes":["/tmp/voltest.txt:/tmp/data.txt"],"pull":false}]}'
exec_vm sudo docker rm -f "$CID2" 2>/dev/null || true

# ── 9. command ──────────────────────────────────────────────────
CID3="void-cmd-$$"
exec_vm sudo docker rm -f "$CID3" 2>/dev/null || true
expect "command: override" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID3"'","image":"nginx:alpine","state":"running","command":"sleep 999","pull":false}]}'
exec_vm sudo docker rm -f "$CID3" 2>/dev/null || true

# ── 10. cap_add + cap_drop ──────────────────────────────────────
CID4="void-cap-$$"
exec_vm sudo docker rm -f "$CID4" 2>/dev/null || true
expect "cap_add/drop" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID4"'","image":"nginx:alpine","state":"running","cap_add":["NET_ADMIN"],"cap_drop":["ALL"],"pull":false}]}'
exec_vm sudo docker rm -f "$CID4" 2>/dev/null || true

# ── 11. healthcheck ─────────────────────────────────────────────
CID5="void-hc-$$"
exec_vm sudo docker rm -f "$CID5" 2>/dev/null || true
expect "healthcheck:" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID5"'","image":"nginx:alpine","state":"running","healthcheck_test":["CMD","echo","ok"],"healthcheck_interval":300,"healthcheck_retries":2,"pull":false}]}'
exec_vm sudo docker rm -f "$CID5" 2>/dev/null || true

# ── 12. memory limit + cpu shares ────────────────────────────────
CID6="void-mem-$$"
exec_vm sudo docker rm -f "$CID6" 2>/dev/null || true
expect "memory + cpu" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID6"'","image":"nginx:alpine","state":"running","memory":67108864,"memory_swap":134217728,"cpu_shares":512,"pull":false}]}'
exec_vm sudo docker rm -f "$CID6" 2>/dev/null || true

# ── 13. network_mode ────────────────────────────────────────────
CID7="void-net-$$"
exec_vm sudo docker rm -f "$CID7" 2>/dev/null || true
expect "network_mode: host" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID7"'","image":"nginx:alpine","state":"running","network_mode":"host","pull":false}]}'
exec_vm sudo docker rm -f "$CID7" 2>/dev/null || true

# ── 14. dns + dns_search + extra_hosts ──────────────────────────
CID8="void-dns-$$"
exec_vm sudo docker rm -f "$CID8" 2>/dev/null || true
expect "dns + extra_hosts" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID8"'","image":"nginx:alpine","state":"running","dns":["8.8.8.8"],"dns_search":["example.com"],"extra_hosts":["host:127.0.0.1"],"pull":false}]}'
exec_vm sudo docker rm -f "$CID8" 2>/dev/null || true

# ── 15. working_dir + user + labels ──────────────────────────────
CID9="void-wdl-$$"
exec_vm sudo docker rm -f "$CID9" 2>/dev/null || true
expect "working_dir+user+labels" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID9"'","image":"nginx:alpine","state":"running","working_dir":"/tmp","user":"nobody","labels":{"app":"test"},"pull":false}]}'
exec_vm sudo docker rm -f "$CID9" 2>/dev/null || true

# ── 16. entrypoint ──────────────────────────────────────────────
CID10="void-ep-$$"
exec_vm sudo docker rm -f "$CID10" 2>/dev/null || true
expect "entrypoint:" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID10"'","image":"nginx:alpine","state":"running","entrypoint":"/bin/sh","pull":false}]}'
exec_vm sudo docker rm -f "$CID10" 2>/dev/null || true

# ── 17. devices + sysctls + tmpfs + security_opt ─────────────────
CID11="void-dst-$$"
exec_vm sudo docker rm -f "$CID11" 2>/dev/null || true
expect "devices+sysctls+tmpfs" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID11"'","image":"nginx:alpine","state":"running","sysctls":{"net.ipv4.ip_forward":"1"},"security_opt":["no-new-privileges"],"pull":false}]}'
exec_vm sudo docker rm -f "$CID11" 2>/dev/null || true

# ── 18. stop_signal + stop_timeout + init ────────────────────────
CID12="void-stp-$$"
exec_vm sudo docker rm -f "$CID12" 2>/dev/null || true
expect "stop_signal+timeout+init" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID12"'","image":"nginx:alpine","state":"running","stop_signal":"SIGTERM","stop_timeout":10,"init":true,"pull":false}]}'
exec_vm sudo docker rm -f "$CID12" 2>/dev/null || true

# ── 19. cpu_quota + cpu_set + memory_reservation ─────────────────
CID13="void-cq-$$"
exec_vm sudo docker rm -f "$CID13" 2>/dev/null || true
expect "cpu_quota+set+memres" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID13"'","image":"nginx:alpine","state":"running","cpu_quota":50000,"cpu_set":"0","memory_reservation":33554432,"pull":false}]}'
exec_vm sudo docker rm -f "$CID13" 2>/dev/null || true

# ── 15. state: absent ───────────────────────────────────────────
exec_vm sudo docker run -d --name "$CID" nginx:alpine sleep 5 2>/dev/null || true
expect "state absent: remove" 1 0 \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID"'","image":"nginx:alpine","state":"absent"}]}'
idem "state absent:" \
  '{"name":"t","tasks":[{"module":"docker","name":"'"$CID"'","image":"nginx:alpine","state":"absent"}]}'

# ── Summary ─────────────────────────────────────────────────────
echo "---"
echo "docker: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
