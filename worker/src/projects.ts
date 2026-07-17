import type { Env } from "./env";

export interface ProjectRow {
	id: string;
	user_id: string;
	name: string;
	slug: string;
	is_default: number;
	created_at: number;
}

export function projectSlug(value: string): string {
	const slug = value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || "project";
}

function newProjectId(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Ensure every user has a top-level project and adopt legacy unscoped rows.
 * Safe to call from reads; the unique (user_id, slug) constraint handles races.
 */
export async function ensureDefaultProject(env: Env, userId: string): Promise<ProjectRow> {
	let row = await env.void_db
		.prepare("SELECT * FROM projects WHERE user_id = ? AND is_default = 1 ORDER BY created_at LIMIT 1")
		.bind(userId)
		.first<ProjectRow>();

	if (!row) {
		const id = newProjectId();
		try {
			await env.void_db
				.prepare(
					"INSERT INTO projects (id, user_id, name, slug, is_default, created_at) VALUES (?, ?, 'Default Project', 'default', 1, unixepoch())",
				)
				.bind(id, userId)
				.run();
		} catch (error) {
			if (!String((error as Error)?.message || error).includes("UNIQUE")) throw error;
		}
		row = await env.void_db
			.prepare("SELECT * FROM projects WHERE user_id = ? AND slug = 'default' LIMIT 1")
			.bind(userId)
			.first<ProjectRow>();
	}

	if (!row) throw new Error("failed to create default project");

	await env.void_db.batch([
		env.void_db
			.prepare("UPDATE servers SET project_id = ? WHERE user_id = ? AND project_id IS NULL")
			.bind(row.id, userId),
	]);

	return row;
}

export async function getOwnedProject(
	env: Env,
	userId: string,
	projectId: string,
): Promise<ProjectRow | null> {
	await ensureDefaultProject(env, userId);
	return await env.void_db
		.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?")
		.bind(projectId, userId)
		.first<ProjectRow>();
}

export async function createProject(env: Env, userId: string, name: string): Promise<ProjectRow> {
	const cleanName = name.trim().slice(0, 80);
	if (!cleanName) throw new Error("project name is required");
	const base = projectSlug(cleanName);
	for (let attempt = 0; attempt < 20; attempt++) {
		const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
		const id = newProjectId();
		try {
			await env.void_db
				.prepare(
					"INSERT INTO projects (id, user_id, name, slug, is_default, created_at) VALUES (?, ?, ?, ?, 0, unixepoch())",
				)
				.bind(id, userId, cleanName, slug)
				.run();
			const row = await getOwnedProject(env, userId, id);
			if (row) return row;
		} catch (error) {
			if (!String((error as Error)?.message || error).includes("UNIQUE")) throw error;
		}
	}
	throw new Error("could not allocate a unique project slug");
}
