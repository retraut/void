#!/usr/bin/env bash
# void test-lab — tail logs for an active deployment via SSE.
#
# Usage:
#   scripts/test-lab/logs.sh <server_id> <deployment_id>
#
# The worker exposes log streaming at /api/servers/<id>/deployments/<dep>/logs
# as a Server-Sent Events stream. We just curl it with -N (no buffering)
# and pretty-print each event.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

SERVER_ID="${1:-}"
DEPLOYMENT_ID="${2:-}"
[ -n "$SERVER_ID" ]      || die "usage: logs.sh <server_id> <deployment_id>"
[ -n "$DEPLOYMENT_ID" ] || die "usage: logs.sh <server_id> <deployment_id>"

if ! wrangler_is_up; then
	die "wrangler dev not running at $LAB_API. Start with scripts/test-lab/up.sh"
fi

BEARER="$(bearer_resolve)"

URL="$LAB_API/api/servers/$SERVER_ID/deployments/$DEPLOYMENT_ID/logs"
log "streaming $URL (Ctrl-C to stop)..."
# -N disables output buffering, --no-buffer too. We strip the
# "data: " prefix and the trailing blank line that SSE uses so
# the output looks like normal log lines.
exec curl -fsSN \
	-H "Authorization: Bearer $BEARER" \
	-H "Accept: text/event-stream" \
	"$URL" | awk '
		/^data: / { sub(/^data: /, ""); print; fflush() }
		/^$/ { next }
		!/^data: / && !/^$/ && !/^event: / && !/^id: / { print; fflush() }
	'
