/**
 * void Worker — WebAuthn / passkey helpers
 *
 * Server-side logic for the passkey flows. The browser side uses
 * @simplewebauthn/browser loaded from CDN (no build step).
 *
 * Two flows:
 *   1. Registration — user is already authenticated (typically via
 *      GitHub OAuth) and wants to add a passkey for next-time login.
 *   2. Authentication — the user clicks "Continue with passkeys" on
 *      the landing page. The browser shows a passkey picker
 *      (discoverable credentials), picks one, server verifies, and
 *      issues a session cookie.
 *
 * Storage:
 *   - passkeys table: one row per registered passkey
 *   - challenge cookies: `passkey_reg_challenge` and `passkey_auth_challenge`
 *     (httpOnly, secure, 5min TTL). Same shape as the existing session
 *     cookie attributes for consistency.
 *
 * RP ID / origin:
 *   Derived from the request URL (hostname = rpID, origin = full URL).
 *   - prod: rpID = "void.retraut.workers.dev"
 *   - dev:  rpID = "localhost" (works because no port in rpID)
 */

import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
	AuthenticatorTransportFuture,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import type { Env } from "./env";

export interface PasskeyRow {
	id: string;
	user_id: string;
	credential_id: string;
	credential_public_key: Uint8Array;
	counter: number;
	transports: string | null;
	name: string;
	created_at: number;
	last_used_at: number | null;
}

/** Cookie names — separate for register vs auth to avoid races. */
export const PASSKEY_REG_CHALLENGE_COOKIE = "passkey_reg_challenge";
export const PASSKEY_AUTH_CHALLENGE_COOKIE = "passkey_auth_challenge";
const CHALLENGE_TTL_SECONDS = 5 * 60;

function rpFromRequest(req: Request): { id: string; name: string; origin: string } {
	const url = new URL(req.url);
	return { id: url.hostname, name: "void", origin: url.origin };
}

/**
 * Start passkey registration. Returns the options the browser needs to
 * call navigator.credentials.create(). Caller must store `opts.challenge`
 * in a cookie to verify the response later.
 *
 * `excludeCredentials` prevents the user from registering the same
 * authenticator twice (e.g. their MacBook TouchID). The browser will
 * show a "this passkey is already registered" message instead.
 */
export async function startRegistration(
	req: Request,
	user: { id: string; username: string },
	existingCredentialIds: string[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
	const rp = rpFromRequest(req);
	return await generateRegistrationOptions({
		rpName: rp.name,
		rpID: rp.id,
		userID: new TextEncoder().encode(user.id),
		userName: user.username,
		userDisplayName: user.username,
		// `preferred` lets the browser do discoverable credentials
		// (so we can use them in the "Continue with passkeys" flow),
		// but doesn't fail on authenticators that don't support it.
		authenticatorSelection: {
			residentKey: "preferred",
			userVerification: "preferred",
		},
		excludeCredentials: existingCredentialIds.map((id) => ({
			id,
			transports: [] as AuthenticatorTransportFuture[],
		})),
	});
}

export type FinishRegistrationResult =
	| {
			ok: true;
			credential: {
				id: string; // base64url
				publicKey: Uint8Array;
				counter: number;
				transportsJson: string | null;
			};
	  }
	| { ok: false; error: string };

/**
 * Verify the response from navigator.credentials.create(). On success,
 * returns the credential fields ready for D1 storage.
 */
export async function finishRegistration(
	req: Request,
	response: unknown,
	expectedChallenge: string,
): Promise<FinishRegistrationResult> {
	const rp = rpFromRequest(req);
	let verification;
	try {
		verification = await verifyRegistrationResponse({
			response: response as any,
			expectedChallenge,
			expectedOrigin: rp.origin,
			expectedRPID: rp.id,
			requireUserVerification: false,
		});
	} catch (e) {
		return { ok: false, error: `verification threw: ${(e as Error).message}` };
	}
	if (!verification.verified || !verification.registrationInfo) {
		return { ok: false, error: "verification failed" };
	}
	const { credential } = verification.registrationInfo;
	return {
		ok: true,
		credential: {
			id: credential.id,
			publicKey: credential.publicKey,
			counter: credential.counter,
			transportsJson: credential.transports
				? JSON.stringify(Array.from(credential.transports))
				: null,
		},
	};
}

/**
 * Start passkey authentication. Returns options for
 * navigator.credentials.get(). No `allowCredentials` — we use
 * discoverable credentials so the browser shows a passkey picker
 * across all the user's passkeys for this RP.
 */
export async function startAuthentication(
	req: Request,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
	const rp = rpFromRequest(req);
	return await generateAuthenticationOptions({
		rpID: rp.id,
		userVerification: "preferred",
	});
}

export type FinishAuthenticationResult =
	| { ok: true; newCounter: number }
	| { ok: false; error: string };

/**
 * Verify the response from navigator.credentials.get(). Caller passes
 * the passkey row we looked up by `credential_id`.
 */
export async function finishAuthentication(
	req: Request,
	response: unknown,
	expectedChallenge: string,
	passkey: PasskeyRow,
): Promise<FinishAuthenticationResult> {
	const rp = rpFromRequest(req);
	let verification;
	try {
		verification = await verifyAuthenticationResponse({
			response: response as any,
			expectedChallenge,
			expectedOrigin: rp.origin,
			expectedRPID: rp.id,
			credential: {
				id: passkey.credential_id,
				publicKey: passkey.credential_public_key,
				counter: passkey.counter,
				transports: passkey.transports
					? (JSON.parse(passkey.transports) as AuthenticatorTransportFuture[])
					: undefined,
			},
			requireUserVerification: false,
		});
	} catch (e) {
		return { ok: false, error: `verification threw: ${(e as Error).message}` };
	}
	if (!verification.verified) {
		return { ok: false, error: "verification failed" };
	}
	return { ok: true, newCounter: verification.authenticationInfo.newCounter };
}

/**
 * Look up a passkey by its credential_id (the one the browser returns
 * in the auth response). The passkey might not be discoverable to us
 * without this — we don't get a user_id from the browser, only the
 * credential id.
 */
export async function getPasskeyByCredentialId(
	env: Env,
	credentialId: string,
): Promise<PasskeyRow | null> {
	const row = await env.void_db
		.prepare(
			"SELECT id, user_id, credential_id, credential_public_key, counter, transports, name, created_at, last_used_at FROM passkeys WHERE credential_id = ?",
		)
		.bind(credentialId)
		.first<PasskeyRow>();
	return row || null;
}

/**
 * Save a new passkey row. `credentialId` is the base64url credential ID
 * from the browser (NOT a UUID we generate — it's the authenticator's
 * stable identifier for this key).
 */
export async function savePasskey(
	env: Env,
	userId: string,
	credentialId: string,
	publicKey: Uint8Array,
	counter: number,
	transportsJson: string | null,
	name: string,
): Promise<{ id: string }> {
	const id = `pk_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
	const now = Math.floor(Date.now() / 1000);
	await env.void_db
		.prepare(
			`INSERT INTO passkeys (id, user_id, credential_id, credential_public_key, counter, transports, name, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, userId, credentialId, publicKey, counter, transportsJson, name, now)
		.run();
	return { id };
}

/** Bump the counter (anti-replay) and last_used_at on a successful auth. */
export async function touchPasskey(env: Env, passkeyId: string, newCounter: number): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await env.void_db
		.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
		.bind(newCounter, now, passkeyId)
		.run();
}

/** List passkeys for the /settings page (no public key in the response). */
export async function listPasskeys(
	env: Env,
	userId: string,
): Promise<Array<{ id: string; name: string; created_at: number; last_used_at: number | null }>> {
	const { results } = await env.void_db
		.prepare(
			"SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at DESC",
		)
		.bind(userId)
		.all<{ id: string; name: string; created_at: number; last_used_at: number | null }>();
	return results || [];
}

/** Delete a passkey. Verifies ownership before deleting. */
export async function deletePasskey(env: Env, userId: string, passkeyId: string): Promise<boolean> {
	const result = await env.void_db
		.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?")
		.bind(passkeyId, userId)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

/** Cookie options for challenge storage. Matches SESSION_COOKIE_OPTS. */
export const CHALLENGE_COOKIE_OPTS = {
	path: "/",
	secure: true,
	httpOnly: true,
	sameSite: "Lax" as const,
	maxAge: CHALLENGE_TTL_SECONDS,
};
