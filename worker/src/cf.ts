/**
 * void Worker — Cloudflare API client
 *
 * Wraps the CF REST API for managing tunnels and DNS records.
 * Requires CF_API_TOKEN with Account > Cloudflare Tunnel: Edit and Zone > DNS: Edit.
 */

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

interface CfResult<T> {
	success: boolean;
	result: T;
	errors: Array<{ code: number; message: string }>;
}

export interface TunnelInfo {
	id: string;
	token: string;
	name: string;
}

export interface DnsRecordInfo {
	id: string;
	name: string;
	content: string;
}

export interface ZoneInfo {
	id: string;
	name: string;
	status: string;
	paused: boolean;
	name_servers: string[];
}

export interface IngressRule {
	hostname?: string;
	service: string;
	originRequest?: Record<string, unknown>;
}

function authHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};
}

async function cfFetch<T>(
	path: string,
	init: RequestInit & { token: string },
): Promise<T> {
	const { token, ...rest } = init;
	const resp = await fetch(`${CF_API_BASE}${path}`, {
		...rest,
		headers: { ...authHeaders(token), ...(rest.headers || {}) },
	});
	const body = (await resp.json()) as CfResult<T>;
	if (!body.success) {
		throw new Error(
			`CF API ${path} failed: ${body.errors.map((e) => e.message).join(", ")}`,
		);
	}
	return body.result;
}

// ---------- Tunnels ----------

/**
 * Create a new remotely-managed tunnel for a server.
 * config_src: "cloudflare" means the Worker (us) manages ingress via API.
 */
export async function createTunnel(
	token: string,
	accountId: string,
	name: string,
): Promise<TunnelInfo> {
	const result = await cfFetch<{ id: string; name: string; token?: string }>(
		`/accounts/${accountId}/cfd_tunnel`,
		{
			token,
			method: "POST",
			body: JSON.stringify({ name, config_src: "cloudflare" }),
		},
	);
	if (!result.token) {
		throw new Error("CF API did not return a tunnel token");
	}
	return { id: result.id, name: result.name, token: result.token };
}

/**
 * Get the current tunnel config (ingress rules).
 */
export async function getTunnelConfig(
	token: string,
	accountId: string,
	tunnelId: string,
): Promise<{ ingress: IngressRule[] }> {
	return cfFetch<{ config: { ingress: IngressRule[] } }>(
		`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
		{ token, method: "GET" },
	).then((r) => ({ ingress: r.config?.ingress || [] }));
}

/**
 * Replace the tunnel's ingress config. Must include a catch-all rule at the end.
 * Idempotent: if hostname is already in the config, just update its service.
 */
export async function setTunnelIngress(
	token: string,
	accountId: string,
	tunnelId: string,
	ingress: IngressRule[],
): Promise<void> {
	await cfFetch<unknown>(
		`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
		{
			token,
			method: "PUT",
			body: JSON.stringify({ config: { ingress } }),
		},
	);
}

/**
 * Add or update a single ingress rule in the tunnel.
 * Always preserves the catch-all rule at the end.
 */
export async function upsertIngressRule(
	token: string,
	accountId: string,
	tunnelId: string,
	hostname: string,
	service: string,
): Promise<void> {
	const current = await getTunnelConfig(token, accountId, tunnelId);
	const filtered = current.ingress.filter(
		(r) => r.hostname !== hostname && r.service !== "http_status:404",
	);
	filtered.unshift({ hostname, service, originRequest: {} });
	filtered.push({ service: "http_status:404" });
	await setTunnelIngress(token, accountId, tunnelId, filtered);
}

/**
 * Remove a single ingress rule from the tunnel.
 */
export async function removeIngressRule(
	token: string,
	accountId: string,
	tunnelId: string,
	hostname: string,
): Promise<void> {
	const current = await getTunnelConfig(token, accountId, tunnelId);
	const filtered = current.ingress.filter(
		(r) => r.hostname !== hostname && r.service !== "http_status:404",
	);
	filtered.push({ service: "http_status:404" });
	await setTunnelIngress(token, accountId, tunnelId, filtered);
}

/**
 * Delete a tunnel (soft-delete; takes a few minutes to fully purge).
 */
export async function deleteTunnel(
	token: string,
	accountId: string,
	tunnelId: string,
): Promise<void> {
	await cfFetch<unknown>(`/accounts/${accountId}/cfd_tunnel/${tunnelId}`, {
		token,
		method: "DELETE",
	});
}

// ---------- DNS ----------

export async function listZones(token: string): Promise<ZoneInfo[]> {
	return await cfFetch<ZoneInfo[]>("/zones?per_page=50&order=name&direction=asc", {
		token,
		method: "GET",
	});
}

/**
 * Create a CNAME record pointing hostname → <tunnel_id>.cfargotunnel.com
 * Returns the record ID (needed for later deletion).
 */
export async function createDnsCname(
	token: string,
	zoneId: string,
	hostname: string,
	tunnelId: string,
): Promise<DnsRecordInfo> {
	const result = await cfFetch<{ id: string; name: string; content: string }>(
		`/zones/${zoneId}/dns_records`,
		{
			token,
			method: "POST",
			body: JSON.stringify({
				type: "CNAME",
				proxied: true,
				name: hostname,
				content: `${tunnelId}.cfargotunnel.com`,
			}),
		},
	);
	return { id: result.id, name: result.name, content: result.content };
}

export async function deleteDnsRecord(
	token: string,
	zoneId: string,
	recordId: string,
): Promise<void> {
	await cfFetch<unknown>(`/zones/${zoneId}/dns_records/${recordId}`, {
		token,
		method: "DELETE",
	});
}

/**
 * Find a DNS record by name (for cleanup when we don't have the ID).
 */
export async function findDnsRecord(
	token: string,
	zoneId: string,
	hostname: string,
): Promise<DnsRecordInfo | null> {
	const result = await cfFetch<Array<{ id: string; name: string; content: string }>>(
		`/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}&type=CNAME`,
		{ token, method: "GET" },
	);
	if (!result || result.length === 0) return null;
	return { id: result[0].id, name: result[0].name, content: result[0].content };
}
