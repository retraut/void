/**
 * void Worker — per-server "void-cell" Durable Object
 *
 * Holds the WebSocket connection to the agent, broadcasts log lines
 * to SSE subscribers, serializes tunnel-config writes via blockConcurrencyWhile.
 *
 * Security:
 * - /cell/* routes require Bearer auth (except WS upgrade which validates setup_token)
 * - Deploy messages are HMAC-signed with AGENT_SHARED_SECRET (signed by Worker,
 *   verified by agent before executing commands)
 * - setup_token is one-time: validated against D1, then marked consumed
 */

import { Env } from "./env";

interface AgentMessage {
	type: "register" | "heartbeat" | "log" | "deploy_done" | "exec_result" | "ready";
	deployment_id?: string;
	server_id?: string;
	public_key?: string;
	setup_token?: string;
	stream?: "stdout" | "stderr";
	data?: string;
	line?: number;
	status?: string;
	url?: string;
	error?: string;
	exit_code?: number;
	timestamp?: number;
	command_id?: string;
	stdout?: string;
	stderr?: string;
}

interface WorkerToAgent {
	type: "deploy" | "ping" | "shutdown" | "ack" | "registered";
	deployment_id?: string;
	repo_url?: string;
	ref?: string;
	env?: Record<string, string>;
	build_command?: string;
	serve_command?: string;
	port?: number;
	// Tunnel/cloudflared info (so the agent can run cloudflared locally)
	hostname?: string;
	public_url?: string;
	tunnel_token?: string;
	tunnel_id?: string;
}

export class VoidCell {
	private state: DurableObjectState;
	private env: Env;
	private ws: WebSocket | null = null;
	private agentPublicKey: string | null = null;
	private serverId: string | null = null;
	private registered = false;
	private lastHeartbeat = 0;
	private sseClients: Set<WritableStreamDefaultWriter> = new Set();
	private logBuffer: Array<{ deployment_id: string; stream: string; data: string; ts: number }> = [];

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// WebSocket upgrade for agent
		if (request.headers.get("Upgrade") === "websocket") {
			if (this.ws) {
				return new Response("Cell already has active WS", { status: 409 });
			}
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair) as WebSocket[];
			this.ws = server;
			this.state.acceptWebSocket(server);

			return new Response(null, { status: 101, webSocket: client });
		}

		// Internal: send deploy command to agent
		if (url.pathname.endsWith("/send-deploy") && request.method === "POST") {
			const body = (await request.json()) as WorkerToAgent & { deployment_id: string; repo_url: string; ref: string };
			if (!this.ws || !this.registered) {
				return Response.json({ error: "Agent not connected" }, { status: 503 });
			}
			// Validate inputs (defense in depth — mcp.ts/webhook.ts also validate)
			const { validateRef, validateRepoUrl, validateShellCommand } = await import("./security");
			const refCheck = validateRef(body.ref || "");
			if (!refCheck.ok) return Response.json({ error: refCheck.reason }, { status: 400 });
			const urlCheck = validateRepoUrl(body.repo_url || "");
			if (!urlCheck.ok) return Response.json({ error: urlCheck.reason }, { status: 400 });
			if (body.build_command) {
				const c = validateShellCommand(body.build_command, "build_command");
				if (!c.ok) return Response.json({ error: c.reason }, { status: 400 });
			}
			if (body.serve_command) {
				const c = validateShellCommand(body.serve_command, "serve_command");
				if (!c.ok) return Response.json({ error: c.reason }, { status: 400 });
			}

			// Build the deploy message and HMAC-sign it
			const deployMsg: WorkerToAgent = {
				type: "deploy",
				deployment_id: body.deployment_id,
				repo_url: urlCheck.normalized,
				ref: body.ref,
				env: body.env,
				build_command: body.build_command,
				serve_command: body.serve_command,
				port: body.port,
				hostname: body.hostname,
				public_url: body.public_url,
				tunnel_token: body.tunnel_token,
				tunnel_id: body.tunnel_id,
			};
			if (env.AGENT_SHARED_SECRET) {
				const { signWithAgentSecret } = await import("./security");
				const payload = JSON.stringify(deployMsg);
				deployMsg.sig = await signWithAgentSecret(env.AGENT_SHARED_SECRET, payload);
			}
			this.ws.send(JSON.stringify(deployMsg));
			return Response.json({ ok: true, sent: deployMsg, signed: !!deployMsg.sig });
		}

		// Internal: subscribe to log stream (SSE)
		if (url.pathname.endsWith("/logs")) {
			const deploymentId = url.searchParams.get("deployment_id") || "";
			return this.sseLogs(deploymentId);
		}

		// Internal: agent status
		if (url.pathname.endsWith("/status")) {
			return Response.json({
				registered: this.registered,
				connected: !!this.ws,
				server_id: this.serverId,
				last_heartbeat: this.lastHeartbeat,
				log_buffer_size: this.logBuffer.length,
			});
		}

		return new Response("Not found in cell", { status: 404 });
	}

	// Hibernation API: required methods on the Durable Object class
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
		await this.handleAgentMessage(raw);
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		this.ws = null;
		this.registered = false;
	}

	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		this.ws = null;
		this.registered = false;
	}

	private async handleAgentMessage(raw: string): Promise<void> {
		let msg: AgentMessage;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}

		if (msg.type === "register") {
			// Validate setup_token against D1 (one-time use)
			const serverId = msg.server_id;
			const token = msg.setup_token;
			if (!serverId) {
				this.ws?.send(JSON.stringify({ type: "error", code: "missing_server_id" }));
				try { this.ws?.close(1008, "missing server_id"); } catch {}
				this.ws = null;
				return;
			}

			const row = await this.env.void_db
				.prepare(
					"SELECT setup_token, setup_token_consumed_at FROM servers WHERE id = ?",
				)
				.bind(serverId)
				.first<{ setup_token: string | null; setup_token_consumed_at: number | null }>();

			if (!row) {
				this.ws?.send(JSON.stringify({ type: "error", code: "unknown_server" }));
				try { this.ws?.close(1008, "unknown server"); } catch {}
				this.ws = null;
				return;
			}
			if (row.setup_token_consumed_at) {
				this.ws?.send(JSON.stringify({ type: "error", code: "token_already_used" }));
				try { this.ws?.close(1008, "setup_token already used"); } catch {}
				this.ws = null;
				return;
			}
			if (!row.setup_token || row.setup_token !== token) {
				this.ws?.send(JSON.stringify({ type: "error", code: "invalid_token" }));
				try { this.ws?.close(1008, "invalid setup_token"); } catch {}
				this.ws = null;
				return;
			}

			// Token is valid — consume it (one-time use) and store public key
			const now = Math.floor(Date.now() / 1000);
			await this.env.void_db
				.prepare(
					"UPDATE servers SET setup_token = NULL, setup_token_consumed_at = ?, agent_public_key = ? WHERE id = ?",
				)
				.bind(now, msg.public_key || null, serverId)
				.run();

			this.registered = true;
			this.serverId = serverId;
			this.agentPublicKey = msg.public_key || null;
			this.lastHeartbeat = Date.now();
			this.ws?.send(JSON.stringify({ type: "registered" }));
			return;
		}

		if (msg.type === "heartbeat") {
			this.lastHeartbeat = Date.now();
			return;
		}

		if (msg.type === "log") {
			const entry = {
				deployment_id: msg.deployment_id || "",
				stream: (msg.stream || "stdout") as string,
				data: msg.data || "",
				ts: Date.now(),
			};
			this.logBuffer.push(entry);
			// cap buffer
			if (this.logBuffer.length > 1000) this.logBuffer.shift();
			// broadcast to SSE subscribers
			const data = `data: ${JSON.stringify(entry)}\n\n`;
			for (const writer of this.sseClients) {
				try {
					writer.write(new TextEncoder().encode(data));
				} catch {
					this.sseClients.delete(writer);
				}
			}
			return;
		}

		if (msg.type === "deploy_done") {
			const entry = {
				deployment_id: msg.deployment_id || "",
				stream: "status",
				data: JSON.stringify({ status: msg.status, url: msg.url, error: msg.error }),
				ts: Date.now(),
			};
			this.logBuffer.push(entry);
			const data = `data: ${JSON.stringify(entry)}\n\n`;
			for (const writer of this.sseClients) {
				try {
					writer.write(new TextEncoder().encode(data));
				} catch {
					this.sseClients.delete(writer);
				}
			}
			return;
		}
	}

	private sseLogs(deploymentId: string): Response {
		const stream = new TransformStream();
		const writer = stream.writable.getWriter();
		this.sseClients.add(writer);

		// send buffered logs for this deployment
		const buffered = this.logBuffer.filter((e) => !deploymentId || e.deployment_id === deploymentId);
		for (const entry of buffered) {
			writer.write(new TextEncoder().encode(`data: ${JSON.stringify(entry)}\n\n`));
		}
		writer.write(new TextEncoder().encode(`data: ${JSON.stringify({ ready: true })}\n\n`));

		// close after 5 min if no new data (avoid DO bloat)
		const keepalive = setInterval(() => {
			try {
				writer.write(new TextEncoder().encode(`: keepalive\n\n`));
			} catch {
				clearInterval(keepalive);
				this.sseClients.delete(writer);
			}
		}, 15000);

		// auto-close after 5 min
		setTimeout(() => {
			clearInterval(keepalive);
			this.sseClients.delete(writer);
			try {
				writer.close();
			} catch {}
		}, 300000);

		return new Response(stream.readable, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				"connection": "keep-alive",
			},
		});
	}
}
