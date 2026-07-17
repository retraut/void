/**
 * void Worker — provider-agnostic server registration.
 *
 * Used by the test-lab (scripts/test-lab/up.sh) and by the
 * "register manually" panel flow. The Hetzner one-click flow
 * has its own path in `server-create.ts` (which calls the
 * Hetzner API and embeds the setup_token in cloud-init).
 *
 * Both paths write to the same `servers` D1 row with the
 * same columns; the only difference is where the setup_token
 * is delivered. Here the caller receives it and is responsible
 * for getting it onto the target VM (config.toml + systemd
 * service for manual provisioning; cloud-init for Hetzner).
 *
 * Lifecycle:
 *   1. Caller hits POST /api/servers/register
 *   2. We insert a D1 row with status='pending' and a fresh
 *      setup_token (one-time, will be replaced by session_token
 *      on first successful WS register)
 *   3. We return { server_id, setup_token, api_base, config_toml }
 *   4. Caller writes config_toml to /etc/void/config.toml on
 *      their VM and starts void-agent
 *   5. Agent WS-connects, sends register{ setup_token }
 *   6. Server validates the token against the pending row,
 *      issues a session_token, status → 'active'
 *   7. Setup token is single-use; rejected on any subsequent
 *      register attempt
 */

import { Env } from "./env";

export interface RegisterServerInput {
	/** Human-readable name (optional). Defaults to 'manual-<short-ulid>'. */
	name?: string;
	/** Optional: the Hetzner region to record in D1 (informational only for manual). */
	region?: string;
	/** Optional: the Hetzner size to record in D1 (informational only for manual). */
	size?: string;
	project_id?: string;
}

export interface RegisterServerResult {
	server_id: string;
	setup_token: string;
	api_base: string;
	config_toml: string;
	expires_in_seconds: number;
}

/**
 * Register a server. Creates a D1 row with status='pending' and
 * returns the credentials needed to bootstrap a void-agent on the
 * target machine. The setup_token is single-use; on first successful
 * WS register it's replaced with a session_token.
 *
 * This function does NOT touch any external provider API. Provisioning
 * the VM (Hetzner, OrbStack, raw Linux, ...) is the caller's job.
 */
export async function registerServerForUser(
	env: Env,
	userId: string,
	input: RegisterServerInput,
	requestUrl: string,
): Promise<RegisterServerResult> {
	const serverId = `srv_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const setupToken = `set_${crypto.randomUUID().replace(/-/g, "")}`;
	const now = Math.floor(Date.now() / 1000);
	const { ensureDefaultProject } = await import("./projects");
	const projectId = input.project_id || (await ensureDefaultProject(env, userId)).id;

	// Sensible default name if the caller didn't provide one.
	const name = (input.name?.trim() || `manual-${serverId.slice(-6)}`).toLowerCase();
	// Manual/test-lab rows: no Hetzner fields; provider is 'manual'.
	// Tests should not see these in the Hetzner project.
	await env.void_db
		.prepare(
			`INSERT INTO servers (
				id, user_id, project_id, name, provider, status, setup_token, created_at
			) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
		)
		.bind(serverId, userId, projectId, name, "manual", setupToken, now)
		.run();

	const apiBase = new URL(requestUrl).origin.replace(/^http/, "wss");
	const configToml = renderAgentConfigToml({
		api_base: apiBase,
		server_id: serverId,
		setup_token: setupToken,
		state_dir: "/var/lib/void",
		// No public_url_template default — the test-lab runs in a VM
		// that doesn't have a public URL unless the user sets up
		// cloudflared, ngrok, etc. and sets this. The Hetzner path
		// uses its own template (in buildCloudInit) since real VMs
		// get a tunnel_token with each deploy.
		public_url_template: "",
	});

	return {
		server_id: serverId,
		setup_token: setupToken,
		api_base: apiBase,
		config_toml: configToml,
		// The setup token has no formal expiry; we document a
		// reasonable default (1 hour) so the test-lab can warn
		// before it goes stale.
		expires_in_seconds: 60 * 60,
	};
}

export interface AgentConfigInput {
	api_base: string;
	server_id: string;
	setup_token: string;
	state_dir?: string;
	public_url_template?: string;
	agent_shared_secret?: string;
}

/**
 * Render the contents of /etc/void/config.toml that the agent
 * reads on startup. Mirrors the `Config` struct in agent/src/config.rs.
 *
 * Used by both the manual registration path (return to the caller
 * so they can write the file) and the test-lab scripts (write
 * directly into the OrbStack VM).
 */
export function renderAgentConfigToml(input: AgentConfigInput): string {
	const lines: string[] = [
		`# void-agent config`,
		`# Written by /api/servers/register on ${new Date().toISOString()}`,
		`# The setup_token below is single-use — it will be replaced`,
		`# by a session_token on first successful WS register.`,
		``,
		`api_base = ${tomlString(input.api_base)}`,
		`server_id = ${tomlString(input.server_id)}`,
		`setup_token = ${tomlString(input.setup_token)}`,
	];
	if (input.state_dir) {
		lines.push(`state_dir = ${tomlString(input.state_dir)}`);
	}
	if (input.public_url_template) {
		lines.push(`public_url_template = ${tomlString(input.public_url_template)}`);
	}
	if (input.agent_shared_secret) {
		lines.push(`agent_shared_secret = ${tomlString(input.agent_shared_secret)}`);
	}
	lines.push(``);
	return lines.join("\n");
}

/** TOML basic string — wraps in double quotes, escapes backslash + quote. */
function tomlString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
