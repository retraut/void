/**
 * void Worker — main entry
 */

import { Env } from "./env";
import { ensureSchema } from "./db";
import { VoidCell } from "./void-cell";
import { handleMcp } from "./mcp";
import { handleGitHubWebhook } from "./webhook";

export { VoidCell };

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Run schema migrations synchronously on first call (idempotent after).
		// Doing this inline (not via waitUntil) ensures the migration has
		// completed before we try to query the new columns.
		await ensureSchema(env.void_db);

		const url = new URL(request.url);
		const path = url.pathname;

		// CORS preflight (for browser-based MCP clients)
		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "GET, POST, OPTIONS",
					"access-control-allow-headers": "content-type, authorization, x-void-sig",
					"access-control-max-age": "86400",
				},
			});
		}

		const corsHeaders = {
			"access-control-allow-origin": "*",
		};

		// Cell routes: WS upgrade OR HTTP /cell/:id/{logs,status,send-deploy}
		if (path.startsWith("/cell/")) {
			const parts = path.slice("/cell/".length).split("/");
			const serverId = parts[0];
			if (!serverId) {
				return new Response("Missing server_id", { status: 400 });
			}
			const cellId = env.void_cell.idFromName(serverId);
			const cellStub = env.void_cell.get(cellId);
			// Rewrite path to internal cell namespace so the DO can route it
			const subPath = "/" + parts.slice(1).join("/") + url.search;
			const internalUrl = new URL("https://cell" + subPath);
			const newRequest = new Request(internalUrl.toString(), request);
			return cellStub.fetch(newRequest);
		}

		// MCP endpoint
		if (path === "/mcp") {
			const resp = await handleMcp(request, env);
			// add CORS headers
			for (const [k, v] of Object.entries(corsHeaders)) {
				resp.headers.set(k, v);
			}
			return resp;
		}

		// Health
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
					do: !!env.void_cell,
				},
				features: {
					github_webhook: !!env.GITHUB_WEBHOOK_SECRET,
					cf_tunnel: !!env.CF_API_TOKEN,
				},
			});
		}

		// API
		if (path === "/api") {
			return json({
				endpoints: [
					"GET /, /health",
					"POST /mcp (MCP Streamable HTTP)",
					"WS /cell/:server_id (agent)",
					"GET /api/servers",
					"POST /api/servers (create stub)",
					"GET /api/cell/:server_id/status",
					"POST /api/webhooks/github (git push → auto-deploy)",
				],
			});
		}

		// GitHub webhook
		if (path === "/api/webhooks/github" && request.method === "POST") {
			return handleGitHubWebhook(request, env);
		}

		// Direct REST wrappers around MCP tools (for curl / scripts)
		if (path === "/api/servers" && request.method === "GET") {
			const { results } = await env.void_db
				.prepare("SELECT id, name, provider, status, region, size, last_seen_at FROM servers ORDER BY created_at DESC")
				.all();
			return json({ servers: results });
		}

		if (path === "/api/cell/:server_id/status" || path.startsWith("/api/cell/")) {
			const m = path.match(/^\/api\/cell\/([^/]+)\/status$/);
			if (m) {
				const cellId = env.void_cell.idFromName(m[1]);
				const cellStub = env.void_cell.get(cellId);
				return cellStub.fetch("https://cell/status");
			}
		}

		return json({ error: "Not found", path }, 404);
	},
} satisfies ExportedHandler<Env>;
