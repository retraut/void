/**
 * void Worker — Hetzner Cloud API client
 *
 * Wraps the Hetzner Cloud API for creating/destroying servers and
 * fetching the catalog (server types, locations, images).
 * Requires HETZNER_TOKEN with read+write permissions.
 *
 * API docs: https://docs.hetzner.cloud/
 */

import type { Env } from "./env";

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
	server_type: {
		name: string;
		description?: string;
		cores?: number;
		memory?: number; // GB
		disk?: number; // GB
		storage_type?: "local" | "network";
		cpu_type?: "shared" | "dedicated";
		architecture?: "x86" | "arm";
	};
	datacenter: { name: string; location: { name: string } };
	image: { name: string };
}

export interface HetznerServerTypeLocation {
	id: number;
	name: string;
	deprecation: { unavailable_after: string; announced: string } | null;
	recommended: boolean;
	available: boolean;
}

export interface HetznerServerType {
	id: number;
	name: string;
	description: string;
	cores: number;
	memory: number; // GB
	disk: number; // GB
	storage_type: "local" | "network";
	cpu_type: "shared" | "dedicated";
	architecture: "x86" | "arm";
	deprecated: boolean;
	category: string | null;
	// Cheap monthly price (net, in EUR) — taken from prices[0] for sorting
	price_monthly: number;
	// Monthly price in the user's preferred location (if known) — for display
	price_display: string;
	// Locations where this type is CURRENTLY available (real-time
	// inventory from `server_types.locations[].available`). Drives the
	// form's location → type filtering. The old way was
	// `prices[].location` which only told us where the type has pricing
	// (i.e. "supported") — not where it's actually orderable right now.
	// Per the Hetzner OpenAPI spec, the /datacenters.server_types
	// field is deprecated and the new authoritative source is
	// `server_types.locations[].available`.
	available_locations: string[];
}

export interface HetznerLocation {
	id: number;
	name: string;
	description: string;
	country: string;
	city: string;
	network_zone: "eu-central" | "us-east" | "us-west" | "ap-southeast";
}

export interface HetznerImage {
	id: number;
	name: string;
	description: string;
	type: "system" | "snapshot" | "backup";
	os_flavor: "ubuntu" | "centos" | "debian" | "fedora" | "rocky" | "alma" | "opensuse" | "arch" | "unknown";
	os_version: string | null;
	architecture: "x86" | "arm";
	status: "available" | "creating" | "deleted";
	rapid_deploy: boolean;
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
 * KV cache TTL for the Hetzner catalog. 5 min for /server_types
 * (availability is real-time inventory — 5 min is a good trade-off
 * between freshness and rate-limit safety), 1h for the rest
 * (locations/images rarely change). Override via
 * `HETZNER_CATALOG_TTL_SECONDS` env for self-hosted deployments.
 */
const CATALOG_TTL_SECONDS =
	parseInt((globalThis as any).process?.env?.HETZNER_CATALOG_TTL_SECONDS || "") ||
	60 * 60; // 1h default

/**
 * Server-types cache is shorter — `locations[].available` is real-time
 * inventory, so a stale cache shows types that just sold out as
 * "available" and vice versa.
 */
const SERVER_TYPES_TTL_SECONDS =
	parseInt((globalThis as any).process?.env?.HETZNER_TYPES_TTL_SECONDS || "") ||
	5 * 60; // 5 min default

/**
 * Cached wrapper around any Hetzner GET. Key includes a short hash
 * of the token so different users (with different tokens) cache
 * independently. (In practice the catalog is the same for all valid
 * tokens, but this avoids cross-tenant surprises if Hetzner ever
 * rolls out per-account custom pricing.)
 */
async function cachedFetch<T>(
	env: Env,
	cacheKey: string,
	token: string,
	path: string,
	ttlSeconds: number = CATALOG_TTL_SECONDS,
): Promise<T> {
	const fullKey = `hetzner:${cacheKey}:${tokenHash(token)}`;
	const cached = await env.ROUTES.get(fullKey, "json");
	if (cached) return cached as T;
	const fresh = await hcloudFetch<T>(path, { token, method: "GET" });
	await env.ROUTES.put(fullKey, JSON.stringify(fresh), { expirationTtl: ttlSeconds });
	return fresh;
}

function tokenHash(token: string): string {
	// Short, non-reversible fingerprint. We don't store the token,
	// just enough to disambiguate cache entries.
	let h = 5381;
	for (let i = 0; i < token.length; i++) h = ((h << 5) + h) ^ token.charCodeAt(i);
	return ("00000000" + (h >>> 0).toString(16)).slice(-8);
}

/**
 * Invalidate all cached catalog entries for a given token. Called when
 * the user clicks "Refresh catalog" on the new-server form, or after
 * a 401 (token revoked) so the next fetch re-verifies.
 */
export async function invalidateCatalogCache(env: Env, token: string): Promise<void> {
	const h = tokenHash(token);
	await Promise.all([
		env.ROUTES.delete(`hetzner:server_types:${h}`),
		env.ROUTES.delete(`hetzner:locations:${h}`),
		env.ROUTES.delete(`hetzner:images_x86:${h}`),
		env.ROUTES.delete(`hetzner:projects:${h}`),
	]);
}

/**
 * List available Hetzner server types (sizes). Filtered to non-deprecated
 * and x86 architecture (the void agent is x86_64 only). Returns the
 * cheapest monthly price for each type, suitable for display, and
 * the list of locations where the type is CURRENTLY available
 * (real-time inventory from `locations[].available`, not just
 * "supported" via `prices[].location`).
 */
export async function listServerTypes(env: Env, token: string): Promise<HetznerServerType[]> {
	const raw = await cachedFetch<{
		server_types: Array<{
			id: number;
			name: string;
			description: string;
			cores: number;
			memory: number;
			disk: number;
			storage_type: "local" | "network";
			cpu_type: "shared" | "dedicated";
			architecture: "x86" | "arm";
			deprecated: boolean;
			category: string | null;
			prices: Array<{ location: string; price_monthly: { net: string; gross: string } }>;
			locations: HetznerServerTypeLocation[];
		}>;
	}>(env, "server_types", token, "/server_types", SERVER_TYPES_TTL_SECONDS);
	return raw.server_types
		.filter((t) => !t.deprecated && t.architecture === "x86")
		.map((t) => {
			// Show the cheapest monthly net price across all locations
			const prices = t.prices.map((p) => parseFloat(p.price_monthly.net)).filter((n) => !isNaN(n));
			const min = prices.length ? Math.min(...prices) : 0;
			// REAL-TIME availability: only locations where the type is
			// currently orderable. This is what tells us "cpx11 is sold
			// out in nbg1 right now" vs the old `prices[].location` which
			// only said "cpx11 has pricing in nbg1".
			const available = (t.locations || [])
				.filter((loc) => loc.available && !loc.deprecation)
				.map((loc) => loc.name);
			return {
				id: t.id,
				name: t.name,
				description: t.description,
				cores: t.cores,
				memory: t.memory,
				disk: t.disk,
				storage_type: t.storage_type,
				cpu_type: t.cpu_type,
				architecture: t.architecture,
				deprecated: t.deprecated,
				category: t.category || null,
				price_monthly: min,
				price_display: `€${min.toFixed(2)}/mo`,
				available_locations: available,
			};
		})
		.sort((a, b) => a.price_monthly - b.price_monthly);
}

export async function listLocations(env: Env, token: string): Promise<HetznerLocation[]> {
	const resp = await cachedFetch<{ locations: HetznerLocation[] }>(
		env,
		"locations",
		token,
		"/locations",
	);
	return resp.locations || [];
}

export async function listImages(
	env: Env,
	token: string,
	opts: { architecture?: "x86" | "arm" } = {},
): Promise<HetznerImage[]> {
	const qs = new URLSearchParams({ type: "system" });
	if (opts.architecture) qs.set("architecture", opts.architecture);
	const resp = await cachedFetch<{ images: HetznerImage[] }>(
		env,
		"images_x86",
		token,
		`/images?${qs.toString()}`,
	);
	return (resp.images || [])
		.filter((i) => i.status === "available" && i.architecture === "x86")
		.sort((a, b) => {
			// Ubuntu first, then Debian, then others
			const rank = (img: HetznerImage) =>
				img.os_flavor === "ubuntu" ? 0 : img.os_flavor === "debian" ? 1 : 2;
			return rank(a) - rank(b) || a.name.localeCompare(b.name);
		});
}

export interface HetznerProject {
	id: number;
	name: string;
	created: string;
	// Aggregate stats returned alongside the project
	servers: number;
	load_balancers: number;
	volumes: number;
	primary_datacenter: { id: number; name: string; location: { name: string } } | null;
}

/**
 * List Hetzner Cloud projects the token has access to. Used to display
 * which project a server belongs to. Note: when creating a server, the
 * project is implicit (whatever the API token is scoped to) — there's
 * no way to pass project_id at create time.
 */
export async function listProjects(env: Env, token: string): Promise<HetznerProject[]> {
	const resp = await cachedFetch<{ projects: HetznerProject[] }>(
		env,
		"projects",
		token,
		"/projects",
	);
	return resp.projects || [];
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
