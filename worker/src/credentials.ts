/**
 * void Worker — per-user provider credentials
 *
 * Stores encrypted API tokens (Hetzner, etc.) in D1, one row per
 * (project_id, provider). Tokens encrypted with AES-256-GCM using
 * ENCRYPTION_KEY (or legacy COOKIE_SECRET).
 */

import type { Env } from "./env";
import { encrypt, decrypt } from "./crypto";

export type Provider = "hetzner" | "cloudflare";

/**
 * Look up a user's token for a provider. Returns the decrypted token
 * or null if the user has not provided one. Falls back to env
 * HETZNER_TOKEN for backwards compatibility with self-hosted setups
 * where there's only one shared credential.
 */
export async function getProviderToken(
	env: Env,
	userId: string,
	provider: Provider,
	projectId: string,
): Promise<string | null> {
	const row = await env.void_db
		.prepare(
			"SELECT encrypted_token FROM provider_credentials WHERE user_id = ? AND project_id = ? AND provider = ?",
		)
		.bind(userId, projectId, provider)
		.first<{ encrypted_token: string }>();

	if (row) {
		const key = env.ENCRYPTION_KEY || env.COOKIE_SECRET;
		if (!key) return null;
		return await decrypt(key, row.encrypted_token);
	}

	// Fallback to env (for self-hosted single-tenant deployments).
	if (provider === "hetzner" && env.HETZNER_TOKEN) return env.HETZNER_TOKEN;
	if (provider === "cloudflare" && env.CF_API_TOKEN) return env.CF_API_TOKEN;
	return null;
}

export async function verifyCloudflareToken(
	token: string,
): Promise<{ ok: boolean; reason?: string; zones?: number }> {
	try {
		const verify = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
			headers: { Authorization: `Bearer ${token}` },
		});
		const verification = await verify.json() as { success?: boolean; errors?: Array<{ message: string }> };
		if (!verify.ok || !verification.success) {
			return { ok: false, reason: verification.errors?.map((error) => error.message).join(", ") || "Cloudflare rejected the token" };
		}
		const zonesResponse = await fetch("https://api.cloudflare.com/client/v4/zones?per_page=50", {
			headers: { Authorization: `Bearer ${token}` },
		});
		const zones = await zonesResponse.json() as { success?: boolean; result?: Array<unknown>; errors?: Array<{ message: string }> };
		if (!zonesResponse.ok || !zones.success) {
			return { ok: false, reason: zones.errors?.map((error) => error.message).join(", ") || "Token cannot read Cloudflare zones" };
		}
		return { ok: true, zones: zones.result?.length ?? 0 };
	} catch (error) {
		return { ok: false, reason: `Network error contacting Cloudflare: ${(error as Error).message}` };
	}
}

/**
 * Verify a Hetzner API token by making a read-only call to the
 * /datacenters endpoint. Returns {ok: true} for a 200 response, or
 * {ok: false, reason: '...'} for any failure (401 unauthorized, network
 * error, etc). Used before saving the token to ensure it's actually
 * valid, not just well-formed.
 */
export async function verifyHetznerToken(
	token: string,
): Promise<{ ok: boolean; reason?: string; datacenters?: number }> {
	try {
		const resp = await fetch("https://api.hetzner.cloud/v1/datacenters", {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (resp.status === 200) {
			const body = (await resp.json()) as { datacenters?: Array<unknown> };
			return { ok: true, datacenters: body.datacenters?.length ?? 0 };
		}
		if (resp.status === 401 || resp.status === 403) {
			return { ok: false, reason: "Token rejected by Hetzner (401 Unauthorized) — check the token has read+write scope" };
		}
		return { ok: false, reason: `Hetzner returned HTTP ${resp.status}` };
	} catch (e) {
		return { ok: false, reason: `Network error contacting Hetzner: ${(e as Error).message}` };
	}
}

/**
 * Save (or update) a user's token for a provider. Encrypts before write.
 * Stores the verified datacenters count (if available) so the UI can
 * show "Token saved — N datacenters reachable" without re-verifying.
 */
export async function setProviderToken(
	env: Env,
	userId: string,
	provider: Provider,
	token: string,
	projectId: string,
	verifiedDatacenters?: number,
	metadata?: Record<string, unknown>,
): Promise<void> {
	const key = env.ENCRYPTION_KEY || env.COOKIE_SECRET;
	if (!key) throw new Error("ENCRYPTION_KEY (or COOKIE_SECRET) not configured");
	const encrypted = await encrypt(key, token);
	const id = `cred_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const now = Math.floor(Date.now() / 1000);
	await env.void_db
		.prepare(
			`INSERT INTO provider_credentials (id, user_id, project_id, provider, encrypted_token, verified_datacenters, metadata_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(project_id, provider) DO UPDATE SET
			   user_id = excluded.user_id,
			   encrypted_token = excluded.encrypted_token,
			   verified_datacenters = excluded.verified_datacenters,
			   metadata_json = excluded.metadata_json,
			   created_at      = excluded.created_at`,
		)
		.bind(id, userId, projectId, provider, encrypted, verifiedDatacenters ?? null, metadata ? JSON.stringify(metadata) : null, now)
		.run();
}

/**
 * Remove a user's token for a provider.
 */
export async function deleteProviderToken(
	env: Env,
	userId: string,
	provider: Provider,
	projectId: string,
): Promise<void> {
	await env.void_db
		.prepare("DELETE FROM provider_credentials WHERE user_id = ? AND project_id = ? AND provider = ?")
		.bind(userId, projectId, provider)
		.run();
}

/**
 * List which providers the user has configured (without exposing tokens).
 */
export async function listProviderCredentials(
	env: Env,
	userId: string,
	projectId: string,
): Promise<Array<{ provider: Provider; created_at: number; verified_datacenters: number | null }>> {
	const rows = await env.void_db
		.prepare(
			"SELECT provider, created_at, verified_datacenters FROM provider_credentials WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC",
		)
		.bind(userId, projectId)
		.all<{ provider: string; created_at: number; verified_datacenters: number | null }>();
	return rows.results.map((r) => ({
		provider: r.provider as Provider,
		created_at: r.created_at,
		verified_datacenters: r.verified_datacenters,
	}));
}
