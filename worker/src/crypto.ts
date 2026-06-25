/**
 * void Worker — symmetric encryption for D1 secrets
 *
 * Uses AES-256-GCM with a 32-byte key derived from the provided secret.
 * If the secret is < 32 bytes or > 32 bytes, it's hashed with SHA-256 to
 * produce a 32-byte key. If it is exactly 32 bytes, it is used as-is.
 *
 * Format: "v1.<base64-iv>.<base64-ciphertext>.<base64-tag>"
 */

const ALGO = "AES-GCM";
const IV_BYTES = 12; // GCM standard

async function importKey(secret: string): Promise<CryptoKey> {
	const raw = new TextEncoder().encode(secret);
	let key: Uint8Array;
	if (raw.length === 32) {
		key = raw;
	} else {
		// Derive a 32-byte key from any-length secret via SHA-256
		const hash = await crypto.subtle.digest("SHA-256", raw);
		key = new Uint8Array(hash);
	}
	return crypto.subtle.importKey("raw", key, ALGO, false, ["encrypt", "decrypt"]);
}

/**
 * Returns the key to use for encryption: ENCRYPTION_KEY (preferred, dedicated secret)
 * or COOKIE_SECRET (backward-compatible fallback). Throws if neither is configured.
 */
export function getEncryptionKey(env: { ENCRYPTION_KEY?: string; COOKIE_SECRET?: string }): string {
	const key = env.ENCRYPTION_KEY || env.COOKIE_SECRET;
	if (!key) {
		throw new Error(
			"ENCRYPTION_KEY (or legacy COOKIE_SECRET) is not configured — set it via `wrangler secret put ENCRYPTION_KEY`",
		);
	}
	return key;
}

export async function encrypt(secret: string, plaintext: string): Promise<string> {
	const key = await importKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ct = await crypto.subtle.encrypt(
		{ name: ALGO, iv },
		key,
		new TextEncoder().encode(plaintext),
	);
	const ctBytes = new Uint8Array(ct);
	const tag = ctBytes.slice(-16);
	const body = ctBytes.slice(0, -16);
	return `v1.${b64(iv)}.${b64(body)}.${b64(tag)}`;
}

export async function decrypt(secret: string, blob: string): Promise<string | null> {
	const parts = blob.split(".");
	if (parts.length !== 4 || parts[0] !== "v1") return null;
	try {
		const iv = fromB64(parts[1]);
		const body = fromB64(parts[2]);
		const tag = fromB64(parts[3]);
		const combined = new Uint8Array(body.length + tag.length);
		combined.set(body, 0);
		combined.set(tag, body.length);
		const key = await importKey(secret);
		const pt = await crypto.subtle.decrypt({ name: ALGO, iv }, key, combined);
		return new TextDecoder().decode(pt);
	} catch {
		return null;
	}
}

function b64(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s);
}

function fromB64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
