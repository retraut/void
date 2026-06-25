#!/bin/bash
# Install the void-agent on a fresh Linux server.
# Use this for self-hosted agents (not provisioned by void's Hetzner flow).
# 
# Usage:
#   curl -sSL https://raw.githubusercontent.com/void-sh/void/main/install/install-agent.sh | \
#     bash -s -- --server-id <srv_xxx> --setup-token <set_xxx> --api-base wss://api.void.example.com

set -e

SERVER_ID=""
SETUP_TOKEN=""
API_BASE="wss://api.void.example.com"
RELEASE_TAG="v0.1.0"
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) AGENT_ARCH="x86_64" ;;
  aarch64) AGENT_ARCH="aarch64" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

while [[ $# -gt 0 ]]; do
  case $1 in
    --server-id) SERVER_ID="$2"; shift 2 ;;
    --setup-token) SETUP_TOKEN="$2"; shift 2 ;;
    --api-base) API_BASE="$2"; shift 2 ;;
    --release-tag) RELEASE_TAG="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$SERVER_ID" ] || [ -z "$SETUP_TOKEN" ]; then
  echo "Usage: $0 --server-id <srv_xxx> --setup-token <set_xxx> [--api-base <wss://...>]"
  exit 1
fi

# Install cloudflared
echo "→ installing cloudflared"
CFD_ARCH="$([ "$ARCH" = "x86_64" ] && echo amd64 || echo arm64)"
curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CFD_ARCH}" \
  -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# Install void-agent
echo "→ installing void-agent"
curl -fsSL "https://github.com/void-sh/void/releases/download/${RELEASE_TAG}/void-agent-linux-${AGENT_ARCH}.tar.gz" \
  -o /tmp/void-agent.tar.gz
tar -xzf /tmp/void-agent.tar.gz -C /usr/local/bin/
chmod +x /usr/local/bin/void-agent

# Config
mkdir -p /etc/void /var/lib/void
cat > /etc/void/config.toml <<EOF
server_id = "${SERVER_ID}"
setup_token = "${SETUP_TOKEN}"
api_base = "${API_BASE}"
state_dir = "/var/lib/void"
public_url_template = "https://pr-{deployment_id}.void.example.com"
