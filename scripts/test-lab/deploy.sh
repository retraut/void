#!/usr/bin/env bash
# void test-lab — call void_deploy MCP tool against a registered agent.
#
# Usage:
#   scripts/test-lab/deploy.sh <server_id> <repo_url> [ref] [build_cmd] [serve_cmd] [port]
#
# The MCP tool is exposed at /mcp. We POST a JSON-RPC request with
# the void_deploy tool name. The response includes a deployment_id
# we can use to tail logs.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

check_prereqs

SERVER_ID="${1:-}"
REPO_URL="${2:-}"
REF="${3:-main}"
BUILD_CMD="${4:-}"
SERVE_CMD="${5:-}"
PORT="${6:-3000}"

[ -n "$SERVER_ID" ] || die "usage: deploy.sh <server_id> <repo_url> [ref] [build_cmd] [serve_cmd] [port]"
[ -n "$REPO_URL" ] || die "usage: deploy.sh <server_id> <repo_url> [ref] [build_cmd] [serve_cmd] [port]"

if ! wrangler_is_up; then
	die "wrangler dev not running at $LAB_API. Start with scripts/test-lab/up.sh"
fi

BEARER="$(bearer_resolve)"

# Build the JSON-RPC body. void_deploy takes an object with server_id,
# repo_url, ref?, env?, build_command?, serve_command?, port?.
JSONRPC_BODY=$(jq -nc \
	--arg sid "$SERVER_ID" \
	--arg url "$REPO_URL" \
	--arg ref "$REF" \
	--argjson port "$PORT" \
	--arg build "$BUILD_CMD" \
	--arg serve "$SERVE_CMD" \
	'{
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: "void_deploy",
			arguments: (
				{
					server_id: $sid,
					repo_url: $url,
					ref: $ref,
					port: $port
				}
				+ (if $build != "" then {build_command: $build} else {} end)
				+ (if $serve != "" then {serve_command: $serve} else {} end)
			)
		}
	}')

log "POST $LAB_API/mcp (tool: void_deploy)..."
RESP=$(curl -fsS -X POST "$LAB_API/mcp" \
	-H "Authorization: Bearer $BEARER" \
	-H "Content-Type: application/json" \
	-d "$JSONRPC_BODY")

echo "$RESP" | jq .

# Extract deployment_id if present, so the user can tail logs immediately.
DEPLOYMENT_ID=$(echo "$RESP" | jq -r '
	(.result.content[0].text // "{}") | fromjson? | .deployment_id // empty
' 2>/dev/null || true)
if [ -n "$DEPLOYMENT_ID" ]; then
	printf '\n%s✓%s deploy queued as %s\n' "$C_GREEN" "$C_RESET" "$DEPLOYMENT_ID"
	printf '  tail logs:  scripts/test-lab/logs.sh %s %s\n' "$SERVER_ID" "$DEPLOYMENT_ID"
fi
