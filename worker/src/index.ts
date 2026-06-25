/**
 * void Worker — main entry
 *
 * Hono-based router. Old code was 262 lines of hand-rolled if/else with
 * `path.startsWith` / `path ===` / `path.match` mixed together. Now: a
 * flat route table at the top, middleware for cross-cutting concerns.
 *
 * Layered:
 *   1. CORS preflight (cors middleware on /mcp, /health)
 *   2. Bearer auth on /api/* (except /api/auth/*, /api/webhooks/*)
 *   3. DO forwarding on /cell/* and /api/cell/*
 *   4. Route handlers
 *
 * Notes:
 *   - security.ts (validateRef / validateRepoUrl / validateShellCommand) is
 *     STILL the source of truth for security validation. We don't use
 *     zValidator because shell command security is allowlist-based, not
 *     shape-based. See docs/HONO.md for the rationale.
 *   - MCP (`/mcp`) keeps its own JSON-RPC router inside mcp.ts.
 *   - WebSocket upgrade on /cell/* stays in the DO forwarding middleware.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
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
	renderDashboardPage,
	renderSettingsPage,
} from "./ui";

export { VoidCell };

const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "content-type, authorization",
	"access-control-max-age": "86400",
} as const;

type Variables = {
	user: { id: string; username: string; avatar_url: string | null };
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================
// Global middleware
// ============================================================

// Run schema migrations on every request (idempotent + cached per-isolate).
// Wrapped so it runs before any route.
app.use("*", async (c, next) => {
	await ensureSchema(c.env.void_db);
	await next();
});

// ============================================================
// CORS — only on routes that need cross-origin
// ============================================================

app.use(
	"/mcp",
	cors({
		origin: "*",
		allowMethods: ["POST", "OPTIONS"],
		allowHeaders: ["content-type", "authorization"],
		maxAge: 86400,
	}),
);

app.use(
	"/health",
	cors({
		origin: "*",
		allowMethods: ["GET", "OPTIONS"],
		maxAge: 86400,
	}),
);

// ============================================================
// Bearer auth — applied to all /api/* except public auth + webhook
// ============================================================

const bearerOnly = async (c: any, next: any) => {
	const fail = requireBearer(c.env, c.req.raw);
	if (fail) return fail;
	await next();
};

// Apply bearer to all /api/<something>/* except /api/auth/* (session cookie)
// and /api/webhooks/* (HMAC). Note: Hono's `/api/*` matches `/api` itself too,
// so we guard with an explicit check.
app.use("/api/*", async (c, next) => {
	const p = c.req.path;
	if (p === "/api" || p === "/api/") return next();
	if (p.startsWith("/api/auth/") || p.startsWith("/api/webhooks/")) return next();
	return bearerOnly(c, next);
});

// ============================================================
// Session auth — UI pages require a valid session cookie
// ============================================================

const requireSession = async (c: any, next: any) => {
	const user = await getSessionUser(c);
	if (!user) {
		// Browser visit: redirect to OAuth start, carrying returnTo so the
		// callback can land back on this page. Programmatic: 401.
		const accept = c.req.header("Accept") || "";
		if (accept.includes("text/html")) {
			const returnTo = c.req.path + (c.req.queryString ? `?${c.req.queryString}` : "");
			const url = `/api/auth/github?returnTo=${encodeURIComponent(returnTo)}`;
			return c.redirect(url);
		}
		return c.json({ error: "unauthorized", message: "session required" }, 401);
	}
	c.set("user", user);
	await next();
};

// ============================================================
// DO forwarding — /cell/* and /api/cell/* (Hono + path params)
// ============================================================

/**
 * Forward a request to a per-server VoidCell Durable Object.
 * The DO's URL parser expects paths of the form `/<serverId>/<action>`.
 * We rewrite the URL so the DO receives the path it expects, then pass
 * method/body/headers through unchanged.
 */
const forwardToCell = (c: any, serverId: string) => {
	const stub = c.env.void_cell.get(c.env.void_cell.idFromName(serverId));
	const inUrl = new URL(c.req.raw.url);
	// /cell/:serverId[/sub]  OR  /api/cell/:serverId[/sub]  →  /:serverId[/sub]
	const m = inUrl.pathname.match(/^\/(?:api\/)?cell\/[^/]+(\/.*)?$/);
	const subPath = m?.[1] || "";
	const internalUrl = `https://cell/${serverId}${subPath}${inUrl.search}`;
	return stub.fetch(new Request(internalUrl, c.req.raw));
};

// /cell/* — WS upgrade OR HTTP forwarding. WS auth is in the DO (setup_token
// or session_token in the first frame). HTTP requires bearer.
app.all("/cell/:serverId", async (c) => {
	if (c.req.header("Upgrade") === "websocket") {
		// WS upgrade: bypass bearer auth (the agent authenticates via the
		// first register frame inside the DO).
		return forwardToCell(c, c.req.param("serverId"));
	}
	// HTTP routes through /cell/:serverId/* — must be bearer-authed
	return bearerOnly(c, () => forwardToCell(c, c.req.param("serverId")));
});

app.all("/cell/:serverId/*", async (c) => {
	if (c.req.header("Upgrade") === "websocket") {
		return forwardToCell(c, c.req.param("serverId"));
	}
	return bearerOnly(c, () => forwardToCell(c, c.req.param("serverId")));
});

// /api/cell/* — bearer-authed DO forwarding (UI buttons, REST clients).
// The bearer middleware is applied via app.use("/api/*") which excludes
// /api/auth/* and /api/webhooks/*; /api/cell/* is included.
app.all("/api/cell/:serverId/*", async (c) => forwardToCell(c, c.req.param("serverId")));

app.all("/api/cell/:serverId", async (c) => forwardToCell(c, c.req.param("serverId")));

// ============================================================
// Public routes
// ============================================================

app.get("/", async (c) => {
	const user = await getSessionUser(c);
	// Logged-in users go straight to the admin dashboard. The marketing
	// landing page is for first-time visitors only.
	if (user) return c.redirect("/dashboard");
	const env = c.env;
	const html = renderLandingHtml({
		user,
		installed: isConfigured(env.GITHUB_CLIENT_ID) && isConfigured(env.GITHUB_CLIENT_SECRET),
		cf_tunnel: isConfigured(env.CF_API_TOKEN),
		github_webhook: isConfigured(env.GITHUB_WEBHOOK_SECRET),
	});
	return c.html(html);
});

/**
 * True if the value is set AND not a placeholder string from wrangler.jsonc.
 * Placeholders look like "REPLACE_WITH_..." — they're set (truthy) but useless.
 */
const isConfigured = (v: string | undefined): boolean => {
	if (!v) return false;
	if (v.startsWith("REPLACE_WITH_")) return false;
	return true;
};

app.get("/health", (c) => {
	const env = c.env;
	return c.json({
		name: "void",
		version: "0.3.1",
		status: "alive",
		message: "Best DX. Hetzner pricing. No SSH.",
		docs: "https://github.com/void-sh/void/blob/main/docs/SPEC.md",
		bindings: {
			d1: !!env.void_db,
			kv: !!env.ROUTES,
			r2: !!env.void_builds,
			do: !!env.void_cell,
		},
		features: {
			github_oauth: isConfigured(env.GITHUB_CLIENT_ID) && isConfigured(env.GITHUB_CLIENT_SECRET),
			github_webhook: isConfigured(env.GITHUB_WEBHOOK_SECRET),
			cf_tunnel: isConfigured(env.CF_API_TOKEN),
			hetzner: isConfigured(env.HETZNER_TOKEN),
		},
	});
});

app.get("/api", (c) => {
	return c.json({
		endpoints: [
			"GET  /",
			"GET  /health",
			"POST /mcp  (MCP Streamable HTTP, Bearer)",
			"WS   /cell/:server_id  (agent)",
			"GET  /api/servers  (Bearer)",
			"GET  /api/cell/:server_id/status  (Bearer)",
			"POST /api/cell/:server_id/rotate-session  (Bearer)",
			"POST /api/webhooks/github  (HMAC)",
			"GET  /api/auth/github  (OAuth start)",
			"GET  /api/auth/callback  (OAuth callback)",
			"GET  /api/auth/me",
			"GET  /api/auth/logout",
			"GET  /servers  (UI, session cookie)",
			"GET  /projects  (UI, session cookie)",
			"GET  /deployments  (UI, session cookie)",
			"GET  /deployments/:id  (UI, session cookie)",
			"POST /servers/:id/rotate-session  (UI form action, session cookie)",
		],
	});
});

// ============================================================
// MCP
// ============================================================

app.post("/mcp", bearerOnly, async (c) => {
	return handleMcp(c.req.raw, c.env);
});

// ============================================================
// Auth (session cookie, NOT bearer)
// ============================================================

app.get("/api/auth/github", (c) => handleAuthStart(c));
app.get("/api/auth/callback", (c) => handleAuthCallback(c));
app.get("/api/auth/me", (c) => handleAuthMe(c));
app.get("/api/auth/logout", (c) => handleAuthLogout(c));

// ============================================================
// Webhooks (HMAC, NOT bearer)
// ============================================================

app.post("/api/webhooks/github", (c) => handleGitHubWebhook(c.req.raw, c.env));

// ============================================================
// REST API (Bearer via middleware)
// ============================================================

app.get("/api/servers", async (c) => {
	const { results } = await c.env.void_db
		.prepare(
			"SELECT id, name, provider, status, region, size, last_seen_at FROM servers ORDER BY created_at DESC",
		)
		.all();
	return c.json({ servers: results });
});

// ============================================================
// UI pages (require session cookie)
// ============================================================

app.get("/dashboard", requireSession, async (c) => {
	return renderDashboardPage(c.env, c.get("user"));
});

app.get("/servers", requireSession, async (c) => {
	return renderServersPage(c.env, c.get("user"));
});

app.get("/projects", requireSession, async (c) => {
	return renderProjectsPage(c.env, c.get("user"));
});

app.get("/deployments", requireSession, async (c) => {
	const projectFilter = c.req.query("project") ?? null;
	const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
	const perPage = Math.min(100, Math.max(1, parseInt(c.req.query("per_page") || "20", 10) || 20));
	return renderDeploymentsPage(c.env, c.get("user"), projectFilter, page, perPage);
});

app.get("/deployments/:id", requireSession, async (c) => {
	return renderDeploymentLogsPage(c.env, c.get("user"), c.req.param("id"));
});

app.get("/settings", requireSession, async (c) => {
	return renderSettingsPage(c.env, c.get("user"));
});

// UI form action: rotate session token (POST from the rotate button)
app.post("/servers/:id/rotate-session", requireSession, async (c) => {
	const serverId = c.req.param("id");
	const stub = c.env.void_cell.get(c.env.void_cell.idFromName(serverId));
	const resp = await stub.fetch(`https://cell/${serverId}/rotate-session`, { method: "POST" });
	const data: any = await resp.json();
	const newToken = (data && data.session_token) || "(error)";
	return c.html(`<!doctype html><html><head><meta charset="UTF-8"><title>Session rotated · void</title>
<style>body{font-family:-apple-system,sans-serif;background:#000;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;margin:0}
.box{max-width:600px;background:#0a0a0a;border:1px solid #222;border-radius:12px;padding:32px}
h1{font-size:1.5rem;margin-bottom:16px}
code{background:#1a1a1a;padding:6px 10px;border-radius:6px;display:block;color:#0f0;font-family:ui-monospace,monospace;margin:8px 0;word-break:break-all}
.warn{color:#f90;font-size:0.9rem;margin:16px 0;padding:12px;background:#1a0a00;border-radius:6px}
a{color:#6cf;display:inline-block;margin-top:16px}</style></head>
<body><div class="box">
<h1>Session token rotated for ${escapeHtml(serverId)}</h1>
<p>New token:</p><code>${escapeHtml(newToken)}</code>
<div class="warn">The agent has been disconnected. Update <code>&lt;state_dir&gt;/session_token</code> on the agent host with the new token, then restart the agent.</div>
<a href="/servers">Back to servers</a>
</div></body></html>`);
});

// ============================================================
// 404
// ============================================================

app.notFound((c) => c.json({ error: "Not found", path: c.req.path }, 404));

// ============================================================
// Worker entry
// ============================================================

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return app.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
