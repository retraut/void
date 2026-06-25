/**
 * void Worker — per-user "current project" context
 *
 * The project switcher in the sidebar sets a `current_project_id` cookie
 * that scopes the entire UI: /dashboard, /servers, /deployments filter
 * by this project. Clearing the cookie (selecting "All projects")
 * returns to a global view.
 *
 * The project must belong to the calling user — we verify on every
 * read so a forged cookie can't leak other users' data.
 */

import type { Context } from "hono";
import { getCookie } from "hono/cookie";

export const CURRENT_PROJECT_COOKIE = "current_project_id";
const COOKIE_OPTS = {
	path: "/",
	secure: true,
	httpOnly: true,
	sameSite: "Lax" as const,
	maxAge: 60 * 60 * 24 * 30, // 30 days
};

/**
 * Read the current project from the cookie. Returns the project row or
 * null. Verifies the project belongs to the user (so a forged cookie
 * can't read someone else's project).
 */
export async function getCurrentProject(
	c: Context,
): Promise<{ id: string; name: string; slug: string } | null> {
	const user = c.get("user");
	const projectId = getCookie(c, CURRENT_PROJECT_COOKIE);
	if (!projectId || !user) return null;
	const row = await c.env.void_db
		.prepare(
			"SELECT id, name, slug FROM projects WHERE id = ? AND user_id = ?",
		)
		.bind(projectId, user.id)
		.first<{ id: string; name: string; slug: string }>();
	return row || null;
}

/**
 * Set the current project. Pass empty string to clear.
 * Validates that the project belongs to the user before setting.
 */
export async function setCurrentProject(
	c: Context,
	projectId: string,
): Promise<{ ok: boolean }> {
	const user = c.get("user");
	if (!user) return { ok: false };
	if (projectId === "") {
		clearCurrentProject(c);
		return { ok: true };
	}
	// Verify ownership
	const row = await c.env.void_db
		.prepare("SELECT id FROM projects WHERE id = ? AND user_id = ?")
		.bind(projectId, user.id)
		.first();
	if (!row) return { ok: false };
	const { setCookie } = await import("hono/cookie");
	setCookie(c, CURRENT_PROJECT_COOKIE, projectId, COOKIE_OPTS);
	return { ok: true };
}

/**
 * Clear the current project cookie.
 */
export async function clearCurrentProject(c: Context): Promise<void> {
	const { deleteCookie } = await import("hono/cookie");
	deleteCookie(c, CURRENT_PROJECT_COOKIE, COOKIE_OPTS);
}
