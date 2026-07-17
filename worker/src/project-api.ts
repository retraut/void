import type { Env } from "./env";
import { createProject as createProjectRecord, ensureDefaultProject, getOwnedProject, projectSlug } from "./projects";
import {
	getGithubRepository,
	getGithubToken,
	githubCloneEnv,
	listGithubRepositories,
	saveGithubConnection,
} from "./github-connections";
import { validateRef, validateShellCommand } from "./security";

type ApiContext = any;

function message(error: unknown): string {
	return String((error as Error)?.message || error);
}

async function requireProject(c: ApiContext) {
	const user = c.get("user");
	const project = await getOwnedProject(c.env, user.id, c.req.param("id"));
	if (!project) return null;
	return { user, project };
}

export async function listProjects(c: ApiContext): Promise<Response> {
	const user = c.get("user");
	await ensureDefaultProject(c.env, user.id);
	const { results } = await c.env.void_db
		.prepare(
			`SELECT w.id, w.name, w.slug, w.is_default, w.created_at,
			        gc.login AS github_login, gc.avatar_url AS github_avatar_url,
			        (SELECT COUNT(*) FROM repositories r WHERE r.project_id = w.id) AS repository_count,
			        (SELECT COUNT(*) FROM servers s WHERE s.project_id = w.id) AS server_count,
			        (SELECT COUNT(*) FROM deployments d WHERE d.project_id = w.id) AS deployment_count
			 FROM projects w
			 LEFT JOIN github_connections gc ON gc.project_id = w.id
			 WHERE w.user_id = ?
			 ORDER BY w.is_default DESC, w.created_at ASC`,
		)
		.bind(user.id)
		.all();
	return c.json({ projects: results });
}

export async function createProject(c: ApiContext): Promise<Response> {
	const user = c.get("user");
	const body = await c.req.json().catch(() => ({}));
	try {
		const project = await createProjectRecord(c.env, user.id, String(body.name || ""));
		return c.json({ project }, 201);
	} catch (error) {
		return c.json({ error: message(error) }, 400);
	}
}

export async function getProject(c: ApiContext): Promise<Response> {
	const owned = await requireProject(c);
	if (!owned) return c.json({ error: "project not found" }, 404);
	const { project } = owned;
	const [connection, hetznerConnection, cloudflareConnection, repositories, servers] = await Promise.all([
		c.env.void_db
			.prepare(
				"SELECT id, github_id, login, avatar_url, created_at, updated_at FROM github_connections WHERE project_id = ?",
			)
			.bind(project.id)
			.first(),
		c.env.void_db
			.prepare(
				"SELECT provider, verified_datacenters, metadata_json, created_at FROM provider_credentials WHERE project_id = ? AND provider = 'hetzner'",
			)
			.bind(project.id)
			.first(),
		c.env.void_db
			.prepare(
				"SELECT provider, metadata_json, created_at FROM provider_credentials WHERE project_id = ? AND provider = 'cloudflare'",
			)
			.bind(project.id)
			.first(),
		c.env.void_db
			.prepare(
				`SELECT r.*,
				        (SELECT COUNT(*) FROM deployments d WHERE d.repository_id = r.id) AS deployment_count,
				        (SELECT status FROM deployments d WHERE d.repository_id = r.id ORDER BY d.started_at DESC LIMIT 1) AS last_deploy_status,
				        (SELECT started_at FROM deployments d WHERE d.repository_id = r.id ORDER BY d.started_at DESC LIMIT 1) AS last_deploy_at
				 FROM repositories r WHERE r.project_id = ? ORDER BY r.created_at DESC`,
			)
			.bind(project.id)
			.all(),
		c.env.void_db
			.prepare(
				`SELECT s.id, s.name, s.provider, s.status, s.region, s.size, s.last_seen_at,
				        s.ip_address, s.created_at,
				        (SELECT COUNT(*) FROM deployments d WHERE d.server_id = s.id) AS deployment_count
				 FROM servers s WHERE s.project_id = ? ORDER BY s.created_at DESC`,
			)
			.bind(project.id)
			.all(),
	]);
	return c.json({
		project,
		github_connection: connection || null,
		hetzner_connection: hetznerConnection || null,
		cloudflare_connection: cloudflareConnection || null,
		repositories: repositories.results,
		servers: servers.results,
	});
}

export async function connectProjectHetzner(c: ApiContext): Promise<Response> {
	const owned = await requireProject(c);
	if (!owned) return c.json({ error: "project not found" }, 404);
	const body = await c.req.json().catch(() => ({}));
	const token = String(body.token || "").trim();
	try {
		const { setProviderToken, verifyHetznerToken } = await import("./credentials");
		const verification = await verifyHetznerToken(token);
		if (!verification.ok) return c.json({ error: verification.reason || "Hetzner rejected the token" }, 400);
		await setProviderToken(
			c.env,
			owned.user.id,
			"hetzner",
			token,
			owned.project.id,
			verification.datacenters,
		);
		return c.json({ ok: true, datacenters: verification.datacenters });
	} catch (error) {
		return c.json({ error: message(error) }, 400);
	}
}

export async function connectProjectCloudflare(c: ApiContext): Promise<Response> {
	const owned = await requireProject(c);
	if (!owned) return c.json({ error: "project not found" }, 404);
	const body = await c.req.json().catch(() => ({}));
	const token = String(body.token || "").trim();
	try {
		const { setProviderToken, verifyCloudflareToken } = await import("./credentials");
		const verification = await verifyCloudflareToken(token);
		if (!verification.ok) return c.json({ error: verification.reason || "Cloudflare rejected the token" }, 400);
		await setProviderToken(
			c.env,
			owned.user.id,
			"cloudflare",
			token,
			owned.project.id,
			undefined,
			{ zones: verification.zones ?? 0 },
		);
		return c.json({ ok: true, zones: verification.zones ?? 0 });
	} catch (error) {
		return c.json({ error: message(error) }, 400);
	}
}

export async function projectDomains(c: ApiContext): Promise<Response> {
	const owned = await requireProject(c);
	if (!owned) return c.json({ error: "project not found" }, 404);
	const { getProviderToken } = await import("./credentials");
	const token = await getProviderToken(c.env, owned.user.id, "cloudflare", owned.project.id);
	if (!token) return c.json({ error: "connect Cloudflare to view domains" }, 412);
	try {
		const { listZones } = await import("./cf");
		return c.json({ domains: await listZones(token) });
	} catch (error) {
		return c.json({ error: message(error) }, 400);
	}
}

export async function connectProjectGithub(c: ApiContext): Promise<Response> {
	const owned = await requireProject(c);
	if (!owned) return c.json({ error: "project not found" }, 404);
	const body = await c.req.json().catch(() => ({}));
	const token = String(body.token || "").trim();
	try {
		const account = await saveGithubConnection(c.env, owned.user.id, owned.project.id, token);
		return c.json({ ok: true, account });
	} catch (error) {
		return c.json({ error: message(error) }, 400);
	}
}

export async function availableGithubRepositories(c: ApiContext): Promise<Response> {
	const owned = await requireProject(c);
	if (!owned) return c.json({ error: "project not found" }, 404);
	try {
		const repositories = await listGithubRepositories(c.env, owned.project.id);
		const existing = await c.env.void_db
			.prepare("SELECT github_repo_id FROM repositories WHERE project_id = ?")
			.bind(owned.project.id)
			.all() as D1Result<{ github_repo_id: string }>;
		const ids = new Set(existing.results.map((row: { github_repo_id: string }) => row.github_repo_id));
		return c.json({ repositories: repositories.filter((repo) => !ids.has(String(repo.id))) });
	} catch (error) {
		return c.json({ error: message(error) }, 400);
	}
}

export async function addProjectRepository(c: ApiContext): Promise<Response> {
	const owned = await requireProject(c);
	if (!owned) return c.json({ error: "project not found" }, 404);
	const body = await c.req.json().catch(() => ({}));
	const buildCommand = String(body.build_command || "").trim();
	const serveCommand = String(body.serve_command || "").trim();
	const port = Number(body.default_port || 3000);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return c.json({ error: "port must be between 1 and 65535" }, 400);
	}
	for (const [value, field] of [[buildCommand, "build_command"], [serveCommand, "serve_command"]] as const) {
		if (!value) continue;
		const check = validateShellCommand(value, field);
		if (!check.ok) return c.json({ error: check.reason }, 400);
	}
	try {
		const githubRepo = await getGithubRepository(c.env, owned.project.id, String(body.github_repo_id || ""));
		const connection = await c.env.void_db
			.prepare("SELECT id FROM github_connections WHERE project_id = ?")
			.bind(owned.project.id)
			.first() as { id: string } | null;
		if (!connection) return c.json({ error: "connect a GitHub account first" }, 409);
		const id = `repo_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
		const slug = projectSlug(githubRepo.full_name.replace("/", "-"));
		await c.env.void_db
			.prepare(
				`INSERT INTO repositories
				 (id, project_id, github_connection_id, github_repo_id, slug, name, full_name, private,
				  clone_url, default_branch, default_port, build_command, serve_command, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
			)
			.bind(
				id,
				owned.project.id,
				connection.id,
				String(githubRepo.id),
				slug,
				githubRepo.name,
				githubRepo.full_name,
				githubRepo.private ? 1 : 0,
				githubRepo.clone_url,
				githubRepo.default_branch || "main",
				port,
				buildCommand || null,
				serveCommand || null,
			)
			.run();
		return c.json({ ok: true, repository_id: id }, 201);
	} catch (error) {
		return c.json({ error: message(error) }, 400);
	}
}

async function hetznerToken(env: Env, userId: string, projectId: string): Promise<string | null> {
	const { getProviderToken } = await import("./credentials");
	return await getProviderToken(env, userId, "hetzner", projectId);
}

export async function projectServerCatalog(c: ApiContext): Promise<Response> {
	const owned = await requireProject(c);
	if (!owned) return c.json({ error: "project not found" }, 404);
	const token = await hetznerToken(c.env, owned.user.id, owned.project.id);
	if (!token) return c.json({ error: "connect Hetzner in Providers first" }, 412);
	try {
		const { listServerTypes, listLocations, listImages } = await import("./hetzner");
		const [serverTypes, locations, images] = await Promise.all([
			listServerTypes(c.env, token),
			listLocations(c.env, token),
			listImages(c.env, token, { architecture: "x86" }),
		]);
		return c.json({ server_types: serverTypes, locations, images });
	} catch (error) {
		return c.json({ error: message(error) }, 400);
	}
}

export async function addProjectServer(c: ApiContext): Promise<Response> {
	const owned = await requireProject(c);
	if (!owned) return c.json({ error: "project not found" }, 404);
	if (!(await hetznerToken(c.env, owned.user.id, owned.project.id))) {
		return c.json({ error: "connect Hetzner in Providers first" }, 412);
	}
	const body = await c.req.json().catch(() => ({}));
	const name = String(body.name || "").trim();
	const region = String(body.region || "").trim();
	const size = String(body.size || "").trim();
	const image = String(body.image || "").trim();
	if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
		return c.json({ error: "name must be 1-32 lowercase letters, digits, or dashes" }, 400);
	}
	if (!region || !size || !image) return c.json({ error: "region, size, and image are required" }, 400);
	try {
		const { createServerForUser } = await import("./server-create");
		const server = await createServerForUser(
			c.env,
			owned.user.id,
			{ name, region, size, image, project_id: owned.project.id },
			c.req.url,
		);
		return c.json({ ok: true, server }, 201);
	} catch (error) {
		return c.json({ error: message(error) }, 400);
	}
}

export async function deployProjectRepository(c: ApiContext): Promise<Response> {
	const owned = await requireProject(c);
	if (!owned) return c.json({ error: "project not found" }, 404);
	const body = await c.req.json().catch(() => ({}));
	const repository = await c.env.void_db
		.prepare(
			"SELECT id, clone_url, default_branch, default_port, build_command, serve_command FROM repositories WHERE id = ? AND project_id = ?",
		)
		.bind(String(body.repository_id || ""), owned.project.id)
		.first() as {
			id: string;
			clone_url: string;
			default_branch: string;
			default_port: number;
			build_command: string | null;
			serve_command: string | null;
		} | null;
	if (!repository) return c.json({ error: "repository not found in this project" }, 404);
	const server = await c.env.void_db
		.prepare("SELECT id, status FROM servers WHERE id = ? AND project_id = ?")
		.bind(String(body.server_id || ""), owned.project.id)
		.first() as { id: string; status: string } | null;
	if (!server) return c.json({ error: "server not found in this project" }, 404);
	if (server.status !== "active") return c.json({ error: "server agent is not active" }, 409);
	const ref = String(body.ref || repository.default_branch);
	const refCheck = validateRef(ref);
	if (!refCheck.ok) return c.json({ error: refCheck.reason }, 400);
	const token = await getGithubToken(c.env, owned.project.id);
	if (!token) return c.json({ error: "GitHub connection is missing" }, 409);
	try {
		const { triggerDeploy } = await import("./webhook");
		const result = await triggerDeploy(c.env, {
			repository_id: repository.id,
			project_id: owned.project.id,
			server_id: server.id,
			repo_url: repository.clone_url,
			ref,
			build_command: repository.build_command || undefined,
			serve_command: repository.serve_command || undefined,
			port: repository.default_port,
			clone_env: githubCloneEnv(token),
		});
		if ("error" in result) return c.json(result, 409);
		return c.json({ ok: true, ...result }, 202);
	} catch (error) {
		return c.json({ error: message(error) }, 400);
	}
}
