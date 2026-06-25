/**
 * void Worker — GitHub OAuth + session management
 *
 * Flow:
 *   1. GET  /api/auth/github       → 302 to GitHub OAuth
 *   2. GET  /api/auth/callback    → exchange code, set session cookie, redirect to /
 *   3. GET  /api/auth/me          → return current user JSON
 *   4. POST /api/auth/logout      → clear session
 *
 * Sessions are stored in KV with 30-day TTL. Cookie is HttpOnly, Secure, SameSite=Lax.
 */

import { Env } from "./env";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

/**
 * Verify Bearer token on /api/* and /mcp. Returns null if authorized,
 * or a 401 Response if not. Fail-closed: if no token is configured,
 * all requests are denied (503).
 */
export function requireBearer(env: Env, request: Request): Response | null {
	if (!env.VOID_BEARER_TOKEN) {
		return new Response(
			JSON.stringify({
				error: "auth_not_configured",
				message:
					"VOID_BEARER_TOKEN not set. Set via: wrangler secret put VOID_BEARER_TOKEN",
			}),
			{ status: 503, headers: { "content-type": "application/json" } },
		);
	}
	const auth = request.headers.get("Authorization") || "";
	// Support both "Bearer X" and "?token=X" (for dev convenience with MCP clients)
	let token = "";
	if (auth.startsWith("Bearer ")) {
		token = auth.slice(7).trim();
	} else {
		try {
			const url = new URL(request.url);
			token = url.searchParams.get("token") || "";
		} catch {}
	}
	if (!token || token !== env.VOID_BEARER_TOKEN) {
		return new Response(
			JSON.stringify({ error: "unauthorized", message: "invalid or missing bearer token" }),
			{ status: 401, headers: { "content-type": "application/json" } },
		);
	}
	return null;
}

/**
 * Constant-time string compare to prevent timing attacks on secrets.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

interface GithubUser {
	login: string;
	id: number;
	avatar_url: string;
	name: string | null;
	email: string | null;
}

interface GithubTokenResponse {
	access_token: string;
	token_type: string;
	scope: string;
	error?: string;
	error_description?: string;
}

export async function getSessionUser(env: Env, request: Request): Promise<{ id: string; username: string; avatar_url: string | null } | null> {
	const cookie = request.headers.get("Cookie") || "";
	const match = cookie.match(/(?:^|;\s*)void_session=([a-f0-9-]{36})/);
	if (!match) return null;
	const sessionId = match[1];
	const session = await env.ROUTES.get(`session:${sessionId}`, "json") as { user_id: string; username: string; avatar_url: string | null } | null;
	if (!session) return null;
	// Confirm user still exists in D1
	const user = await env.void_db
		.prepare("SELECT id, username, avatar_url FROM users WHERE id = ?")
		.bind(session.user_id)
		.first<{ id: string; username: string; avatar_url: string | null }>();
	return user;
}

export async function handleAuthStart(request: Request, env: Env): Promise<Response> {
	if (!env.GITHUB_CLIENT_ID) {
		return new Response("GITHUB_CLIENT_ID not configured", { status: 503 });
	}
	const url = new URL(request.url);
	const redirectUri = `${url.origin}/api/auth/callback`;
	const state = crypto.randomUUID();
	// Stash state in KV for CSRF check
	await env.ROUTES.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

	const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
	authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
	authorizeUrl.searchParams.set("redirect_uri", redirectUri);
	authorizeUrl.searchParams.set("scope", "read:user user:email");
	authorizeUrl.searchParams.set("state", state);
	authorizeUrl.searchParams.set("allow_signup", "true");

	return Response.redirect(authorizeUrl.toString(), 302);
}

export async function handleAuthCallback(request: Request, env: Env): Promise<Response> {
	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
		return new Response("GitHub OAuth not configured", { status: 503 });
	}
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const error = url.searchParams.get("error");

	if (error) {
		return Response.redirect(`${url.origin}/?error=${encodeURIComponent(error)}`, 302);
	}
	if (!code || !state) {
		return new Response("missing code or state", { status: 400 });
	}

	// CSRF check
	const stored = await env.ROUTES.get(`oauth_state:${state}`);
	if (!stored) {
		return new Response("invalid state", { status: 400 });
	}
	await env.ROUTES.delete(`oauth_state:${state}`);

	// Exchange code for access token
	const tokenResp = await fetch(GITHUB_TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			client_id: env.GITHUB_CLIENT_ID,
			client_secret: env.GITHUB_CLIENT_SECRET,
			code,
			redirect_uri: `${url.origin}/api/auth/callback`,
		}),
	});
	const tokenData = (await tokenResp.json()) as GithubTokenResponse;
	if (tokenData.error) {
		return new Response(`OAuth error: ${tokenData.error_description || tokenData.error}`, { status: 400 });
	}

	// Fetch user info
	const userResp = await fetch(GITHUB_USER_URL, {
		headers: {
			Authorization: `Bearer ${tokenData.access_token}`,
			Accept: "application/json",
			"User-Agent": "void-paas",
		},
	});
	const ghUser = (await userResp.json()) as GithubUser;

	// Upsert user in D1
	const userId = `usr_${ghUser.id}`;
	const now = Math.floor(Date.now() / 1000);
	const existing = await env.void_db
		.prepare("SELECT id FROM users WHERE id = ?")
		.bind(userId)
		.first();
	if (existing) {
		await env.void_db
			.prepare(
				"UPDATE users SET username = ?, avatar_url = ?, gh_access_token = ? WHERE id = ?",
			)
			.bind(ghUser.login, ghUser.avatar_url, tokenData.access_token, userId)
			.run();
	} else {
		await env.void_db
			.prepare(
				"INSERT INTO users (id, github_id, username, avatar_url, gh_access_token, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind(userId, String(ghUser.id), ghUser.login, ghUser.avatar_url, tokenData.access_token, now)
			.run();
	}

	// Create session
	const sessionId = crypto.randomUUID();
	await env.ROUTES.put(
		`session:${sessionId}`,
		JSON.stringify({ user_id: userId, username: ghUser.login, avatar_url: ghUser.avatar_url }),
		{ expirationTtl: SESSION_TTL_SECONDS },
	);

	// Set cookie and redirect
	const cookie = `void_session=${sessionId}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
	return new Response(null, {
		status: 302,
		headers: {
			Location: `${url.origin}/`,
			"Set-Cookie": cookie,
		},
	});
}

export async function handleAuthMe(request: Request, env: Env): Promise<Response> {
	const user = await getSessionUser(env, request);
	if (!user) {
		return new Response(JSON.stringify({ authenticated: false }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}
	return new Response(JSON.stringify({ authenticated: true, user }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

export async function handleAuthLogout(request: Request, env: Env): Promise<Response> {
	const cookie = request.headers.get("Cookie") || "";
	const match = cookie.match(/(?:^|;\s*)void_session=([a-f0-9-]{36})/);
	if (match) {
		await env.ROUTES.delete(`session:${match[1]}`);
	}
	const url = new URL(request.url);
	return new Response(null, {
		status: 302,
		headers: {
			Location: `${url.origin}/`,
			"Set-Cookie": "void_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
		},
	});
}

/**
 * Minimal landing page HTML. Server-rendered with optional user info.
 * No build step, no SPA — just plain HTML + tiny inline JS.
 */
export function renderLandingHtml(opts: {
	user: { username: string; avatar_url: string | null } | null;
	installed: boolean;
	cf_tunnel: boolean;
	github_webhook: boolean;
}): string {
	const userBlock = opts.user
		? `<div class="user">
        <img src="${opts.user.avatar_url || ""}" alt="" width="32" height="32">
        <span>@${escapeHtml(opts.user.username)}</span>
        <a href="/api/auth/logout" class="link-mute">logout</a>
      </div>`
		: `<a href="/api/auth/github" class="btn btn-primary">Sign in with GitHub</a>`;

	const featureList = [
		{ name: "GitHub OAuth", on: opts.installed, missing: "GITHUB_CLIENT_ID/SECRET" },
		{ name: "GitHub webhook", on: opts.github_webhook, missing: "GITHUB_WEBHOOK_SECRET" },
		{ name: "Cloudflare tunnel", on: opts.cf_tunnel, missing: "CF_API_TOKEN/ACCOUNT/ZONE" },
		{ name: "Hetzner provisioning", on: !!opts.installed, missing: "HETZNER_TOKEN" },
	].map(
		(f) =>
			`<li><span class="dot ${f.on ? "on" : "off"}"></span>${f.name} <code>${escapeHtml(f.missing)}</code></li>`,
	).join("");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>void — Vercel DX, Hetzner bill, No SSH</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;background:#000;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .wrap{max-width:780px;width:100%}
  h1{font-size:4rem;font-weight:800;letter-spacing:-0.04em;line-height:1;margin-bottom:24px}
  h1 span{background:linear-gradient(120deg,#fff 0%,#666 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .sub{font-size:1.25rem;color:#999;margin-bottom:32px;line-height:1.5}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:32px}
  .card{background:#0a0a0a;border:1px solid #222;border-radius:12px;padding:20px;transition:border-color 0.2s}
  .card:hover{border-color:#444}
  .card h3{font-size:0.85rem;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:8px}
  .card .val{font-size:1.75rem;font-weight:700;line-height:1}
  .card .sub2{font-size:0.85rem;color:#666;margin-top:4px}
  .actions{display:flex;gap:12px;margin-bottom:32px;flex-wrap:wrap}
  .btn{display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border-radius:8px;font-size:0.95rem;font-weight:600;text-decoration:none;border:1px solid transparent;transition:all 0.15s;cursor:pointer}
  .btn-primary{background:#fff;color:#000}
  .btn-primary:hover{background:#ddd}
  .btn-secondary{background:#1a1a1a;color:#fff;border-color:#333}
  .btn-secondary:hover{border-color:#555;background:#222}
  .features{background:#0a0a0a;border:1px solid #222;border-radius:12px;padding:20px;margin-bottom:24px}
  .features h3{font-size:0.85rem;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:12px}
  .features ul{list-style:none}
  .features li{padding:6px 0;color:#ccc;font-size:0.9rem;display:flex;align-items:center;gap:8px}
  .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .dot.on{background:#0f0;box-shadow:0 0 8px #0f0}
  .dot.off{background:#555}
  .features code{background:#1a1a1a;padding:1px 6px;border-radius:4px;color:#888;font-size:0.8rem;margin-left:auto;font-family:ui-monospace,monospace}
  .user{display:flex;align-items:center;gap:8px;margin-bottom:16px;padding:8px 12px;background:#0a0a0a;border-radius:8px;width:fit-content}
  .user img{border-radius:50%}
  .link-mute{color:#666;text-decoration:none;font-size:0.85rem;margin-left:8px}
  .link-mute:hover{color:#fff}
  .endpoints{background:#0a0a0a;border:1px solid #222;border-radius:12px;padding:20px}
  .endpoints h3{font-size:0.85rem;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:12px}
  .endpoints code{display:block;padding:8px 12px;background:#000;border-radius:6px;color:#0f0;font-size:0.85rem;margin-bottom:4px;font-family:ui-monospace,monospace;overflow-x:auto}
  .endpoints .method{display:inline-block;padding:1px 6px;border-radius:3px;font-size:0.7rem;margin-right:8px;background:#222;color:#888}
  .endpoints .method.get{background:#0a3320;color:#0f0}
  .endpoints .method.post{background:#33220a;color:#f90}
</style>
</head>
<body>
<div class="wrap">
  <h1>deployed <span>into the void</span></h1>
  <p class="sub">Self-hosted, edge-driven PaaS. Vercel DX, Hetzner bill, No SSH. Your AI deploys from Cursor.</p>

  <div class="user">${userBlock}</div>

  <div class="actions">
    ${opts.user ? `
      <a href="/servers" class="btn btn-secondary">Servers</a>
      <a href="/projects" class="btn btn-secondary">Projects</a>
      <a href="/deployments" class="btn btn-secondary">Deployments</a>
      <a href="/api/auth/github?action=new-server" class="btn btn-primary">+ New Server</a>
    ` : `
      <a href="/api/auth/github" class="btn btn-primary">Get started with GitHub</a>
      <a href="https://github.com/void-sh/void" class="btn btn-secondary">View on GitHub</a>
    `}
  </div>

  <div id="panel"></div>

  <div class="features">
    <h3>Configuration status</h3>
    <ul>${featureList}</ul>
  </div>

  <div class="endpoints">
    <h3>MCP tools (for your AI)</h3>
    <code><span class="method post">POST</span>/mcp — MCP Streamable HTTP endpoint</code>
    <code>tools: void_list_servers, void_create_server, void_deploy, void_get_logs, void_teardown, void_register_project, void_ping_agent</code>
  </div>

  <div class="endpoints" style="margin-top:16px">
    <h3>Connect your AI — paste into Claude Desktop / Cursor / Cline</h3>
    <code>{
  "mcpServers": {
    "void": {
      "url": "https://void.retraut.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_BEARER_TOKEN"
      }
    }
  }
}</code>
    <p style="color:#666;font-size:0.8rem;margin-top:8px">Set <code>VOID_BEARER_TOKEN</code> via <code>wrangler secret put VOID_BEARER_TOKEN</code> (use <code>openssl rand -hex 32</code>). Restart your AI client to load the MCP server.</p>
  </div>
</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
