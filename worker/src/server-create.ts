/**
 * void Worker — shared server-creation logic
 *
 * Extracted from the `void_create_server` MCP tool so the UI can
 * use the same code path. Resolves the user's Hetzner token, builds
 * cloud-init, calls the Hetzner API, persists the row in D1.
 *
 * Stub mode (no Hetzner token available) is supported for self-hosted
 * dev setups that don't have a Hetzner account.
 */

import { Env } from "./env";
import { buildCloudInit, createServer as hetznerCreateServer, listProjects, getServer as hetznerGetServer } from "./hetzner";
import { getProviderToken } from "./credentials";

export interface CreateServerInput {
	name: string;
	size: string; // e.g. "cx22"
	region: string; // e.g. "fsn1"
	image: string; // e.g. "ubuntu-26.04"
	project_id?: string;
}

export interface CreateServerResult {
	id: string; // our internal srv_ id
	mode: "hetzner" | "stub";
	hetzner_id?: number;
	public_ip?: string | null;
	datacenter?: string;
	region: string;
	size: string;
	image: string;
	status: string;
	project_id?: number | null;
	project_name?: string | null;
	note: string;
}

/**
 * Create a server for a user. Used by both:
 *   - `void_create_server` MCP tool
 *   - POST /servers/new (UI form)
 *
 * Resolution order for the Hetzner token:
 *   1. Per-user stored token in `provider_credentials` (preferred)
 *   2. `HETZNER_TOKEN` env var (self-hosted single-tenant fallback)
 *   3. No token → stub mode (inserts a D1 row, no real VM)
 */
export async function createServerForUser(
	env: Env,
	userId: string | null,
	input: CreateServerInput,
	requestUrl: string,
): Promise<CreateServerResult> {
	const serverId = `srv_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const now = Math.floor(Date.now() / 1000);
	let projectId = input.project_id || null;
	if (!projectId && userId) {
		const { ensureDefaultProject } = await import("./projects");
		projectId = (await ensureDefaultProject(env, userId)).id;
	}
	if (!projectId) throw new Error("project is required");

	// Resolve the token: per-user → system (panel) → env
	let hetznerToken: string | null = null;
	if (userId) hetznerToken = await getProviderToken(env, userId, "hetzner", projectId);
	if (!hetznerToken) {
		const { getSystemToken } = await import("./system-settings");
		hetznerToken = await getSystemToken(env, "hetzner_token");
	}

	// Stub mode: no token at all (env, system, or per-user)
	if (!hetznerToken) {
		await env.void_db
			.prepare(
				`INSERT INTO servers (id, user_id, project_id, name, provider, region, size, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'provisioning', ?)`,
			)
			.bind(serverId, userId, projectId, input.name, "hetzner", input.region, input.size, now)
			.run();
		return {
			id: serverId,
			mode: "stub",
			region: input.region,
			size: input.size,
			image: input.image,
			status: "provisioning",
			note: env.HETZNER_TOKEN
				? "Stub mode — no Hetzner token found for this Project. Add one in Project → Providers, or set a system default in Account settings."
				: "No Hetzner token configured. Set one in Project → Providers or configure a system default in Account settings.",
		};
	}

	// Real Hetzner provisioning. Generate a one-time setup token, insert
	// the row with status 'provisioning', build cloud-init, call Hetzner.
	const setupToken = `set_${crypto.randomUUID().replace(/-/g, "")}`;
	await env.void_db
		.prepare(
			`INSERT INTO servers (id, user_id, project_id, name, provider, region, size, status, setup_token, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?)`,
		)
		.bind(serverId, userId, projectId, input.name, "hetzner", input.region, input.size, setupToken, now)
		.run();

	const apiBase = new URL(requestUrl).origin.replace(/^http/, "wss");
	const userData = buildCloudInit({
		server_id: serverId,
		setup_token: setupToken,
		api_base: apiBase,
		github_release_tag: env.VOID_AGENT_RELEASE_TAG || "v0.3.1",
		github_repo: (env as any).VOID_AGENT_REPO || undefined,
	});

	try {
		const hs = await hetznerCreateServer(hetznerToken, {
			// Use the user-provided name directly. Hetzner requires
			// a-z, 0-9, and dashes only (no underscores), 1-63 chars,
			// must be unique per project. Our form validation already
			// enforces a-z + 0-9 + dashes + max 32 chars, which fits.
			name: input.name,
			server_type: input.size,
			image: input.image,
			location: input.region,
			user_data: userData,
		});

		await env.void_db
			.prepare(
				`UPDATE servers SET provider_server_id = ?, ip_address = ?, status = 'provisioning',
				 cpu = ?, memory = ?, disk = ? WHERE id = ?`,
			)
			.bind(
				String(hs.id),
				hs.public_net?.ipv4?.ip || null,
				hs.server_type?.cores ?? null,
				hs.server_type?.memory ?? null,
				hs.server_type?.disk ?? null,
				serverId,
			)
			.run();

		// Capture which Hetzner project the server landed in. The Hetzner
		// API doesn't return project_id on server create (it uses the
		// token's implicit project), so we re-fetch the server and list
		// projects to identify the right one. For most tokens there's
		// only one project anyway, so we fall back to the first.
		let projectId: number | null = null;
		let projectName: string | null = null;
		try {
			const projects = await listProjects(env, hetznerToken);
			// Try to find the project by looking up the server's owning project
			// via GET /servers/{id} — it doesn't include project_id either,
			// so we just use the first project as a best-effort.
			if (projects.length === 1) {
				projectId = projects[0].id;
				projectName = projects[0].name;
			} else if (projects.length > 1) {
				// Multiple projects: store the first as default. User can
				// correct via the re-sync action if it was the wrong one.
				projectId = projects[0].id;
				projectName = projects[0].name;
			}
			if (projectId) {
				await env.void_db
					.prepare(
						`UPDATE servers SET hetzner_project_id = ?, hetzner_project_name = ? WHERE id = ?`,
					)
					.bind(projectId, projectName, serverId)
					.run();
			}
		} catch {
			// best-effort, don't fail the create
		}

		return {
			id: serverId,
			mode: "hetzner",
			hetzner_id: hs.id,
			public_ip: hs.public_net?.ipv4?.ip,
			datacenter: hs.datacenter?.name,
			region: hs.datacenter?.location?.name || input.region,
			size: hs.server_type?.name || input.size,
			image: hs.image?.name || input.image,
			status: hs.status,
			project_id: projectId,
			project_name: projectName,
			note: "Agent will auto-register when cloud-init completes (~30-60s).",
		};
	} catch (e: any) {
		await env.void_db
			.prepare(`UPDATE servers SET status = 'failed' WHERE id = ?`)
			.bind(serverId)
			.run();
		throw new Error(translateHetznerError(e));
	}
}

/**
 * Translate a Hetzner API error into a more helpful message.
 * The raw error from `hcloudFetch` is `Hetzner API error: <code> — <message>`.
 * We detect common causes and append concrete next steps so the user
 * doesn't have to guess (e.g. "is my token broken? is my account suspended?").
 */
function translateHetznerError(e: any): string {
	const raw = String(e?.message || e);
	// Hetzner returns "Hetzner API error: <code> — <message>"
	const m = raw.match(/Hetzner API error:\s*(\w+)\s*—\s*(.+)$/);
	const code = m?.[1] || "";
	const detail = m?.[2] || raw;

	if (code === "forbidden") {
		return (
			`Hetzner denied the request (${code}). Most likely causes:\n` +
			`• Your API token is read-only — re-create it with read+write scope at console.hetzner.cloud → Security → API Tokens\n` +
			`• Your Hetzner project is suspended (unpaid balance or no payment method) — check Billing in the Hetzner console\n` +
			`• Project quota reached (max servers, etc.)\n` +
			`\nOriginal error: ${raw}`
		);
	}
	if (code === "invalid_input" && detail.includes("name")) {
		return (
			`Hetzner rejected the server name. The name must:\n` +
			`• Use only lowercase letters (a-z), digits (0-9), and dashes (-)\n` +
			`• Start with a letter, max 63 characters\n` +
			`• Be unique within your Hetzner project\n` +
			`\nOriginal error: ${raw}`
		);
	}
	if (code === "invalid_input" && detail.toLowerCase().includes("location")) {
		return (
			`This server type isn't available in the selected location. Try:\n` +
			`• Pick a different location (the type list is filtered automatically)\n` +
			`• Pick a different server type (cheaper types are often region-restricted)\n` +
			`\nOriginal error: ${raw}`
		);
	}
	if (code === "payment_required" || code === "limit_reached") {
		return `Hetzner account/billing issue (${code}). Check your Hetzner project billing. (${raw})`;
	}
	if (code === "rate_limit_exceeded" || raw.includes("rate limit")) {
		return `Hetzner API rate limit hit. Wait a minute and retry. (${raw})`;
	}
	if (code === "unavailable") {
		return `Hetzner service temporarily unavailable. Retry in a few seconds. (${raw})`;
	}
	return `Hetzner provisioning failed: ${raw}`;
}
