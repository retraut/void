# Current architecture

**Status:** Current

**Verified against:** repository source on 2026-07-13

**Scope:** deployed runtime and its direct external dependencies

This document describes how void is built today. It deliberately excludes
roadmap features from [`SPEC.md`](SPEC.md).

## System context

void separates the control path from application traffic. The Cloudflare Worker
coordinates deployments, while Cloudflare Tunnel carries requests to an
application after it has been deployed.

```text
 Human / MCP client / GitHub
             |
             | HTTPS: UI, REST, MCP, webhook
             v
 +---------------- Cloudflare account ----------------+
 | Worker + Hono                                      |
 |   |                                                |
 |   +--> D1: durable product state                   |
 |   +--> KV: sessions, OAuth state, provider cache   |
 |   +--> R2: bound, not in the active deploy path    |
 |   +--> Durable Object: one VoidCell per server     |
 +-----------------------|----------------------------+
                         | authenticated WebSocket
                         v
               +--------------------+
               | Rust agent on VM   |
               | thin step executor |
               +----------+---------+
                          |
                          | local processes / cloudflared
                          v
 User request --> Cloudflare edge --> tunnel --> application port
```

The Worker is not in the application request path after routing has been
configured. A control-plane outage therefore does not by itself stop an already
running process or tunnel. It does prevent new deploys and management actions.

## Runtime containers and ownership

| Component | Owns | Does not own |
|---|---|---|
| React SPA (`frontend/`) | Browser views, session-backed API calls | Deployment orchestration, durable state |
| Worker (`worker/src/index.ts`) | HTTP routing, auth boundaries, UI API, composition | Per-server socket state, command execution |
| Domain modules (`worker/src/*.ts`) | GitHub webhook, MCP, provider, Cloudflare, credentials and validation logic | Browser rendering and VM-local state |
| D1 (`worker/src/db.ts`) | Users, Project aggregates, connections, repositories, servers, deployments, passkeys, system settings | Live sockets and streaming buffers |
| KV (`ROUTES`) | Login sessions, OAuth state, Hetzner catalog cache | Authoritative project or deployment state |
| R2 (`void_builds`) | Reserved binding | No active build/log persistence path yet |
| `VoidCell` Durable Object | One agent socket per server, registration state, recent metrics, bounded in-memory logs/SSE fan-out, token rotation | Durable deployment queue, authoritative server record |
| Rust agent (`agent/`) | Reconnection, local identity/token files, heartbeat/metrics, ordered shell-step execution, local JSONL logs | Build-policy selection, DNS, tunnel configuration, project state |
| Cloudflare Tunnel | Application ingress without VM inbound ports | Deployment decisions or application lifecycle |

### Dependency direction

```text
 HTTP adapters (index.ts, mcp.ts, webhook.ts)
          |
          +--> domain helpers (auth, security, credentials, provider, cf)
          +--> durable state (D1 / KV)
          +--> per-server coordination (VoidCell)
                                      |
                                      v
                              protocol contract
                                      |
                                      v
                                Rust agent
```

New provider integrations should provision a machine and deliver the generic
agent configuration. They should not introduce provider-specific frames into the
agent protocol.

## Core flows

### 0. Project composition

`Project` is the aggregate root exposed by the API and panel. It is stored as a
`projects` row so it remains distinct from a deployable `repository`.

1. The first authenticated request creates `Default Project` if the user has no
   Project yet.
2. A Project-scoped GitHub PAT is verified and encrypted before storage.
3. Repositories can only be imported from that connected GitHub account.
4. Project-scoped Hetzner and Cloudflare tokens are verified and encrypted
   independently from GitHub.
5. Hetzner unlocks server provisioning; Cloudflare unlocks the Project domain
   catalog; GitHub unlocks repository import.
6. Servers and Cloudflare zones are resolved inside one Project boundary.
7. A deployment is valid only when its repository and target server belong to
   the same Project.

### 1. Server registration

1. A UI/MCP/provider flow creates a D1 server row and a one-time
   `setup_token`.
2. The VM starts the agent with `api_base`, `server_id`, and `setup_token`.
3. The agent opens `/cell/:serverId` and sends `register`.
4. The server's `VoidCell` validates the token against D1, consumes it, issues a
   persistent `session_token`, and marks the server active.
5. The agent stores the session token locally and uses it after reconnects.
6. The cell rotates the session token periodically over the authenticated open
   connection.

The WebSocket upgrade itself is intentionally public; authentication happens in
the first protocol frame. Non-WebSocket `/cell/*` requests require Bearer auth.

### 2. Deployment dispatch

1. The panel, MCP, or a verified GitHub webhook validates the repository, ref, and optional
   commands.
2. The Worker resolves a server/project and optionally creates Cloudflare tunnel
   and DNS state.
3. It inserts a `deployments` row in D1.
4. It asks the server's `VoidCell` to build an ordered `pipeline` frame.
5. The cell HMAC-signs the canonical frame when `AGENT_SHARED_SECRET` is set.
6. The agent verifies the signature, executes steps sequentially in an isolated
   deployment directory, streams log frames, and emits `deploy_done`.
7. The cell persists the terminal deployment status and broadcasts recent logs
   and the terminal event to SSE subscribers.

The agent is a **thin executor**. Today the Worker constructs clone, build,
serve, and tunnel commands. Railpack/Docker are not implicit agent policies;
they run only when a dispatched command invokes them.

### 3. Application request

1. DNS points an application hostname at the server's Cloudflare tunnel.
2. Tunnel ingress maps that hostname to a VM-local port.
3. Cloudflare edge and `cloudflared` carry the request directly to the process.

No Worker, D1, KV, MCP, or Durable Object call is required per application
request.

## State model

| State | Authority | Lifetime |
|---|---|---|
| Users and Project aggregates | D1 `users`, `projects` | Durable |
| GitHub and provider connections | D1, Project-scoped encrypted values | Durable |
| Repositories, servers, deployments | D1, each carrying Project ownership | Durable |
| Web sessions and OAuth state | KV | TTL-bound |
| Provider catalog cache | KV | TTL-bound, rebuildable |
| Active agent connection | `VoidCell` | Ephemeral |
| Latest metrics and SSE log buffer | `VoidCell` memory | Ephemeral |
| Agent identity, session token, JSONL logs | VM filesystem | Survives agent restart |
| Tunnel/DNS configuration | Cloudflare API | External durable state |

D1 is authoritative for product state. KV and Durable Object memory must remain
rebuildable. External Cloudflare state currently requires explicit cleanup and
is not continuously reconciled from D1.

## Trust boundaries

| Boundary | Mechanism |
|---|---|
| Browser -> Worker | GitHub OAuth/passkey session cookie |
| MCP/API client -> Worker | Static Bearer token |
| GitHub -> webhook | `X-Hub-Signature-256` HMAC |
| Agent registration -> `VoidCell` | One-time setup token, then session token |
| Worker command -> agent | Optional HMAC with `AGENT_SHARED_SECRET` |
| Stored provider/tunnel secrets | AES-GCM via `ENCRYPTION_KEY` (legacy fallback exists) |

Validation of command contents is centralized in `worker/src/security.ts`.
Protocol shape validation is strict on both TypeScript and Rust sides. See
[`PROTOCOL.md`](PROTOCOL.md) for the normative frame contract.

## Architecture invariants

Changes should preserve these properties:

1. Application traffic must not depend on the Worker request path.
2. D1 is the durable source of truth; caches and live sessions are rebuildable.
3. Exactly one `VoidCell` name maps to one server ID.
4. Provider provisioning stays outside the agent wire protocol.
5. A repository and deployment target must belong to the same Project.
6. The Worker decides pipeline policy; the agent validates and executes it.
7. Protocol changes update TypeScript schema, Rust mirror, tests, and
   `PROTOCOL.md` together.
8. Secrets must not be placed in URLs, command arguments, logs, or cloud-init
   when a protected channel is available.
9. Teardown removes public DNS before tunnel ingress to avoid dangling routes.

## Known architectural gaps

These are current constraints, not hidden roadmap promises:

- Deployment dispatch has no durable queue. If the agent is disconnected,
  dispatch returns an error; automatic retry/reconciliation is not established.
- Tunnel/DNS changes and the D1 deployment insert are separate operations. A
  partial failure can leave external state that needs cleanup.
- Tunnel ingress uses read-modify-write Cloudflare API calls. Cross-request
  serialization/reconciliation is not yet a documented runtime guarantee.
- Schema creation/migrations run lazily from Worker request middleware and are
  cached only per isolate.
- The cell's SSE buffer and latest metrics are ephemeral; R2 is not currently
  used for full log persistence.
- Arbitrary approved pipeline steps execute through `sh -c`; validation and the
  HMAC secret are therefore high-value security boundaries.
- The implementation does not yet provide a general blue-green deployment,
  health-check, rollback, or process supervisor abstraction.

These gaps should become focused ADRs or acceptance specs before implementation,
instead of being expanded inside the product vision document.

## Where to make a change

| Change | Primary files |
|---|---|
| HTTP route or auth boundary | `worker/src/index.ts`, `worker/src/auth.ts` |
| Deploy/MCP behavior | `worker/src/mcp.ts`, `worker/src/webhook.ts`, `worker/src/void-cell.ts` |
| Wire frame | `worker/src/protocol.ts`, `agent/src/protocol.rs`, protocol tests, `PROTOCOL.md` |
| Agent execution | `agent/src/connection.rs`, `agent/src/deploy.rs`, `agent/src/log.rs` |
| Persistent model | `worker/src/db.ts` plus callers |
| Project composition and connections | `worker/src/projects.ts`, `worker/src/project-api.ts`, `worker/src/github-connections.ts` |
| Provider provisioning | provider module plus generic registration contract |
| Browser behavior | `frontend/src/` and session-backed `/api/*` route |
