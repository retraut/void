/**
 * void Worker — per-user provider credentials
 *
 * Stores encrypted API tokens (Hetzner, etc.) in D1, one row per
 * (user_id, provider). Tokens are encrypted at rest with AES-256-GCM
 * using the same key as tunnel_token (ENCRYPTION_KEY > COOKIE_SECRET).
 *
 * Used by MCP tools (void_create_server) and future features that
 * need to act on the user's behalf on the provider.
 */

import type { Env } from "./env";
import { encrypt, decrypt } from "./crypto";

export type Provider = "hetzner";

/**
 * Look up a user's token for a provider. Returns the decrypted token
 * or null if the user has not provided one. Falls back to the worker's
 * env (e.g. HETZNER_TOKEN) for backwards compatibility with self-hosted
 * setups where there's only one shared credential.
 */
export async function getProviderToken(
	env: Env,
	userId: string,
	provider: Provider,
): Promise<string | null> {
	const row = await env.void_db
		.prepare(
			"SELECT encrypted_token FROM provider_credentials WHERE user_id = ? AND provider = ?",
		)
		.bind(userId, provider)
		.first<{ encrypted_token: string }>();

	if (row) {
		const key = env.ENCRYPTION_KEY || env.COOKIE_SECRET;
		if (!key) return null;
		return await decrypt(key, row.encrypted_token);
	}

	// Fallback to env (for self-hosted single-tenant deployments).
	// New users will be guided to add their own credential in /settings.
	if (provider === "hetzner" && env.HETZNER_TOKEN) return env.HETZNER_TOKEN;
	return null;
}

/**
 * Save (or update) a user's token for a provider. Encrypts before write.
 */
export async function setProviderToken(
	env: Env,
	userId: string,
	provider: Provider,
	token: string,
): Promise<void> {
	const key = env.ENCRYPTION_KEY || env.COOKIE_SECRET;
	if (!key) throw new Error("ENCRYPTION_KEY (or COOKIE_SECRET) not configured");
	const encrypted = await encrypt(key, token);
	const id = `cred_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const now = Math.floor(Date.now() / 1000);
	await env.void_db
		.prepare(
			`INSERT INTO provider_credentials (id, user_id, provider, encrypted_token, created_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, provider) DO UPDATE SET
			   encrypted_token = excluded.encrypted_token,
			   created_at      = excluded.created_at`,
		)
		.bind(id, userId, provider, encrypted, now)
		.run();
}

/**
 * Remove a user's token for a provider.
 */
export async function deleteProviderToken(
	env: Env,
	userId: string,
	provider: Provider,
): Promise<void> {
	await env.void_db
		.prepare("DELETE FROM provider_credentials WHERE user_id = ? AND provider = ?")
		.bind(userId, provider)
		.run();
}

/**
 * List which providers the user has configured (without exposing tokens).
 */
export async function listProviderCredentials(
	env: Env,
	userId: string,
): Promise<Array<{ provider: Provider; created_at: number; is_own: boolean }>> {
	const rows = await env.void_db
		.prepare(
			"SELECT provider, created_at FROM provider_credentials WHERE user_id = ? ORDER BY created_at DESC",
		)
		.bind(userId)
		.all<{ provider: string; created_at: number }>();
	return rows.results.map((r) => ({
		provider: r.provider as Provider,
		created_at: r.created_at,
		is_own: true,
	}));
}
