/**
 * void Worker — minimal MCP server
 *
 * Implements JSON-RPC 2.0 + MCP Streamable HTTP.
 * Tools: void_list_servers, void_create_server, void_deploy, void_get_logs.
 */

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: any;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: any;
	error?: { code: number; message: string; data?: any };
}

const TOOLS = [
	{
		name: "void_list_servers",
		description: "List all servers (Hetzner/DO VMs) registered for the current user.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "void_create_server",
		description:
			"Create a new server (provisions a Hetzner Cloud VM and installs the void agent). For MVP this is a stub that returns a fake server_id — real provisioning wires up Hetzner API + cloud-init in v0.1.",
		inputSchema: {
			type: "object",
			properties: {
				provider: { type: "string", enum: ["hetzner", "digitalocean"], default: "hetzner" },
				name: { type: "string", description: "Friendly name, e.g. 'prod-1'" },
				size: { type: "string", description: "Hetzner server type, e.g. 'cx22'", default: "cx22" },
				region: { type: "string", description: "Hetzner location, e.g. 'fsn1'", default: "fsn1" },
			},
			required: ["name"],
		},
	},
	{
		name: "void_deploy",
		description:
			"Trigger a deployment on a server. Sends a deploy command to the connected agent over WebSocket. The agent clones the repo, runs Railpack, starts the container, streams logs back.",
		inputSchema: {
			type: "object",
			properties: {
				server_id: { type: "string", description: "Target server (from void_list_servers)" },
				repo_url: { type: "string", description: "Git URL, e.g. 'https://github.com/owner/repo'" },
				ref: { type: "string", description: "Branch / tag / commit SHA. Default: 'main'", default: "main" },
				env: { type: "object", description: "Env vars as key-value", additionalProperties: { type: "string" } },
				build_command: { type: "string", description: "Shell command to run after clone (e.g. 'cd examples/static-site && npm run build'). Default: skip build." },
				serve_command: { type: "string", description: "Shell command to run in background after build (e.g. 'cd examples/static-site && npm start'). Default: no serve." },
				port: { type: "integer", description: "Local port the serve_command listens on. Default: 3000.", default: 3000 },
			},
			required: ["server_id", "repo_url"],
		},
	},
	{
		name: "void_get_logs",
		description: "Stream build/runtime logs for a deployment via SSE.",
		inputSchema: {
			type: "object",
			properties: {
				server_id: { type: "string" },
				deployment_id: { type: "string" },
			},
			required: ["server_id"],
		},
	},
	{
		name: "void_ping_agent",
		description: "Send a ping to the connected agent and return the agent's public key (verifies the WS is alive and the agent is registered).",
		inputSchema: {
			type: "object",
			properties: {
				server_id: { type: "string" },
			},
			required: ["server_id"],
		},
	},
];

function rpc(id: JsonRpcRequest["id"], result: any): JsonRpcResponse {
	return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcErr(id: JsonRpcRequest["id"], code: number, message: string, data?: any): JsonRpcResponse {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

export async function handleMcp(request: Request, env: any): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("MCP requires POST", { status: 405 });
	}

	let body: JsonRpcRequest;
	try {
		body = await request.json();
	} catch {
		return Response.json(rpcErr(null, -32700, "Parse error"), { status: 400 });
	}

	const { id, method, params } = body;

	// MCP initialize handshake
	if (method === "initialize") {
		return Response.json(
			rpc(id, {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "void", version: "0.1.0" },
			})
		);
	}

	// tools/list
	if (method === "tools/list") {
		return Response.json(rpc(id, { tools: TOOLS }));
	}

	// tools/call
	if (method === "tools/call") {
		const toolName = params?.name as string;
		const args = (params?.arguments || {}) as Record<string, any>;

		try {
			switch (toolName) {
				case "void_list_servers": {
					const { results } = await env.void_db
						.prepare("SELECT id, name, provider, status, region, last_seen_at FROM servers ORDER BY created_at DESC")
						.all();
					return Response.json(
						rpc(id, {
							content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
						})
					);
				}

				case "void_create_server": {
					const id = `srv_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
					const now = Math.floor(Date.now() / 1000);
					// For MVP, insert as 'provisioning'. Real impl would call Hetzner API + cloud-init.
					await env.void_db
						.prepare(
							`INSERT INTO servers (id, name, provider, region, size, status, created_at)
							 VALUES (?, ?, ?, ?, ?, 'provisioning', ?)`
						)
						.bind(id, args.name, args.provider || "hetzner", args.region || "fsn1", args.size || "cx22", now)
						.run();
					return Response.json(
						rpc(id, {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											id,
											name: args.name,
											provider: args.provider || "hetzner",
											region: args.region || "fsn1",
											size: args.size || "cx22",
											status: "provisioning",
											note: "MVP stub — real Hetzner provisioning wires up the cloud-init flow in v0.1",
										},
										null,
										2
									),
								},
							],
						})
					);
				}

				case "void_deploy": {
					const serverId = args.server_id as string;
					const deploymentId = `dep_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

					// Check server exists
					const server = await env.void_db
						.prepare("SELECT id, status FROM servers WHERE id = ?")
						.bind(serverId)
						.first();
					if (!server) {
						return Response.json(
							rpcErr(id, -32004, `Server ${serverId} not found. Use void_list_servers to see available servers.`)
						);
					}

					// Insert deployment row
					await env.void_db
						.prepare(
							`INSERT INTO deployments (id, server_id, ref, status, started_at)
							 VALUES (?, ?, ?, 'queued', ?)`
						)
						.bind(deploymentId, serverId, args.ref || "main", Math.floor(Date.now() / 1000))
						.run();

					// Send deploy command to the agent via the void-cell DO
					const cellId = env.void_cell.idFromName(serverId);
					const cellStub = env.void_cell.get(cellId);
					const sendResp = await cellStub.fetch("https://cell/send-deploy", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							deployment_id: deploymentId,
							repo_url: args.repo_url,
							ref: args.ref || "main",
							env: args.env || {},
							build_command: args.build_command || null,
							serve_command: args.serve_command || null,
							port: args.port || 3000,
						}),
					});

					const sendResult: any = await sendResp.json();

					return Response.json(
						rpc(id, {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											deployment_id: deploymentId,
											server_id: serverId,
											repo_url: args.repo_url,
											ref: args.ref || "main",
											build_command: args.build_command || "(skipped)",
											serve_command: args.serve_command || "(skipped)",
											port: args.port || 3000,
											dispatched_to_agent: sendResp.ok,
											agent_response: sendResult,
											note: "Watch logs via void_get_logs (SSE stream).",
										},
										null,
										2
									),
								},
							],
						})
					);
				}

				case "void_get_logs": {
					const serverId = args.server_id as string;
					const deploymentId = (args.deployment_id as string) || "";
					const cellId = env.void_cell.idFromName(serverId);
					const cellStub = env.void_cell.get(cellId);
					const params = new URLSearchParams();
					if (deploymentId) params.set("deployment_id", deploymentId);
					const logResp = await cellStub.fetch(`https://cell/logs?${params.toString()}`);

					// Return the SSE stream directly as the tool response (MCP supports stream)
					return new Response(logResp.body, {
						headers: {
							"content-type": "text/event-stream",
							"cache-control": "no-cache",
						},
					});
				}

				case "void_ping_agent": {
					const serverId = args.server_id as string;
					const cellId = env.void_cell.idFromName(serverId);
					const cellStub = env.void_cell.get(cellId);
					const statusResp = await cellStub.fetch("https://cell/status");
					const status: any = await statusResp.json();
					return Response.json(
						rpc(id, {
							content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
						})
					);
				}

				default:
					return Response.json(rpcErr(id, -32601, `Unknown tool: ${toolName}`));
			}
		} catch (e: any) {
			return Response.json(rpcErr(id, -32603, `Tool execution error: ${e?.message || e}`));
		}
	}

	// ping
	if (method === "ping") {
		return Response.json(rpc(id, { pong: true, ts: Date.now() }));
	}

	return Response.json(rpcErr(id, -32601, `Method not found: ${method}`));
}
