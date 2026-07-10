/**
 * void Worker — GitHub OAuth + session management
 *
 * Flow:
 *   1. GET  /api/auth/github       → 302 to GitHub OAuth
 *   2. GET  /api/auth/callback    → exchange code, set session cookie, redirect to /
 *   3. GET  /api/auth/me          → return current user JSON
 *   4. POST /api/auth/logout      → clear session
 *
 * Sessions are stored in KV with 30-day TTL. Cookie uses Hono's helper
 * for set/get/delete — battle-tested against subtle hand-rolled bugs.
 * __Host- prefix enforces: secure + path=/ + no domain (RFC 6265bis-13).
 */

import type { Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { Env } from "./env";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

/**
 * Session cookie options. Used for both setCookie and deleteCookie so
 * the delete matches the set exactly (path, secure, etc.) — required
 * for the browser to actually remove it.
 */
export const SESSION_COOKIE_OPTS = {
	path: "/",
	secure: true,
	httpOnly: true,
	sameSite: "Lax" as const,
	maxAge: SESSION_TTL_SECONDS,
};
// Dev/test-lab cookie name + opts. The production name uses the
// `__Host-` prefix, which REQUIRES the Secure flag — and a Secure
// cookie is never sent over plain http://localhost. The test-lab runs
// on http://127.0.0.1:8787 (no TLS), so we use a non-prefixed,
// non-Secure cookie there, otherwise the dev-login session is dropped
// by the browser and every protected page redirects to GitHub OAuth
// (which 503s with "GITHUB_CLIENT_ID not configured" because the lab
// has no GitHub app). Only used when VOID_DEV_AUTH is enabled.
export const SESSION_COOKIE_NAME_DEV = "void_session_dev";
export const SESSION_COOKIE_OPTS_DEV = {
	path: "/",
	httpOnly: true,
	sameSite: "Lax" as const,
	maxAge: SESSION_TTL_SECONDS,
};
// Cookie name uses __Host- prefix: browser enforces path=/, secure,
// no Domain. Prevents subdomain cookie injection.
export const SESSION_COOKIE_NAME = "__Host-void_session";

/**
 * Create a session for the given user and set the session cookie.
 * Used by both the GitHub OAuth callback and the passkey login flow
 * (both end up "logged in" the same way). Idempotent in the sense
 * that the caller decides what to do with the response.
 */
export async function createSession(
	c: Context,
	user: { id: string; username: string; avatar_url: string | null },
	dev = false,
): Promise<void> {
	const sessionId = crypto.randomUUID();
	await c.env.ROUTES.put(
		`session:${sessionId}`,
		JSON.stringify({ user_id: user.id, username: user.username, avatar_url: user.avatar_url }),
		{ expirationTtl: SESSION_TTL_SECONDS },
	);
	if (dev) {
		setCookie(c, SESSION_COOKIE_NAME_DEV, sessionId, SESSION_COOKIE_OPTS_DEV);
	} else {
		setCookie(c, SESSION_COOKIE_NAME, sessionId, SESSION_COOKIE_OPTS);
	}
}

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

export async function getSessionUser(c: Context): Promise<{ id: string; username: string; avatar_url: string | null } | null> {
	const env = c.env;
	// The test-lab (VOID_DEV_AUTH) sets a non-Secure, non-prefixed cookie
	// so it survives over plain http://localhost. Try it first when the
	// dev bypass is enabled, falling back to the production cookie.
	let sessionId = env.VOID_DEV_AUTH === "1" || env.VOID_DEV_AUTH === "true"
		? getCookie(c, SESSION_COOKIE_NAME_DEV)
		: undefined;
	if (!sessionId) sessionId = getCookie(c, SESSION_COOKIE_NAME);
	if (!sessionId) return null;
	const session = await env.ROUTES.get(`session:${sessionId}`, "json") as { user_id: string; username: string; avatar_url: string | null } | null;
	if (!session) return null;
	// Confirm user still exists in D1
	const user = (await env.void_db
		.prepare("SELECT id, username, avatar_url FROM users WHERE id = ?")
		.bind(session.user_id)
		.first()) as { id: string; username: string; avatar_url: string | null } | null;
	return user;
}

/**
 * Only allow returnTo paths that are same-origin relative paths (start with
 * a single "/", no "//", no scheme). Prevents open-redirect attacks via
 * the OAuth flow.
 */
function safeReturnTo(raw: string | null): string {
	if (!raw) return "/";
	if (!raw.startsWith("/")) return "/";
	if (raw.startsWith("//")) return "/";
	if (raw.includes("\n") || raw.includes("\r")) return "/";
	return raw;
}

export async function handleAuthStart(c: Context): Promise<Response> {
	const env = c.env;
	if (!env.GITHUB_CLIENT_ID) {
		return c.text("GITHUB_CLIENT_ID not configured", 503);
	}
	const url = new URL(c.req.url);
	const redirectUri = `${url.origin}/api/auth/callback`;
	const state = crypto.randomUUID();
	const returnTo = safeReturnTo(url.searchParams.get("returnTo"));

	// Stash state + returnTo in KV. Value is JSON so we can extend later
	// (e.g. tenant selection) without breaking existing state tokens.
	await env.ROUTES.put(`oauth_state:${state}`, JSON.stringify({ returnTo }), {
		expirationTtl: 600,
	});

	const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
	authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
	authorizeUrl.searchParams.set("redirect_uri", redirectUri);
	authorizeUrl.searchParams.set("scope", "read:user user:email");
	authorizeUrl.searchParams.set("state", state);
	authorizeUrl.searchParams.set("allow_signup", "true");

	return c.redirect(authorizeUrl.toString(), 302);
}

export async function handleAuthCallback(c: Context): Promise<Response> {
	const env = c.env;
	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
		return c.text("GitHub OAuth not configured", 503);
	}
	const url = new URL(c.req.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const error = url.searchParams.get("error");

	if (error) {
		return c.redirect(`${url.origin}/?error=${encodeURIComponent(error)}`, 302);
	}
	if (!code || !state) {
		return c.text("missing code or state", 400);
	}

	// CSRF check (also retrieve returnTo we stashed at /api/auth/github)
	const stored = await env.ROUTES.get(`oauth_state:${state}`);
	if (!stored) {
		return c.text("invalid state", 400);
	}
	let returnTo = "/";
	try {
		const parsed = JSON.parse(stored);
		if (parsed && typeof parsed.returnTo === "string") {
			returnTo = safeReturnTo(parsed.returnTo);
		}
	} catch {
		// legacy state values were just "1" — treat as no returnTo
	}
	await env.ROUTES.delete(`oauth_state:${state}`); // single-use

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
		return c.text(`OAuth error: ${tokenData.error_description || tokenData.error}`, 400);
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

	// Create session — shared with passkey login so both flows produce
	// the same session shape (KV key, cookie name, cookie attributes).
	await createSession(c, {
		id: userId,
		username: ghUser.login,
		avatar_url: ghUser.avatar_url,
	});

	// Show a brief "welcome" interstitial so the user can see the OAuth
	// round-trip happened. Without this, /servers → OAuth → /servers looks
	// like nothing happened (the user thought logout was broken because
	// the silent re-auth felt like staying logged in).
	return c.html(authInterstitial({
		kind: "login",
		username: ghUser.login,
		avatarUrl: ghUser.avatar_url,
		redirectTo: `${url.origin}${returnTo}`,
		delayMs: 2500,
	}));
}

/**
 * Brief interstitial page shown between OAuth completion and the final
 * redirect. Solves two UX problems:
 *
 * 1. Login: the OAuth round-trip (browser → GitHub → callback → app) is
 *    instant if the user is already logged into GitHub. Looks like
 *    "nothing happened" — the user thought logout was broken because
 *    the silent re-auth felt like staying logged in.
 *
 * 2. Logout: the immediate 302 to / leaves no time to see the logout
 *    was successful. With this page, the user sees a "Logged out"
 *    confirmation before being redirected.
 *
 * Page is server-rendered, no JS framework, ~50 lines. Auto-redirects
 * after `delayMs` via inline setTimeout. Spinner is pure CSS.
 */
function authInterstitial(opts: {
	kind: "login" | "logout";
	username?: string;
	avatarUrl?: string | null;
	redirectTo: string;
	delayMs: number;
}): string {
	const title =
		opts.kind === "login"
			? `Welcome back, @${opts.username}`
			: "Signed out";
	const subtitle =
		opts.kind === "login"
			? "Signed in via GitHub"
			: "The void will be empty without you.";
	const tagline =
		opts.kind === "login" ? "almost there…" : "on the way out…";
	const avatar =
		opts.avatarUrl && opts.kind === "login"
			? `<img class="avatar" src="${opts.avatarUrl}" alt="">`
			: `<div class="avatar avatar-empty">∅</div>`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escapeHtml(title)} · void</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#000;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#0a0a0a;border:1px solid #222;border-radius:16px;padding:40px 48px;text-align:center;max-width:380px;width:100%;animation:pop 240ms cubic-bezier(.34,1.56,.64,1) both}
  @keyframes pop{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}
  .avatar{width:64px;height:64px;border-radius:50%;margin:0 auto 20px;display:block;animation:pop 320ms cubic-bezier(.34,1.56,.64,1) .05s both}
  .avatar-empty{background:#0a3320;color:#0f0;font-size:32px;line-height:64px;font-weight:600}
  h1{font-size:1.35rem;font-weight:700;margin-bottom:8px;letter-spacing:-0.01em}
  p{color:#888;font-size:0.9rem;margin-bottom:24px}
  .progress{height:3px;background:#1a1a1a;border-radius:2px;overflow:hidden;margin-bottom:8px}
  .progress-bar{height:100%;background:linear-gradient(90deg,#fff,#888);width:0;animation:fill ${opts.delayMs}ms linear forwards}
  @keyframes fill{from{width:0}to{width:100%}}
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid #333;border-top-color:#fff;border-radius:50%;animation:spin 700ms linear infinite;vertical-align:middle;margin-right:6px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .skip{color:#666;font-size:0.8rem;text-decoration:underline;margin-top:8px;display:inline-block}
</style>
</head>
<body>
<div class="card">
  ${avatar}
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(subtitle)}</p>
  <div class="progress"><div class="progress-bar"></div></div>
  <p><span class="spinner"></span>${escapeHtml(tagline)}</p>
  <a class="skip" href="${escapeHtml(opts.redirectTo)}">skip →</a>
</div>
<script>
  setTimeout(function(){ window.location.href = ${JSON.stringify(opts.redirectTo)}; }, ${opts.delayMs});
</script>
</body>
</html>`;
}

export async function handleAuthMe(c: Context): Promise<Response> {
	const user = await getSessionUser(c);
	if (!user) {
		return c.json({ authenticated: false });
	}
	return c.json({ authenticated: true, user });
}

export async function handleAuthLogout(c: Context): Promise<Response> {
	const env = c.env;
	const sessionId = getCookie(c, SESSION_COOKIE_NAME);
	if (sessionId) {
		await env.ROUTES.delete(`session:${sessionId}`);
	}
	// Clear the dev cookie too (test-lab runs over plain http://localhost
	// with a non-Secure, non-prefixed cookie — see createSession dev path).
	const devSessionId = env.VOID_DEV_AUTH === "1" || env.VOID_DEV_AUTH === "true"
		? getCookie(c, SESSION_COOKIE_NAME_DEV)
		: undefined;
	if (devSessionId) {
		await env.ROUTES.delete(`session:${devSessionId}`);
	}
	// Hono's deleteCookie constructs an Expires=Thu, 01 Jan 1970 + Max-Age=0
	// Set-Cookie with the same attributes (path, secure, etc.) as setCookie.
	// This is the RFC-compliant way to delete a cookie — attributes must match.
	deleteCookie(c, SESSION_COOKIE_NAME, SESSION_COOKIE_OPTS);
	if (devSessionId) {
		deleteCookie(c, SESSION_COOKIE_NAME_DEV, SESSION_COOKIE_OPTS_DEV);
	}
	c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
	c.header("Pragma", "no-cache");

	// Show "Logged out" interstitial so the user sees the logout was
	// successful. Without this, the immediate redirect to / makes it
	// look like nothing happened.
	return c.html(authInterstitial({
		kind: "logout",
		redirectTo: new URL("/", c.req.url).toString(),
		delayMs: 1500,
	}));
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
	devAuth: boolean; // true when VOID_DEV_AUTH is enabled (test-lab only)
	// The dev-login button itself lives in src/auth-dev.ts and is
	// injected by dev-entry middleware via a marker. We just emit
	// the marker in production HTML so nothing dev-related is in
	// the production bundle's response body.
	// (The marker is a static string defined here — see DEV_AUTH_BUTTON_MARKER.)
	devAuthButtonMarker?: string;
}): string {
	const featureList = [
		{ name: "GitHub OAuth", on: opts.installed, missing: "GITHUB_CLIENT_ID/SECRET" },
		{ name: "GitHub webhook", on: opts.github_webhook, missing: "GITHUB_WEBHOOK_SECRET" },
		{ name: "Cloudflare tunnel", on: opts.cf_tunnel, missing: "CF_API_TOKEN/ACCOUNT/ZONE" },
		{ name: "Hetzner provisioning", on: !!opts.installed, missing: "HETZNER_TOKEN" },
	];
	if (opts.devAuth) {
		featureList.push({ name: "Dev auth (local-only)", on: true, missing: "VOID_DEV_AUTH=1" });
	}
	const featuresHtml = featureList
		.map(
			(f) =>
				`<li><span class="dot ${f.on ? "on" : "off"}"></span>${f.name} <code>${escapeHtml(f.missing)}</code></li>`,
		)
		.join("");

	// Marker comment for the dev-login button. The dev-entry
	// middleware replaces this with the actual button HTML.
	// The marker is a static string so it appears in both
	// production and dev bundles; only dev-entry replaces it.
	const devAuthButtonMarker = opts.devAuthButtonMarker ?? "";

	// Banner shown when GitHub OAuth is not properly configured (placeholder values)
	// or when a real value is set. Tells the user exactly what to do.
	const oauthBanner = opts.installed
		? ""
		: `<div class="banner">
			<strong>GitHub OAuth not configured.</strong>
			The placeholder <code>GITHUB_CLIENT_ID</code> / <code>GITHUB_CLIENT_SECRET</code> from <code>wrangler.jsonc</code> is in use — clicking "Get started" will 404.
			<br><br>
			<strong>Fix:</strong> create an OAuth app at
			<a href="https://github.com/settings/developers" target="_blank" rel="noopener">github.com/settings/developers</a>
			(callback: <code>${escapeHtml("https://void.retraut.workers.dev/api/auth/callback")}</code>),
			then run:
			<br><br>
			<code>cd worker && npx wrangler secret put GITHUB_CLIENT_ID</code>
			<br>
			<code>npx wrangler secret put GITHUB_CLIENT_SECRET</code>
			<br>
			<code>npx wrangler secret put COOKIE_SECRET</code> &nbsp;<span style="color:#666">(any random 32+ char string)</span>
		</div>`;

	// Octocat (GitHub Mark) — single inline SVG, white on dark.
	// viewBox 16x16 scales cleanly to any size.
	const octocat = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

	const topRight = `<div class="top-right">
		<a href="https://github.com/void-sh/void" class="gh-link" target="_blank" rel="noopener" title="View on GitHub">${octocat}</a>
		${opts.user ? `<details class="user-menu">
			<summary>
				<img src="${escapeHtml(opts.user.avatar_url || "")}" alt="" width="24" height="24">
				<span>@${escapeHtml(opts.user.username)}</span>
			</summary>
			<div class="user-menu-pop">
				<a href="/servers">Servers</a>
				<a href="/projects">Projects</a>
				<a href="/deployments">Deployments</a>
				<hr>
				<a href="/api/auth/logout">logout</a>
			</div>
		</details>` : ""}
	</div>`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>void — Best DX. Hetzner pricing. No SSH.</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;
    background:#000;
    color:#fff;
    min-height:100vh;
    display:flex;align-items:center;justify-content:center;
    padding:24px;
    position:relative;
  }
  /* Glass slab — radial gradient makes the background feel like a
     frosted glass panel in the dark, lighter on the upper-left, fading
     to pure black on the right/bottom. The 1px noise SVG overlay adds
     a subtle film-grain texture so it doesn't look flat. */
  body::before{
    content:"";position:fixed;inset:0;z-index:-2;pointer-events:none;
    background:
      radial-gradient(ellipse 70% 60% at 25% 40%, #1c1c1c 0%, #0a0a0a 45%, #000 80%),
      linear-gradient(135deg, #161616 0%, #050505 60%, #000 100%);
  }
  body::after{
    content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:0.5;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.025 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
    mix-blend-mode:overlay;
  }
  /* The wrap is a subtle glass card — translucent with a thin
     highlight on top, gives the H1 the "etched in glass" look */
  .wrap{
    max-width:820px;width:100%;position:relative;
    padding:48px 40px;
    border-radius:24px;
    background:linear-gradient(135deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0.005) 100%);
    border:1px solid rgba(255,255,255,0.06);
    box-shadow:
      0 20px 60px rgba(0,0,0,0.5),
      inset 0 1px 0 rgba(255,255,255,0.08);
    backdrop-filter:blur(20px);
    -webkit-backdrop-filter:blur(20px);
  }
  .top-right{position:absolute;top:20px;right:24px;display:flex;align-items:center;gap:12px;z-index:2}
  .gh-link{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;color:#888;transition:color 0.15s,background 0.15s;border-radius:8px}
  .gh-link:hover{color:#fff;background:rgba(255,255,255,0.04)}
  .gh-link svg{width:22px;height:22px}
  .user-menu{position:relative}
  .user-menu summary{list-style:none;display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;cursor:pointer;color:#999;font-size:0.9rem;transition:background 0.15s;user-select:none}
  .user-menu summary::-webkit-details-marker{display:none}
  .user-menu summary:hover{background:#1a1a1a;color:#fff}
  .user-menu[open] summary{background:#1a1a1a;color:#fff}
  .user-menu img{border-radius:50%;display:block}
  .user-menu-pop{position:absolute;top:calc(100% + 8px);right:0;background:#0a0a0a;border:1px solid #222;border-radius:10px;padding:6px;min-width:180px;box-shadow:0 10px 30px rgba(0,0,0,0.5);z-index:10;display:flex;flex-direction:column;gap:2px}
  .user-menu-pop a{display:block;padding:8px 12px;border-radius:6px;color:#ccc;font-size:0.9rem;text-decoration:none;transition:background 0.1s}
  .user-menu-pop a:hover{background:#1a1a1a;color:#fff}
  .user-menu-pop hr{border:0;border-top:1px solid #222;margin:4px 6px}
  h1{font-size:4.5rem;font-weight:800;letter-spacing:-0.05em;line-height:1;margin-bottom:24px;position:relative}
  /* H1 text: white→gray gradient etched into the glass. The "ship to"
     part is bright (lit by the highlight from upper-left), "the void"
     fades into the glass edge on the right. */
  h1 span{
    background:linear-gradient(95deg, #fff 0%, #f0f0f0 30%, #888 75%, #555 100%);
    -webkit-background-clip:text;
    -webkit-text-fill-color:transparent;
    background-clip:text;
    /* Subtle inner glow so the text looks like it has light behind it */
    filter:drop-shadow(0 0 30px rgba(255,255,255,0.04));
  }
  h1 .o{display:inline-block;font-size:1.05em;font-weight:200;vertical-align:-0.06em;margin:0 -0.04em;animation:o-spin 12s linear infinite}
  @keyframes o-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
  .sub{font-size:1.25rem;color:#999;margin-bottom:32px;line-height:1.5}
  .taglines{position:relative;height:3.4em;margin-bottom:12px;font-size:1.25rem;color:#999;line-height:1.5;overflow:hidden}
  .tagline{position:absolute;top:0;left:0;right:0;opacity:0;transform:translateY(10px);animation:tagline-cycle 20s linear infinite}
  .tagline.t1{animation-delay:0s}.tagline.t2{animation-delay:5s}.tagline.t3{animation-delay:10s}.tagline.t4{animation-delay:15s}
  @keyframes tagline-cycle{0%{opacity:0;transform:translateY(10px)}3%{opacity:1;transform:translateY(0)}22%{opacity:1;transform:translateY(0)}27%{opacity:0;transform:translateY(-10px)}100%{opacity:0;transform:translateY(-10px)}}
  .tagline-dots{display:flex;gap:6px;margin-bottom:32px}
  .tagline-dots .dot{width:5px;height:5px;border-radius:50%;background:#333;transition:background 0.3s}
  .tagline-dots .dot.active{background:#fff}
  .tagline-dots .dot:nth-child(1){animation:dot-cycle 20s linear infinite;animation-delay:0s}
  .tagline-dots .dot:nth-child(2){animation:dot-cycle 20s linear infinite;animation-delay:5s}
  .tagline-dots .dot:nth-child(3){animation:dot-cycle 20s linear infinite;animation-delay:10s}
  .tagline-dots .dot:nth-child(4){animation:dot-cycle 20s linear infinite;animation-delay:15s}
  @keyframes dot-cycle{0%{background:#333}3%{background:#fff}27%{background:#fff}30%{background:#333}100%{background:#333}}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:32px}
  .card{background:#0a0a0a;border:1px solid #222;border-radius:12px;padding:20px;transition:border-color 0.2s}
  .card:hover{border-color:#444}
  .card h3{font-size:0.85rem;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:8px}
  .card .val{font-size:1.75rem;font-weight:700;line-height:1}
  .card .sub2{font-size:0.85rem;color:#666;margin-top:4px}
  .actions{display:flex;gap:12px;margin-bottom:32px;flex-wrap:wrap}
  .btn{display:inline-flex;align-items:center;gap:10px;padding:12px 22px;border-radius:10px;font-size:1rem;font-weight:600;text-decoration:none;border:1px solid transparent;transition:all 0.2s;cursor:pointer;white-space:nowrap;flex-shrink:0}
  .btn svg{width:18px;height:18px;flex-shrink:0}
  /* Primary CTA — matches the H1 gradient (etched-glass look) */
  .btn-primary{
    color:#000;
    background:linear-gradient(95deg, #fff 0%, #f0f0f0 50%, #e0e0e0 100%);
    border:1px solid rgba(255,255,255,0.3);
    box-shadow:
      0 1px 0 rgba(255,255,255,0.4) inset,
      0 8px 24px rgba(255,255,255,0.06),
      0 0 40px rgba(255,255,255,0.04);
    position:relative;
    overflow:hidden;
  }
  .btn-primary:hover{
    transform:translateY(-1px);
    box-shadow:
      0 1px 0 rgba(255,255,255,0.5) inset,
      0 12px 32px rgba(255,255,255,0.1),
      0 0 60px rgba(255,255,255,0.06);
  }
  .btn-primary:active{transform:translateY(0)}
  /* The 'shine' that sweeps across on hover — gives a glassy premium feel */
  .btn-primary::after{
    content:"";position:absolute;top:0;left:-100%;width:60%;height:100%;
    background:linear-gradient(120deg, transparent 0%, rgba(255,255,255,0.3) 50%, transparent 100%);
    transition:left 0.6s ease;
    pointer-events:none;
  }
  .btn-primary:hover::after{left:120%}
  .btn-primary svg{width:18px;height:18px}
  .btn-secondary{background:rgba(255,255,255,0.04);color:#fff;border:1px solid rgba(255,255,255,0.08);backdrop-filter:blur(8px)}
  .btn-secondary:hover{background:rgba(255,255,255,0.08);border-color:rgba(255,255,255,0.15)}
  .features{background:#0a0a0a;border:1px solid #222;border-radius:12px;padding:20px;margin-bottom:24px}
  .features h3{font-size:0.85rem;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:12px}
  .features ul{list-style:none}
  .features li{padding:6px 0;color:#ccc;font-size:0.9rem;display:flex;align-items:center;gap:8px}
  .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .dot.on{background:#0f0;box-shadow:0 0 8px #0f0}
  .dot.off{background:#555}
  .features code{background:#1a1a1a;padding:1px 6px;border-radius:4px;color:#888;font-size:0.8rem;margin-left:auto;font-family:ui-monospace,monospace}
  .link-mute{color:#666;text-decoration:none;font-size:0.85rem;margin-left:6px}
  .link-mute:hover{color:#fff}
  .endpoints{background:#0a0a0a;border:1px solid #222;border-radius:12px;padding:20px}
  .endpoints h3{font-size:0.85rem;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:12px}
  .endpoints code{display:block;padding:8px 12px;background:#000;border-radius:6px;color:#0f0;font-size:0.85rem;margin-bottom:4px;font-family:ui-monospace,monospace;overflow-x:auto}
  .endpoints .method{display:inline-block;padding:1px 6px;border-radius:3px;font-size:0.7rem;margin-right:8px;background:#222;color:#888}
  .endpoints .method.get{background:#0a3320;color:#0f0}
  .endpoints .method.post{background:#33220a;color:#f90}
  .banner{background:#1a0a00;border:1px solid #532;color:#f90;padding:16px 20px;border-radius:8px;margin-bottom:24px;font-size:0.9rem;line-height:1.5}
  .banner strong{color:#fff}
  .banner code{background:#000;color:#0f0;padding:2px 6px;border-radius:4px;font-family:ui-monospace,monospace;font-size:0.85em}
  .banner a{color:#6cf}
</style>
</head>
<body>
<div class="wrap">
  ${topRight}
  <h1>ship to the <span class="o">∅</span> void</h1>
  <div class="taglines" aria-live="polite">
    <span class="tagline t1">Self-hosted, edge-driven PaaS. Best-in-class DX, Hetzner pricing, no SSH. AI-deploys via MCP.</span>
    <span class="tagline t2">your AI writes the code. void ships it.</span>
    <span class="tagline t3">Hetzner bill. Premium DX. Zero SSH. Live in 60 seconds.</span>
    <span class="tagline t4">the only PaaS that runs on your own VMs. you own it all.</span>
  </div>
  <div class="tagline-dots" aria-hidden="true">
    <span class="dot active"></span>
    <span class="dot"></span>
    <span class="dot"></span>
    <span class="dot"></span>
  </div>

  <div class="actions">
    ${opts.user ? `
      <a href="/servers" class="btn btn-secondary">Servers</a>
      <a href="/projects" class="btn btn-secondary">Projects</a>
      <a href="/deployments" class="btn btn-secondary">Deployments</a>
      <a href="/api/auth/github?returnTo=%2Fservers" class="btn btn-primary">${octocat}New Server</a>
    ` : `
      <a href="/api/auth/github?returnTo=%2Fservers" class="btn btn-primary">${octocat}Continue with GitHub</a>
      <button type="button" id="passkey-btn" class="btn btn-secondary" onclick="loginWithPasskey()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true">
          <path d="M12 2c-2.5 0-4.5 2-4.5 4.5v3c0 1 .5 2 1.5 2.5"/>
          <path d="M12 2c2.5 0 4.5 2 4.5 4.5v3c0 1-.5 2-1.5 2.5"/>
          <path d="M5 12a7 7 0 0 1 14 0v2"/>
          <path d="M3 16a9 9 0 0 1 18 0"/>
          <path d="M12 12v10"/>
          <path d="M8 18l4 4 4-4"/>
        </svg>
        Continue with passkeys
      </button>
      ${opts.devAuthButtonMarker ?? ""}
    `}
  </div>
  <small id="passkey-status" style="display:block;margin:-16px 0 32px;font-size:0.85rem;min-height:1.2em;color:#888"></small>

  <div id="panel"></div>

  ${oauthBanner}

  <div class="features">
    <h3>Configuration status</h3>
    <ul>${featuresHtml}</ul>
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
</div>
<!-- Passkey login JS — uses the browser lib from jsdelivr's +esm
     endpoint. Same flow as registration but in reverse: get options,
     call navigator.credentials.get(), post response to /login/finish,
     follow redirectTo on success. -->
<script type="module">
import { startAuthentication } from 'https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@13.1.0/+esm';
window.loginWithPasskey = async function() {
  const btn = document.getElementById('passkey-btn');
  const status = document.getElementById('passkey-status');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Waiting for passkey…';
  status.style.color = '#888';
  status.textContent = 'Tap your passkey (TouchID, FaceID, security key)…';
  try {
    const optsResp = await fetch('/api/passkey/login/start', { method: 'POST' });
    if (!optsResp.ok) {
      const j = await optsResp.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + optsResp.status));
    }
    const opts = await optsResp.json();
    let authResp;
    try {
      authResp = await startAuthentication({ optionsJSON: opts });
    } catch (authErr) {
      if (authErr && authErr.name === 'NotAllowedError') {
        throw new Error('No passkey found for this site. Sign in with GitHub first, then add a passkey in /settings.');
      }
      throw authErr;
    }
    const verifyResp = await fetch('/api/passkey/login/finish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: authResp })
    });
    const result = await verifyResp.json();
    if (!result.ok) throw new Error(result.error || 'Verification failed');
    status.style.color = '#0f0';
    status.textContent = '✓ Signed in — redirecting…';
    setTimeout(() => { window.location.href = result.redirectTo || '/dashboard'; }, 400);
  } catch (err) {
    status.style.color = '#f55';
    status.textContent = '✕ ' + (err.message || err);
    btn.disabled = false;
    btn.innerHTML = orig;
  }
};
</script>
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
