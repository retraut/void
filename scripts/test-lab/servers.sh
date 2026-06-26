#!/usr/bin/env bash
# void test-lab — list servers registered with the local control plane.
#
# Uses GET /api/servers with the Bearer token. Prints a compact
# table (id, name, provider, status, region, size).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

check_prereqs

if ! wrangler_is_up; then
	die "wrangler dev not running at $LAB_API. Start with scripts/test-lab/up.sh"
fi

api_servers | jq -r '
	.servers[] |
	[
		.id,
		.name,
		.provider,
		.status,
		(.region // "-"),
		(.size // "-"),
		(.last_seen_at // "never")
	] | @tsv
' | column -t -s $'\t' | (
	read -r header
	printf '%-22s %-20s %-10s %-12s %-8s %-8s %s\n' \
		"ID" "NAME" "PROVIDER" "STATUS" "REGION" "SIZE" "LAST SEEN"
	printf '%-22s %-20s %-10s %-12s %-8s %-8s %s\n' \
		"----------------------" "--------------------" "----------" "------------" "--------" "--------" "---------"
	cat
)
