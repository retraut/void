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
	createSession,
	SESSION_COOKIE_OPTS,
} from "./auth";
import {
	renderServersPage,
	renderProjectsPage,
	renderDeploymentsPage,
	renderDeploymentLogsPage,
	renderDashboardPage,
	renderSettingsPage,
	renderNewServerPage,
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

// Apply bearer to all /api/<something>/* except:
//   - /api/auth/*       (session cookie)
//   - /api/webhooks/*   (HMAC)
//   - /api/passkey/*    (login is public, register/delete use session —
//                        each route handler enforces its own auth)
//   - /api/hetzner/*    (UI form actions, session cookie — handlers
//                        enforce their own session check)
// Note: Hono's `/api/*` matches `/api` itself too, so we guard with
// an explicit check.
app.use("/api/*", async (c, next) => {
	const p = c.req.path;
	if (p === "/api" || p === "/api/") return next();
	if (
		p.startsWith("/api/auth/") ||
		p.startsWith("/api/webhooks/") ||
		p.startsWith("/api/passkey/") ||
		p.startsWith("/api/hetzner/")
	) return next();
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
	return handleMcp(c);
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

// JSON variant for the /servers page auto-poll. Same shape as the cards.
// Requires session (cookie) — used by the in-page JS, no Bearer needed.
app.get("/api/servers-ui", requireSession, async (c) => {
	const user = c.get("user");
	const { results } = await c.env.void_db
		.prepare(
			`SELECT s.id, s.name, s.status, s.region, s.size, s.last_seen_at,
			        s.hetzner_project_name, s.provider_server_id, s.ip_address,
			        s.cpu, s.memory, s.disk,
			        (SELECT COUNT(*) FROM deployments d WHERE d.server_id = s.id) AS deployment_count
			 FROM servers s
			 WHERE s.user_id = ?
			 ORDER BY s.created_at DESC`,
		)
		.bind(user.id)
		.all();
	return c.json({ servers: results });
});

// ============================================================
// UI pages (require session cookie)
// ============================================================

app.get("/dashboard", requireSession, async (c) => {
	return renderDashboardPage(c, c.get("user"));
});

app.get("/servers", requireSession, async (c) => {
	return renderServersPage(c, c.get("user"), {
		kind: c.req.query("toast") || null,
		msg: c.req.query("msg") || null,
	});
});

// GET /servers/new — provisioning wizard. Fetches the Hetzner catalog
// (cached in KV), renders location/size/image/name selectors.
app.get("/servers/new", requireSession, async (c) => {
	return renderNewServerPage(c, c.get("user"));
});

// POST /api/hetzner/catalog/refresh — force-refresh the Hetzner catalog
// cache for the calling user's token. Hits the live API and re-populates
// the KV entries. Useful when the user added a new project / type / image
// in the Hetzner console and the cached catalog is stale.
app.post("/api/hetzner/catalog/refresh", requireSession, async (c) => {
	const user = c.get("user");
	const { getProviderToken } = await import("./credentials");
	const { invalidateCatalogCache, listServerTypes, listLocations, listImages } = await import(
		"./hetzner"
	);
	const token = await getProviderToken(c.env, user.id, "hetzner");
	if (!token) {
		return c.redirect("/servers/new?toast=error&msg=No+Hetzner+token+configured");
	}
	try {
		await invalidateCatalogCache(c.env, token);
		// Warm the cache with fresh data so the next page load is instant
		await Promise.all([
			listServerTypes(c.env, token),
			listLocations(c.env, token),
			listImages(c.env, token, { architecture: "x86" }),
		]);
		return c.redirect("/servers/new?toast=success&msg=Catalog+refreshed+from+Hetzner");
	} catch (e: any) {
		return c.redirect(
			`/servers/new?toast=error&msg=${encodeURIComponent("Refresh failed: " + (e?.message || e))}`,
		);
	}
});

// POST /servers/new — create the server. Validates form data, calls
// the shared createServerForUser(), redirects to /servers on success.
app.post("/servers/new", requireSession, async (c) => {
	const user = c.get("user");
	const form = await c.req.parseBody();
	const f = form as Record<string, string>;
	const name = String(f.name || "").trim();
	const region = String(f.region || "").trim();
	const size = String(f.size || "").trim();
	const image = String(f.image || "").trim();

	// Server-side validation (defense in depth — UI also validates)
	if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
		return renderNewServerPage(c, user, { error: "Name must be 1-32 chars, lowercase, start with a letter", values: { name, region, size, image } });
	}
	if (!region || !size || !image) {
		return renderNewServerPage(c, user, { error: "Please pick a location, server type, and image", values: { name, region, size, image } });
	}

	try {
		const { createServerForUser } = await import("./server-create");
		const result = await createServerForUser(
			c.env,
			user.id,
			{ name, size, region, image },
			c.req.url,
		);
		const msg = result.mode === "stub"
			? `Stub server '${name}' created (no Hetzner token — no real VM).`
			: `Server '${name}' provisioning — agent will auto-register in ~30-60s.`;
		return c.redirect(`/servers?toast=success&msg=${encodeURIComponent(msg)}`);
	} catch (e: any) {
		// Always append the submitted form values to the error so the
		// user can paste the whole thing (original error + what we
		// tried) into a bug report without retyping. The CSS uses
		// `white-space: pre-line` so the indented block renders cleanly.
		const submitted = `\n\nSubmitted:\n  name:   ${name}\n  region: ${region}\n  size:   ${size}\n  image:  ${image}`;
		const errMsg = (e?.message || String(e)) + submitted;
		return renderNewServerPage(c, user, { error: errMsg, values: { name, region, size, image } });
	}
});

app.get("/projects", requireSession, async (c) => {
	return renderProjectsPage(c, c.get("user"));
});

app.get("/deployments", requireSession, async (c) => {
	const projectFilter = c.req.query("project") ?? null;
	const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
	const perPage = Math.min(100, Math.max(1, parseInt(c.req.query("per_page") || "20", 10) || 20));
	return renderDeploymentsPage(c, c.get("user"), projectFilter, page, perPage);
});

app.get("/deployments/:id", requireSession, async (c) => {
	return renderDeploymentLogsPage(c, c.get("user"), c.req.param("id"));
});

app.get("/settings", requireSession, async (c) => {
	const flash = {
		kind: c.req.query("toast") || null,
		msg: c.req.query("msg") || null,
	};
	return renderSettingsPage(c, c.get("user"), flash);
});

// Project switcher — sets the current_project_id cookie based on dropdown selection.
// Empty value clears the cookie (returns to "All projects" view).
app.post("/projects/select", requireSession, async (c) => {
	const { setCurrentProject } = await import("./state");
	const form = await c.req.parseBody();
	const projectId = String((form as Record<string, string>)["project_id"] || "").trim();
	const result = await setCurrentProject(c, projectId);
	if (!result.ok) return c.text("project not found or access denied", 403);
	// Redirect back to the page that triggered the switch (referer) or dashboard
	const referer = c.req.header("referer");
	if (referer && new URL(referer).origin === new URL(c.req.url).origin) {
		return c.redirect(referer);
	}
	return c.redirect("/dashboard");
});

// Provider credential management (HTML form posts, requires session)
app.post("/settings/hetzner", requireSession, async (c) => {
	const { setProviderToken, verifyHetznerToken } = await import("./credentials");
	const form = await c.req.parseBody();
	const token = (form as Record<string, string>)["token"]?.trim();
	if (!token) return c.redirect("/settings?toast=error&msg=missing+token");
	if (!/^[A-Za-z0-9_=+-]{30,}$/.test(token)) {
		return c.redirect("/settings?toast=error&msg=invalid+token+format+%28too+short+or+has+weird+chars%29");
	}
	// Live API verification — token must actually work, not just look right.
	const verify = await verifyHetznerToken(token);
	if (!verify.ok) {
		return c.redirect(
			`/settings?toast=error&msg=${encodeURIComponent(verify.reason || "Token verification failed")}`,
		);
	}
	await setProviderToken(c.env, c.get("user").id, "hetzner", token, verify.datacenters);
	return c.redirect(
		`/settings?toast=success&msg=${encodeURIComponent(`Hetzner token saved (verified — ${verify.datacenters} datacenters reachable)`)}`,
	);
});

app.post("/settings/hetzner/test", requireSession, async (c) => {
	// Just verify the token without saving. Returns JSON so the client
	// can tell success from failure (vs always-302 redirect which the
	// client can't distinguish).
	const { verifyHetznerToken } = await import("./credentials");
	const form = await c.req.parseBody();
	const token = (form as Record<string, string>)["token"]?.trim() || "";
	if (!token) return c.json({ ok: false, reason: "missing token" }, 400);
	if (!/^[A-Za-z0-9_=+-]{30,}$/.test(token)) {
		return c.json({ ok: false, reason: "invalid format (too short or has weird chars)" }, 400);
	}
	const verify = await verifyHetznerToken(token);
	if (!verify.ok) {
		return c.json({ ok: false, reason: verify.reason || "verification failed" }, 400);
	}
	return c.json({ ok: true, datacenters: verify.datacenters });
});

app.post("/settings/hetzner/delete", requireSession, async (c) => {
	const { deleteProviderToken } = await import("./credentials");
	await deleteProviderToken(c.env, c.get("user").id, "hetzner");
	return c.redirect("/settings?toast=success&msg=Hetzner+token+deleted");
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
		.prepare("SELECT id, name, provider_server_id FROM servers WHERE id = ? AND user_id = ?")
		.bind(serverId, user.id)
		.first<{ id: string; name: string; provider_server_id: string | null }>();
	if (!srv) return c.redirect("/servers?toast=error&msg=server+not+found");

	let hetznerMsg = "";
	if (srv.provider_server_id) {
		try {
			const { getProviderToken } = await import("./credentials");
			const { deleteServer } = await import("./hetzner");
			const token = await getProviderToken(env, user.id, "hetzner");
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
			"SELECT id, provider_server_id, status, hetzner_project_id, hetzner_project_name FROM servers WHERE id = ? AND user_id = ?",
		)
		.bind(serverId, user.id)
		.first<{ id: string; provider_server_id: string | null; status: string; hetzner_project_id: number | null; hetzner_project_name: string | null }>();
	if (!srv) return c.redirect("/servers?toast=error&msg=server+not+found");

	if (!srv.provider_server_id) {
		return c.redirect("/servers?toast=error&msg=no+hetzner+id+for+this+server");
	}

	// 2. Resolve the Hetzner token
	const { getProviderToken } = await import("./credentials");
	const { getServer, listProjects } = await import("./hetzner");
	const token = await getProviderToken(env, user.id, "hetzner");
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
