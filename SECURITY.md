# Security Audit — void

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

### H1. tunnel_token on command line — ⚠️ PARTIALLY FIXED

✅ Stored **encrypted** in D1 (`tunnel_token_encrypted`) via AES-256-GCM with `COOKIE_SECRET`.  
❌ Still passed as CLI arg to `cloudflared tunnel run --token {token}` — visible via `ps aux`.

Files: `agent/src/main.rs:957`, `worker/src/crypto.ts`, `worker/src/mcp.ts:389-391`, `worker/src/webhook.ts:107-109`

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

### N1. 🐛 validateShellCommand backtick regex broken

`security.ts:88`:
```js
/`, `/,  // intent: match backtick
```
This regex matches literal string `` `, `` (backtick-comma-space-backtick), not a single backtick. Backtick command substitution (` `whoami` `) passes validation.

**Fix:** Replace with `/`+/`.

### N2. 🐛 Agent cannot reconnect after setup_token consumed

`agent/src/main.rs:149-156` sends setup_token on **every** WS connect. After first successful register, token is consumed. Server rejects reconnect with `token_already_used` → infinite reconnect loop.

Agent never stores or sends a "I'm already registered" proof (e.g. Ed25519 challenge-response or persistent session token).

**Fix:** After first register, use Ed25519 challenge-response or a session token instead of setup_token for reconnects.

### N3. 🐛 setup_token in cloud-init plaintext

`worker/src/hetzner.ts:118`:
```toml
setup_token = "${setup_token}"
```
Token written to cloud-init user_data. Visible in Hetzner Cloud console, cloud-init logs, and VM journal. Anyone with Hetzner UI access can read it and register as that server.

**Fix:** Generate setup_token server-side after VM boot, or use a pre-shared secret per Hetzner API call.

### N4. validateShellCommand allowlist too permissive

`worker/src/security.ts:85`:
```js
const ALLOWED_SHELL_CHARS = /^[a-zA-Z0-9\s\-_/.:=+,'"*?~!@#%^&;|(){}[\]$]+$/;
```
Allows `;`, `|`, `&`, `$` — all shell metacharacters. Defense relies entirely on `FORBIDDEN_PATTERNS` which are grep-style pattern matches, not a proper allowlist. A command like `; rm -rf / ;` passes because `;` is allowed and there's no forbidden pattern for it.

**Fix:** Switch to strict allowlist (only safe characters: `a-zA-Z0-9`, `\-_/.:=+,'"*?~!@#%^`), reject `;|&$()` outright.

### N5. COOKIE_SECRET overloaded for encryption

`COOKIE_SECRET` used for both session cookies and AES-256-GCM key derivation (`crypto.ts:12-16`). Custom key derivation (cyclic repetition to 32 bytes, no PBKDF2) weakens the encryption.

**Fix:** Separate secrets for cookie signing vs encryption; use HKDF or PBKDF2 for key derivation.

### N6. No Ed25519 verify setup after first register

Ed25519 keypair still unused after setup. Agent sends `public_key` on register, server stores it (`agent_public_key` in D1), but never uses it for subsequent auth. All post-register WS frames are unauthenticated at the transport level (only HMAC on deploy messages protects command execution, but heartbeat/log/status are unsigned).

---

## Quick wins (updated priorities)

| # | Fix | Effort |
|---|-----|--------|
| 1 | Fix backtick regex in `security.ts:88` | 1 line |
| 2 | Fix agent reconnect (use Ed25519 challenge instead of setup_token) | 3 files, ~30 lines |
| 3 | Tighten validateShellCommand: reject `;`, `|`, `&`, `$`, `` ` `` outright | 1 file, 5 lines |
| 4 | Remove setup_token from cloud-init (pass via Hetzner metadata API) | 1 file, 10 lines |
| 5 | Add per-DO rate limit on send-deploy | 1 file, 10 lines |
| 6 | Use separate encryption key (not COOKIE_SECRET overloaded) | 2 files, 5 lines |
| 7 | tunnel_token via env var or temp file instead of CLI arg | 1 file, 5 lines |
