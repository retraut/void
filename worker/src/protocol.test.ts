/**
 * void Agent ↔ Worker protocol — Zod schema tests
 *
 * Run with: npx vitest run src/protocol.test.ts
 */

import { describe, expect, it } from "vitest";
import {
	AgentOutFrameSchema,
	WorkerToAgentFrameSchema,
	parseAgentFrame,
	parseWorkerFrame,
} from "./protocol";

describe("AgentOut (agent → worker)", () => {
	describe("register", () => {
		it("accepts first-time register with setup_token", () => {
			const r = AgentOutFrameSchema.parse({
				type: "register",
				server_id: "srv_abc",
				public_key: "MCowBQYDK2VwAyEAR9pyz3Wm0EfY...",
				setup_token: "set_xyz",
			});
			expect(r.type).toBe("register");
			if (r.type === "register") {
				expect(r.setup_token).toBe("set_xyz");
				expect(r.session_token).toBeUndefined();
			}
		});

		it("accepts reconnect with session_token", () => {
			const r = AgentOutFrameSchema.parse({
				type: "register",
				server_id: "srv_abc",
				public_key: "MCowBQYDK2VwAyEAR9pyz3Wm0EfY...",
				session_token: "sess_abc",
			});
			expect(r.type).toBe("register");
		});

		it("rejects register with both setup_token and session_token", () => {
			expect(() =>
				AgentOutFrameSchema.parse({
					type: "register",
					server_id: "srv_abc",
					public_key: "key",
					setup_token: "set_xyz",
					session_token: "sess_abc",
				}),
			).toThrow();
		});

		it("rejects register with neither token", () => {
			expect(() =>
				AgentOutFrameSchema.parse({
					type: "register",
					server_id: "srv_abc",
					public_key: "key",
				}),
			).toThrow();
		});

		it("rejects register with unknown field (strict)", () => {
			expect(() =>
				AgentOutFrameSchema.parse({
					type: "register",
					server_id: "srv_abc",
					public_key: "key",
					setup_token: "set_xyz",
					extra_field: "nope",
				}),
			).toThrow();
		});
	});

	describe("heartbeat", () => {
		it("accepts valid heartbeat", () => {
			const r = AgentOutFrameSchema.parse({ type: "heartbeat", timestamp: 1747526400 });
			expect(r.type).toBe("heartbeat");
		});

		it("rejects heartbeat with negative timestamp", () => {
			expect(() =>
				AgentOutFrameSchema.parse({ type: "heartbeat", timestamp: -1 }),
			).toThrow();
		});
	});

	describe("log", () => {
		it("accepts valid log line", () => {
			const r = AgentOutFrameSchema.parse({
				type: "log",
				deployment_id: "dep_1",
				stream: "stdout",
				data: "building...\n",
				line: 42,
			});
			expect(r.type).toBe("log");
		});

		it("rejects log with invalid stream", () => {
			expect(() =>
				AgentOutFrameSchema.parse({
					type: "log",
					deployment_id: "dep_1",
					stream: "stdoutx",
					data: "x",
					line: 1,
				}),
			).toThrow();
		});

		it("rejects log line over 64KB", () => {
			expect(() =>
				AgentOutFrameSchema.parse({
					type: "log",
					deployment_id: "dep_1",
					stream: "stdout",
					data: "x".repeat(70_000),
					line: 1,
				}),
			).toThrow();
		});
	});

	describe("deploy_done", () => {
		it("accepts success with url", () => {
			const r = AgentOutFrameSchema.parse({
				type: "deploy_done",
				deployment_id: "dep_1",
				status: "success",
				url: "https://app.example.com",
				local_url: "http://127.0.0.1:3000",
			});
			expect(r.type).toBe("deploy_done");
		});

		it("accepts failed with error", () => {
			const r = AgentOutFrameSchema.parse({
				type: "deploy_done",
				deployment_id: "dep_1",
				status: "failed",
				error: "git clone failed",
			});
			expect(r.type).toBe("deploy_done");
		});

		it("rejects failed without error", () => {
			expect(() =>
				AgentOutFrameSchema.parse({
					type: "deploy_done",
					deployment_id: "dep_1",
					status: "failed",
				}),
			).toThrow();
		});
	});

	describe("ready", () => {
		it("accepts ready frame", () => {
			const r = AgentOutFrameSchema.parse({ type: "ready", timestamp: 1747526400 });
			expect(r.type).toBe("ready");
		});
	});
});

describe("WorkerToAgent (worker → agent)", () => {
	describe("registered", () => {
		it("accepts registered with session_token", () => {
			const r = WorkerToAgentFrameSchema.parse({
				type: "registered",
				session_token: "sess_xxx",
			});
			expect(r.type).toBe("registered");
		});

		it("accepts registered without session_token (reconnect)", () => {
			const r = WorkerToAgentFrameSchema.parse({ type: "registered" });
			expect(r.type).toBe("registered");
		});
	});

	describe("ping", () => {
		it("accepts empty ping", () => {
			const r = WorkerToAgentFrameSchema.parse({ type: "ping" });
			expect(r.type).toBe("ping");
		});
	});

	describe("pipeline", () => {
		it("accepts minimal pipeline", () => {
			const r = WorkerToAgentFrameSchema.parse({
				type: "pipeline",
				deployment_id: "dep_1",
				steps: [{ cmd: "git clone https://github.com/owner/repo .", timeout_s: 300 }],
			});
			expect(r.type).toBe("pipeline");
		});

		it("accepts full pipeline with env + sig", () => {
			const r = WorkerToAgentFrameSchema.parse({
				type: "pipeline",
				deployment_id: "dep_1",
				steps: [
					{ cmd: "git clone https://github.com/owner/repo .", timeout_s: 300 },
					{ cmd: "npm ci", timeout_s: 600 },
					{ cmd: "node server.js", timeout_s: 300 },
					{
						cmd: "cloudflared tunnel --no-autoupdate run",
						env: { TUNNEL_TOKEN: "eyJh..." },
						timeout_s: 300,
					},
				],
				sig: "v1.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			});
			expect(r.type).toBe("pipeline");
		});

		it("rejects empty steps", () => {
			expect(() =>
				WorkerToAgentFrameSchema.parse({
					type: "pipeline",
					deployment_id: "dep_1",
					steps: [],
				}),
			).toThrow();
		});

		it("rejects invalid sig format", () => {
			expect(() =>
				WorkerToAgentFrameSchema.parse({
					type: "pipeline",
					deployment_id: "dep_1",
					steps: [{ cmd: "echo hi", timeout_s: 300 }],
					sig: "not-a-valid-sig",
				}),
			).toThrow();
		});

		it("rejects step without cmd", () => {
			expect(() =>
				WorkerToAgentFrameSchema.parse({
					type: "pipeline",
					deployment_id: "dep_1",
					steps: [{ timeout_s: 300 }],
				}),
			).toThrow();
		});
	});

	describe("shutdown", () => {
		it("accepts empty shutdown", () => {
			const r = WorkerToAgentFrameSchema.parse({ type: "shutdown" });
			expect(r.type).toBe("shutdown");
		});
	});

	describe("error", () => {
		it("accepts error frame", () => {
			const r = WorkerToAgentFrameSchema.parse({
				type: "error",
				code: "invalid_token",
				message: "setup_token mismatch",
			});
			expect(r.type).toBe("error");
		});
	});
});

describe("parseAgentFrame (error handling)", () => {
	it("returns error for invalid JSON", () => {
		const r = parseAgentFrame("not json");
		expect("error" in r).toBe(true);
	});

	it("returns error for missing type", () => {
		const r = parseAgentFrame(JSON.stringify({ foo: "bar" }));
		expect("error" in r).toBe(true);
	});

	it("returns error for unknown type", () => {
		const r = parseAgentFrame(JSON.stringify({ type: "made_up", x: 1 }));
		expect("error" in r).toBe(true);
	});

	it("returns parsed frame on success", () => {
		const r = parseAgentFrame(
			JSON.stringify({ type: "heartbeat", timestamp: 1747526400 }),
		);
		expect("error" in r).toBe(false);
		if (!("error" in r)) {
			expect(r.type).toBe("heartbeat");
		}
	});
});

describe("parseWorkerFrame (error handling)", () => {
	it("returns error for invalid JSON", () => {
		const r = parseWorkerFrame("not json");
		expect("error" in r).toBe(true);
	});

	it("returns error for unknown field (strict)", () => {
		const r = parseWorkerFrame(
			JSON.stringify({ type: "ping", extra: "nope" }),
		);
		expect("error" in r).toBe(true);
	});
});
