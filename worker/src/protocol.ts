/**
 * void Agent ↔ Worker protocol — single source of truth
 *
 * Both sides use these Zod schemas for runtime validation and to derive
 * their TypeScript types via `z.infer`. The Rust side mirrors these shapes
 * exactly via serde — see `agent/src/main.rs` `AgentOut` / `AgentIn`.
 *
 * Adding a field here = adding it on both sides. If one side deserializes
 * a frame that doesn't match its schema, it sends back an `error` frame
 * (or closes the WS) instead of silently ignoring the field.
 */

import { z } from "zod";

// ============================================================
// Shared primitives
// ============================================================

/** Unix timestamp in seconds (u32 range, post-2001 and pre-2106). */
export const TimestampSchema = z.number().int().nonnegative();

/** A non-empty ID string used for servers, projects, deployments, etc. */
export const IdSchema = z.string().min(1).max(64);

/** A base64-encoded Ed25519 public key (32 bytes → 44 chars). */
export const Ed25519PubKeySchema = z.string().min(1).max(128);

/** A setup_token or session_token issued by the Worker. */
export const TokenSchema = z.string().min(1).max(128);

/** A free-form shell command (already validated by validateShellCommand). */
export const ShellCommandSchema = z.string().min(1).max(2000);

/** A git ref: branch, tag, or commit SHA. */
export const GitRefSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[a-zA-Z0-9._/+-]+$/, "ref must match [a-zA-Z0-9._/+-]+");

/** A git repo URL (already validated by validateRepoUrl). */
export const RepoUrlSchema = z.string().url().max(500);

/** TCP port 1-65535. */
export const PortSchema = z.number().int().min(1).max(65535);

/** Environment variables. */
export const EnvSchema = z.record(z.string(), z.string()).default({});

/** HMAC-SHA256 signature: "v1.<64-hex>". */
export const HmacSigSchema = z.string().regex(/^v1\.[0-9a-f]{64}$/);

// ============================================================
// Frames: Agent → Worker
// ============================================================

/**
 * First-time register (setup_token) OR reconnect (session_token).
 * Exactly one of setup_token / session_token must be set.
 */
export const RegisterFrameSchema = z
	.object({
		type: z.literal("register"),
		server_id: IdSchema,
		public_key: Ed25519PubKeySchema,
		setup_token: TokenSchema.optional(),
		session_token: TokenSchema.optional(),
	})
	.strict()
	.refine(
		(d) => Boolean(d.setup_token) !== Boolean(d.session_token),
		"register: exactly one of setup_token / session_token must be set",
	);

export const HeartbeatFrameSchema = z
	.object({
		type: z.literal("heartbeat"),
		timestamp: TimestampSchema,
	})
	.strict();

export const LogFrameSchema = z
	.object({
		type: z.literal("log"),
		deployment_id: IdSchema,
		stream: z.enum(["stdout", "stderr"]),
		data: z.string().max(64 * 1024), // 64KB max per log line
		line: z.number().int().nonnegative(),
	})
	.strict();

export const DeployDoneFrameSchema = z
	.object({
		type: z.literal("deploy_done"),
		deployment_id: IdSchema,
		status: z.enum(["success", "failed"]),
		url: z.string().url().optional(),
		local_url: z.string().url().optional(),
		error: z.string().max(2000).optional(),
	})
	.strict()
	.refine(
		(d) => d.status === "success" || !!d.error,
		"deploy_done: status=failed requires error field",
	);

export const ReadyFrameSchema = z
	.object({
		type: z.literal("ready"),
		timestamp: TimestampSchema,
	})
	.strict();

/** Discriminated union of all agent → worker frames. */
export const AgentOutFrameSchema = z.discriminatedUnion("type", [
	RegisterFrameSchema,
	HeartbeatFrameSchema,
	LogFrameSchema,
	DeployDoneFrameSchema,
	ReadyFrameSchema,
]);

export type AgentOutFrame = z.infer<typeof AgentOutFrameSchema>;

// ============================================================
// Frames: Worker → Agent
// ============================================================

/**
 * Reply to a register frame. session_token is present only on FIRST register
 * (when setup_token was used) — agent persists it for future reconnects.
 */
export const RegisteredFrameSchema = z
	.object({
		type: z.literal("registered"),
		session_token: TokenSchema.optional(),
	})
	.strict();

/** Heartbeat probe — agent must reply with `ready`. */
export const PingFrameSchema = z
	.object({
		type: z.literal("ping"),
	})
	.strict();

/**
 * Deploy command. All fields except sig are part of the HMAC payload.
 * sig is set by Worker when AGENT_SHARED_SECRET is configured.
 */
export const DeployFrameSchema = z
	.object({
		type: z.literal("deploy"),
		deployment_id: IdSchema,
		repo_url: RepoUrlSchema,
		ref: GitRefSchema,
		env: EnvSchema,
		build_command: ShellCommandSchema.optional(),
		serve_command: ShellCommandSchema.optional(),
		port: PortSchema,
		hostname: z.string().min(1).max(253).optional(),
		public_url: z.string().url().optional(),
		tunnel_token: z.string().min(1).max(4096).optional(),
		tunnel_id: z.string().min(1).max(128).optional(),
		sig: HmacSigSchema.optional(),
	})
	.strict();

/** Graceful shutdown — agent calls std::process::exit(0). */
export const ShutdownFrameSchema = z
	.object({
		type: z.literal("shutdown"),
	})
	.strict();

/** Error frame sent to the other side before closing. */
export const ErrorFrameSchema = z
	.object({
		type: z.literal("error"),
		code: z.string().min(1).max(64),
		message: z.string().max(500).optional(),
	})
	.strict();

/** Discriminated union of all worker → agent frames. */
export const WorkerToAgentFrameSchema = z.discriminatedUnion("type", [
	RegisteredFrameSchema,
	PingFrameSchema,
	DeployFrameSchema,
	ShutdownFrameSchema,
	ErrorFrameSchema,
]);

export type WorkerToAgentFrame = z.infer<typeof WorkerToAgentFrameSchema>;

// ============================================================
// Validation helpers
// ============================================================

/**
 * Validate a JSON string from the agent (agent → worker). Returns either
 * the parsed frame or a formatted error string. Use this in the VoidCell DO.
 */
export function parseAgentFrame(raw: string): AgentOutFrame | { error: string } {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (e) {
		return { error: `invalid JSON: ${(e as Error).message}` };
	}
	const result = AgentOutFrameSchema.safeParse(json);
	if (!result.success) {
		return { error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
	}
	return result.data;
}

/**
 * Validate a JSON string from the worker (worker → agent) — for the agent
 * runtime. Mirrored on the Rust side via serde in `agent/src/main.rs`.
 */
export function parseWorkerFrame(raw: string): WorkerToAgentFrame | { error: string } {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (e) {
		return { error: `invalid JSON: ${(e as Error).message}` };
	}
	const result = WorkerToAgentFrameSchema.safeParse(json);
	if (!result.success) {
		return { error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
	}
	return result.data;
}
