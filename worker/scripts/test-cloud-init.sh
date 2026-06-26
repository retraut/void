#!/bin/bash
# Test the cloud-init user_data in a fresh Ubuntu 24.04 container.
#
# 1. Run vitest to validate the script structure.
# 2. Run scripts/extract-cloud-init.mts (via tsx) to write the real
#    user_data to test/output/user_data.sh.
# 3. Build the Docker image from test/Dockerfile.
# 4. Run it and print the state.
#
# Requires: pnpm, docker, and the agent-binary URL in buildCloudInit
# to 404 cleanly (which it does — the release doesn't exist yet, so
# the smoke test fails at the agent download but verifies everything
# before that point).
#
# Usage:
#   ./scripts/test-cloud-init.sh

set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ Validating user_data structure (vitest)..."
pnpm vitest run test/cloud-init.test.ts --reporter=basic

echo ""
echo "▶ Extracting user_data via tsx..."
pnpm exec tsx scripts/extract-cloud-init.mts

if [ ! -f test/output/user_data.sh ]; then
    echo "✕ test/output/user_data.sh was not generated" >&2
    exit 1
fi
echo "✓ user_data written ($(wc -c < test/output/user_data.sh) bytes)"

echo ""
echo "▶ Building Docker image..."
docker build -f test/Dockerfile -t void-bootstrap-test . --quiet

echo ""
echo "▶ Running container..."
docker run --rm void-bootstrap-test

