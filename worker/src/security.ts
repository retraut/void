/**
 * void Worker — input validation + HMAC signing
 *
 * Defense against:
 * - C1: no auth on API/MCP (handled in auth.ts via requireBearer)
 * - C3: shell injection via deploy params
 * - C2: unsigned deploy frames
 */

import { timingSafeEqual } from "./auth";

/**
 * Validate git ref (branch / tag / commit SHA).
 * Allows: alphanumeric, dot, dash, underscore, slash, plus (for git refs).
 * Rejects: newlines, backticks, dollar-paren (command substitution), backslash, spaces, control chars.
 */
export function validateRef(ref: string): { ok: true } | { ok: false; reason: string } {
	if (typeof ref !== "string") return { ok: false, reason: "ref must be a string" };
	if (ref.length === 0) return { ok: false, reason: "ref cannot be empty" };
	if (ref.length > 200) return { ok: false, reason: "ref too long (max 200)" };
	if (!/^[a-zA-Z0-9._/+-]+$/.test(ref)) {
		return {
			ok: false,
			reason: "ref must match [a-zA-Z0-9._/+-]+ (no spaces, no shell metachars)",
		};
	}
	if (ref.startsWith("-")) {
		return { ok: false, reason: "ref cannot start with '-' (flag injection)" };
	}
	return { ok: true };
}

/**
 * Validate git repo URL.
 * Only allows https URLs from known git hosts. Rejects anything with shell metachars.
 */
const ALLOWED_REPO_HOSTS = new Set([
	"github.com",
	"gitlab.com",
	"bitbucket.org",
	"gitea.com",
]);

export function validateRepoUrl(url: string): { ok: true; normalized: string } | { ok: false; reason: string } {
	if (typeof url !== "string") return { ok: false, reason: "repo_url must be a string" };
	if (url.length === 0) return { ok: false, reason: "repo_url cannot be empty" };
	if (url.length > 500) return { ok: false, reason: "repo_url too long (max 500)" };
	// Reject shell metachars outright
	if (/[`$\n\r\\;|<>&]/.test(url)) {
		return { ok: false, reason: "repo_url contains shell metachars" };
	}
	// Must be https
	if (!url.startsWith("https://") && !url.startsWith("git@")) {
		return { ok: false, reason: "repo_url must start with https:// or git@" };
	}
	// Extract host
	let host = "";
	try {
		if (url.startsWith("git@")) {
			host = url.split(":")[0].replace("git@", "");
		} else {
			host = new URL(url).host;
		}
	} catch {
		return { ok: false, reason: "repo_url is not a valid URL" };
	}
	if (!ALLOWED_REPO_HOSTS.has(host)) {
		return { ok: false, reason: `repo_url host '${host}' not in allowlist` };
	}
	// Normalize: strip trailing .git
	let normalized = url;
	if (normalized.endsWith(".git")) normalized = normalized.slice(0, -4);
	return { ok: true, normalized };
}

/**
 * Validate shell command (build_command / serve_command).
 * STRICT allowlist — only safe characters. NO shell metachars at all.
 * The build/serve command runs as `sh -c CMD`, so even seemingly safe
 * chars like `;` and `&` are dangerous (command chaining).
 */
const ALLOWED_SHELL_CHARS = /^[a-zA-Z0-9\s\-_/.:=+,'"*?~!@#%^(),{}\[\]]+$/;
const FORBIDDEN_PATTERNS = [
	/;/,            // command chaining
	/\|/,           // pipe
	/&/,            // background / and / &&
	/\$/,           // variable / command substitution $()
	/\\/,          // backslash (escape)
	/\n/,           // newline
	/\r/,           // carriage return
	/[<>]/,        // redirect operators
	/\|\s*sh/,     // pipe to sh
	/\|\s*bash/,   // pipe to bash
	/&&\s*rm/,     // force rm chain
	/;\s*rm/,      // force rm chain
];

export function validateShellCommand(
	cmd: string,
	field: string,
): { ok: true } | { ok: false; reason: string } {
	if (typeof cmd !== "string") return { ok: false, reason: `${field} must be a string` };
	if (cmd.length === 0) return { ok: true }; // empty is allowed (means "skip")
	if (cmd.length > 2000) return { ok: false, reason: `${field} too long (max 2000)` };
	if (!ALLOWED_SHELL_CHARS.test(cmd)) {
		return {
			ok: false,
			reason: `${field} contains forbidden characters. Allowed: alphanum, spaces, ., /, -, _, :, =, +, ', \", *, ?, ~, !, @, #, %, ^, (, ), {, }, [, ]`,
		};
	}
	for (const pat of FORBIDDEN_PATTERNS) {
		if (pat.test(cmd)) {
			return { ok: false, reason: `${field} contains forbidden pattern: ${pat}` };
		}
	}
	return { ok: true };
}

/**
 * Sign a payload with HMAC-SHA256 using AGENT_SHARED_SECRET.
 * Returns "v1.<hex>" signature for versioned compatibility.
 */
export async function signWithAgentSecret(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	const hex = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `v1.${hex}`;
}

/**
 * Verify a signature against a payload. Constant-time compare.
 */
export async function verifyWithAgentSecret(
	secret: string,
	payload: string,
	signature: string,
): Promise<boolean> {
	const expected = await signWithAgentSecret(secret, payload);
	return timingSafeEqual(expected, signature);
}
