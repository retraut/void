#!/usr/bin/env bash
# CI warning checker: downloads full CI log, extracts ALL Rust warnings
# Usage: scripts/ci-check-warnings.sh [run_id]

set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${1:-}"

if [ -z "$RUN_ID" ]; then
  RUN_ID=$(rtk gh run list -w test -L 1 --json databaseId 2>/dev/null | rtk jq -r '.[0].databaseId' 2>/dev/null || echo "")
fi

if [ -z "$RUN_ID" ]; then
  echo "No run ID found. Usage: $0 [run_id]"
  exit 1
fi

echo "=== Fetching CI log for run $RUN_ID ==="
rtk gh run view "$RUN_ID" --log > /tmp/ci-raw.log 2>/dev/null

echo "=== Rust warnings in BUILD output ==="
python3 << 'PYEOF'
import re, sys
with open('/tmp/ci-raw.log') as f:
    text = f.read()
    clean = re.sub(r'\x1b\[[0-9;]*m', '', text)
    warnings = []
    in_cargo = True
    for line in clean.split('\n'):
        if 'Compiling void-agent' in line:
            in_cargo = True
        if 'Finished `test` profile' in line or 'Finished `dev` profile' in line or 'Finished `release` profile' in line:
            in_cargo = False
        # warnings only from cargo build/test output
        if 'warning:' in line.lower() and 'node:' not in line and 'punycode' not in line and 'hint:' not in line and 'Deprecation' not in line and 'generated' not in line and 'Use' not in line:
            if not in_cargo and 'Running unittests' not in line:
                continue  # skip non-cargo warnings
            clean_line = re.sub(r'2026-\d+-\d+T\d+:\d+:\d+\.\d+Z\s+', '', line)
            clean_line = re.sub(r'[A-Za-z0-9._-]+\t[A-Za-z0-9._ -]+\t', '', clean_line).strip()
            if clean_line and 'warning:' in clean_line.lower():
                warnings.append(clean_line)
    
    if warnings:
        for w in warnings:
            print(f"  {w}")
    else:
        print("  (none)")
PYEOF

echo ""
echo "=== Rust warnings in TEST output ==="
python3 << 'PYEOF'
import re
with open('/tmp/ci-raw.log') as f:
    text = f.read()
    clean = re.sub(r'\x1b\[[0-9;]*m', '', text)
    in_test_section = False
    warnings = []
    for line in clean.split('\n'):
        # Detect test section start
        if 'Running unittests' in line or 'Compiling void-agent' in line:
            in_test_section = True
            continue
        if 'test result:' in line:
            in_test_section = False
            continue
        if in_test_section and 'warning:' in line.lower() and 'generated' not in line:
            clean_line = re.sub(r'2026-\d+-\d+T\d+:\d+:\d+\.\d+Z\s+', '', line)
            clean_line = re.sub(r'[A-Za-z0-9._-]+\t[A-Za-z0-9._ -]+\t', '', clean_line).strip()
            if clean_line:
                warnings.append(clean_line)
    
    if warnings:
        for w in warnings:
            print(f"  {w}")
    else:
        print("  (none)")
PYEOF

echo ""
echo "=== Summary of warning lines ==="
python3 << 'PYEOF'
import re, sys
with open('/tmp/ci-raw.log') as f:
    text = f.read()
    clean = re.sub(r'\x1b\[[0-9;]*m', '', text)
    all_warnings = []
    for line in clean.split('\n'):
        if 'warning:' in line.lower() and 'node:' not in line and 'punycode' not in line and 'hint:' not in line and 'Deprecation' not in line and 'Use' not in line and 'generated' not in line:
            clean_line = re.sub(r'2026-\d+-\d+T\d+:\d+:\d+\.\d+Z\s+', '', line)
            clean_line = re.sub(r'[A-Za-z0-9._-]+\t[A-Za-z0-9._ -]+\t', '', clean_line).strip()
            if clean_line:
                all_warnings.append(clean_line)
    
    for w in all_warnings:
        print(f"  ! {w}")
    
    if not all_warnings:
        print("  ZERO WARNINGS")
        sys.exit(0)
    
    sys.exit(len(all_warnings))
PYEOF
