#!/usr/bin/env bash
# void test-lab — provision D1 with a 'lab' user.
#
# The control plane attributes registered servers to a user
# (multi-tenant: who owns this server?). For production the user
# is created by the GitHub OAuth flow on first login. For the
# test-lab there's no OAuth (we don't want to log in just to boot
# a VM), so we seed a 'lab' user with a stable id directly in D1.
#
# This script is idempotent — running it twice is a no-op. Run
# it ONCE after a fresh `wrangler dev` first request (which
# creates the schema) and before `up.sh`.
#
# What it does:
#   1. Calls POST /health to make sure wrangler dev is up
#      (and therefore D1 schema is initialised).
#   2. INSERT OR IGNORE a 'lab' user into the users table.
#
# What it does NOT do:
#   - Touch the production users table (different DB).
#   - Create any servers or projects (that's up.sh).
#   - Authenticate with GitHub (the lab has no GitHub identity).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

check_prereqs

LAB_USER_ID="usr_lab"
LAB_USERNAME="lab"

# Make sure wrangler dev is up (which triggers schema init on first
# request). We can also use this to verify the bearer token is set.
if ! wrangler_is_up; then
	die "wrangler dev not running at $LAB_API. Start with: cd worker && wrangler dev --port $LAB_AGENT_PORT"
fi

# Resolve the D1 binding name + database name from wrangler.jsonc.
# We do this so the script works without hardcoding "void-db" —
# if the user renamed the binding or the DB, we pick it up.
# jsonc (JSON with // and /* */ comments) needs pre-stripping
# before jq can parse it. Use Python (or perl) for the multi-line
# block-comment stripping — BSD sed on macOS doesn't have GNU
# extensions like :a;N;$!ba.
strip_jsonc_comments() {
	# Use perl for portable multi-line regex. Reads $1 (the file),
	# strips /* ... */ block comments (greedy across lines) and
	# // line comments, prints the rest.
	perl -0777 -pe 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g' "$1"
}
D1_BINDING="$(strip_jsonc_comments "$LAB_REPO_ROOT/worker/wrangler.jsonc" | jq -r '.d1_databases[0].binding // "void_db"')"
D1_DB_NAME="$(strip_jsonc_comments "$LAB_REPO_ROOT/worker/wrangler.jsonc" | jq -r '.d1_databases[0].database_name // "void-db"')"

# Sanity: the bearer token must be set in .dev.vars (or env), or
# the wrangler dev we just pinged wouldn't have started.
bearer_resolve > /dev/null

# Use --local so the script always operates on the local SQLite
# D1 in .wrangler/state/, never the remote one. This is the point
# of the lab — no external infrastructure.
section "test-lab: provision D1 (local)"
log "binding=$D1_BINDING database=$D1_DB_NAME"

cd "$LAB_REPO_ROOT/worker"

# --yes skips the interactive prompt for non-remote (i.e. --local)
# commands. --json gives us machine-readable output so we can
# confirm the user was created without parsing prose.
NOW="$(date +%s)"

# Single-line SQL: wrangler passes the command verbatim to the
# SQLite shell, and embedded whitespace / line continuations make
# the parser unhappy when the SQL has multiple statements.
wrangler d1 execute "$D1_DB_NAME" --local --yes --json --command "INSERT OR IGNORE INTO users (id, username, avatar_url, onboarding_completed_at, created_at) VALUES ('$LAB_USER_ID', '$LAB_USERNAME', NULL, $NOW, $NOW);" > /dev/null

# Confirm the user is there.
USER_ID_FOUND=$(wrangler d1 execute "$D1_DB_NAME" --local --yes --json --command "SELECT id FROM users WHERE id = '$LAB_USER_ID' LIMIT 1;" | jq -r '.[0].results[0].id // empty')

if [ -z "$USER_ID_FOUND" ]; then
	die "user '$LAB_USER_ID' was not created — check .wrangler/state/ and wrangler dev logs"
fi

ok "user $LAB_USER_ID ($LAB_USERNAME) ready in local D1"
printf '\n%sNext:%s run scripts/test-lab/up.sh to bring up an OrbStack VM.\n' "$C_BOLD" "$C_RESET"
