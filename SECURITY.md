# Security Audit — void

Date: 2026-06-25  
Rev: ac8f252 (GitHub App + webhook: git push → auto-deploy)  
Scope: agent + worker (Rust / TypeScript)

---

## 🔴 CRITICAL

### C1. No authentication on API / MCP / WebSocket

Every endpoint is publicly accessible with zero auth:

- `POST /mcp` — any tool call (`void_deploy`, `void_create_server`, `void_teardown`)
- `GET /api/servers` — list all registered servers
- `GET /api/cell/{id}/status` — agent status
- `WS /cell/{id}` — agent WebSocket upgrade
- `GET /cell/{id}/logs` (via MCP) — live deploy logs

`AGENT_SHARED_SECRET` and `COOKIE_SECRET` are declared in `env.ts` but **never used**.

Impact: attacker can trigger arbitrary deploys, read logs, enumerate infrastructure.

Files: `worker/src/index.ts:111-125`, `worker/src/mcp.ts`, `worker/src/void-cell.ts:63-73`

Fix: Bearer token on all /api/* and /mcp routes; validate setup_token on WS upgrade.

---

### C2. Ed25519 keypair generated but never verified

Agent sends `public_key` in `register` frame. Neither side ever validates a signature on incoming messages. Any WS frame from the control plane is blindly trusted. No challenge-response at connect time.

Impact: if WS connection is hijacked or the Worker is compromised, attacker gains arbitrary RCE on every connected VM.

Files: `agent/src/main.rs:133-196` (no verify), `agent/src/main.rs:204-284` (blind execution)

Fix: server signs deploy frames with AGENT_SHARED_SECRET (or Ed25519), agent verifies before executing.

---

### C3. No input validation — shell injection via deploy params

`repo_url`, `build_command`, `serve_command` go straight into:
- `git clone --branch {ref} {repo_url}` — ref injection
- `sh -c {build_command}` — arbitrary shell
- `sh -c {serve_command}` — arbitrary shell

Combined with C1/C2: **RCE on any void VM** with no auth required.

Files: `agent/src/main.rs:374-376`, `461-463`, `749-751`

Fix: validate with regex before execution; sandbox with seccomp / landlock (future).

---

### C4. setup_token sent in plaintext on every WS connect

The one-time join credential is sent as plain JSON in the WS register frame every reconnect. No token rotation after first use.

File: `agent/src/main.rs:149-156`

Fix: one-time use + rotate on first successful register; never retransmit.

---

## 🟠 HIGH

### H1. tunnel_token on command line

```
cloudflared tunnel --no-autoupdate run {token}
```

Token visible to any local process via `ps aux`. Also stored in D1 in plaintext (`servers.tunnel_token`). Allows anyone with the token to join the tunnel and serve traffic.

Files: `agent/src/main.rs:904-908`, `worker/src/db.ts:27-28`

Fix: pass token via env var (`TUNNEL_TOKEN`) or config file; encrypt at rest in D1.

---

### H2. Insecure project lookup in webhook

```sql
SELECT ... FROM projects WHERE repo_url LIKE ?
-- bind: `%{repoFullName}%`
```

`repoFullName` comes from the GitHub webhook payload `repository.full_name`. If an attacker-controlled repo name matches partially, the deploy goes to the wrong project.

File: `worker/src/webhook.ts:218-224`

Fix: match against normalized URL (strip scheme, trailing slash, `.git`); use exact match.

---

### H3. SSE logs publicly subscribable

`void_get_logs` MCP tool proxies to `GET /cell/{id}/logs` with zero auth. Full build output including env vars is streamed to anyone.

Files: `worker/src/void-cell.ts:204-242`, `worker/src/mcp.ts:466-480`

---

### H4. /send-deploy reachable without auth

The internal DO route rewrites `/cell/{id}` to DO namespace. An attacker who can reach the DO (no auth on fetch) can call `send-deploy`.

File: `worker/src/void-cell.ts:76-97`

---

## 🟡 MEDIUM

### M1. CORS wildcard on everything

```ts
"access-control-allow-origin": "*"
```

Applied to all endpoints including MCP and API. A malicious site can make authenticated (once auth is added) cross-origin requests.

File: `worker/src/index.ts:35,44`

Fix: restrict to configured origin(s).

---

### M2. `ensureSchema` runs on every fetch

Short-circuits via global `migrated` flag after first call, but flag is per-request in CF Workers isolate — with concurrent isolates the migration runs N times. Fine for schema but risky for data migrations.

File: `worker/src/db.ts:87-107`

Fix: use `ctx.waitUntil` for migration; track version in D1 itself.

---

### M3. No rate limiting

Any endpoint can be hammered: D1 writes, git clone (disk fill on agent), tunnel creation (CF API quota).

---

### M4. HTTP in dev mode

Default `api_base` is `ws://127.0.0.1:8787` — unencrypted WS.

File: `agent/src/config.rs:48`

---

### M5. Duplicate tunnel/DNS logic in mcp.ts and webhook.ts

`triggerDeploy` in webhook.ts reimplements the same CF tunnel + DNS setup as `void_deploy` in mcp.ts. Security fixes must be applied in two places.

---

### M6. cloudflared orphaned on redeploy

`kill_on_drop(false)` + no tracking of child PID. Each new deploy spawns another `cloudflared`. Old instances keep running with old tunnel tokens.

File: `agent/src/main.rs:941-944`

Fix: kill previous instance before spawning new one; track PID in state file.

---

### M7. `AGENT_SHARED_SECRET` and `COOKIE_SECRET` unused

Declared in `env.ts:12,21` but never referenced anywhere in the codebase. Dead code that creates a false sense of security.

---

### M8. WebSocket closes are not authenticated

`webSocketClose` and `webSocketError` in the DO clear `this.ws = null`, allowing an attacker to repeatedly connect/disconnect and force the cell into a null state, or race the WS upgrade and the 409 check.

File: `worker/src/void-cell.ts:125-133`

---

## 🟢 LOW

### L1. Key file TOCTOU

Race between `key_path.exists()` and `std::fs::read()` in `Identity::load_or_create`.

File: `agent/src/keys.rs:20-26`

### L2. Dev defaults leaky

`setup_token = "dev-setup-token"` as default in config.rs — dangerous if someone deploys without setting it.

File: `agent/src/config.rs:53-54`

### L3. Log buffer unbounded (per DO)

`logBuffer` capped at 1000 entries but DO memory is limited (128 MB). With large log lines or many deployments, OOM is possible.

File: `worker/src/void-cell.ts:169-171`

---

## Quick wins (in priority order)

| # | Fix | Effort |
|---|-----|--------|
| 1 | Bearer token on /api/* and /mcp | 1 file, 5 lines |
| 2 | Validate `AGENT_SHARED_SECRET` or Ed25519 signature on deploy frames in agent | 2 files, ~20 lines |
| 3 | Rate-limit /send-deploy per-DO | 1 file, 10 lines |
| 4 | Remove CORS `*` on non-public routes | 1 file, 3 lines |
| 5 | Kill old cloudflared before spawning new | 1 file, 10 lines |
| 6 | Exact-match project lookup instead of LIKE | 1 file, 2 lines |
| 7 | Rotate setup_token after first register | 1 file, 5 lines |
