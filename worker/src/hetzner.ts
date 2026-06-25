/**
 * void Worker — Hetzner Cloud API client
 *
 * Wraps the Hetzner Cloud API for creating/destroying servers.
 * Requires HETZNER_TOKEN with read+write permissions.
 *
 * API docs: https://docs.hetzner.cloud/
 */

const HETZNER_API = "https://api.hetzner.cloud/v1";

export interface HetznerServer {
	id: number;
	name: string;
	status: string;
	created: string;
	public_net: {
		ipv4: { ip: string | null };
		ipv6: { ip: string | null };
	};
	server_type: { name: string };
	datacenter: { name: string; location: { name: string } };
	image: { name: string };
}

interface HetznerCreateResponse {
	server: HetznerServer;
	root_password: string | null;
	next_actions: any[];
	error?: { code: string; message: string };
}

function authHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};
}

async function hcloudFetch<T>(
	path: string,
	init: RequestInit & { token: string },
): Promise<T> {
	const { token, ...rest } = init;
	const resp = await fetch(`${HETZNER_API}${path}`, {
		...rest,
		headers: { ...authHeaders(token), ...(rest.headers || {}) },
	});
	const body = (await resp.json()) as T & { error?: { code: string; message: string } };
	if ((body as any).error) {
		throw new Error(
			`Hetzner API error: ${(body as any).error.code} — ${(body as any).error.message}`,
		);
	}
	if (!resp.ok) {
		throw new Error(`Hetzner API HTTP ${resp.status} on ${path}`);
	}
	return body;
}

/**
 * Build the cloud-init user_data script that bootstraps a void-agent.
 * Installs cloudflared + downloads agent binary + registers it as a systemd service.
 *
 * Parameters:
 *  - server_id: pre-generated ULID
 *  - setup_token: one-time token for first registration
 *  - api_base: Worker URL the agent should connect to (wss://...)
 *  - github_release_url: full URL to the agent binary tarball/zip on GitHub releases
 *  - github_release_tag: tag name (e.g. v0.1.0)
 */
export function buildCloudInit(args: {
	server_id: string;
	setup_token: string;
	api_base: string;
	github_release_tag: string;
}): string {
	const { server_id, setup_token, api_base, github_release_tag } = args;
	// GitHub release asset URL — adjust if agent binary name differs
	const arch = "$(uname -m | sed 's/x86_64/x86_64/;s/aarch64/aarch64/')";
	const agent_url = `https://github.com/void-sh/void/releases/download/${github_release_tag}/void-agent-linux-${arch}.tar.gz`;

	return `#!/bin/bash
set -e
exec > >(tee -a /var/log/void-bootstrap.log) 2>&1
echo "=== void-agent bootstrap starting at $(date) ==="

# State dir
mkdir -p /var/lib/void /etc/void
echo "state dir ready"

# Install cloudflared
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
  CFD_ARCH="amd64"
elif [ "$ARCH" = "aarch64" ]; then
  CFD_ARCH="arm64"
else
  echo "unsupported arch: $ARCH"
  exit 1
fi
curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-\${CFD_ARCH}" \\
  -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
echo "cloudflared installed: $(/usr/local/bin/cloudflared --version 2>&1 | head -1)"

# Install void-agent
cd /tmp
curl -fsSL "${agent_url}" -o void-agent.tar.gz
tar -xzf void-agent.tar.gz
mv void-agent /usr/local/bin/void-agent
chmod +x /usr/local/bin/void-agent
echo "void-agent installed: $(/usr/local/bin/void-agent --version 2>&1 | head -1)"

# Write config
cat > /etc/void/config.toml <<EOF
server_id = "${server_id}"
setup_token = "${setup_token}"
api_base = "${api_base}"
state_dir = "/var/lib/void"
public_url_template = "https://pr-{deployment_id}.void.example.com"
EOF
echo "config written"

# Install systemd service
cat > /etc/systemd/system/void-agent.service <<EOF
[Unit]
Description=void agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/void-agent
Restart=always
RestartSec=5
EnvironmentFile=-/etc/void/config.toml
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
echo "systemd unit written"

systemctl daemon-reload
systemctl enable --now void-agent.service
echo "void-agent service started"

echo "=== void-agent bootstrap complete at $(date) ==="
`;
}

/**
 * Create a new Hetzner server with the given cloud-init script.
 */
export async function createServer(
	token: string,
	args: {
		name: string;
		server_type: string; // "cx22", "cx32", etc
		image: string; // "ubuntu-24.04"
		location: string; // "fsn1", "nbg1", etc
		user_data: string;
	},
): Promise<HetznerServer> {
	const result = await hcloudFetch<HetznerCreateResponse>(
		"/servers",
		{
			token,
			method: "POST",
			body: JSON.stringify({
				name: args.name,
				server_type: args.server_type,
				image: args.image,
				location: args.location,
				user_data: args.user_data,
				start_after_create: true,
			}),
		},
	);
	return result.server;
}

/**
 * Get a server by ID.
 */
export async function getServer(
	token: string,
	id: number,
): Promise<HetznerServer> {
	const result = await hcloudFetch<{ server: HetznerServer }>(`/servers/${id}`, {
		token,
		method: "GET",
	});
	return result.server;
}

/**
 * Delete a server (and its disks, etc).
 */
export async function deleteServer(token: string, id: number): Promise<void> {
	await hcloudFetch<unknown>(`/servers/${id}`, { token, method: "DELETE" });
}

/**
 * List all servers (optionally filtered by name).
 */
export async function listServers(token: string, namePrefix?: string): Promise<HetznerServer[]> {
	const url = namePrefix
		? `/servers?name=${encodeURIComponent(namePrefix)}`
		: "/servers";
	const result = await hcloudFetch<{ servers: HetznerServer[] }>(url, { token, method: "GET" });
	return result.servers || [];
}
