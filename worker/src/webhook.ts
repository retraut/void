/**
 * void Worker — GitHub webhook handler
 *
 * Receives push and pull_request events, verifies HMAC, looks up
 * the project by repo URL, and triggers a void_deploy.
 *
 * Configure: GitHub repo webhook → POST https://api.void.example.com/api/webhooks/github
 *   with content-type application/json
 *   and a secret that matches wrangler secret put GITHUB_WEBHOOK_SECRET
 */

import { Env } from "./env";
import { validateRef, validateRepoUrl, validateShellCommand } from "./security";
import { decrypt } from "./crypto";

interface PushPayload {
	ref: string;
	repository: { full_name: string; default_branch: string };
	head_commit?: { id: string; message: string };
	pusher: { name: string };
}

interface PullRequestPayload {
	action: string;
	pull_request: {
		number: number;
		head: { ref: string; sha: string };
		base: { ref: string };
	};
	repository: { full_name: string; default_branch: string };
}

async function verifyHmac(secret: string, body: string, signature: string | null): Promise<boolean> {
	if (!signature) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	const expected =
		"sha256=" +
		Array.from(new Uint8Array(sig))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	// Constant-time compare
	if (expected.length !== signature.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) {
		diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	}
	return diff === 0;
}

interface TriggerResult {
	deployment_id: string;
	repository_id: string;
	project_id: string;
	kind: "production" | "preview";
	build?: string;
	serve?: string;
}

/**
 * Internal deploy trigger — used by both MCP and webhook.
 * Returns the deployment_id (or null on failure).
 */
export async function triggerDeploy(
	env: Env,
	args: {
		repository_id: string;
		project_id: string;
		server_id: string;
		repo_url: string;
		ref: string;
		commit_sha?: string;
		build_command?: string;
		serve_command?: string;
		port?: number;
		hostname?: string;
		env?: Record<string, string>;
		clone_env?: Record<string, string>;
	},
): Promise<TriggerResult | { error: string }> {
	const deploymentId = `dep_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

	// Tunnel + DNS setup (same logic as MCP void_deploy)
	let hostname = args.hostname || null;
	let publicUrl: string | null = null;
	let dnsRecordId: string | null = null;
	let tunnelToken: string | null = null;
	let tunnelId: string | null = null;

	const server = await env.void_db
		.prepare("SELECT id, tunnel_id, tunnel_token_encrypted FROM servers WHERE id = ?")
		.bind(args.server_id)
		.first<{ id: string; tunnel_id: string | null; tunnel_token_encrypted: string | null }>();
	if (!server) return { error: `Server ${args.server_id} not found` };

	if (env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ZONE_ID) {
		const { createTunnel, upsertIngressRule, createDnsCname } = await import("./cf");
const { encrypt } = await import("./crypto");
		if (!server.tunnel_id) {
			try {
				const tunnel = await createTunnel(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, `void-${server.id}`);
				tunnelId = tunnel.id;
				tunnelToken = tunnel.token;
				const encryptKey = env.ENCRYPTION_KEY || env.COOKIE_SECRET;
				const encrypted = encryptKey
					? await encrypt(encryptKey, tunnel.token)
					: null;
				await env.void_db
					.prepare("UPDATE servers SET tunnel_id = ?, tunnel_name = ?, tunnel_token_encrypted = ? WHERE id = ?")
					.bind(tunnelId, tunnel.name, encrypted, server.id)
					.run();
			} catch (e: any) {
				return { error: `tunnel create failed: ${e?.message || e}` };
			}
		} else {
			tunnelId = server.tunnel_id;
			// Decrypt stored token
			if (server.tunnel_token_encrypted && (env.ENCRYPTION_KEY || env.COOKIE_SECRET)) {
				tunnelToken = await decrypt(env.ENCRYPTION_KEY || env.COOKIE_SECRET!, server.tunnel_token_encrypted);
			}
		}

		hostname = hostname || `pr-${deploymentId}`;
		const port = args.port || 3000;
		try {
			await upsertIngressRule(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, tunnelId, hostname, `http://localhost:${port}`);
		} catch (e: any) {
			return { error: `ingress failed: ${e?.message || e}` };
		}
		try {
			const zoneResp = await fetch(
				`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}`,
				{ headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } },
			);
			const zoneBody: any = await zoneResp.json();
			const zoneName: string = zoneBody.result?.name || "void.delivery";
			const fqdn = `${hostname}.${zoneName}`;
			const dns = await createDnsCname(env.CF_API_TOKEN, env.CF_ZONE_ID, fqdn, tunnelId);
			dnsRecordId = dns.id;
			publicUrl = `https://${fqdn}`;
		} catch (e: any) {
			return { error: `dns failed: ${e?.message || e}` };
		}
	}

	const now = Math.floor(Date.now() / 1000);
	await env.void_db
		.prepare(
			`INSERT INTO deployments (id, repository_id, project_id, server_id, ref, commit_sha, status, started_at, hostname, public_url, dns_record_id, port)
			 VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
		)
		.bind(
			deploymentId,
			args.repository_id,
			args.project_id,
			args.server_id,
			args.ref,
			args.commit_sha || null,
			now,
			hostname,
			publicUrl,
			dnsRecordId,
			args.port || 3000,
		)
		.run();

	const cellId = env.void_cell.idFromName(args.server_id);
	const cellStub = env.void_cell.get(cellId);
	const sendResp = await cellStub.fetch("https://cell/send-deploy", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			deployment_id: deploymentId,
			repo_url: args.repo_url,
			ref: args.ref,
			env: args.env || {},
			build_command: args.build_command || null,
			serve_command: args.serve_command || null,
			port: args.port || 3000,
			hostname,
			public_url: publicUrl,
			tunnel_token: tunnelToken,
			tunnel_id: tunnelId,
			clone_env: args.clone_env,
		}),
	});
	if (!sendResp.ok) {
		const failed = await sendResp.json().catch(() => ({ error: "agent dispatch failed" })) as { error?: string };
		await env.void_db
			.prepare("UPDATE deployments SET status = 'failed', error = ?, finished_at = unixepoch() WHERE id = ?")
			.bind(failed.error || "agent dispatch failed", deploymentId)
			.run();
		return { error: failed.error || "agent dispatch failed" };
	}

	return {
		deployment_id: deploymentId,
		repository_id: args.repository_id,
		project_id: args.project_id,
		kind: hostname && hostname.startsWith("pr-") ? "preview" : "production",
		build: args.build_command,
		serve: args.serve_command,
	};
}

export async function handleGitHubWebhook(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("webhook requires POST", { status: 405 });
	}
	if (!env.GITHUB_WEBHOOK_SECRET) {
		return new Response("GITHUB_WEBHOOK_SECRET not configured", { status: 503 });
	}

	const body = await request.text();
	const signature = request.headers.get("X-Hub-Signature-256");
	const event = request.headers.get("X-GitHub-Event");

	const ok = await verifyHmac(env.GITHUB_WEBHOOK_SECRET, body, signature);
	if (!ok) {
		return new Response("invalid signature", { status: 401 });
	}

	let payload: any;
	try {
		payload = JSON.parse(body);
	} catch {
		return new Response("invalid JSON", { status: 400 });
	}

	const repoFullName: string = payload?.repository?.full_name;
	if (!repoFullName) {
		return new Response("missing repository.full_name", { status: 400 });
	}

	// Look up repository by exact GitHub full name.
	const repository = await env.void_db
		.prepare(
			`SELECT r.id, r.project_id, r.slug, r.clone_url, r.default_branch, r.default_port,
			        r.build_command, r.serve_command,
			        (SELECT id FROM servers s WHERE s.project_id = r.project_id AND s.status = 'active' ORDER BY s.created_at LIMIT 1) AS server_id
			 FROM repositories r WHERE r.full_name = ?`,
		)
		.bind(repoFullName)
		.first<{
			id: string;
			project_id: string;
			server_id: string | null;
			slug: string;
			clone_url: string;
			default_branch: string;
			default_port: number;
			build_command: string | null;
			serve_command: string | null;
		}>();

	if (!repository) {
		// Not a project we own. Return 200 so GitHub doesn't retry, but log.
		return jsonResponse({
			ignored: true,
			reason: `no project registered for ${repoFullName}`,
		});
	}
	if (!repository.server_id) return jsonResponse({ ignored: true, reason: "no active server in project" });
	const { getGithubToken, githubCloneEnv } = await import("./github-connections");
	const githubToken = await getGithubToken(env, repository.project_id);
	const cloneEnv = githubToken ? githubCloneEnv(githubToken) : undefined;

	// Dispatch by event type
	if (event === "push") {
		const push = payload as PushPayload;
		const branch = push.ref.replace(/^refs\/heads\//, "");
		if (branch !== repository.default_branch) {
			// push to a non-default branch — ignore (PRs cover that)
			return jsonResponse({
				ignored: true,
				reason: `push to ${branch} (not default branch ${repository.default_branch})`,
			});
		}
		// Validate inputs (defense in depth — same checks happen in MCP path)
		const refCheck = validateRef(branch);
		if (!refCheck.ok) {
			return jsonResponse({ error: refCheck.reason }, 400);
		}
		if (repository.build_command) {
			const c = validateShellCommand(repository.build_command, "build_command");
			if (!c.ok) return jsonResponse({ error: c.reason }, 400);
		}
		if (repository.serve_command) {
			const c = validateShellCommand(repository.serve_command, "serve_command");
			if (!c.ok) return jsonResponse({ error: c.reason }, 400);
		}
		const commitSha = push.head_commit?.id;
		const result = await triggerDeploy(env, {
			repository_id: repository.id,
			project_id: repository.project_id,
			server_id: repository.server_id,
			repo_url: repository.clone_url,
			ref: branch,
			commit_sha: commitSha,
			build_command: repository.build_command || undefined,
			serve_command: repository.serve_command || undefined,
			port: repository.default_port,
			clone_env: cloneEnv,
		});
		return jsonResponse({ event: "push", branch, ...result });
	}

	if (event === "pull_request") {
		const pr = payload as PullRequestPayload;
		if (!["opened", "synchronize", "reopened"].includes(pr.action)) {
			return jsonResponse({
				ignored: true,
				reason: `pr action: ${pr.action}`,
			});
		}
		const prNumber = pr.pull_request.number;
		const prBranch = pr.pull_request.head.ref;
		const prSha = pr.pull_request.head.sha;
		const baseBranch = pr.pull_request.base.ref;
		// only deploy PRs targeting the project's default branch
		if (baseBranch !== repository.default_branch) {
			return jsonResponse({
				ignored: true,
				reason: `pr targets ${baseBranch}, not ${repository.default_branch}`,
			});
		}
		// Validate PR ref
		const refCheck = validateRef(prBranch);
		if (!refCheck.ok) {
			return jsonResponse({ error: refCheck.reason }, 400);
		}
		if (repository.build_command) {
			const c = validateShellCommand(repository.build_command, "build_command");
			if (!c.ok) return jsonResponse({ error: c.reason }, 400);
		}
		if (repository.serve_command) {
			const c = validateShellCommand(repository.serve_command, "serve_command");
			if (!c.ok) return jsonResponse({ error: c.reason }, 400);
		}
		const hostname = `pr-${prNumber}-${repository.slug}`;
		const result = await triggerDeploy(env, {
			repository_id: repository.id,
			project_id: repository.project_id,
			server_id: repository.server_id,
			repo_url: repository.clone_url,
			ref: prBranch,
			commit_sha: prSha,
			build_command: repository.build_command || undefined,
			serve_command: repository.serve_command || undefined,
			port: repository.default_port,
			hostname,
			clone_env: cloneEnv,
		});
		return jsonResponse({ event: "pull_request", pr: prNumber, branch: prBranch, ...result });
	}

	return jsonResponse({ ignored: true, reason: `event: ${event}` });
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});
}
