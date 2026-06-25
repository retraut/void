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
		.prepare("SELECT id, tunnel_id, tunnel_token FROM servers WHERE id = ?")
		.bind(args.server_id)
		.first<{ id: string; tunnel_id: string | null; tunnel_token: string | null }>();
	if (!server) return { error: `Server ${args.server_id} not found` };

	if (env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ZONE_ID) {
		const { createTunnel, upsertIngressRule, createDnsCname } = await import("./cf");
		if (!server.tunnel_id || !server.tunnel_token) {
			try {
				const tunnel = await createTunnel(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, `void-${server.id}`);
				tunnelId = tunnel.id;
				tunnelToken = tunnel.token;
				await env.void_db
					.prepare("UPDATE servers SET tunnel_id = ?, tunnel_name = ?, tunnel_token = ? WHERE id = ?")
					.bind(tunnelId, tunnel.name, tunnelToken, server.id)
					.run();
			} catch (e: any) {
				return { error: `tunnel create failed: ${e?.message || e}` };
			}
		} else {
			tunnelId = server.tunnel_id;
			tunnelToken = server.tunnel_token;
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
			`INSERT INTO deployments (id, project_id, server_id, ref, commit_sha, status, started_at, hostname, public_url, dns_record_id, port)
			 VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
		)
		.bind(
			deploymentId,
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
		}),
	});

	return {
		deployment_id: deploymentId,
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

	// Look up project by repo_url
	const project = await env.void_db
		.prepare(
			"SELECT id, server_id, slug, default_branch, default_port, build_command, serve_command FROM projects WHERE repo_url LIKE ?",
		)
	.bind(`%${repoFullName}%`)
	.first<{
		id: string;
		server_id: string;
		slug: string;
		default_branch: string;
		default_port: number;
		build_command: string | null;
		serve_command: string | null;
	}>();

	if (!project) {
		// Not a project we own. Return 200 so GitHub doesn't retry, but log.
		return jsonResponse({
			ignored: true,
			reason: `no project registered for ${repoFullName}`,
		});
	}

	// Dispatch by event type
	if (event === "push") {
		const push = payload as PushPayload;
		const branch = push.ref.replace(/^refs\/heads\//, "");
		if (branch !== project.default_branch) {
			// push to a non-default branch — ignore (PRs cover that)
			return jsonResponse({
				ignored: true,
				reason: `push to ${branch} (not default branch ${project.default_branch})`,
			});
		}
		const commitSha = push.head_commit?.id;
		const result = await triggerDeploy(env, {
			project_id: project.id,
			server_id: project.server_id,
			repo_url: `https://github.com/${repoFullName}`,
			ref: branch,
			commit_sha: commitSha,
			build_command: project.build_command || undefined,
			serve_command: project.serve_command || undefined,
			port: project.default_port,
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
		if (baseBranch !== project.default_branch) {
			return jsonResponse({
				ignored: true,
				reason: `pr targets ${baseBranch}, not ${project.default_branch}`,
			});
		}
		const hostname = `pr-${prNumber}-${project.slug}`;
		const result = await triggerDeploy(env, {
			project_id: project.id,
			server_id: project.server_id,
			repo_url: `https://github.com/${repoFullName}`,
			ref: prBranch,
			commit_sha: prSha,
			build_command: project.build_command || undefined,
			serve_command: project.serve_command || undefined,
			port: project.default_port,
			hostname,
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
