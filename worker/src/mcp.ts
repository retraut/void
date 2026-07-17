/**
 * void Worker — minimal MCP server
 *
 * Implements JSON-RPC 2.0 + MCP Streamable HTTP.
 * Tools: void_list_servers, void_create_server, void_deploy, void_get_logs,
 *        void_ping_agent, void_teardown.
 */

import { Env } from "./env";
import {
	removeIngressRule,
	findDnsRecord,
	deleteDnsRecord,
} from "./cf";
import { getServer as hetznerGetServer, deleteServer as hetznerDeleteServer } from "./hetzner";
import { createServerForUser } from "./server-create";
import { getProviderToken } from "./credentials";

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
				image: { type: "string", description: "OS image", default: "ubuntu-26.04" },
			},
			required: ["name"],
		},
	},
	{
		name: "void_deploy",
		description:
			"Deploy a repository to a server. Both must belong to the same Project aggregate.",
		inputSchema: {
			type: "object",
			properties: {
				repository_id: { type: "string", description: "Repository ID from the Project." },
				server_id: { type: "string", description: "Target server in the same Project." },
				ref: { type: "string", description: "Branch / tag / commit SHA. Defaults to repository default branch." },
				env: { type: "object", description: "Env vars as key-value", additionalProperties: { type: "string" } },
				hostname: { type: "string", description: "Custom public hostname (without zone). Default: auto-generated from deployment_id." },
			},
			required: ["repository_id", "server_id"],
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
		name: "void_list_projects",
		description: "List Project aggregates with their GitHub connection, repositories, and servers.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
];

function rpc(id: JsonRpcRequest["id"], result: any): JsonRpcResponse {
	return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcErr(id: JsonRpcRequest["id"], code: number, message: string, data?: any): JsonRpcResponse {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

export async function handleMcp(c: any): Promise<Response> {
	const request = c.req.raw;
	const env = c.env as Env;
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
					const image = (args.image as string) || "ubuntu-26.04";

					// Provider guard — only hetzner + stub supported for now
					if (provider !== "hetzner" && provider !== "stub") {
						return Response.json(
							rpcErr(id, -32009, `Provider '${provider}' not yet supported. Use 'hetzner' or 'stub'.`),
						);
					}

					// Resolve user from bearer-auth context (if any) — same code path as UI
					const u = c.get?.("user");
					const userId = u?.id || null;

					try {
						const result = await createServerForUser(
							env,
							userId,
							{ name, size, region, image },
							request.url,
						);
						return Response.json(
							rpc(id, {
								content: [
									{
										type: "text",
										text: JSON.stringify(
											{
												id: result.id,
												hetzner_id: result.hetzner_id,
												name,
												status: result.status,
												public_ip: result.public_ip,
												region: result.region,
												datacenter: result.datacenter,
												size: result.size,
												image: result.image,
												mode: result.mode,
												note: result.note,
											},
											null,
											2,
										),
									},
								],
							})
						);
					} catch (e: any) {
						return Response.json(
							rpcErr(id, -32010, e?.message || String(e))
						);
					}
				}

				case "void_deploy": {
					const repositoryId = String(args.repository_id || "");
					const serverId = String(args.server_id || "");
					const repository = await env.void_db
						.prepare(
							"SELECT id, project_id, clone_url, default_branch, default_port, build_command, serve_command FROM repositories WHERE id = ?",
						)
						.bind(repositoryId)
						.first<any>();
					const server = await env.void_db
						.prepare("SELECT id, project_id, status FROM servers WHERE id = ?")
						.bind(serverId)
						.first<any>();
					if (!repository) return Response.json(rpcErr(id, -32000, "repository not found"));
					if (!server) return Response.json(rpcErr(id, -32004, "server not found"));
					if (repository.project_id !== server.project_id) {
						return Response.json(rpcErr(id, -32009, "repository and server must belong to the same project"));
					}
					if (server.status !== "active") return Response.json(rpcErr(id, -32010, "server agent is not active"));
					const { getGithubToken, githubCloneEnv } = await import("./github-connections");
					const token = await getGithubToken(env, repository.project_id);
					if (!token) return Response.json(rpcErr(id, -32011, "project GitHub connection is missing"));
					const { triggerDeploy } = await import("./webhook");
					const result = await triggerDeploy(env, {
						repository_id: repository.id,
						project_id: repository.project_id,
						server_id: server.id,
						repo_url: repository.clone_url,
						ref: String(args.ref || repository.default_branch),
						build_command: repository.build_command || undefined,
						serve_command: repository.serve_command || undefined,
						port: repository.default_port,
						env: args.env || {},
						clone_env: githubCloneEnv(token),
						hostname: args.hostname as string | undefined,
					});
					return Response.json(rpc(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }));
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

				case "void_list_projects": {
					const projects = await env.void_db
						.prepare(
							`SELECT w.id, w.name, w.slug, gc.login AS github_login,
							        (SELECT COUNT(*) FROM repositories r WHERE r.project_id = w.id) AS repositories,
							        (SELECT COUNT(*) FROM servers s WHERE s.project_id = w.id) AS servers
							 FROM projects w LEFT JOIN github_connections gc ON gc.project_id = w.id
							 ORDER BY w.is_default DESC, w.created_at`,
						)
						.all();
					return Response.json(rpc(id, { content: [{ type: "text", text: JSON.stringify(projects.results, null, 2) }] }));
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
