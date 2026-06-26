/**
 * System settings — operator-managed secrets stored in the panel.
 *
 * The deploy workflow only ships the OAuth secrets (GITHUB_CLIENT_ID
 * and GITHUB_CLIENT_SECRET) at deploy time. Everything else — Hetzner
 * tokens, Cloudflare API tokens, GitHub App creds, the agent HMAC key,
 * the session cookie signer, the D1 encryption key — is configured
 * post-deploy via the /settings page and stored encrypted in D1.
 *
 * At runtime, `getSystemToken(env, key)` looks up the value in D1
 * first, then falls back to the env var. This lets the operator
 * override anything via the UI without redeploying.
 */

import type { Env } from "./env";
import { encrypt, decrypt, getEncryptionKey } from "./crypto";

export interface SystemKeyMeta {
	key: string;
	label: string;
	description: string;
	envVar: string;
	placeholder: string;
	textarea?: boolean;
	warning?: string;
}

/**
 * All system-managed keys. The UI in /settings reads this list to
 * render forms; the worker calls `getSystemToken(env, key)` to read.
 * Adding a new key: add it here, add a form in ui.ts, add a route
 * in index.ts, and update any caller that previously read env.X
 * directly.
 */
export const SYSTEM_KEYS = [
	{
		key: "hetzner_token",
		label: "Hetzner Cloud API token",
		description: "Used to provision Hetzner Cloud VMs. Per-user tokens in /settings → Cloud providers override this default.",
		envVar: "HETZNER_TOKEN",
		placeholder: "hcloud_xxxxxxxxxxxxxxxx",
	},
	{
		key: "cf_api_token",
		label: "Cloudflare API token",
		description: "Used to create Cloudflare Tunnels and DNS records. Needs Zone:DNS:Edit and Account:Cloudflare Tunnel:Edit scopes.",
		envVar: "CF_API_TOKEN",
		placeholder: "your-cloudflare-api-token",
	},
	{
		key: "cf_account_id",
		label: "Cloudflare account ID",
		description: "Numeric ID of the Cloudflare account where tunnels and DNS records will be created.",
		envVar: "CF_ACCOUNT_ID",
		placeholder: "1234567890abcdef",
	},
	{
		key: "cf_zone_id",
		label: "Cloudflare zone ID",
		description: "DNS zone where the worker adds `pr-<id>.void.example.com` records.",
		envVar: "CF_ZONE_ID",
		placeholder: "abcdef1234567890",
	},
	{
		key: "github_webhook_secret",
		label: "GitHub webhook secret",
		description: "HMAC secret used to verify GitHub webhook deliveries (X-Hub-Signature-256).",
		envVar: "GITHUB_WEBHOOK_SECRET",
		placeholder: "any-random-string",
	},
	{
		key: "github_app_id",
		label: "GitHub App ID",
		description: "Numeric ID of the GitHub App used for repo access (optional — leave unset if you only use OAuth).",
		envVar: "GITHUB_APP_ID",
		placeholder: "123456",
	},
	{
		key: "github_app_private_key",
		label: "GitHub App private key",
		description: "PEM-encoded private key for the GitHub App. Multiline. Newlines are accepted as-is.",
		envVar: "GITHUB_APP_PRIVATE_KEY",
		placeholder: "-----BEGIN RSA PRIVATE KEY-----\n...",
		textarea: true,
	},
	{
		key: "agent_shared_secret",
		label: "Agent shared secret (HMAC)",
		description: "Used to sign deploy / teardown / ping frames sent to the void-agent. Must match the one baked into the agent binary at build time.",
		envVar: "AGENT_SHARED_SECRET",
		placeholder: "any-random-string",
	},
	{
		key: "void_bearer_token",
		label: "Bearer token (/api/* and /mcp auth)",
		description: "Required for all /api/* and /mcp requests. Set with `openssl rand -hex 32`.",
		envVar: "VOID_BEARER_TOKEN",
		placeholder: "64-hex-char-token",
	},
	{
		key: "encrypt_key",
		label: "D1 encryption key (AES-256-GCM)",
		description: "Encrypts tunnel tokens stored in D1. If you change this, all previously encrypted data becomes unreadable. 32 bytes recommended.",
		envVar: "ENCRYPTION_KEY",
		placeholder: "32-byte-key",
		warning: "Changing this invalidates all encrypted data in D1.",
	},
	{
		key: "cookie_secret",
		label: "Session cookie signer (HMAC)",
		description: "Signs and verifies the __Host-void_session cookie. Changing this logs all users out.",
		envVar: "COOKIE_SECRET",
		placeholder: "any-random-32+-char-string",
		warning: "Changing this logs all users out.",
	},
];

export type SystemKey = (typeof SYSTEM_KEYS)[number]["key"];

/**
 * Look up a system token. Tries the D1 panel-set value first, then
 * falls back to the env var. Returns null if neither is set.
 */
export async function getSystemToken(env: Env, key: SystemKey): Promise<string | null> {
	// 1. D1 (panel-set)
	const row = await env.void_db
		.prepare("SELECT encrypted_value FROM system_settings WHERE key = ?")
		.bind(key)
		.first<{ encrypted_value: string }>();
	if (row) {
		try {
			const k = getEncryptionKey(env);
			return await decrypt(k, row.encrypted_value);
		} catch {
			// Fall through to env if decryption fails (key rotation etc.)
		}
	}
	// 2. Env fallback
	const envMap: Record<SystemKey, string | undefined> = {
		hetzner_token: env.HETZNER_TOKEN,
		cf_api_token: env.CF_API_TOKEN,
		cf_account_id: env.CF_ACCOUNT_ID,
		cf_zone_id: env.CF_ZONE_ID,
		github_webhook_secret: env.GITHUB_WEBHOOK_SECRET,
		github_app_id: env.GITHUB_APP_ID,
		github_app_private_key: env.GITHUB_APP_PRIVATE_KEY,
		agent_shared_secret: env.AGENT_SHARED_SECRET,
		void_bearer_token: env.VOID_BEARER_TOKEN,
		encrypt_key: env.ENCRYPTION_KEY,
		cookie_secret: env.COOKIE_SECRET,
	};
	return envMap[key] || null;
}

/**
 * Set (or overwrite) a system token. Encrypts with ENCRYPTION_KEY before
 * writing to D1. Pass an empty string to clear.
 */
export async function setSystemToken(env: Env, key: SystemKey, value: string): Promise<void> {
	if (value === "") {
		return deleteSystemToken(env, key);
	}
	const k = getEncryptionKey(env);
	const encrypted = await encrypt(k, value);
	const now = Math.floor(Date.now() / 1000);
	await env.void_db
		.prepare(
			`INSERT INTO system_settings (key, encrypted_value, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET
			   encrypted_value = excluded.encrypted_value,
			   updated_at = excluded.updated_at`,
		)
		.bind(key, encrypted, now)
		.run();
}

/**
 * Clear a system token (revert to env fallback).
 */
export async function deleteSystemToken(env: Env, key: SystemKey): Promise<void> {
	await env.void_db
		.prepare("DELETE FROM system_settings WHERE key = ?")
		.bind(key)
		.run();
}

/**
 * List all currently-overridden system tokens (for the /settings UI).
 * Returns the set of keys that are set in D1 (env-only ones are
 * invisible to the UI — operator can't see them, but they're still
 * used as fallbacks).
 */
export async function listOverriddenSystemTokens(env: Env): Promise<Set<SystemKey>> {
	const { results } = await env.void_db
		.prepare("SELECT key FROM system_settings")
		.all<{ key: string }>();
	return new Set(results.map((r) => r.key as SystemKey));
}
