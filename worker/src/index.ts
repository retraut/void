/**
 * void — control plane Worker
 *
 * Edge-driven, MCP-native, self-hosted PaaS.
 * See docs/SPEC.md for the full technical specification.
 */

export interface Env {
	void_db: D1Database;
	ROUTES: KVNamespace;
	void_builds: R2Bucket;
	COOKIE_SECRET?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	CF_API_TOKEN?: string;
	CF_ACCOUNT_ID?: string;
	CF_ZONE_ID?: string;
	GITHUB_APP_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
	GITHUB_WEBHOOK_SECRET?: string;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// Health check / landing
		if (path === "/" || path === "/health") {
			return json({
				name: "void",
				version: "0.1.0",
				status: "alive",
				message: "Vercel DX. Hetzner bill. No SSH.",
				docs: "https://github.com/retraut/void/blob/main/docs/SPEC.md",
				bindings: {
					d1: !!env.void_db,
					kv: !!env.ROUTES,
					r2: !!env.void_builds,
				},
			});
		}

		// API root
		if (path === "/api") {
			return json({
				endpoints: [
					"GET /",
					"GET /health",
					"POST /mcp (MCP Streamable HTTP — coming in v0.1)",
					"POST /api/webhooks/github (GitHub webhook — coming in v0.1)",
				],
			});
		}

		// MCP endpoint placeholder
		if (path === "/mcp" && request.method === "POST") {
			return json(
				{
					jsonrpc: "2.0",
					error: { code: -32601, message: "MCP not yet implemented (v0.1 in progress)" },
					id: null,
				},
				501
			);
		}

		// 404
		return json({ error: "Not found", path }, 404);
	},
} satisfies ExportedHandler<Env>;
