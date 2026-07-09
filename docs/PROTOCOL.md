# void Agent ↔ Control Plane Protocol

## Transport

- **WebSocket** (TLS in production, plain in dev)
- Agent connects to `{api_base}/cell/{server_id}` where `api_base` is `wss://` or `ws://`
- JSON text frames, newline-delimited if needed (one JSON object per frame)
- Worker-side Durable Object (VoidCell) holds exactly one WS connection per server_id
- 409 Conflict if a second agent tries to connect for the same server_id

---

## Frame: Agent → Worker (AgentOut)

All frames use `{"type": "...", ...}` for discrimination.

### register

```json
{
  "type": "register",
  "server_id": "srv_a1b2c3d4e5f6",
  "public_key": "base64-ed25519-public-key",
  "setup_token": "set_<uuid>" | null,
  "session_token": "sess_<uuid>" | null
}
```

`setup_token` and `session_token` are mutually exclusive:
- **First register:** `setup_token` is set, `session_token` is null
- **Reconnect:** `session_token` is set, `setup_token` is null
- If neither matches → Worker sends `{"type":"error","code":"invalid_token"}` and closes WS

After successful first register, Worker replies with `registered` containing a `session_token` for future use. Agent persists `<state_dir>/session_token` to disk.

### heartbeat

```json
{
  "type": "heartbeat",
  "timestamp": 1747526400
}
```

Sent every **30 seconds**. Resets the DO's `lastHeartbeat` timer.

### log

```json
{
  "type": "log",
  "deployment_id": "dep_a1b2c3d4e5f6",
  "stream": "stdout" | "stderr",
  "data": "line of output\n",
  "line": 42
}
```

Streamed during build and serve phases. Broadcast to SSE subscribers in real-time.

### deploy_done

```json
{
  "type": "deploy_done",
  "deployment_id": "dep_a1b2c3d4e5f6",
  "status": "success" | "failed",
  "url": "https://app.void.example.com",
  "local_url": "http://127.0.0.1:3000",
  "error": "git clone failed (exit 128)"
}
```

Signals deployment completion. `url`/`local_url` set when status is `success`.

### ready

```json
{
  "type": "ready",
  "timestamp": 1747526400
}
```

Reply to Worker `ping`.

---

## Frame: Worker → Agent (WorkerToAgent)

### registered

```json
{
  "type": "registered",
  "session_token": "sess_a1b2c3d4e5f67890abcdef12345678" | null
}
```

`session_token` is present only on **first** register (when setup_token was used). Agent must persist it for future reconnects. On reconnect, `session_token` is absent (the agent already has one).

### ping

```json
{
  "type": "ping"
}
```

Agent must reply with `ready { timestamp }`.

### pipeline

```json
{
  "type": "pipeline",
  "deployment_id": "dep_a1b2c3d4e5f6",
  "steps": [
    { "cmd": "git clone --depth 1 --branch main https://github.com/owner/repo .", "timeout_s": 300 },
    { "cmd": "npm ci && npm run build", "timeout_s": 600 },
    { "cmd": "node dist/server.js", "timeout_s": 300 },
    { "cmd": "cloudflared tunnel --no-autoupdate run", "env": { "TUNNEL_TOKEN": "base64-tunnel-credential" }, "timeout_s": 300 }
  ],
  "sig": "v1.abc123deadbeef..."
}
```

The agent is a **thin shell executor**: it runs each `cmd` via `sh -c` (in the deployment work dir), streams stdout/stderr back as `log` frames, stops at the first non-zero exit, and reports `deploy_done`. The Worker owns all deploy logic — it builds each `cmd` (clone / build / serve / tunnel). Steps run sequentially; order matters.

Each step:
- `cmd` (required): the shell command.
- `cwd` (optional): working directory; defaults to the deployment work dir.
- `env` (optional): extra environment variables (e.g. `TUNNEL_TOKEN`).
- `timeout_s` (optional, default 300): kill the command (and report failure) after this many seconds.

`sig` is HMAC-SHA256 of the canonical JSON (all fields except `sig` itself) signed with `AGENT_SHARED_SECRET`. Format: `"v1.<hex>"`. If `AGENT_SHARED_SECRET` is configured on the agent side and `sig` is missing or invalid, agent rejects with `{"type":"error","code":"invalid_signature"}` or `"missing_signature"`.

### shutdown

```json
{
  "type": "shutdown"
}
```

Agent calls `std::process::exit(0)`.

---

## Error Frames

When the agent sends invalid/malformed data, the Worker may close the WS with:

| Code | Reason | Condition |
|------|--------|-----------|
| 1008 | `missing server_id` | register without server_id |
| 1008 | `unknown server` | server_id not in D1 |
| 1008 | `invalid setup_token or session_token` | neither matched D1 |
| 1008 | `setup_token already used` | deprecated — N2 makes this unreachable |

Agent-side error frames (sent before closing on their end): none currently — agent just returns `Ok(())` and logs.

---

## SSE Log Stream

`GET /cell/{server_id}/logs?deployment_id=dep_xxx` returns `text/event-stream`.

Events:

```
data: {"deployment_id":"dep_xxx","stream":"stdout","data":"building...\n","ts":1747526400000}

data: {"deployment_id":"dep_xxx","stream":"status","data":"{\"status\":\"success\",\"url\":\"https://...\"}","ts":1747526400000}

: keepalive
```

- Buffer capped at 1000 entries per DO
- SSE auto-closes after 5 minutes
- Keepalive every 15 seconds

---

## Auth Flow (full sequence)

```
Agent                     Worker (VoidCell)           D1
  │                            │                        │
  │──── WS connect ──────────>│                        │
  │                            │                        │
  │──── register ────────────>│                        │
  │    {                       │                        │
  │      setup_token OR        │                        │
  │      session_token         │                        │
  │    }                       │                        │
  │                            │── SELECT session_token,│
  │                            │    setup_token,        │
  │                            │    setup_token_consumed│
  │                            │<── row ────────────────│
  │                            │                        │
  │    (compare tokens)        │                        │
  │                            │                        │
  │<── registered ────────────│                        │
  │    { session_token }*     │                        │
  │                            │── UPDATE servers SET   │
  │    *only on first register │   session_token=...,   │
  │                            │   setup_token=NULL     │
  │                            │<── ok ────────────────│
```

---

## Deploy Lifecycle

```
MCP/REST ── POST /cell/{id}/send-deploy ──> VoidCell
                                               │
                          (validate ref/repo_url/command)
                          (build ordered shell steps)
                          (HMAC-sign pipeline msg)
                          │
                          ├── WS pipeline ─────────────> Agent
                          │                              │
                          │                    step 0: git clone
                          │                    step 1: build
                          │                    step 2: serve
                          │                    step 3: tunnel
                          │                              │
                          │<── log, log, log ────────── WS
                          │     (streamed live)          │
                          │<── deploy_done ───────────── WS
                          │                              │
                          ├── SSE ──> subscribers
                          │     (log + deploy_done)
                          │
                          └── D1 INSERT deployment
```

---

## Signing Scheme

Messages sent from Worker to Agent over WS include an HMAC-SHA256 signature.

**Fields included in signature:** All fields of the `pipeline` frame **except** `sig` itself — i.e. `type`, `deployment_id`, and `steps`.  
**Signed content:** `JSON.stringify({ type: "pipeline", deployment_id, steps })` where each step is `{ cmd, env?, timeout_s }` (absent `cwd`/`env` are omitted, and `timeout_s` is always present), with `steps` serialized in order. This MUST byte-for-byte match the agent's `PipelineNoSig` canonical JSON (`serde_json::to_string` of `{ type, deployment_id, steps }` with `cwd`/`env` skipped when empty).  
**Signature format:** `v1.<64-hex-chars>`  
**Key:** `AGENT_SHARED_SECRET` (must match on both sides)  
**Verification:** Agent strips `sig`, serializes the remaining fields via `PipelineNoSig::canonical_json()`, recomputes HMAC, compares with constant-time.

If `agent_shared_secret` is not set in agent config, signature verification is **skipped** (dev mode only).

---

## Portability & Tooling Note

**Status (June 2026): single source of truth adopted.**

The protocol is now defined as Zod schemas in `worker/src/protocol.ts` and mirrored exactly in `agent/src/protocol.rs` via `serde` (with `deny_unknown_fields` matching Zod's `.strict()`). Both sides:

- Reject unknown fields (protocol drift is caught immediately, not silently)
- Use the same field names and JSON shape
- Are tested: 30 unit tests on the TS side, 9 on the Rust side

Adding a new field requires:
1. Add it to the Zod schema in `worker/src/protocol.ts`
2. Add the matching `#[serde(...)]` field to the Rust enum in `agent/src/protocol.rs`
3. Update both sets of unit tests
4. Update this `PROTOCOL.md`

The TS side derives types via `z.infer<typeof AgentOutFrameSchema>` and `z.infer<typeof WorkerToAgentFrameSchema>`. The Rust side uses `#[derive(Serialize, Deserialize)]` with `deny_unknown_fields` to match Zod's `.strict()`.
