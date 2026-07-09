/**
 * void Worker — per-server "void-cell" Durable Object
 *
 * Holds the WebSocket connection to the agent, broadcasts log lines
 * to SSE subscribers, serializes tunnel-config writes via blockConcurrencyWhile.
 *
 * Security:
 * - /cell/* routes require Bearer auth (except WS upgrade which validates setup_token or session_token)
 * - Deploy messages are HMAC-signed with AGENT_SHARED_SECRET (signed by Worker,
 *   verified by agent before executing commands)
 * - setup_token is one-time: validated against D1 on first register, then replaced with persistent session_token
 * - session_token is persistent for reconnects (rotated manually or on logout)
 *
 * Protocol: all WS frames are validated via Zod schemas in `./protocol`.
 * See docs/PROTOCOL.md for the wire format.
 */

import { Env } from "./env";
import { timingSafeEqual } from "./auth";
import { parseAgentFrame, type AgentOutFrame, type WorkerToAgentFrame, type Metrics } from "./protocol";

export class VoidCell {
	private state: DurableObjectState;
	private env: Env;
	private ws: WebSocket | null = null;
	private agentPublicKey: string | null = null;
	private serverId: string | null = null;
	private registered = false;
	private lastHeartbeat = 0;
	private latestMetrics: Metrics | null = null;
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
			const body = (await request.json()) as {
				deployment_id: string;
				repo_url: string;
				ref: string;
				env?: Record<string, string>;
				build_command?: string;
				serve_command?: string;
				port: number;
				hostname?: string;
				public_url?: string;
				tunnel_token?: string;
				tunnel_id?: string;
			};
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

			// Build the ordered list of shell steps. The agent is a thin
			// executor: clone → build → serve → tunnel. The Worker owns
			// all the logic (it knows the framework, the port, the tunnel
			// token). Steps run sequentially; the agent stops at the first
			// non-zero exit and reports DeployDone.
			const steps: Array<{
				cmd: string;
				env?: Record<string, string>;
				timeout_s?: number;
			}> = [];
			steps.push({
				cmd: `git clone --depth 1 --branch ${body.ref} ${urlCheck.normalized} .`,
				timeout_s: 300,
			});
			if (body.build_command) {
				steps.push({ cmd: body.build_command, timeout_s: 600 });
			}
			if (body.serve_command) {
				steps.push({ cmd: body.serve_command, timeout_s: 300 });
			}
			if (body.tunnel_token) {
				steps.push({
					cmd: "cloudflared tunnel --no-autoupdate run",
					env: { TUNNEL_TOKEN: body.tunnel_token },
					timeout_s: 300,
				});
			}

			// Build the pipeline frame and HMAC-sign its canonical JSON.
			// Canonical form MUST match `PipelineNoSig` in agent/src/crypto.rs:
			//   { "type": "pipeline", "deployment_id": <id>, "steps": [ ... ] }
			// (sig is excluded; steps are serialized exactly as below).
			const pipelineMsg: WorkerToAgentFrame = {
				type: "pipeline",
				deployment_id: body.deployment_id,
				steps,
			};
			if (this.env.AGENT_SHARED_SECRET) {
				const { signWithAgentSecret } = await import("./security");
				// Canonical form MUST match `PipelineNoSig` in agent/src/crypto.rs.
				// The agent serializes each step with serde, omitting absent
				// `cwd`/`env` and always including `timeout_s`, in field order
				// cmd → env → timeout_s. We replicate that exactly.
				const canonicalSteps = steps.map((s) => {
					const step: Record<string, unknown> = { cmd: s.cmd, timeout_s: s.timeout_s };
					if (s.env && Object.keys(s.env).length > 0) step.env = s.env;
					return step;
				});
				const canonical = JSON.stringify({
					type: "pipeline",
					deployment_id: body.deployment_id,
					steps: canonicalSteps,
				});
				(pipelineMsg as { sig?: string }).sig = await signWithAgentSecret(
					this.env.AGENT_SHARED_SECRET,
					canonical,
				);
			}
			this.ws.send(JSON.stringify(pipelineMsg));
			return Response.json({ ok: true, sent: pipelineMsg, signed: !!(pipelineMsg as { sig?: string }).sig });
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

		// Internal: latest agent metrics (CPU/memory)
		if (url.pathname.endsWith("/metrics")) {
			return Response.json({
				metrics: this.latestMetrics,
				last_heartbeat: this.lastHeartbeat,
			});
		}

		// Internal: rotate session_token (invalidates the old one)
		if (url.pathname.endsWith("/rotate-session") && request.method === "POST") {
			// Path is /:server_id/rotate-session (DO strips the host)
			const m = url.pathname.match(/^\/([^/]+)\/rotate-session$/);
			const serverIdFromUrl = m?.[1] || this.serverId;
			if (!serverIdFromUrl) {
				return Response.json({ error: "no server_id" }, { status: 400 });
			}
			const newToken = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
			const now = Math.floor(Date.now() / 1000);
			await this.env.void_db
				.prepare(
					"UPDATE servers SET session_token = ?, session_token_created_at = ? WHERE id = ?",
				)
				.bind(newToken, now, serverIdFromUrl)
				.run();
			// Disconnect the current WS so the agent must re-register with the new token
			try { this.ws?.close(1000, "session_token rotated"); } catch {}
			this.ws = null;
			this.registered = false;
			return Response.json({
				ok: true,
				session_token: newToken,
				note: "Agent must re-register with this new session_token. Update <state_dir>/session_token on the agent host.",
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
		const parsed = parseAgentFrame(raw);
		if ("error" in parsed) {
			// Malformed frame: tell the agent, then close.
			this.ws?.send(
				JSON.stringify({ type: "error", code: "invalid_frame", message: parsed.error }),
			);
			try { this.ws?.close(1008, "invalid frame: " + parsed.error); } catch {}
			this.ws = null;
			return;
		}
		const msg: AgentOutFrame = parsed;

		if (msg.type === "register") {
			const serverId = msg.server_id;
			const setupToken = msg.setup_token;
			const sessionToken = msg.session_token;

			const row = await this.env.void_db
				.prepare(
					"SELECT setup_token, setup_token_consumed_at, session_token FROM servers WHERE id = ?",
				)
				.bind(serverId)
				.first<{
					setup_token: string | null;
					setup_token_consumed_at: number | null;
					session_token: string | null;
				}>();

			if (!row) {
				this.ws?.send(JSON.stringify({ type: "error", code: "unknown_server" }));
				try { this.ws?.close(1008, "unknown server"); } catch {}
				this.ws = null;
				return;
			}

			// First-time register: validate one-time setup_token, issue persistent session_token
			// Reconnect: validate persistent session_token
			let authenticated = false;
			let isFirstRegister = false;
			const now = Math.floor(Date.now() / 1000);

			if (row.session_token && sessionToken && timingSafeEqual(row.session_token, sessionToken)) {
				// Reconnect via session_token
				authenticated = true;
			} else if (row.setup_token && setupToken && timingSafeEqual(row.setup_token, setupToken)) {
				// First-time register via setup_token
				authenticated = true;
				isFirstRegister = true;
			}

			if (!authenticated) {
				this.ws?.send(JSON.stringify({ type: "error", code: "invalid_token" }));
				try { this.ws?.close(1008, "invalid setup_token or session_token"); } catch {}
				this.ws = null;
				return;
			}

			if (isFirstRegister) {
				// Generate persistent session_token for future reconnects
				const newSessionToken = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
				await this.env.void_db
					.prepare(
						`UPDATE servers SET setup_token = NULL, setup_token_consumed_at = ?,
						                  session_token = ?, session_token_created_at = ?,
						                  agent_public_key = ?, status = 'active' WHERE id = ?`,
					)
					.bind(now, newSessionToken, now, msg.public_key, serverId)
					.run();
				this.registered = true;
				this.serverId = serverId;
				this.agentPublicKey = msg.public_key;
				this.lastHeartbeat = Date.now();
				this.ws?.send(
					JSON.stringify({
						type: "registered",
						session_token: newSessionToken,
					}),
				);
			} else {
				// Reconnect: just update public_key if changed, keep session_token.
				// Also flip status from 'pending' to 'active' in case the
				// first register on a manual/test-lab row happened before
				// the fix that updates status (legacy rows). Idempotent.
				await this.env.void_db
					.prepare(
						"UPDATE servers SET agent_public_key = COALESCE(?, agent_public_key), last_seen_at = ?, status = CASE WHEN status = 'pending' THEN 'active' ELSE status END WHERE id = ?",
					)
					.bind(msg.public_key, now, serverId)
					.run();
				this.registered = true;
				this.serverId = serverId;
				this.agentPublicKey = msg.public_key;
				this.lastHeartbeat = Date.now();
				this.ws?.send(JSON.stringify({ type: "registered" }));
			}
			return;
		}

		if (!this.registered) {
			// Anything other than `register` before registration is rejected
			this.ws?.send(
				JSON.stringify({ type: "error", code: "not_registered", message: `got ${msg.type} before register` }),
			);
			try { this.ws?.close(1008, "not registered"); } catch {}
			this.ws = null;
			return;
		}

		if (msg.type === "heartbeat") {
			this.lastHeartbeat = Date.now();
			if (msg.metrics) {
				this.latestMetrics = msg.metrics;
			}
			return;
		}

		if (msg.type === "log") {
			const entry = {
				deployment_id: msg.deployment_id,
				stream: msg.stream,
				data: msg.data,
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
				deployment_id: msg.deployment_id,
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

		if (msg.type === "ready") {
			// Reply to a Worker `ping` — nothing to do server-side, just acknowledge.
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
