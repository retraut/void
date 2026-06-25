/**
 * void Worker — symmetric encryption for D1 secrets
 *
 * Uses AES-256-GCM with a key derived from COOKIE_SECRET (or any 32+ byte secret).
 * Format: "v1.<base64-iv>.<base64-ciphertext>.<base64-tag>"
 */

const ALGO = "AES-GCM";
const IV_BYTES = 12; // GCM standard

async function importKey(secret: string): Promise<CryptoKey> {
	// Pad/shorten to 32 bytes
	const raw = new TextEncoder().encode(secret);
	const key = new Uint8Array(32);
	for (let i = 0; i < 32; i++) key[i] = raw[i % raw.length];
	return crypto.subtle.importKey("raw", key, ALGO, false, ["encrypt", "decrypt"]);
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
