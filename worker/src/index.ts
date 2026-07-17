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
	authInterstitial,
	renderLandingHtml,
	requireBearer,
	createSession,
	SESSION_COOKIE_OPTS,
} from "./auth";
import {
	addProjectRepository,
	addProjectServer,
	availableGithubRepositories,
	connectProjectCloudflare,
	connectProjectGithub,
	connectProjectHetzner,
	createProject,
	deployProjectRepository,
	getProject,
	listProjects,
	projectDomains,
	projectServerCatalog,
} from "./project-api";

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

// Apply bearer to all /api/<something>/* except:
//   - /api/auth/*       (session cookie)
//   - /api/webhooks/*   (HMAC)
//   - /api/passkey/*    (login is public, register/delete use session —
//                        each route handler enforces its own auth)
//   - /api/hetzner/*    (UI form actions, session cookie — handlers
//                        enforce their own session check)
// Note: Hono's `/api/*` matches `/api` itself too, so we guard with
// an explicit check.
//
// The React SPA authenticates with the SESSION COOKIE (not a Bearer
// token), so all its JSON API routes are excluded from Bearer auth
// here and rely on `requireSession` (which reads the cookie). Bearer
// auth stays on /api/* for programmatic/MCP clients (deploy frames,
// agent WS negotiation, etc).
app.use("/api/*", async (c, next) => {
	const p = c.req.path;
	if (p === "/api" || p === "/api/") return next();
	if (
		p.startsWith("/api/auth/") ||
		p.startsWith("/api/webhooks/") ||
		p.startsWith("/api/passkey/") ||
		p.startsWith("/api/hetzner/") ||
		p === "/api/servers-ui" ||
		p === "/api/me" ||
		p === "/api/dashboard" ||
		p === "/api/settings" ||
		p === "/api/projects" ||
		p.startsWith("/api/projects/") ||
		p === "/api/deployments" ||
		p.startsWith("/api/servers/")
	) return next();
	return bearerOnly(c, next);
});

// ============================================================
// Session auth — UI pages require a valid session cookie
// ============================================================

const requireSession = async (c: any, next: any) => {
	const user = await getSessionUser(c);
	if (!user) {
		// Browser visits to protected URLs always return to the public
		// landing page. Authentication starts only from `/`.
		const accept = c.req.header("Accept") || "";
		if (accept.includes("text/html")) {
			return c.redirect("/");
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
	if (new URL(c.req.url).searchParams.get("auth") === "unauthorized") {
		return c.html(
			authInterstitial({
				kind: "unauthorized",
				redirectTo: new URL("/", c.req.url).toString(),
				delayMs: 1500,
			}),
		);
	}
	const env = c.env;
	const html = renderLandingHtml({
		user,
		installed: isConfigured(env.GITHUB_CLIENT_ID) && isConfigured(env.GITHUB_CLIENT_SECRET),
		cf_tunnel: isConfigured(env.CF_API_TOKEN),
		github_webhook: isConfigured(env.GITHUB_WEBHOOK_SECRET),
		devAuth: env.VOID_DEV_AUTH === "1" || env.VOID_DEV_AUTH === "true",
		// Emit the marker; dev-entry middleware replaces it with
		// the actual dev-login button. In production, the marker
		// stays in the HTML (inert comment) and is never replaced.
		devAuthButtonMarker: "<!--DEV_AUTH_BUTTON-->",
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
			"POST /api/webhooks/github  (HMAC)",
			"GET  /api/auth/github  (OAuth start)",
			"GET  /api/auth/callback  (OAuth callback)",
			"GET  /api/auth/me",
			"GET  /api/auth/logout",
			"GET  /servers  (UI, session cookie)",
			"GET  /projects  (UI, session cookie)",
			"GET  /deployments  (UI, session cookie)",
			"GET  /deployments/:id  (UI, session cookie)",
			"GET  /servers/:id/metrics  (UI, session cookie)",
		],
	});
});

// ============================================================
// MCP
// ============================================================

app.post("/mcp", bearerOnly, async (c) => {
	return handleMcp(c);
});

// ============================================================
// Auth (session cookie, NOT bearer)
// ============================================================

app.get("/api/auth/github", (c) => handleAuthStart(c));
app.get("/api/auth/callback", (c) => handleAuthCallback(c));
app.get("/api/auth/me", (c) => handleAuthMe(c));
app.get("/api/auth/logout", (c) => handleAuthLogout(c));

// Dev-only auth bypass lives in src/auth-dev.ts and is registered
// in src/dev-entry.ts (used by wrangler.dev.jsonc for local dev).
// The production entry point (this file) does NOT import auth-dev,
// so the dev login code is physically absent from the deployed
// worker bundle. See wrangler.dev.jsonc.

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

// POST /api/servers/register — provider-agnostic registration.
//
// Returns a one-time setup_token and the agent config.toml the caller
// should write to /etc/void/config.toml on the target VM. After the
// agent WS-connects and sends register{setup_token}, the row is
// promoted to status='active' and the token is replaced with a
// session_token.
//
// This is the path the test-lab scripts use, and the path the panel
// "register manually" button will use. The Hetzner one-click flow
// uses a different code path (see server-create.ts) which calls the
// Hetzner API and embeds the setup_token in cloud-init — that path
// keeps working unchanged.
//
// Both paths share the same D1 row shape and the same WS handshake.
//
// Auth: Bearer token (consistent with the rest of /api/*). The
// test-lab script reads VOID_BEARER_TOKEN from .dev.vars and sends
// it as Authorization: Bearer. The panel uses a server-side fetch
// with the same token (it has access to env at render time).
app.post("/api/servers/register", async (c) => {
	// Resolve the user from the Bearer token. The token is system-wide
	// (one per deployment). We attribute the registered server to the
	// first user in the users table.
	const auth = c.req.header("authorization") || "";
	const m = auth.match(/^Bearer\s+(\S+)$/i);
	const bearer = m?.[1] || "";
	if (!bearer || bearer !== c.env.VOID_BEARER_TOKEN) {
		return c.json({ error: "unauthorized", message: "Bearer token required" }, 401);
	}
	const { results } = await c.env.void_db
		.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1")
		.all<{ id: string }>();
	const userId = results[0]?.id;
	if (!userId) {
		// No user in the system yet. The test-lab has a provision
		// script that seeds a 'lab' user; the production panel
		// has the OAuth flow. Either way, this endpoint requires
		// a real user to attribute the server to.
		return c.json(
			{
				error: "no_users",
				message:
					"no users in D1; run scripts/test-lab/provision.sh (lab) or complete the OAuth login (production) first",
			},
			412,
		);
	}
	const body = await c.req.json().catch(() => ({}));
	const { registerServerForUser } = await import("./server-register");
	const result = await registerServerForUser(
		c.env,
		userId,
		{
			name: body?.name,
			region: body?.region,
			size: body?.size,
		},
		c.req.url,
	);
	return c.json(result);
});

// JSON variant for the /servers page auto-poll. Same shape as the cards.
// Requires session (cookie) — used by the in-page JS, no Bearer needed.
app.get("/api/servers-ui", requireSession, async (c) => {
	const user = c.get("user");
	const projectId = c.req.query("project") || null;
	const { results } = await c.env.void_db
		.prepare(
			`SELECT s.id, s.name, s.status, s.region, s.size, s.last_seen_at, s.created_at,
			        s.hetzner_project_name, s.provider_server_id, s.ip_address, s.provider,
			        s.cpu, s.memory, s.disk, s.project_id, w.name AS project_name,
			        (SELECT COUNT(*) FROM deployments d WHERE d.server_id = s.id) AS deployment_count,
			        (SELECT ref FROM deployments d
			           WHERE d.server_id = s.id ORDER BY d.started_at DESC LIMIT 1) AS last_deploy_ref,
			        (SELECT commit_sha FROM deployments d
			           WHERE d.server_id = s.id ORDER BY d.started_at DESC LIMIT 1) AS last_deploy_commit,
			        (SELECT status FROM deployments d
			           WHERE d.server_id = s.id ORDER BY d.started_at DESC LIMIT 1) AS last_deploy_status,
			        (SELECT started_at FROM deployments d
			           WHERE d.server_id = s.id ORDER BY d.started_at DESC LIMIT 1) AS last_deploy_at
			 FROM servers s
			 LEFT JOIN projects w ON w.id = s.project_id
			 WHERE s.user_id = ? AND (? IS NULL OR s.project_id = ?)
			 ORDER BY s.created_at DESC`,
		)
		.bind(user.id, projectId, projectId)
		.all();
	return c.json({ servers: results });
});

// ============================================================
// UI pages are now served as a static SPA from frontend/dist
// (wrangler.jsonc `assets` + single-page-application fallback).
// These GET routes are removed; the React app handles all page
// rendering. JSON API routes for the SPA live above under
// "JSON API for the React SPA". Auth + form-action POST routes below.

// SPA handles /projects, /deployments, /deployments/:id, /settings rendering.
// (GET page routes removed — served as static SPA from frontend/dist.)

// GET /api/settings — aggregate data for the React Settings SPA page.
// Mirrors what renderSettingsPage() assembled from SQL + KV + env.
app.get("/api/settings", requireSession, async (c) => {
	const user = c.get("user");
	const fullUser = await c.env.void_db
		.prepare("SELECT id, username, avatar_url, github_id, created_at FROM users WHERE id = ?")
		.bind(user.id)
		.first<{ id: string; username: string; avatar_url: string | null; github_id: string; created_at: number }>();
	const { listPasskeys } = await import("./passkey");
	const passkeys = await listPasskeys(c.env, user.id);
	const { listOverriddenSystemTokens, SYSTEM_KEYS } = await import("./system-settings");
	const overridden = await listOverriddenSystemTokens(c.env);
	return c.json({
		user: fullUser,
		passkeys,
		system_keys: SYSTEM_KEYS,
		overridden: Array.from(overridden),
	});
});

// System settings — operator-managed tokens stored in the panel.
// Only GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set via the
// deploy workflow (see .github/workflows/deploy.yml). Everything else
// is configured here post-deploy. See worker/src/system-settings.ts
// for the full list of keys and the env-var fallback chain.
app.post("/settings/system/:key", requireSession, async (c) => {
	const { setSystemToken, SYSTEM_KEYS } = await import("./system-settings");
	const key = c.req.param("key");
	const meta = SYSTEM_KEYS.find((k) => k.key === key);
	if (!meta) return c.redirect("/settings?toast=error&msg=unknown+system+key:+${encodeURIComponent(key)}");
	const form = await c.req.parseBody();
	const value = String((form as Record<string, string>)["value"] || "").trim();
	if (!value) {
		return c.redirect(`/settings?toast=error&msg=${encodeURIComponent(`${meta.label}: value cannot be empty (use Clear to remove)`)}`);
	}
	try {
		await setSystemToken(c.env, meta.key, value);
		return c.redirect(
			`/settings?toast=success&msg=${encodeURIComponent(`${meta.label} saved`)}`,
		);
	} catch (e: any) {
		return c.redirect(
			`/settings?toast=error&msg=${encodeURIComponent(e?.message || String(e))}`,
		);
	}
});

app.post("/settings/system/:key/delete", requireSession, async (c) => {
	const { deleteSystemToken, SYSTEM_KEYS } = await import("./system-settings");
	const key = c.req.param("key");
	const meta = SYSTEM_KEYS.find((k) => k.key === key);
	if (!meta) return c.redirect("/settings?toast=error&msg=unknown+system+key:+${encodeURIComponent(key)}");
	await deleteSystemToken(c.env, meta.key);
	return c.redirect(
		`/settings?toast=success&msg=${encodeURIComponent(`${meta.label} cleared (falling back to env)`)}`,
	);
});

// GET /servers/:id/metrics — live agent CPU/memory metrics (session cookie auth)
app.get("/servers/:id/metrics", requireSession, async (c) => {
	const serverId = c.req.param("id");
	const user = c.get("user");
	const server = await c.env.void_db
		.prepare("SELECT id FROM servers WHERE id = ? AND user_id = ?")
		.bind(serverId, user.id)
		.first<{ id: string }>();
	if (!server) {
		return c.json({ error: "server not found" }, 404);
	}
	const stub = c.env.void_cell.get(c.env.void_cell.idFromName(serverId));
	const resp = await stub.fetch(`https://cell/${serverId}/metrics`);
	const data = await resp.json();
	return c.json(data);
});

// ============================================================
// JSON API for the React SPA (session cookie auth)
// These mirror the HTML-rendered pages but return JSON so the SPA
// can hydrate without a full page render. Same auth as the UI pages.
// ============================================================

// GET /api/servers/:id — full server row for the detail page.
app.get("/api/servers/:id", requireSession, async (c) => {
	const serverId = c.req.param("id");
	const user = c.get("user");
	const row = await c.env.void_db
		.prepare("SELECT * FROM servers WHERE id = ? AND user_id = ?")
		.bind(serverId, user.id)
		.first<Record<string, unknown>>();
	if (!row) return c.json({ error: "server not found" }, 404);
	let inventory: Record<string, unknown> | null = null;
	if (typeof row.inventory_json === "string") {
		try {
			const parsed = JSON.parse(row.inventory_json);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) inventory = parsed as Record<string, unknown>;
		} catch {
			// Ignore a malformed/stale inventory snapshot; the server row remains usable.
		}
	}
	const { inventory_json: _inventoryJson, ...server } = row;
	return c.json({ server: { ...server, inventory } });
});

// GET /api/servers/:id/logs — SSE log stream (session cookie auth).
// Proxies the cell's /logs SSE through the bearer-authed DO forward,
// so the browser only needs its session cookie (no bearer token).
app.get("/api/servers/:id/logs", requireSession, async (c) => {
	const serverId = c.req.param("id");
	const user = c.get("user");
	const server = await c.env.void_db
		.prepare("SELECT id FROM servers WHERE id = ? AND user_id = ?")
		.bind(serverId, user.id)
		.first<{ id: string }>();
	if (!server) return c.json({ error: "server not found" }, 404);
	const deploymentId = c.req.query("deployment_id") || "";
	const stub = c.env.void_cell.get(c.env.void_cell.idFromName(serverId));
	const resp = await stub.fetch(`https://cell/${serverId}/logs?deployment_id=${encodeURIComponent(deploymentId)}`);
	return new Response(resp.body, {
		status: resp.status,
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			"connection": "keep-alive",
		},
	});
});

// Project aggregate API. A Project owns GitHub, repositories, and servers.
app.get("/api/projects", requireSession, listProjects);
app.post("/api/projects", requireSession, createProject);
app.get("/api/projects/:id", requireSession, getProject);
app.post("/api/projects/:id/github", requireSession, connectProjectGithub);
app.post("/api/projects/:id/hetzner", requireSession, connectProjectHetzner);
app.post("/api/projects/:id/cloudflare", requireSession, connectProjectCloudflare);
app.get("/api/projects/:id/domains", requireSession, projectDomains);
app.get("/api/projects/:id/github/repositories", requireSession, availableGithubRepositories);
app.post("/api/projects/:id/repositories", requireSession, addProjectRepository);
app.get("/api/projects/:id/server-catalog", requireSession, projectServerCatalog);
app.post("/api/projects/:id/servers", requireSession, addProjectServer);
app.post("/api/projects/:id/deploy", requireSession, deployProjectRepository);

// GET /api/deployments — list with pagination + optional project filter.
app.get("/api/deployments", requireSession, async (c) => {
	const user = c.get("user");
	const projectFilter = c.req.query("project") ?? null;
	const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
	const perPage = Math.min(100, Math.max(1, parseInt(c.req.query("per_page") || "20", 10) || 20));
	const offset = (page - 1) * perPage;
	const where = projectFilter
		? "WHERE d.project_id = ? AND w.user_id = ?"
		: "WHERE w.user_id = ?";
	const countSql = `SELECT COUNT(*) AS n FROM deployments d LEFT JOIN projects w ON w.id = d.project_id ${where}`;
	const listSql = `
		SELECT d.id, d.ref, d.status, d.started_at, d.finished_at, d.duration_ms,
		       d.hostname, d.public_url, d.commit_sha, d.error,
		       w.name AS project_name, w.id AS project_id,
		       r.name AS repository_name, r.id AS repository_id, r.slug AS repository_slug,
		       s.id AS server_id, s.name AS server_name
		FROM deployments d
		LEFT JOIN projects w ON w.id = d.project_id
		LEFT JOIN repositories r ON r.id = d.repository_id
		LEFT JOIN servers s ON s.id = d.server_id
		${where}
		ORDER BY d.started_at DESC
		LIMIT ? OFFSET ?`;
	const countParams = projectFilter ? [projectFilter, user.id] : [user.id];
	const listParams = projectFilter ? [projectFilter, user.id, perPage, offset] : [user.id, perPage, offset];
	const { results: list } = await c.env.void_db.prepare(listSql).bind(...listParams).all();
	const { results: countRes } = await c.env.void_db.prepare(countSql).bind(...countParams).all<{ n: number }>();
	const total = countRes[0]?.n ?? 0;
	return c.json({ deployments: list, page, per_page: perPage, total, total_pages: Math.ceil(total / perPage) });
});

// GET /api/deployments/:id — full deployment row + server/project info.
app.get("/api/deployments/:id", requireSession, async (c) => {
	const deploymentId = c.req.param("id");
	const user = c.get("user");
	const row = await c.env.void_db
		.prepare(
			`SELECT d.*, s.id AS server_id, s.name AS server_name,
			        w.name AS project_name, r.name AS repository_name
			 FROM deployments d
			 LEFT JOIN servers s ON s.id = d.server_id
			 LEFT JOIN projects w ON w.id = d.project_id
			 LEFT JOIN repositories r ON r.id = d.repository_id
			 WHERE d.id = ? AND (w.user_id = ? OR s.user_id = ?)`,
		)
		.bind(deploymentId, user.id, user.id)
		.first();
	if (!row) return c.json({ error: "deployment not found" }, 404);
	return c.json({ deployment: row });
});

// GET /api/dashboard — aggregate stats for the dashboard page.
app.get("/api/dashboard", requireSession, async (c) => {
	const user = c.get("user");
	const projectId = c.req.query("project") || null;
	const servers = await c.env.void_db
		.prepare("SELECT id, name, status, last_seen_at FROM servers WHERE user_id = ? AND (? IS NULL OR project_id = ?) ORDER BY created_at DESC")
		.bind(user.id, projectId, projectId)
		.all();
	const projects = await c.env.void_db
		.prepare("SELECT id, name, slug FROM projects WHERE user_id = ? AND (? IS NULL OR id = ?) ORDER BY is_default DESC, created_at ASC")
		.bind(user.id, projectId, projectId)
		.all();
	const deployments24h = await c.env.void_db
		.prepare(
			"SELECT COUNT(*) AS n FROM deployments d LEFT JOIN projects w ON w.id = d.project_id WHERE w.user_id = ? AND (? IS NULL OR d.project_id = ?) AND d.started_at > unixepoch() - 86400",
		)
		.bind(user.id, projectId, projectId)
		.first<{ n: number }>();
	const recent = await c.env.void_db
		.prepare(
			`SELECT d.id, d.ref, d.status, d.started_at, w.name AS project_name, r.name AS repository_name
			 FROM deployments d
			 LEFT JOIN projects w ON w.id = d.project_id
			 LEFT JOIN repositories r ON r.id = d.repository_id
			 WHERE w.user_id = ? AND (? IS NULL OR d.project_id = ?)
			 ORDER BY d.started_at DESC LIMIT 10`,
		)
		.bind(user.id, projectId, projectId)
		.all();
	return c.json({
		servers: servers.results,
		projects: projects.results,
		deployments_24h: deployments24h?.n ?? 0,
		recent_deployments: recent.results,
	});
});

// GET /api/me — current session user (for the SPA shell).
app.get("/api/me", requireSession, async (c) => {
	return c.json({ user: c.get("user") });
});

// DELETE /api/servers/:id — delete a server (Hetzner + void row).
// Reuses the same ownership check + best-effort Hetzner delete as the
// HTML form action. Returns JSON so the SPA can update without reload.
app.delete("/api/servers/:id", requireSession, async (c) => {
	const user = c.get("user");
	const serverId = c.req.param("id");
	const env = c.env;
	const srv = await env.void_db
		.prepare("SELECT id, name, provider_server_id, project_id FROM servers WHERE id = ? AND user_id = ?")
		.bind(serverId, user.id)
		.first<{ id: string; name: string; provider_server_id: string | null; project_id: string }>();
	if (!srv) return c.json({ error: "server not found" }, 404);
	let hetznerMsg = "";
	if (srv.provider_server_id) {
		try {
			const { getProviderToken } = await import("./credentials");
			const { deleteServer } = await import("./hetzner");
			const token = await getProviderToken(env, user.id, "hetzner", srv.project_id);
			if (token) {
				await deleteServer(token, parseInt(srv.provider_server_id, 10));
				hetznerMsg = "VM deleted in Hetzner.";
			} else {
				hetznerMsg = "No Hetzner token available — only void row removed.";
			}
		} catch (e: any) {
			const msg = String(e?.message || e);
			hetznerMsg = msg.includes("not found") || msg.includes("404")
				? "VM was already gone in Hetzner."
				: `Hetzner delete failed: ${msg} (void row still removed).`;
		}
	} else {
		hetznerMsg = "No Hetzner ID — void row removed only.";
	}
	try {
		const stub = env.void_cell.get(env.void_cell.idFromName(serverId));
		await stub.fetch(`https://cell/${serverId}/teardown`, { method: "POST" });
	} catch { /* best-effort */ }
	await env.void_db.prepare("DELETE FROM servers WHERE id = ?").bind(serverId).run();
	return c.json({ ok: true, message: `Server '${srv.name}' deleted. ${hetznerMsg}` });
});

// POST /servers/:id/delete — full delete (Hetzner + void).
// Tries to delete the VM in Hetzner first (best-effort: ignores 404,
// tolerates other errors so the user can still clean up the void row).
// Then hard-deletes the D1 row. Deployments stay for history (orphaned
// but visible until cleaned up separately).
app.post("/servers/:id/delete", requireSession, async (c) => {
	const user = c.get("user");
	const serverId = c.req.param("id");
	const env = c.env;

	const srv = await env.void_db
		.prepare("SELECT id, name, provider_server_id, project_id FROM servers WHERE id = ? AND user_id = ?")
		.bind(serverId, user.id)
		.first<{ id: string; name: string; provider_server_id: string | null; project_id: string }>();
	if (!srv) return c.redirect("/servers?toast=error&msg=server+not+found");

	let hetznerMsg = "";
	if (srv.provider_server_id) {
		try {
			const { getProviderToken } = await import("./credentials");
			const { deleteServer } = await import("./hetzner");
			const token = await getProviderToken(env, user.id, "hetzner", srv.project_id);
			if (token) {
				await deleteServer(token, parseInt(srv.provider_server_id, 10));
				hetznerMsg = "VM deleted in Hetzner.";
			} else {
				hetznerMsg = "No Hetzner token available — only void row removed.";
			}
		} catch (e: any) {
			const msg = String(e?.message || e);
			if (msg.includes("not found") || msg.includes("404")) {
				hetznerMsg = "VM was already gone in Hetzner.";
			} else {
				// Token revoked, project suspended, network — let the user
				// still clean up the void row. They can re-attempt Hetzner
				// deletion manually from the Hetzner console.
				hetznerMsg = `Hetzner delete failed: ${msg} (void row still removed).`;
			}
		}
	} else {
		hetznerMsg = "No Hetzner ID — void row removed only.";
	}

	// Also clear the Durable Object state (fire-and-forget — DO might be
	// gone if the agent already disconnected, that's fine).
	try {
		const stub = env.void_cell.get(env.void_cell.idFromName(serverId));
		await stub.fetch(`https://cell/${serverId}/teardown`, { method: "POST" });
	} catch {
		// best-effort
	}

	await env.void_db
		.prepare("DELETE FROM servers WHERE id = ?")
		.bind(serverId)
		.run();

	return c.redirect(
		`/servers?toast=success&msg=${encodeURIComponent(`Server '${srv.name}' deleted. ${hetznerMsg}`)}`,
	);
});

// POST /servers/:id/sync — re-check the server's status with Hetzner.
// If Hetzner returns 404 (server deleted in their console, or the
// project containing it was deleted), we mark the void row as 'destroyed'
// so the UI can show a clear "gone" state instead of stale data.
// Also refreshes the cached Hetzner project name in case the user
// renamed the project in the Cloud Console.
app.post("/servers/:id/sync", requireSession, async (c) => {
	const user = c.get("user");
	const serverId = c.req.param("id");
	const env = c.env;

	// 1. Look up the server and verify ownership
	const srv = await env.void_db
		.prepare(
			"SELECT id, project_id, provider_server_id, status, hetzner_project_id, hetzner_project_name FROM servers WHERE id = ? AND user_id = ?",
		)
		.bind(serverId, user.id)
		.first<{ id: string; project_id: string; provider_server_id: string | null; status: string; hetzner_project_id: number | null; hetzner_project_name: string | null }>();
	if (!srv) return c.redirect("/servers?toast=error&msg=server+not+found");

	if (!srv.provider_server_id) {
		return c.redirect("/servers?toast=error&msg=no+hetzner+id+for+this+server");
	}

	// 2. Resolve the Hetzner token
	const { getProviderToken } = await import("./credentials");
	const { getServer, listProjects } = await import("./hetzner");
	const token = await getProviderToken(env, user.id, "hetzner", srv.project_id);
	if (!token) {
		return c.redirect("/servers?toast=error&msg=no+hetzner+token+configured");
	}

	// 3. Call Hetzner
	try {
		const hs = await getServer(token, parseInt(srv.provider_server_id, 10));
		const now = Math.floor(Date.now() / 1000);
		// Refresh the project name from Hetzner in case it was renamed
		let projectName = srv.hetzner_project_name;
		try {
			const projects = await listProjects(env, token);
			// Find the project that has this server — Hetzner doesn't tell
			// us which project owns a server directly, so we re-sync the
			// name from the same project we stored at creation time.
			const same = projects.find((p) => p.id === srv.hetzner_project_id);
			if (same) projectName = same.name;
		} catch {}
		// Also backfill cpu/memory/disk if missing (e.g. for servers
		// created before we started storing these fields).
		const cpu = hs.server_type?.cores ?? null;
		const memory = hs.server_type?.memory ?? null;
		const disk = hs.server_type?.disk ?? null;
		await env.void_db
			.prepare(
				"UPDATE servers SET status = ?, last_seen_at = ?, ip_address = ?, hetzner_project_name = ?, cpu = COALESCE(cpu, ?), memory = COALESCE(memory, ?), disk = COALESCE(disk, ?) WHERE id = ?",
			)
			.bind(
				hs.status,
				now,
				hs.public_net?.ipv4?.ip || null,
				projectName,
				cpu,
				memory,
				disk,
				serverId,
			)
			.run();
		return c.redirect(`/servers?toast=success&msg=${encodeURIComponent(`Synced · status: ${hs.status}`)}`);
	} catch (e: any) {
		const msg = String(e?.message || e);
		if (msg.includes("not found") || msg.includes("404")) {
			// Server or its project was deleted in Hetzner
			await env.void_db
				.prepare("UPDATE servers SET status = 'destroyed' WHERE id = ?")
				.bind(serverId)
				.run();
			return c.redirect("/servers?toast=success&msg=server+no+longer+exists+in+Hetzner+(marked+as+destroyed)");
		}
		return c.redirect(`/servers?toast=error&msg=${encodeURIComponent(msg)}`);
	}
});

// ============================================================
// Passkeys (WebAuthn)
// ============================================================
//
// Five routes, split between "auth required" (register, delete) and
// "no auth" (login start/finish). All use httpOnly challenge cookies
// scoped per-flow. The actual WebAuthn helpers live in passkey.ts.

import {
	startRegistration as pkStartRegistration,
	finishRegistration as pkFinishRegistration,
	startAuthentication as pkStartAuthentication,
	finishAuthentication as pkFinishAuthentication,
	getPasskeyByCredentialId,
	savePasskey,
	touchPasskey,
	listPasskeys,
	deletePasskey,
	PASSKEY_REG_CHALLENGE_COOKIE,
	PASSKEY_AUTH_CHALLENGE_COOKIE,
	CHALLENGE_COOKIE_OPTS,
} from "./passkey";

import { setCookie as honoSetCookie, getCookie as honoGetCookie, deleteCookie as honoDeleteCookie } from "hono/cookie";

// Start registration: returns WebAuthn options, stashes the challenge
// in a short-lived httpOnly cookie. The browser then calls
// navigator.credentials.create() with these options.
app.post("/api/passkey/register/start", requireSession, async (c) => {
	const user = c.get("user");
	const env = c.env;
	const { results } = await env.void_db
		.prepare("SELECT credential_id FROM passkeys WHERE user_id = ?")
		.bind(user.id)
		.all<{ credential_id: string }>();
	const opts = await pkStartRegistration(
		c.req.raw,
		user,
		results.map((r) => r.credential_id),
	);
	honoSetCookie(c, PASSKEY_REG_CHALLENGE_COOKIE, opts.challenge, CHALLENGE_COOKIE_OPTS);
	return c.json(opts);
});

// Finish registration: browser posts the navigator.credentials.create()
// response back. We verify it, store the credential, return success.
app.post("/api/passkey/register/finish", requireSession, async (c) => {
	const user = c.get("user");
	const env = c.env;
	const challenge = honoGetCookie(c, PASSKEY_REG_CHALLENGE_COOKIE);
	if (!challenge) return c.json({ ok: false, error: "challenge expired — try again" }, 400);
	const body = (await c.req.json().catch(() => null)) as
		| { name?: string; response?: unknown }
		| null;
	if (!body || !body.response) return c.json({ ok: false, error: "missing response" }, 400);
	const name = (String(body.name || "").trim() || "Passkey").slice(0, 64);
	const result = await pkFinishRegistration(c.req.raw, body.response, challenge);
	if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
	try {
		await savePasskey(
			env,
			user.id,
			result.credential.id,
			result.credential.publicKey,
			result.credential.counter,
			result.credential.transportsJson,
			name,
		);
	} catch (e: any) {
		// Unique constraint on credential_id = user re-registered the same
		// authenticator. Should've been caught by excludeCredentials, but
		// some platforms let you bypass it.
		if (String(e?.message || e).includes("UNIQUE")) {
			honoDeleteCookie(c, PASSKEY_REG_CHALLENGE_COOKIE, { path: "/" });
			return c.json({ ok: false, error: "This passkey is already registered" }, 409);
		}
		throw e;
	}
	honoDeleteCookie(c, PASSKEY_REG_CHALLENGE_COOKIE, { path: "/" });
	return c.json({ ok: true, name });
});

// Start login: returns options for navigator.credentials.get(). No
// allowCredentials → discoverable credentials → browser shows a
// passkey picker across all the user's passkeys for this RP.
app.post("/api/passkey/login/start", async (c) => {
	const opts = await pkStartAuthentication(c.req.raw);
	honoSetCookie(c, PASSKEY_AUTH_CHALLENGE_COOKIE, opts.challenge, CHALLENGE_COOKIE_OPTS);
	return c.json(opts);
});

// Finish login: verify, look up the user by credential_id, create a
// session, set the session cookie. The browser then redirects to
// /dashboard (or whatever redirectTo we tell it).
app.post("/api/passkey/login/finish", async (c) => {
	const env = c.env;
	const challenge = honoGetCookie(c, PASSKEY_AUTH_CHALLENGE_COOKIE);
	if (!challenge) return c.json({ ok: false, error: "challenge expired — try again" }, 400);
	const body = (await c.req.json().catch(() => null)) as { response?: any } | null;
	if (!body || !body.response || !body.response.id) {
		return c.json({ ok: false, error: "missing credential" }, 400);
	}
	const pk = await getPasskeyByCredentialId(env, body.response.id);
	if (!pk) return c.json({ ok: false, error: "passkey not recognized" }, 404);
	const result = await pkFinishAuthentication(c.req.raw, body.response, challenge, pk);
	if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
	const user = (await env.void_db
		.prepare("SELECT id, username, avatar_url FROM users WHERE id = ?")
		.bind(pk.user_id)
		.first()) as { id: string; username: string; avatar_url: string | null } | null;
	if (!user) return c.json({ ok: false, error: "user not found" }, 404);
	await touchPasskey(env, pk.id, result.newCounter);
	await createSession(c, user);
	honoDeleteCookie(c, PASSKEY_AUTH_CHALLENGE_COOKIE, { path: "/" });
	return c.json({ ok: true, redirectTo: "/dashboard" });
});

// Delete a passkey (form-encoded, redirects to /settings with toast).
// Verifies ownership in the WHERE clause — one query, no race.
app.post("/api/passkey/delete", requireSession, async (c) => {
	const user = c.get("user");
	const form = await c.req.parseBody();
	const id = String((form as Record<string, string>)["id"] || "").trim();
	if (!id) return c.redirect("/settings?toast=error&msg=missing+passkey+id");
	const ok = await deletePasskey(c.env, user.id, id);
	if (!ok) return c.redirect("/settings?toast=error&msg=passkey+not+found+or+not+yours");
	return c.redirect("/settings?toast=success&msg=Passkey+deleted");
});

// List passkeys for the /settings page (JSON).
app.get("/api/passkey/list", requireSession, async (c) => {
	const user = c.get("user");
	const passkeys = await listPasskeys(c.env, user.id);
	return c.json({ passkeys });
});

// ============================================================
// 404 / SPA fallback — unmatched routes serve the static React app.
// The frontend/dist is bound via wrangler.jsonc `assets` (FRONTEND
// fetcher). API/WS routes are handled above; everything else boots the
// React router from index.html. We fetch "/" (index.html) explicitly
// because the assets binding does a literal file lookup, not SPA fallback.
// ============================================================

app.notFound(async (c) => {
	const assets = c.env.FRONTEND;
	if (!assets) return c.json({ error: "Not found", path: c.req.path }, 404);
	// Preserve the original path so hashed JS/CSS assets are served with their
	// real body and content type. The assets binding's SPA fallback returns
	// index.html for client routes such as /dashboard and /projects/:id.
	return await assets.fetch(c.req.raw);
});

// ============================================================
// Worker entry
// ============================================================

// Export the Hono app for dev-entry.ts (local-only) to extend with
// dev-only routes (auth bypass, future /api/dev/reset, etc). The
// production entry uses `default` below, which is the standard
// ExportedHandler shape Workers expects.
export { app };

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
