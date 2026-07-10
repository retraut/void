/**
 * void Worker — dev-only auth bypass for the test-lab.
 *
 * NEVER bundle this into the production worker. The production
 * entry point (`src/index.ts`) does not import this file, so
 * esbuild cannot reach it from the prod build — it is physically
 * absent from the deployed bundle.
 *
 * The dev-only entry point (`src/dev-entry.ts`) imports it and
 * registers POST /api/auth/dev-login. That entry is used by
 * `wrangler.dev.jsonc` (local); production uses `wrangler.jsonc`
 * with main = `src/index.ts`.
 *
 * Guarded at runtime by VOID_DEV_AUTH=1 in worker/.dev.vars.
 * Without it the route returns 404 — same as if it didn't exist.
 */
import type { Context } from "hono";
import type { Env } from "./env";
import { createSession, SESSION_COOKIE_NAME_DEV } from "./auth";

export async function handleDevLogin(c: Context): Promise<Response> {
	if (c.env.VOID_DEV_AUTH !== "1" && c.env.VOID_DEV_AUTH !== "true") {
		return c.json(
			{
				error: "dev_auth_disabled",
				message:
					"VOID_DEV_AUTH is not enabled. Set VOID_DEV_AUTH=1 in worker/.dev.vars to use the local test-lab auth bypass.",
			},
			404,
		);
	}
	const body = await c.req.json().catch(() => ({}));
	const username = String(body?.username || "lab")
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "");
	if (!username) {
		return c.json({ error: "invalid_username" }, 400);
	}
	// Idempotent: upsert the user. github_id is synthetic (starts
	// with "dev_") so it can never collide with a real GitHub
	// user's id.
	const userId = `usr_dev_${username}`;
	const now = Math.floor(Date.now() / 1000);
	await c.env.void_db
		.prepare(
			`INSERT INTO users (id, github_id, username, avatar_url, onboarding_completed_at, created_at)
			 VALUES (?, ?, ?, NULL, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   username = excluded.username,
			   onboarding_completed_at = COALESCE(users.onboarding_completed_at, excluded.onboarding_completed_at)`,
		)
		.bind(userId, `dev_${username}`, username, now, now)
		.run();
	await createSession(c, { id: userId, username, avatar_url: null }, true);
	const returnTo = String(body?.returnTo || "/dashboard");
	// Form posts land here too; return HTML for them, JSON for fetch.
	const accept = c.req.header("accept") || "";
	if (accept.includes("application/json") || accept.includes("text/html") === false) {
		return c.json({ ok: true, user_id: userId, username });
	}
	return c.redirect(returnTo);
}

// HTML marker that the dev-entry middleware replaces with the
// dev-login button. Defined here so the production entry's
// renderLandingHtml() can include the marker without referencing
// the button itself.
export const DEV_AUTH_BUTTON_MARKER = "<!--DEV_AUTH_BUTTON-->";

// HTML for the dev-login button. Only injected by dev-entry
// middleware (which imports this module); the production bundle
// never sees this string.
export const devAuthButtonHtml = `
${DEV_AUTH_BUTTON_MARKER}
<form method="POST" action="/api/auth/dev-login" style="margin-top:8px">
  <input type="hidden" name="returnTo" value="/dashboard">
  <button type="submit" class="btn btn-secondary" style="width:100%;background:rgba(255,153,0,0.12);border:1px solid rgba(255,153,0,0.4);color:#f90">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="18" height="18" style="vertical-align:-3px;margin-right:6px" aria-hidden="true">
      <path d="M14 7h-4v10h4M9 17l-3-3 3-3M15 17l3-3-3-3"/>
    </svg>
    Continue as <strong>lab</strong> (test-lab, no GitHub)
  </button>
</form>`.trim();

// Re-export so dev-entry can read the same cookie name when it
// wants to clear it on dev-logout.
export { SESSION_COOKIE_NAME_DEV };

