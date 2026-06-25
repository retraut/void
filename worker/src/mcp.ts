/**
 * void Worker — minimal MCP server
 *
 * Implements JSON-RPC 2.0 + MCP Streamable HTTP.
 * Tools: void_list_servers, void_create_server, void_deploy, void_get_logs,
 *        void_ping_agent, void_teardown.
 */

import { Env } from "./env";
import {
	createTunnel,
	createDnsCname,
	upsertIngressRule,
	removeIngressRule,
	findDnsRecord,
	deleteDnsRecord,
} from "./cf";
import {
	buildCloudInit,
	createServer as hetznerCreateServer,
	getServer as hetznerGetServer,
	deleteServer as hetznerDeleteServer,
} from "./hetzner";

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
			"Create a new server. With HETZNER_TOKEN set, this provisions a real Hetzner Cloud VM, runs a cloud-init script that installs the void-agent, and the agent auto-registers with the control plane. Without the token, falls back to inserting a stub row (useful for dev).",
		inputSchema: {
			type: "object",
			properties: {
				provider: { type: "string", enum: ["hetzner", "digitalocean", "stub"], default: "hetzner" },
				name: { type: "string", description: "Friendly name, e.g. 'prod-1'" },
				size: { type: "string", description: "Hetzner server type, e.g. 'cx22' (€4.50/mo, 2vCPU/4GB)", default: "cx22" },
				region: { type: "string", description: "Hetzner location, e.g. 'fsn1' (Falkenstein, DE)", default: "fsn1" },
				image: { type: "string", description: "OS image", default: "ubuntu-24.04" },
			},
			required: ["name"],
		},
	},
	{
		name: "void_deploy",
		description:
			"Trigger a deployment on a server. Sends a deploy command to the connected agent over WebSocket. The agent clones the repo, runs the build, starts the serve, and (if cloudflared is installed + CF_API_TOKEN is set) makes the app publicly accessible via a wildcard tunnel + DNS record.",
		inputSchema: {
			type: "object",
			properties: {
				server_id: { type: "string", description: "Target server (from void_list_servers)" },
				repo_url: { type: "string", description: "Git URL, e.g. 'https://github.com/owner/repo'" },
				ref: { type: "string", description: "Branch / tag / commit SHA. Default: 'main'", default: "main" },
				env: { type: "object", description: "Env vars as key-value", additionalProperties: { type: "string" } },
				build_command: { type: "string", description: "Shell command to run after clone. Default: skip." },
				serve_command: { type: "string", description: "Shell command to run in background after build. Default: no serve." },
				port: { type: "integer", description: "Local port the serve_command listens on. Default: 3000.", default: 3000 },
				hostname: { type: "string", description: "Custom public hostname (without zone). Default: auto-generated from deployment_id." },
			},
			required: ["server_id", "repo_url"],
		},
	},
	{
		name: "void_teardown",
		description:
			"Tear down a deployment: removes the DNS record and the tunnel ingress rule for the hostname. Does NOT stop the running process on the agent (the agent handles that via the deployment lifecycle).",
		inputSchema: {
			type: "object",
			properties: {
				deployment_id: { type: "string", description: "Deployment to teardown" },
			},
			required: ["deployment_id"],
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
	{
		name: "void_register_project",
		description:
			"Register a project for git push auto-deploy. Once registered, configure a GitHub webhook on the repo pointing to POST /api/webhooks/github with a secret matching GITHUB_WEBHOOK_SECRET. Pushes to the default branch → production deploy; PRs → preview URL.",
		inputSchema: {
			type: "object",
			properties: {
				server_id: { type: "string", description: "Server to deploy to" },
				slug: { type: "string", description: "URL-safe project slug, e.g. 'my-app'" },
				name: { type: "string", description: "Display name" },
				repo_url: { type: "string", description: "Git URL, e.g. 'https://github.com/owner/repo'" },
				default_branch: { type: "string", description: "Default branch (main/master)", default: "main" },
				default_port: { type: "integer", description: "Port the serve_command listens on", default: 3000 },
				build_command: { type: "string", description: "Build command (optional)" },
				serve_command: { type: "string", description: "Serve command (optional)" },
			},
			required: ["server_id", "slug", "name", "repo_url"],
		},
	},
];

function rpc(id: JsonRpcRequest["id"], result: any): JsonRpcResponse {
	return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcErr(id: JsonRpcRequest["id"], code: number, message: string, data?: any): JsonRpcResponse {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
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

	if (method === "initialize") {
		return Response.json(
			rpc(id, {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "void", version: "0.1.0" },
			})
		);
	}

	if (method === "tools/list") {
		return Response.json(rpc(id, { tools: TOOLS }));
	}

	if (method === "tools/call") {
		const toolName = params?.name as string;
		const args = (params?.arguments || {}) as Record<string, any>;

		try {
			switch (toolName) {
				case "void_list_servers": {
					const { results } = await env.void_db
						.prepare("SELECT id, name, provider, status, region, last_seen_at, tunnel_id IS NOT NULL AS has_tunnel FROM servers ORDER BY created_at DESC")
						.all();
					return Response.json(
						rpc(id, {
							content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
						})
					);
				}

				case "void_create_server": {
					const provider = (args.provider as string) || "hetzner";
					const name = args.name as string;
					const region = (args.region as string) || "fsn1";
					const size = (args.size as string) || "cx22";
					const image = (args.image as string) || "ubuntu-24.04";
					const serverId = `srv_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
					const now = Math.floor(Date.now() / 1000);

					// Stub mode: no provider, just insert a row
					if (provider === "stub" || !env.HETZNER_TOKEN) {
						await env.void_db
							.prepare(
								`INSERT INTO servers (id, name, provider, region, size, status, created_at)
								 VALUES (?, ?, ?, ?, ?, 'provisioning', ?)`,
							)
							.bind(serverId, name, provider, region, size, now)
							.run();
						return Response.json(
							rpc(id, {
								content: [
									{
										type: "text",
										text: JSON.stringify(
											{
												id: serverId,
												name,
												provider,
												region,
												size,
												status: "provisioning",
												note: env.HETZNER_TOKEN
													? "Stub mode (provider=stub) — no Hetzner VM provisioned"
													: "HETZNER_TOKEN not configured — inserted stub row. Set the secret for real provisioning.",
											},
											null,
											2
										),
									},
								],
							})
						);
					}

					// Real Hetzner provisioning
					if (provider !== "hetzner") {
						return Response.json(
							rpcErr(
								id,
								-32009,
								`Provider '${provider}' not yet supported. Use 'hetzner' or 'stub'.`,
							)
						);
					}

					// generate a one-time setup token (we'll store it in D1 and the cloud-init
					// script will pass it to the agent for first registration)
					const setupToken = `set_${crypto.randomUUID().replace(/-/g, "")}`;
					// Insert row first with status 'provisioning' so the agent can find itself
					await env.void_db
						.prepare(
							`INSERT INTO servers (id, name, provider, region, size, status, created_at)
							 VALUES (?, ?, ?, ?, ?, 'provisioning', ?)`,
						)
						.bind(serverId, name, provider, region, size, now)
						.run();

					// Build cloud-init user_data. The agent binary URL points to the
					// latest release on the void-sh org — adjust when we publish.
					const apiBase = new URL(request.url).origin.replace(/^http/, "wss");
					const userData = buildCloudInit({
						server_id: serverId,
						setup_token: setupToken,
						api_base: apiBase,
						github_release_tag: env.VOID_AGENT_RELEASE_TAG || "v0.1.0",
					});

					try {
						const hs = await hetznerCreateServer(env.HETZNER_TOKEN, {
							name: `void-${serverId.slice(0, 12)}`,
							server_type: size,
							image,
							location: region,
							user_data: userData,
						});

						// Update the row with the real Hetzner details
						await env.void_db
							.prepare(
								`UPDATE servers SET provider_server_id = ?, ip_address = ?, status = 'provisioning' WHERE id = ?`,
							)
							.bind(
								String(hs.id),
								hs.public_net?.ipv4?.ip || null,
								serverId,
							)
							.run();

						// Store setup_token on the servers table too, so we can verify it
						// when the agent registers. (For MVP we trust the agent; a hardening
						// would be a separate setup_tokens table with TTL.)
						await env.void_db
							.prepare(`UPDATE servers SET agent_public_key = ? WHERE id = ?`)
							.bind(`pending:${setupToken}`, serverId)
							.run();

						return Response.json(
							rpc(id, {
								content: [
									{
										type: "text",
										text: JSON.stringify(
											{
												id: serverId,
												hetzner_id: hs.id,
												name: hs.name,
												status: hs.status, // "initializing" → "starting" → "running"
												public_ip: hs.public_net?.ipv4?.ip,
												region: hs.datacenter?.location?.name,
												datacenter: hs.datacenter?.name,
												size: hs.server_type?.name,
												image: hs.image?.name,
												note: "Agent will auto-register when cloud-init completes (~30-60s). Watch status with void_list_servers.",
											},
											null,
											2
										),
									},
								],
							})
						);
					} catch (e: any) {
						// Mark server as failed
						await env.void_db
							.prepare(`UPDATE servers SET status = 'failed' WHERE id = ?`)
							.bind(serverId)
							.run();
						return Response.json(
							rpcErr(id, -32010, `Hetzner provisioning failed: ${e?.message || e}`)
						);
					}
				}

				case "void_deploy": {
					const serverId = args.server_id as string;
					const deploymentId = `dep_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

					// Check server exists
					const server = await env.void_db
						.prepare(
							"SELECT id, status, tunnel_id, tunnel_token, tunnel_name FROM servers WHERE id = ?",
						)
						.bind(serverId)
						.first<{
							id: string;
							status: string;
							tunnel_id: string | null;
							tunnel_token: string | null;
							tunnel_name: string | null;
						}>();
					if (!server) {
						return Response.json(
							rpcErr(
								id,
								-32004,
								`Server ${serverId} not found. Use void_list_servers to see available servers.`,
							)
						);
					}

					// Cloudflare tunnel + DNS setup (if configured)
					let hostname: string | null = null;
					let publicUrl: string | null = null;
					let dnsRecordId: string | null = null;
					let tunnelToken = server.tunnel_token;
					let tunnelId = server.tunnel_id;

					if (env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ZONE_ID) {
						// 1. Create tunnel on first use
						if (!tunnelId || !tunnelToken) {
							try {
								const tunnel = await createTunnel(
									env.CF_API_TOKEN,
									env.CF_ACCOUNT_ID,
									`void-${serverId}`,
								);
								tunnelId = tunnel.id;
								tunnelToken = tunnel.token;
								await env.void_db
									.prepare(
										"UPDATE servers SET tunnel_id = ?, tunnel_name = ?, tunnel_token = ? WHERE id = ?",
									)
									.bind(tunnelId, tunnel.name, tunnelToken, serverId)
									.run();
							} catch (e: any) {
								return Response.json(
									rpcErr(
										id,
										-32005,
										`Failed to create CF tunnel: ${e?.message || e}. Check CF_API_TOKEN / CF_ACCOUNT_ID.`,
									)
								);
							}
						}

						// 2. Compute hostname
						hostname = (args.hostname as string) || `pr-${deploymentId}`;
						// 3. Upsert ingress
						const port = (args.port as number) || 3000;
						try {
							await upsertIngressRule(
								env.CF_API_TOKEN,
								env.CF_ACCOUNT_ID,
								tunnelId!,
								hostname,
								`http://localhost:${port}`,
							);
						} catch (e: any) {
							return Response.json(
								rpcErr(id, -32006, `Failed to update tunnel ingress: ${e?.message || e}`),
							);
						}

						// 4. Create DNS record
						try {
							// Get zone name to build FQDN
							const zoneResp = await fetch(
								`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}`,
								{ headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } },
							);
							const zoneBody: any = await zoneResp.json();
							const zoneName: string = zoneBody.result?.name || "void.delivery";
							const fqdn = `${hostname}.${zoneName}`;
							const dns = await createDnsCname(
								env.CF_API_TOKEN,
								env.CF_ZONE_ID,
								fqdn,
								tunnelId!,
							);
							dnsRecordId = dns.id;
							publicUrl = `https://${fqdn}`;
						} catch (e: any) {
							return Response.json(
								rpcErr(id, -32007, `Failed to create DNS record: ${e?.message || e}`),
							);
						}
					}

					// 5. Insert deployment row
					const now = Math.floor(Date.now() / 1000);
					await env.void_db
						.prepare(
							`INSERT INTO deployments (id, server_id, ref, status, started_at, hostname, public_url, dns_record_id, port)
							 VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
						)
						.bind(
							deploymentId,
							serverId,
							args.ref || "main",
							now,
							hostname,
							publicUrl,
							dnsRecordId,
							(args.port as number) || 3000,
						)
						.run();

					// 6. Send deploy command to the agent via the void-cell DO
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
							port: (args.port as number) || 3000,
							hostname,
							public_url: publicUrl,
							tunnel_token: tunnelToken,
							tunnel_id: tunnelId,
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
											port: (args.port as number) || 3000,
											hostname,
											public_url: publicUrl,
											dns_record_id: dnsRecordId,
											tunnel_id: tunnelId,
											dispatched_to_agent: sendResp.ok,
											agent_response: sendResult,
											note: publicUrl
												? `Public URL: ${publicUrl} (requires cloudflared running on agent)`
												: "No public URL — set CF_API_TOKEN/CF_ACCOUNT_ID/CF_ZONE_ID to enable tunneling",
										},
										null,
										2
									),
								},
							],
						})
					);
				}

				case "void_teardown": {
					const deploymentId = args.deployment_id as string;
					const dep = await env.void_db
						.prepare(
							"SELECT id, server_id, hostname, dns_record_id, public_url, port FROM deployments WHERE id = ?",
						)
						.bind(deploymentId)
						.first<{
							id: string;
							server_id: string;
							hostname: string | null;
							dns_record_id: string | null;
							public_url: string | null;
							port: number;
						}>();
					if (!dep) {
						return Response.json(rpcErr(id, -32004, `Deployment ${deploymentId} not found`));
					}

					if (env.CF_API_TOKEN && env.CF_ACCOUNT_ID) {
						const server = await env.void_db
							.prepare("SELECT tunnel_id FROM servers WHERE id = ?")
							.bind(dep.server_id)
							.first<{ tunnel_id: string | null }>();
						if (server?.tunnel_id && dep.hostname) {
							try {
								await removeIngressRule(
									env.CF_API_TOKEN,
									env.CF_ACCOUNT_ID,
									server.tunnel_id,
									dep.hostname,
								);
							} catch (e: any) {
								// log but don't fail
							}
						}
						if (dep.dns_record_id && env.CF_ZONE_ID) {
							try {
								await deleteDnsRecord(
									env.CF_API_TOKEN,
									env.CF_ZONE_ID,
									dep.dns_record_id,
								);
							} catch (e: any) {
								// log but don't fail
							}
						}
					}

					await env.void_db
						.prepare("UPDATE deployments SET status = 'cancelled' WHERE id = ?")
						.bind(deploymentId)
						.run();

					return Response.json(
						rpc(id, {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{ deployment_id: deploymentId, status: "cancelled" },
										null,
										2,
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

				case "void_register_project": {
					const slug = (args.slug as string).toLowerCase().replace(/[^a-z0-9-]/g, "-");
					const projectId = `proj_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

					// verify server exists
					const serverCheck = await env.void_db
						.prepare("SELECT id FROM servers WHERE id = ?")
						.bind(args.server_id)
						.first();
					if (!serverCheck) {
						return Response.json(rpcErr(id, -32004, `Server ${args.server_id} not found`));
					}

					try {
						await env.void_db
							.prepare(
								`INSERT INTO projects (id, server_id, slug, name, repo_url, default_branch, default_port, build_command, serve_command)
								 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							)
							.bind(
								projectId,
								args.server_id,
								slug,
								args.name,
								args.repo_url,
								args.default_branch || "main",
								(args.default_port as number) || 3000,
								(args.build_command as string) || null,
								(args.serve_command as string) || null,
							)
							.run();
					} catch (e: any) {
						if (String(e?.message || e).includes("UNIQUE")) {
							return Response.json(
								rpcErr(id, -32008, `Project with slug '${slug}' already exists for this user`),
							);
						}
						throw e;
					}

					return Response.json(
						rpc(id, {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											project_id: projectId,
											slug,
											name: args.name,
											repo_url: args.repo_url,
											server_id: args.server_id,
											default_branch: args.default_branch || "main",
											next_step: `Configure a GitHub webhook on ${args.repo_url}: URL=https://api.void.example.com/api/webhooks/github, content-type=application/json, secret=<your GITHUB_WEBHOOK_SECRET>, events=[push, pull_request]`,
										},
										null,
										2,
									),
								},
							],
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

	if (method === "ping") {
		return Response.json(rpc(id, { pong: true, ts: Date.now() }));
	}

	return Response.json(rpcErr(id, -32601, `Method not found: ${method}`));
}
