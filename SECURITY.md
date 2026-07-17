# Security Audit — void

> **Status: Point-in-time audit and remediation backlog.** This is not a complete
> statement of the current security architecture. For trust boundaries and
> current ownership, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Verify
> every finding against the referenced code before treating its status as current.

Date: 2026-06-25  
Rev: 5ba0a5d (Security sprint: address all CRITICAL + HIGH findings from SECURITY.md)  
Scope: agent + worker (Rust / TypeScript)

---

## Status legend
- ✅ FIXED
- ⚠️ PARTIALLY FIXED
- ❌ OPEN
- 🆕 NEW (since last audit)

---

## 🔴 CRITICAL

### C1. No authentication on API / MCP / WebSocket — ✅ FIXED

`requireBearer()` checks `VOID_BEARER_TOKEN` on all `/api/*` and `/mcp` routes.  
Token via `Authorization: Bearer` or `?token=` query param. Without token set, returns 503.

Files: `worker/src/auth.ts:25-54`, `worker/src/index.ts:60-62,79-83,167-170`

### C2. Ed25519 keypair unused — ✅ FIXED (switched to HMAC-SHA256)

Worker signs deploy frames with `AGENT_SHARED_SECRET` via HMAC-SHA256. Agent verifies signature before executing any command. Constant-time comparison on both sides.

Files: `worker/src/void-cell.ts:104-123`, `worker/src/security.ts:123-148`, `agent/src/main.rs:224-252,1008-1036`, `agent/src/config.rs:37`

### C3. No input validation — shell injection — ✅ FIXED

`validateRef()`, `validateRepoUrl()`, `validateShellCommand()` at three layers:
1. MCP tool handler (`worker/src/mcp.ts:330-345`)
2. DO `/send-deploy` (`worker/src/void-cell.ts:90-102`)
3. GitHub webhook (`worker/src/webhook.ts:262-273,307-319`)

`validateRepoUrl` normalizes URL and strips `.git`.  
`validateShellCommand` uses allowlist + forbidden patterns.

### C4. setup_token in plaintext — ✅ FIXED

One-time token: consumed on first register, `setup_token_consumed_at` set in D1. Rejects reused tokens with `token_already_used`.

Files: `worker/src/db.ts:26-27`, `worker/src/void-cell.ts:172-224`

---

## 🟠 HIGH

### H1. tunnel_token on command line — ✅ FIXED

✅ Stored **encrypted** in D1 (`tunnel_token_encrypted`) via AES-256-GCM with `ENCRYPTION_KEY` (or `COOKIE_SECRET` fallback).
✅ Passed to cloudflared via `TUNNEL_TOKEN` env var, NOT CLI arg. Not visible in `ps aux`.

Files: `agent/src/main.rs:981-988`, `worker/src/crypto.ts`, `worker/src/mcp.ts:389-391`, `worker/src/webhook.ts:107-109`

### H2. Insecure project lookup — ✅ FIXED

`LIKE` replaced with exact match `repo_url = ?`. URL constructed as `https://github.com/{full_name}`.

File: `worker/src/webhook.ts:227-231`

### H3. Public SSE logs — ✅ FIXED (by C1 — behind Bearer auth)

### H4. /send-deploy without auth — ✅ FIXED (by C1 — behind Bearer auth)

---

## 🟡 MEDIUM

### M1. CORS wildcard on everything — ✅ FIXED

CORS restricted to `/mcp` and `/health` only.

File: `worker/src/index.ts:41`

### M2. ensureSchema runs on every fetch — ❌ OPEN

Global `migrated` flag per-isolate still causes N runs with concurrent isolates.

File: `worker/src/db.ts:94-112`

### M3. No rate limiting — ❌ OPEN

No protection against DOS on `/send-deploy`, `POST /mcp`, D1 queries.

### M4. HTTP in dev mode — ❌ OPEN

Default `api_base` still `ws://127.0.0.1:8787`.

File: `agent/src/config.rs:54`

### M5. Duplicate tunnel/DNS logic — ❌ OPEN

Identical tunnel + DNS setup in `mcp.ts` (void_deploy) and `webhook.ts` (triggerDeploy). Security fixes must be applied in two places.

### M6. cloudflared orphaned — ✅ FIXED

PID file + `libc::kill(SIGTERM)` before spawning new instance.

File: `agent/src/main.rs:935-949`, `agent/src/config.rs:40`

### M7. Unused secrets — ✅ FIXED

`VOID_BEARER_TOKEN` and `AGENT_SHARED_SECRET` now used.

---

## 🆕 NEW FINDINGS

### N1. 🐛 validateShellCommand backtick regex broken — ✅ FIXED

`security.ts:88` previously:
```js
/`, `/,  // intent: match backtick
```
This regex matched literal string `` `, `` (backtick-comma-space-backtick), not a single backtick. Backtick command substitution passed validation.

**Fix applied:** Removed the broken regex entirely. New strict allowlist excludes `` ` `` and all shell metachars at the character level (see N4).

### N2. 🐛 Agent cannot reconnect after setup_token consumed — ✅ FIXED

**Fix applied:** Server now issues a persistent `session_token` (`sess_<uuid>`) on first register, stores it in `servers.session_token`, and returns it in the `registered` ack. Agent persists it to `<state_dir>/session_token` and uses it for all subsequent reconnects. The one-time `setup_token` is consumed and never re-sent. On reconnect, the DO checks `session_token` first (with `timingSafeEqual`), then falls back to `setup_token` if no session exists yet (first register only).

Files: `worker/src/void-cell.ts:174-260`, `worker/src/db.ts:7-31`, `agent/src/main.rs:152-178,238-246`

### N3. 🐛 setup_token in cloud-init plaintext — ❌ OPEN

`worker/src/hetzner.ts:118`:
```toml
setup_token = "${setup_token}"
```
Token written to cloud-init user_data. Visible in Hetzner Cloud console, cloud-init logs, and VM journal. Anyone with Hetzner UI access can read it and register as that server.

**Mitigation in place:** N2 (session_token for reconnects) means the setup_token is only useful for ~5 minutes (until the agent registers). After that, the attacker would need the session_token from the VM's local disk, which is much harder to access.

**Proper fix:** Generate setup_token server-side AFTER VM creation, deliver via Hetzner Metadata API or a pre-shared secret per Hetzner API call. Out of scope without real HETZNER_TOKEN to test.

### N4. validateShellCommand allowlist too permissive — ✅ FIXED

`security.ts:85` previously:
```js
const ALLOWED_SHELL_CHARS = /^[a-zA-Z0-9\s\-_/.:=+,'"*?~!@#%^&;|(){}[\]$]+$/;
```
Allowed `;`, `|`, `&`, `$` — all shell metacharacters.

**Fix applied:** Replaced with strict allowlist that excludes `;`, `|`, `&`, `$`, `` ` ``, `\`, `<`, `>` entirely. Any shell metacharacter now fails at the character level. `; rm -rf / ;` now rejected.

```js
const ALLOWED_SHELL_CHARS = /^[a-zA-Z0-9\s\-_/.:=+,'"*?~!@#%^(),{}\[\]]+$/;
const FORBIDDEN_PATTERNS = [/;/, /\|/, /&/, /\$/, /\\/, /\n/, /\r/, /[<>]/, ...];
```

### N5. COOKIE_SECRET overloaded for encryption — ✅ FIXED (partial)

**Fix applied:** Added dedicated `ENCRYPTION_KEY` secret. `COOKIE_SECRET` retained as fallback for backward compat. `mcp.ts`, `webhook.ts`, `crypto.ts` updated to prefer `ENCRYPTION_KEY`.

**Also fixed:** Replaced weak cyclic-repeat key derivation with SHA-256 derivation (any-length secret → 32-byte key). Stronger than cyclic padding; no PBKDF2 needed since the secret is high-entropy random.

Files: `worker/src/crypto.ts:14-22`, `worker/src/env.ts:13`, `worker/src/webhook.ts:107-109,120-121`, `worker/src/mcp.ts:389-391,409-410`

**To enable:** `wrangler secret put ENCRYPTION_KEY` (use `openssl rand -hex 32`).

### N6. No Ed25519 verify setup after first register — ⚠️ PARTIALLY FIXED

**Mitigation in place (via N2):** The persistent `session_token` (`sess_<32-hex>`) is itself a 128-bit secret, comparable in strength to a bearer token. Attacker would need to read it from the VM disk to impersonate the agent.

**Proper fix not done:** Ed25519 challenge-response on every post-register frame (heartbeat/log/status) would require a more complex state machine in the DO. Deferred — session_token is sufficient for MVP.

---

## Quick wins (updated priorities)

| # | Fix | Status |
|---|-----|--------|
| 1 | Fix backtick regex in `security.ts:88` | ✅ N1 done |
| 2 | Fix agent reconnect (session_token instead of setup_token) | ✅ N2 done |
| 3 | Tighten validateShellCommand: reject `;`, `|`, `&`, `$`, `` ` `` outright | ✅ N4 done |
| 4 | Remove setup_token from cloud-init (pass via Hetzner metadata API) | ❌ N3 — needs real Hetzner env |
| 5 | Add per-DO rate limit on send-deploy | ❌ M3 — medium |
| 6 | Use separate encryption key (ENCRYPTION_KEY) | ✅ N5 done |
| 7 | tunnel_token via TUNNEL_TOKEN env var instead of CLI arg | ✅ H1 done |
