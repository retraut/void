/**
 * void Worker — env interface
 */

export interface Env {
	// Bindings
	void_db: D1Database;
	ROUTES: KVNamespace;
	void_builds: R2Bucket;

	// Secrets (set via wrangler secret put or via wizard)
	COOKIE_SECRET?: string; // session cookie HMAC key
	ENCRYPTION_KEY?: string; // 32-byte secret for AES-256-GCM of tunnel tokens
	VOID_BEARER_TOKEN?: string; // required on /api/* and /mcp
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;

	// Local-dev only. When set to "1" (or "true"), exposes a
	// /api/auth/dev-login route that creates a session without
	// going through GitHub OAuth — useful for the test-lab where
	// you don't have a real domain to register as the OAuth
	// callback. NEVER set in production.
	VOID_DEV_AUTH?: string;
	CF_API_TOKEN?: string;
	CF_ACCOUNT_ID?: string;
	CF_ZONE_ID?: string;
	GITHUB_APP_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
	GITHUB_WEBHOOK_SECRET?: string;
	HETZNER_TOKEN?: string;
	VOID_AGENT_RELEASE_TAG?: string; // e.g. "v0.1.0" — pin agent version
	AGENT_SHARED_SECRET?: string; // HMAC for deploy frames + WS challenge-response

	// Durable Objects
	void_cell: DurableObjectNamespace;
}
