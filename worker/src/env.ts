/**
 * void Worker — env interface
 */

export interface Env {
	// Bindings
	void_db: D1Database;
	ROUTES: KVNamespace;
	void_builds: R2Bucket;

	// Secrets (set via wrangler secret put or via wizard)
	COOKIE_SECRET?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	CF_API_TOKEN?: string;
	CF_ACCOUNT_ID?: string;
	CF_ZONE_ID?: string;
	GITHUB_APP_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
	GITHUB_WEBHOOK_SECRET?: string;
	AGENT_SHARED_SECRET?: string; // used to sign WS challenges

	// Durable Objects
	void_cell: DurableObjectNamespace;
}
