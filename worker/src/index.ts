/**
 * void Worker — main entry
 */

import { Env } from "./env";
import { ensureSchema } from "./db";
import { VoidCell } from "./void-cell";
import { handleMcp } from "./mcp";
import { handleGitHubWebhook } from "./webhook";
import {
	getSessionUser,
	handleAuthStart,
	handleAuthCallback,
	handleAuthMe,
	handleAuthLogout,
	renderLandingHtml,
	requireBearer,
} from "./auth";
import {
	renderServersPage,
	renderProjectsPage,
	renderDeploymentsPage,
	renderDeploymentLogsPage,
} from "./ui";

export { VoidCell };

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Run schema migrations synchronously on first call (idempotent after).
		// Doing this inline (not via waitUntil) ensures the migration has
		// completed before we try to query the new columns.
		await ensureSchema(env.void_db);

		const url = new URL(request.url);
		const path = url.pathname;

		// CORS preflight: ONLY for /mcp (real cross-origin) and /health (public).
		// Other routes have NO CORS — they require same-origin or auth header.
		if (request.method === "OPTIONS" && (path === "/mcp" || path === "/health")) {
			return new Response(null, {
				status: 204,
				headers: {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "GET, POST, OPTIONS",
					"access-control-allow-headers": "content-type, authorization",
					"access-control-max-age": "86400",
				},
			});
		}

		// Cell routes: WS upgrade OR HTTP /cell/:id/{logs,status,send-deploy}
		if (path.startsWith("/cell/")) {
			const isWsUpgrade = request.headers.get("Upgrade") === "websocket";

			// WS upgrade: agent authenticates with setup_token in register frame (no bearer)
			// HTTP: require Bearer auth (called by MCP tools, browser SSE)
			if (!isWsUpgrade) {
				const authFail = requireBearer(env, request);
				if (authFail) return authFail;
			}

			const parts = path.slice("/cell/".length).split("/");
			const serverId = parts[0];
			if (!serverId) {
				return new Response("Missing server_id", { status: 400 });
			}
			const cellId = env.void_cell.idFromName(serverId);
			const cellStub = env.void_cell.get(cellId);
			const subPath = "/" + parts.slice(1).join("/") + url.search;
			const internalUrl = new URL("https://cell" + subPath);
			const newRequest = new Request(internalUrl.toString(), request);
			return cellStub.fetch(newRequest);
		}

		// MCP endpoint (requires Bearer auth)
		if (path === "/mcp") {
			const authFail = requireBearer(env, request);
			if (authFail) {
				// Add CORS headers to auth failure so browser-based clients can read it
				authFail.headers.set("access-control-allow-origin", "*");
				return authFail;
			}
			const resp = await handleMcp(request, env);
			resp.headers.set("access-control-allow-origin", "*");
			return resp;
		}

		// Health
		if (path === "/health") {
			return json({
				name: "void",
				version: "0.1.0",
				status: "alive",
				message: "Vercel DX. Hetzner bill. No SSH.",
				docs: "https://github.com/void-sh/void/blob/main/docs/SPEC.md",
				bindings: {
					d1: !!env.void_db,
					kv: !!env.ROUTES,
					r2: !!env.void_builds,
					do: !!env.void_cell,
				},
				features: {
					github_oauth: !!env.GITHUB_CLIENT_ID && !!env.GITHUB_CLIENT_SECRET,
					github_webhook: !!env.GITHUB_WEBHOOK_SECRET,
					cf_tunnel: !!env.CF_API_TOKEN,
					hetzner: !!env.HETZNER_TOKEN,
				},
			});
		}

		// Landing page (root)
		if (path === "/") {
			const user = await getSessionUser(env, request);
			const html = renderLandingHtml({
				user,
				installed: !!env.GITHUB_CLIENT_ID,
				cf_tunnel: !!env.CF_API_TOKEN,
				github_webhook: !!env.GITHUB_WEBHOOK_SECRET,
			});
			return new Response(html, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}

		// Auth routes
		if (path === "/api/auth/github" && request.method === "GET") {
			return handleAuthStart(request, env);
		}
		if (path === "/api/auth/callback" && request.method === "GET") {
			return handleAuthCallback(request, env);
		}
		if (path === "/api/auth/me" && request.method === "GET") {
			return handleAuthMe(request, env);
		}
		if (path === "/api/auth/logout" && request.method === "GET") {
			return handleAuthLogout(request, env);
		}

		// UI pages (require session cookie)
		if (path === "/servers") {
			const user = await getSessionUser(env, request);
			return renderServersPage(env, user);
		}
		// UI form action: rotate session token
		const rotateMatch = path.match(/^\/servers\/([^/]+)\/rotate-session$/);
		if (rotateMatch && request.method === "POST") {
			const user = await getSessionUser(env, request);
			if (!user) return new Response("Login required", { status: 401 });
			const serverId = rotateMatch[1];
			const cellId = env.void_cell.idFromName(serverId);
			const cellStub = env.void_cell.get(cellId);
			const resp = await cellStub.fetch(`https://cell/${serverId}/rotate-session`, { method: "POST" });
			const data: any = await resp.json();
			// Show a simple confirmation page
			return new Response(
				`<!doctype html><html><head><meta charset="UTF-8"><title>Session rotated · void</title>
				<style>body{font-family:-apple-system,sans-serif;background:#000;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;margin:0}
				.box{max-width:600px;background:#0a0a0a;border:1px solid #222;border-radius:12px;padding:32px}
				h1{font-size:1.5rem;margin-bottom:16px}
				code{background:#1a1a1a;padding:6px 10px;border-radius:6px;display:block;color:#0f0;font-family:ui-monospace,monospace;margin:8px 0;word-break:break-all}
				.warn{color:#f90;font-size:0.9rem;margin:16px 0;padding:12px;background:#1a0a00;border-radius:6px}
				a{color:#6cf;display:inline-block;margin-top:16px}</style></head>
				<body><div class="box">
				<h1>✓ Session token rotated for ${escapeHtml(serverId)}</h1>
				<p>New token:</p><code>${escapeHtml((data && data.session_token) || "(error)")}</code>
				<div class="warn">⚠ The agent has been disconnected. Update <code>&lt;state_dir&gt;/session_token</code> on the agent host with the new token, then restart the agent.</div>
				<a href="/servers">← Back to servers</a>
				</div></body></html>`,
				{ headers: { "content-type": "text/html; charset=utf-8" } },
			);
		}
		if (path === "/projects") {
			const user = await getSessionUser(env, request);
			return renderProjectsPage(env, user);
		}
		if (path === "/deployments" || path === "/deployments/") {
			const user = await getSessionUser(env, request);
			const projectFilter = url.searchParams.get("project");
			const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
			const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get("per_page") || "20", 10) || 20));
			return renderDeploymentsPage(env, user, projectFilter, page, perPage);
		}
		if (path.startsWith("/deployments/")) {
			const user = await getSessionUser(env, request);
			const id = path.slice("/deployments/".length);
			return renderDeploymentLogsPage(env, user, id);
		}

		// API
		if (path === "/api") {
			return json({
				endpoints: [
					"GET /  (landing page)",
					"GET /health",
					"POST /mcp (MCP Streamable HTTP)",
					"WS /cell/:server_id (agent)",
					"GET /api/servers",
					"POST /api/servers (real Hetzner or stub)",
					"GET /api/cell/:server_id/status",
					"POST /api/webhooks/github (git push → auto-deploy)",
					"GET /api/auth/github (OAuth start)",
					"GET /api/auth/callback (OAuth callback)",
					"GET /api/auth/me (current user)",
					"GET /api/auth/logout",
				],
			});
		}

		// GitHub webhook
		if (path === "/api/webhooks/github" && request.method === "POST") {
			return handleGitHubWebhook(request, env);
		}

		// All other /api/* and /api/cell/* require Bearer auth
		if (path.startsWith("/api/")) {
			const authFail = requireBearer(env, request);
			if (authFail) return authFail;
		}

		// Direct REST wrappers around MCP tools (for curl / scripts)
		if (path === "/api/servers" && request.method === "GET") {
			const { results } = await env.void_db
				.prepare("SELECT id, name, provider, status, region, size, last_seen_at FROM servers ORDER BY created_at DESC")
				.all();
			return json({ servers: results });
		}

		if (path === "/api/cell/:server_id/status" || path.startsWith("/api/cell/")) {
			const m = path.match(/^\/api\/cell\/([^/]+)\/([^/]+)$/);
			if (m) {
				const [, serverId, action] = m;
				const cellId = env.void_cell.idFromName(serverId);
				const cellStub = env.void_cell.get(cellId);
				if (action === "status") {
					return cellStub.fetch("https://cell/status");
				}
				if (action === "rotate-session" && request.method === "POST") {
					return cellStub.fetch(`https://cell/${serverId}/rotate-session`, { method: "POST" });
				}
			}
		}

		return json({ error: "Not found", path }, 404);
	},
} satisfies ExportedHandler<Env>;
