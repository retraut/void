# void — Technical Specification v0.1

> **Status: Historical target-design archive.** This document mixes product
> requirements, superseded architecture, future design, and historical rationale.
> Completion marks and implementation claims have not been re-audited and must
> not be treated as current state. Start with
> [ARCHITECTURE.md](ARCHITECTURE.md) and use [PROTOCOL.md](PROTOCOL.md) for the
> normative agent wire contract. The documentation taxonomy and precedence rules
> are in [README.md](README.md).

**Tagline:** Best-in-class DX. Hetzner pricing. No SSH.
**Longer pitch:** Your AI deploys. You don't SSH. You pay €4/mo to Hetzner, not $20/mo to a managed PaaS.

---

## Philosophy

void is a self-hosted, edge-driven PaaS for the AI coding era. The browser is optional. The terminal is optional. The AI agent in your IDE is the user.

We are not "yet another self-hosted PaaS". Self-hosting exists (Coolify, Dokku, Devpush) but it's painful: SSH into a server, maintain a 200MB control plane, click through a web UI. void flips that: control plane lives on Cloudflare's edge (free, maintained by someone else), your VMs are dumb Docker hosts, your AI is the operator.

### Core Principles

- **Zero DevOps** — no YAML, no Dockerfile, no Kubernetes, no SSH. Push to git, AI deploys.
- **Zero CI** — no Jenkins, no GitHub Actions runner to babysit. Builds run on-demand, in-place, on the user's own server.
- **Zero Lock-in** — user owns the Hetzner/DO account, the source code, the deployment manifests. void is a control plane you can fork.
- **Zero Idle Cost** — control plane lives on Cloudflare Workers free tier. The user only pays for the VMs they actually run, billed by their cloud provider.
- **Zero Friction** — setup in 10 minutes. `git push` deploys automatically. AI calls `void_deploy` when you ask. No clicking through 50 screens to add a project.

### What "convenient" means for void

A self-hosted PaaS is only worth using if it's actually pleasant — otherwise you'll just use Vercel. void commits to the following DX table stakes from day one (v0.1 launch):

| Action | Vercel | Coolify | void |
|--------|--------|---------|------|
| Sign up | Email/SSO | SSH to server + manual install | GitHub OAuth, 30 sec |
| Add a server | None (Vercel runs it) | Web UI, manual SSH | Paste Hetzner token → "Create Server" |
| Add a project | Import repo | Web UI, 5 steps | Install GitHub App, push code |
| Deploy | `git push` | Web UI button | `git push` OR `void_deploy` from AI |
| Live logs | Web UI | Web UI | Web UI + xterm.js + MCP stream to AI |
| Preview URLs per PR | Auto | Manual | Auto (v0.1 requirement) |
| Cost | $20/mo + overages | Free + your server €4-50/mo | Free + your server €4-50/mo |

Coolify has 40k+ stars because it's free and self-hosted. But it's not *convenient* — it's the Homelab-as-PaaS experience. void targets the dev who would use Vercel if it weren't for cost or compliance, and who would use Coolify if it weren't for the SSH-and-dashboard overhead. We're the third option: same DX as Vercel, same ownership as Coolify, no friction in either direction.

---

## Why void exists

The 2026 PaaS landscape is a split:

**Heavy self-hosted (Coolify, Dokku, Devpush, CapRover)** — single big server, Laravel/Flask/Django monolith, requires SSH, eats 200-500MB just for the control plane. Powerful but heavy. Last updated 2024 vibes. Free, but you pay in setup time and maintenance.

**Managed cloud (Vercel, Railway, Render, Fly)** — beautiful DX, but you're renting markup-priced VMs and praying they don't shut down your account. Lock-in, recurring bills, no compliance control.

**Missing gap**: a PaaS that has Vercel DX, lives on the user's own VMs, has zero control plane to maintain, no SSH, and works natively with AI coding agents. We sit between these two. Same Hetzner box as Coolify. Same deploy experience as Vercel. No SSH, no dashboard hunting, no 200MB control plane. Just `git push` or `void_deploy` from your AI.

Closest neighbor: [Devpush](https://github.com/hunvreus/devpush) (4.7k stars) — self-hosted Vercel clone, but Python monolith on your own server, requires SSH, no MCP, no edge control plane. We're edge-first, no-SSH, MCP-native, and free of the self-hosted control plane tax.

---

## Architecture Overview

```
                      User / AI Agent
                            │
                            ▼
                    ┌───────────────────────────────────────────┐
                    │          Cloudflare Edge (free)           │
                    └───────────────────────────────────────────┘
                            │
              ┌─────────────┴──────────────┐
              │ hostname match              │
              ▼                             ▼
   ┌──────────────────────┐    ┌──────────────────────────────────┐
   │  Worker (control)    │    │  Tunnel Public Hostnames (data)  │
   │  api.void.example    │    │  pr-42-app.void.example.com      │
   │  void.example        │    │  pr-43-api.void.example.com      │
   │                      │    │           │                      │
   │  • REST API          │    │           ▼                      │
   │  • MCP server        │    │  cloudflared tunnel              │
   │  • Web UI            │    │           │                      │
   │  • SSE log streams   │    │           ▼                      │
   │  • D1, KV, R2        │    │  Docker container (port 3000)    │
   │  • DO (per-server)   │    │                                  │
   └──────────┬───────────┘    └──────────────────────────────────┘
              │ WebSocket                          (no Worker in path)
              │ (Hibernation API)
              ▼
   ┌──────────────────────────────────────┐
   │  void-agent (Rust, ~8MB) on user's VM │
   │   • WS client → Worker                │
   │   • Spawns cloudflared on demand      │
   │   • Runs Railpack builds              │
   │   • Manages Docker                    │
   └──────────────────────────────────────┘
```

**The Worker is not in the app data path.** App traffic flows User → CF edge → cloudflared → Docker directly. If the Worker crashes, deployed apps keep serving. The Worker is only invoked for control-plane requests: deploys, MCP calls, API queries, log streaming. See [Routing Layer](#routing-layer-two-path-model) for the full two-path model.

### Components

| Component | Tech | Role | Idle cost |
|-----------|------|------|-----------|
| Control plane | Cloudflare Workers + Hono | Auth, MCP, REST API, web UI. **Not in app data path.** | $0 (free tier) |
| State DB | Cloudflare D1 (SQLite) | Users, servers, projects, deployments | $0 (free tier) |
| Route cache | Cloudflare KV | Hostname → tunnel lookup, per-user rate limits | $0 (free tier) |
| Build cache | Cloudflare R2 | Cached build layers, mirrored images | ~$0.015/GB/mo |
| Live sessions | Cloudflare Durable Objects | Per-server WS hub, MCP server endpoint, log streams | $0.15/M req |
| Agent | Rust binary | WS client, Railpack runner, Docker control | ~8MB RAM |
| Build engine | [Railpack](https://github.com/railwayapp/railpack) (Go) | Source → OCI image, zero-config | $0 (on-demand) |
| Ingress | cloudflared (named tunnel) | Inbound to Docker containers, no exposed ports. **Carries all app traffic.** | $0 |
| VMs | Hetzner Cloud / DigitalOcean | User-owned, user-billed | User's bill |

**Why Railpack, not Nixpacks, not OpenTofu, not Buildpacks:** Railpack is the [active successor to Nixpacks](https://nixpacks.com) (which Railway put in maintenance mode in 2025). Written in Go, no Nix dependency (faster cold start), auto-detects Node/Python/Go/Rust/Elixir/etc., produces OCI image via BuildKit. Used in production at Railway. MIT.

---

## Data Flow

### Deploy flow (AI-assisted)

```
1. User in Cursor: "Deploy my-app to production"
2. Cursor's MCP client calls POST /mcp with tool=void_deploy
   { "project": "my-app", "branch": "main", "commit": "abc123" }
3. Worker authenticates MCP token, validates project exists
4. Worker generates unique hostname prefix: pr-42-myapp (or myapp for prod)
5. Worker looks up which server (void-cell DO) hosts this project
6. Worker writes deployment record to D1 (status: queued)
7. Worker sends WS message to void-cell DO: { type: "pipeline", steps: [...] }
8. DO forwards to connected void-agent via WS
9. Agent:
   a. git clone using GitHub App installation token passed in deploy message:
      `git clone https://x-access-token:<installation_token>@github.com/owner/repo.git /tmp/build/<id>`
      ⚠️ Token is short-lived (1h), scoped to that repo only, never stored on disk.
   b. Cancel any previous running build for this project (same project_id):
      → send { type: "build_cancelled" } over WS for the old build
      → docker rm -f my-app-old-build || true
      → rm -rf /tmp/build/<old_id>
   c. railpack build . --output my-app:abc123
      → agent passes Railpack-detected port info (from build output) back to Worker:
      { type: "build_meta", port: 3000, framework: "nextjs" }
      → streams stdout chunks back over WS
   d. docker stop my-app-old || true
   e. docker run -d --name my-app --restart=unless-stopped -p HOST_PORT:CONTAINER_PORT my-app:abc123
      HOST_PORT = build_meta.port (from step c) OR projects.default_port (3000 fallback)
   f. health check (curl -f localhost:HOST_PORT/healthz, 30s timeout)
      → if /healthz 404, try curl -f localhost:HOST_PORT/ (some apps don't have /healthz)
   g. report status back: { type: "deploy_done", port: HOST_PORT }
10. DO broadcasts log chunks to all SSE subscribers (UI + MCP clients)
11. Worker (via per-server DO, serialised) calls Cloudflare API in two steps:
    a. PUT /accounts/{id}/cfd_tunnel/{tunnel_id}/configurations
       to add the ingress rule: pr-42-myapp.void.example.com → http://localhost:3000
    b. POST /zones/{id}/dns_records
       to create the CNAME: pr-42-myapp.void.example.com → <tunnel_id>.cfargotunnel.com
12. CF edge now resolves pr-42-myapp.void.example.com → this tunnel → cloudflared → container
13. Worker updates D1 (status: success/failed, hostname, dns_record_id, tunnel_id)
14. MCP server returns final response to AI:
    { "url": "https://pr-42-myapp.void.example.com",
      "duration_ms": 45230, "status": "success" }
15. AI shows user: "Deployed. Live at https://pr-42-myapp.void.example.com"
```

**App traffic for the newly deployed app now flows:**

```
User browser → CF edge → CNAME resolves to tunnel → cloudflared → Docker container
```

The Worker is not in this path. CF edge handles routing via the DNS CNAME registered in step 11b.

### Teardown flow (deploy removed, rolled back, or server destroyed)

```
1. Trigger: user calls void_deploy with new ref, OR deletes project, OR destroys server
2. Worker looks up hostname + dns_record_id + tunnel_id for the old deployment
3. Worker (per-server DO) calls Cloudflare API in two steps, ORDER MATTERS:
   a. DELETE /zones/{id}/dns_records/{dns_record_id} FIRST
      → visitors get NXDOMAIN, no 1016 error pages
   b. PUT /accounts/{id}/cfd_tunnel/{tunnel_id}/configurations
      to remove the ingress rule (Worker re-PUTs the array without this entry)
4. CF edge no longer resolves the hostname; tunnel catch-all answers if hit directly
5. Worker updates D1 (deployment.status = "removed", cleared hostname)
6. Agent (when it sees the old container is no longer in D1's active list) runs:
   docker stop my-app-old && docker rm my-app-old
7. Old container is gone, no orphaned Docker processes
```

### Server provisioning flow (one-time per VM)

```
1. User: "Add a Hetzner server" in UI / via MCP
2. User pastes their Hetzner Cloud API token (encrypted, stored in D1)
3. Worker (using CF API token) creates a cloudflared tunnel for the new server:
   POST /accounts/{account_id}/cfd_tunnel
   { "name": "void-<server_id>", "config_src": "cloudflare" }
   → returns { id: "<tunnel_id>", token: "<tunnel_secret>" }
4. Worker calls Hetzner Cloud API:
   POST /servers
   { name: "void-prod-1", server_type: "cx22", image: "ubuntu-24.04",
     user_data: "#!/bin/bash\ncurl -sSL install.void.dev | sh -s -- --server-id=X --setup-token=Y" }
   ⚠️ user_data передає тільки короткоживучий `setup_token`, не `tunnel_token`.
   tunnel_token — довгоживучий секрет, він ніколи не потрапляє в user_data
   (яка лежить plaintext в Hetzner API i стає доступною будь-кому з доступом до проекту).
5. Hetzner boots VM, cloud-init runs install script
6. Install script:
   - installs Docker, cloudflared, railpack
   - downloads void-agent binary from GitHub releases
   - writes /etc/void/config.toml with setup_token, server_id
   - starts void-agent
7. void-agent on first boot:
   - generates Ed25519 keypair
   - opens WS to wss://api.void.example.com/cell/<server_id>?ticket=...
   - sends { setup_token, server_id, public_key } over WS for registration
   - Worker validates setup_token, stores agent_public_key in D1
   - Worker sends back { session_ticket, tunnel_id, tunnel_token }
     — tunnel_token передається тільки через завершений WSS-канал,
     після того як агент довів що він — це він (підписав фрейм Ed25519)
   - Agent writes cloudflared credentials to /etc/cloudflared/<tunnel_id>.json
   - Agent starts cloudflared: `cloudflared tunnel run <tunnel_id>`
   - cloudflared connects to CF, registers itself for the tunnel
8. Worker sets server status = "active" in D1
9. Worker is now ready to add ingress + DNS records to this tunnel on each deploy
10. User can now deploy to this server
```

### Server destroy flow (cleanup on VM termination)

```
1. User: "Delete this server" in UI / via MCP
2. Worker checks D1 for all running deployments on this server
3. For each deployment on the server, run Teardown flow steps 3a-3b
   (delete DNS record, remove tunnel ingress rule)
4. Worker calls DELETE /accounts/{id}/cfd_tunnel/{tunnel_id}
   → CF soft-deletes the tunnel (sets deleted_at; takes ~5min to fully clean)
5. Worker calls Hetzner/DO API to delete the server VM
6. Worker updates D1: server.status = "destroyed", tunnel.deleted_at = now
7. void-agent on the VM (if still running) sees WS disconnect, retries, fails
   → exits cleanly, no zombie processes

Order matters: DNS first, then ingress, then tunnel, then VM.
If VM is destroyed first, the agent can't gracefully shut down, but DNS records
will still be cleaned by step 3, so no 1016 errors linger.
```

### Live log streaming flow (for AI to debug)

```
1. AI calls MCP tool: void_get_logs({ deployment_id: "..." })
2. Worker initiates SSE stream back to AI client
3. SSE stream is wired to the void-cell DO for that deployment
4. As agent streams build/runtime logs over WS → DO → SSE → AI
5. AI reads logs, can call void_rebuild with different env if needed
6. User sees real-time xterm.js terminal in browser (same SSE stream)
```

---

## Authentication

Three identity layers, scoped properly:

### 1. User auth (human or AI on user's behalf)

**GitHub OAuth** for the web UI (one-time login, session cookie).

OAuth flow MUST use `state` parameter (crypto.randomUUID) to prevent CSRF on the callback endpoint. State is stored in KV with 10min TTL, verified on callback, then deleted.

**MCP API tokens** for AI agents. Tokens are:
- Created in UI ("Create Token" → copy into Cursor's MCP config)
- Scoped: `read:projects`, `write:deploy`, `read:logs`, `write:env`
- Stored hashed (SHA-256) in D1
- Revocable
- Rate-limited (60 req/min per token, 1000 deploys/day)

MCP endpoint requires `Authorization: Bearer <token>` header. The Origin header MUST be validated per [MCP spec §Streamable HTTP](https://modelcontextprotocol.io/docs/concepts/transports) to prevent DNS rebinding.

### 2. Agent auth (machine-to-machine)

Agent generates Ed25519 keypair on first boot. Public key registered with Worker during install. Every WS message from the agent includes an Ed25519 signature in the JSON payload itself:

```json
{
  "type": "deploy_done",
  "payload": { ... },
  "sig": "base64(Ed25519(sha256(type + payload)))"
}
```

Private key never leaves the VM. The Worker verifies `sig` against the stored `agent_public_key` before processing any message. ⚠️ **Important:** WS frames after the HTTP upgrade do not have custom headers, so the signature must live in the message body, not in a header field. This is the correct implementation — the original spec incorrectly mentioned `X-Void-Sig` header, which doesn't exist in WebSocket frames.

Token exchange: agent presents `setup_token` (one-time, generated by Worker when server is created) over WSS, gets back a long-lived session ticket.

### 3. Webhook auth (v0.1 — required for launch)

GitHub App for auto-deploy on push. Without this, void is not "convenient" — it's "MCP-call-only PaaS", which is a much smaller wedge. See [GitHub App Integration](#github-app-integration) for full spec.

---

## GitHub App Integration (v0.1 — required for launch)

Without `git push` auto-deploy, void is "MCP-only PaaS" — a much smaller wedge. With it, void is "self-hosted Vercel" — the actual goal. This section is therefore part of v0.1 launch criteria, not v0.2.

### Setup flow (one-time per user)

```
1. User signs in to void (GitHub OAuth)
2. User clicks "Connect a Repository" in UI
3. UI redirects to GitHub App install page:
   https://github.com/apps/void-deployer/installations/new
   (GitHub App is owned by void's GitHub org, published once)
4. User picks which repo(s) to grant access to
5. GitHub redirects back to void with installation_id
6. Worker stores installation_id in D1, linked to user_id
7. User picks the default branch (main/master) and confirms
8. void is now wired to that repo — every push triggers a deploy
```

The void GitHub App is **public, published once** by the void project. Self-hosted void users either use the public app (we host it) OR deploy their own GitHub App (for compliance / on-prem). Both modes are supported in v0.1.

### Auto-deploy flow (every push, automatic)

```
1. User pushes commit to GitHub (default branch or PR branch)
2. GitHub sends webhook to Worker:
   POST /api/webhooks/github
   Headers: X-Hub-Signature-256: sha256=...
           X-GitHub-Event: push OR pull_request
3. Worker verifies HMAC-SHA256 signature using GITHUB_WEBHOOK_SECRET
4. Worker extracts: { repo.full_name, ref, commit_sha, installation_id, is_pr }
5. Worker looks up project by (repo.full_name, installation_id)
   If no project found → 200 OK (ignore, not our repo)
6. Worker determines deploy target:
   - ref matches project's default_branch → production deploy
   - ref is a PR branch → preview deploy, hostname = "pr-{number}-{slug}"
7. Worker triggers the same internal flow as `void_deploy` MCP tool
8. (Optional, v0.1 stretch) Worker posts status back to commit:
   - GitHub commit status: "void/deploy" → success/failure
   - On PR: comment with preview URL
```

### Webhook payload handling

```ts
// Worker pseudo-handler
async function handleGitHubWebhook(req: Request, env: Env) {
  const body = await req.text();
  const sig = req.headers.get("X-Hub-Signature-256");
  
  if (!verifyHMAC(body, sig, env.GITHUB_WEBHOOK_SECRET)) {
    return new Response("invalid signature", { status: 401 });
  }
  
  const event = req.headers.get("X-GitHub-Event"); // "push" or "pull_request"
  const payload = JSON.parse(body);
  
  if (event === "push" && payload.ref.startsWith("refs/heads/")) {
    await triggerDeployFromPush(payload, env);
  } else if (event === "pull_request" && payload.action === "opened" || payload.action === "synchronize") {
    await triggerPreviewDeployFromPR(payload, env);
  }
  
  return new Response("ok"); // always 200 to ack
}
```

### What the worker does NOT do via webhook

- ❌ Receive webhooks for repos the user hasn't installed the App on (returns 200, ignores — GitHub retries on non-2xx, we don't want that)
- ❌ Re-deploy if the commit is from a bot (skip `[bot]` authors)
- ❌ Handle webhook events other than `push` and `pull_request` (ignore check runs, releases, etc.)

### GitHub App manifest (for self-hosted users who deploy their own)

Users who self-host void can publish their own GitHub App to keep webhook traffic on their org. The void Worker reads the App credentials from env vars:

```toml
# wrangler.toml
[vars]
GITHUB_APP_ID = "123456"
GITHUB_APP_NAME = "my-org-void-deployer"
# GITHUB_APP_PRIVATE_KEY is a secret
GITHUB_WEBHOOK_SECRET = "..."
```

The App manifest (id, name, public link) is provided as a Cloudflare secret, not committed.

### Why GitHub App (not OAuth App, not webhook with PAT)

- **GitHub App** is the modern, scoped, multi-repo way. One installation grants access to N repos. No PATs to manage, no OAuth scope creep.
- **OAuth App** requires the user to grant access to ALL their repos. Bad UX, bad security.
- **Webhook with PAT** requires the user to generate a PAT, paste it, and renew it. Manual, error-prone, doesn't scale.
- **GitHub App** posts commit statuses natively (no extra API calls), and PR comments are scoped to the App's identity.

### v0.1 stretch goals (do if time permits, not blockers)

- ⏳ PR comment with preview URL (requires posting comments API, needs App installation token)
- ⏳ Commit status checks (✓ / ✗ on the commit)
- ⏳ "Redeploy" button on GitHub PR comment (via comment command `/void redeploy`)

These are nice but not "convenient" baseline. `git push` → live URL is the baseline.

---

## Edge Functions via Workers for Platforms (v0.3)

**This is the v0.3 feature that closes the gap with Vercel's Edge.** v0.1 ships without it; v0.3 adds it; v0.4 (managed mode) makes it the headline differentiator.

### Why this is possible (and Coolify can never do it)

void runs a Cloudflare Worker as its control plane. That Worker is in CF's edge network. We can use [Workers for Platforms (WfP)](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/) to deploy **the user's code** to a per-tenant Worker slot, also in CF's edge. Their code runs at the edge, before the request hits the tunnel → container. Coolify would need to build a separate edge compute layer (impossible) or proxy through a self-hosted worker (slow). We get it for free because void is already edge-native.

### Architecture

```
User browser → CF edge
                ↓
         ┌──────┴──────┐
         ↓             ↓
   [User Worker]   [Direct tunnel → container]
   (via WfP)            ↑
   Can: rewrite,                │
   auth, A/B, geo,              │
   short-circuit ───────────────┘
   return early
```

User configures which paths go through the edge function (e.g. `/_middleware`, `/api/*`, `*` for all). For all other paths, traffic flows directly to the tunnel → container (no edge overhead, same as v0.1).

### User-facing API

Users write `middleware.ts` in their repo:

```ts
// middleware.ts (Vercel-compatible)
import { NextRequest, NextResponse } from "next/server";

export const config = {
  matcher: ["/api/:path*", "/((?!_next|favicon.ico).*)"],
};

export default async function middleware(request: NextRequest) {
  // 1. Auth at the edge (no origin hit if invalid)
  const token = request.headers.get("Authorization");
  if (!token || !validateJWT(token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 2. A/B test
  const bucket = hashUserId(request.cookies.get("uid")?.value) % 2;
  const url = request.nextUrl.clone();
  url.pathname = bucket === 0 ? "/variant-a" + url.pathname : url.pathname;

  // 3. Add headers for the origin
  const response = NextResponse.rewrite(url, {
    request: { headers: new Headers({ ...request.headers, "X-Edge-Bucket": String(bucket) }) },
  });

  // 4. Cache at the edge
  response.headers.set("Cache-Control", "public, max-age=60, s-maxage=300");

  return response;
}
```

This is **Vercel-compatible middleware syntax** — anyone who has used Vercel Edge Middleware will recognize it. The user's code is compiled to a Worker script and deployed via WfP.

### How deployment works (v0.3 internal flow)

```
1. User commits middleware.ts to their repo
2. GitHub webhook fires void_deploy (or user calls void_deploy via MCP)
3. Agent on user's VM:
   a. git pull, railpack build (as before)
   b. detect middleware.ts, compile to Worker script
      - Use esbuild/wrangler's bundler, target = "es2022" + "worker"
      - Result: a single JS file (max 10MB compressed per CF limit)
   c. compute SHA-256 of the bundle
   d. send bundle + SHA to Worker via WS:
      { type: "edge_function_upload", project_id, sha, bundle_base64 }
4. Worker (control plane):
   a. stores bundle in R2: void-edge/{project_id}/{sha}.js
   b. calls WfP API to deploy/update per-tenant Worker:
      PUT /accounts/{id}/workers/dispatch/namespaces/{ns}/scripts/{project_id}
      Body: the JS bundle (or URL reference to R2)
   c. WfP returns version_id, stores in D1
5. WfP propagates the script to CF edge within ~30s globally
6. CF edge now executes user's middleware for matching paths
7. Worker updates route config in KV: path matcher → use edge
```

### WfP integration specifics

- **Per-user Worker scripts:** one script per (user_id, project_id). Isolated execution, own memory/CPU limits.
- **Custom limits:** each user Worker gets configurable CPU time (default 10ms, max 30s on paid WfP).
- **Custom hostnames:** WfP integrates with CF for SaaS, so the user's app on `myapp.void.example.com` can have the edge function applied without extra DNS work.
- **Subrequests limit:** 50/req free, 1000/req paid. Same as regular Workers.
- **Bundling:** workerd runtime, not Node.js. User code must use Web APIs (fetch, Request, Response, Headers, URL, crypto.subtle, etc.). No `fs`, no `child_process`. We compile out Node-only deps via wrangler's bundler with `compatibility_flags: ["nodejs_compat"]` where possible.

### What users get (the marketing pitch)

> "Vercel Edge functions, on your Hetzner, no Vercel bill."
> "Edge auth, A/B tests, geo-redirects — 5ms away from your users, runs on CF, free tier."

This is the **headline v0.3 differentiator**. No self-hosted competitor (Coolify, Devpush, Dokku) has anything close. Vercel charges $20+/mo for edge function invocations; we charge €0 (within WfP free tier of 100k req/day per script).

### Cost analysis (v0.3, projected)

WfP pricing (per [Cloudflare docs](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)):

- Dispatch requests: $0.05/M
- User Worker requests: $0.15/M
- CPU duration: $0.02/M GB-s

For 100 active users, each running a typical edge function (~5ms CPU, 100k requests/mo):

- 100 × 100k = 10M dispatches/mo × $0.05/M = **$0.50/mo**
- 10M user Worker requests × $0.15/M = **$1.50/mo**
- CPU: 10M × 5ms × 128MB ÷ 1024 ≈ 6,250 GB-s × $0.02/M = **$0.13/mo**

**Total: ~$2/mo for 100 users. Free tier covers 100k req/day = 3M/mo for free.**

Cheap enough to bundle in managed void.sh at $12/mo flat. Profitable from day one of paid tier.

### v0.3 implementation milestones

- [ ] WfP account setup + dispatch Worker template
- [ ] esbuild integration in void-agent (compile middleware.ts → Worker bundle)
- [ ] R2 upload of bundle + SHA
- [ ] WfP API deploy endpoint in control plane Worker
- [ ] Path matcher config (UI + MCP tool to set which paths use edge)
- [ ] Per-tenant observability (logs, CPU, errors via WfP Tail Workers)
- [ ] Per-tenant rate limiting (KV counters in dispatch Worker)
- [ ] Documentation: "writing void-compatible middleware"
- [ ] Migration guide: Vercel Edge middleware → void (mostly trivial, same API surface)

### v0.3 stretch goals

- Edge KV bindings (user can read/write KV at the edge from middleware)
- Edge D1 read-only bindings (for auth lookups at edge)
- Edge cron triggers (scheduled functions)

### What edge functions do NOT enable (out of scope even for v0.3)

- Edge SSR (rendering pages at edge) — apps render server-side on the Hetzner VM via Railpack/Next.js, not at edge
- Edge image optimization — user apps handle this themselves, or we add Cloudflare Images integration in v0.4
- Edge databases (D1, Durable Objects) — user KV/DO bindings are a stretch goal only

### Why this isn't v0.1

Re-emphasizing scope discipline: v0.1 = "git push → live URL + MCP + no SSH". Edge functions = advanced feature, adds 1-2 weeks of work (WfP setup, esbuild integration, deploy pipeline, error handling), opens a new auth surface (untrusted user code at edge), and isn't required for the "convenient" pitch. The MVP demo doesn't need it. Save for v0.3, ship to a paying audience that already loves the v0.1→v0.2 baseline.

---

## MCP Server (the primary interface)

Single endpoint: `https://api.void.example.com/mcp`

Implements [MCP Streamable HTTP transport](https://modelcontextprotocol.io/docs/concepts/transports) (2025-06-18 spec). POST for client→server, GET for server→client SSE stream.

### Tools exposed in MVP

```json
{
  "tools": [
    {
      "name": "void_list_servers",
      "description": "List all servers (Hetzner/DO VMs) in the user's account with status.",
      "inputSchema": { "type": "object", "properties": {} }
    },
    {
      "name": "void_create_server",
      "description": "Provision a new VM. Requires Hetzner or DO API token (will prompt user if missing).",
      "inputSchema": {
        "type": "object",
        "properties": {
          "provider": { "type": "string", "enum": ["hetzner", "digitalocean"] },
          "name": { "type": "string" },
          "size": { "type": "string", "description": "e.g. cx22, s-2vcpu-4gb" },
          "region": { "type": "string", "description": "e.g. fsn1, nyc3" }
        },
        "required": ["provider", "name", "size", "region"]
      }
    },
    {
      "name": "void_deploy",
      "description": "Build and deploy a project. Returns a live URL when done. Streams logs via SSE.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "project": { "type": "string", "description": "Project slug, e.g. 'my-app'" },
          "ref": { "type": "string", "description": "Git ref: branch, tag, or commit SHA. Default: HEAD of default branch." },
          "env": { "type": "object", "description": "Env vars as key-value object. Merged with project defaults." }
        },
        "required": ["project"]
      }
    },
    {
      "name": "void_get_logs",
      "description": "Stream build and runtime logs for a deployment. SSE stream, server-pushes until done.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "deployment_id": { "type": "string" }
        },
        "required": ["deployment_id"]
      }
    },
    {
      "name": "void_list_deployments",
      "description": "Recent deployments with status, duration, commit, URL.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "project": { "type": "string" },
          "limit": { "type": "integer", "default": 20 }
        }
      }
    }
  ]
}
```

### MCP response format for void_deploy

```json
{
  "deployment_id": "dep_abc123",
  "status": "success",
  "url": "https://pr-42-my-app.void.example.com",
  "duration_ms": 45230,
  "image": "my-app:abc123",
  "build_logs_url": "https://api.void.example.com/mcp/logs/dep_abc123"
}
```

The AI gets back a structured result, then either renders it as a markdown link or opens the log stream for debugging.

---

## API Specification (HTTP, for CLI/direct use)

Same backing logic as MCP, exposed as plain REST for tools that don't speak MCP.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET`  | `/api/auth/github` | — | Start OAuth |
| `GET`  | `/api/auth/callback` | — | OAuth callback |
| `GET`  | `/api/auth/me` | session | Current user |
| `POST` | `/api/auth/tokens` | session | Create MCP token |
| `DELETE` | `/api/auth/tokens/:id` | session | Revoke token |
| `GET`  | `/api/servers` | token | List servers |
| `POST` | `/api/servers` | token | Provision server |
| `DELETE` | `/api/servers/:id` | token | Destroy server |
| `GET`  | `/api/projects` | token | List projects |
| `POST` | `/api/projects` | token | Register project (git repo) |
| `POST` | `/api/projects/:slug/deploy` | token | Trigger deploy |
| `GET`  | `/api/deployments/:id` | token | Get status |
| `GET`  | `/api/deployments/:id/logs` | token | SSE log stream (requires CORS: `Access-Control-Allow-Origin: *` for browser clients) |
| `GET`  | `/api/routes/resolve?host=...` | — (internal) | Worker → tunnel lookup |
| `POST` | `/mcp` | token (or session) | MCP Streamable HTTP endpoint |

---

## Routing Layer (Two-Path Model)

**Critical design rule:** the Worker is **not** in the app data path. App traffic flows User → CF edge → cloudflared tunnel → Docker container, completely bypassing the Worker. The Worker is control-plane only (UI, REST, MCP, log streaming). If the Worker goes down, deployed apps keep serving.

This is achieved with two parallel routing paths in the user's CF zone:

```
User → CF edge
           ↓
   ┌───────┴───────────────────────────────────────┐
   ↓                                                ↓
[Worker routes]                               [Per-app DNS records]
api.void.example.com                          pr-42-app.void.example.com
void.example.com                              api-2.void.example.com
                                               blog.void.example.com
   ↓                                                ↓
UI, REST, MCP, log SSE                       → CNAME → tunnel
                                              → cloudflared → Docker container
                                              (no Worker in path)
```

### Path A: Worker routes (control plane)

Two specific routes in the CF zone:

```
api.void.example.com/*  →  Worker
void.example.com/*       →  Worker
```

⚠️ **CORS note:** The web UI lives on `void.example.com`, but SSE and API calls go to `api.void.example.com`. All `/api/*` endpoints and the `/mcp` endpoint MUST return `Access-Control-Allow-Origin: *` (or the specific UI origin) with `Access-Control-Allow-Headers: Authorization, Content-Type` and handle OPTIONS preflight. Without this, the xterm.js log viewer won't work in the browser.

The Worker handles:
- Web UI (login, dashboard, deploy history, log viewer)
- REST API (`/api/*`)
- MCP endpoint (`/mcp`)
- SSE log streams (`/api/deployments/:id/logs`)

### Path B: Per-app DNS records → tunnel → container

**Important correction (v0.1):** we cannot use a single wildcard `*.void.example.com` CNAME for tunnel traffic, because the CNAME target is `<tunnel_id>.cfargotunnel.com` — a per-tunnel UUID. Since we have one tunnel per server (not one tunnel per platform), each app needs its own CNAME record pointing to its server's tunnel. The Worker manages these via the Cloudflare API.

For each running app, the Worker performs two CF API calls on deploy:

**1. Add ingress rule to the server's tunnel** — [`PUT /accounts/{id}/cfd_tunnel/{tunnel_id}/configurations`](https://developers.cloudflare.com/api/operations/cloudflare-tunnel-put-configuration):

```http
PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations
Authorization: Bearer <CF_API_TOKEN>
Content-Type: application/json

{
  "config": {
    "ingress": [
      { "hostname": "pr-42-myapp.void.example.com", "service": "http://localhost:3000", "originRequest": {} },
      { "hostname": "pr-43-api.void.example.com",   "service": "http://localhost:8080", "originRequest": {} },
      { "service": "http_status:404" }
    ]
  }
}
```

This call REPLACES the entire ingress array. The Worker must read current state, modify, and PUT the full new array. Concurrent PUTs race (last write wins) — see "Concurrency" below.

**2. Create DNS record** — `POST /zones/{zone_id}/dns_records`:

```http
POST /zones/{zone_id}/dns_records
Authorization: Bearer <CF_API_TOKEN>
Content-Type: application/json

{
  "type": "CNAME",
  "proxied": true,
  "name": "pr-42-myapp.void.example.com",
  "content": "<tunnel_id>.cfargotunnel.com"
}
```

The DNS record is what tells the public internet "this hostname routes through Cloudflare and ends up at this specific tunnel". The `proxied: true` flag is critical — it activates CF's edge (DDoS, WAF, caching) on this hostname.

DNS records pointing to deleted/non-running tunnels return [error 1016](https://developers.cloudflare.com/support/troubleshooting/error-codes/cloudflare-1016-errors/) to visitors. So the order of operations on cleanup matters — see "Lifecycle" below.

### Lifecycle of an app hostname

```
Deploy starts
  → Worker generates unique prefix: pr-42-myapp (or reuses existing)
  → Worker calls PUT /cfd_tunnel/{id}/configurations to add the ingress rule
  → Worker calls POST /zones/{id}/dns_records to create the CNAME
  → CF edge now routes pr-42-myapp.void.example.com → tunnel → cloudflared → container

App is live (Worker uninvolved)

Deploy ends / app removed / rolled back
  → Worker calls DELETE /zones/{id}/dns_records/{record_id} FIRST
    (removes the public DNS — visitors get DNS NXDOMAIN, no error page)
  → Worker calls PUT /cfd_tunnel/{id}/configurations to remove the ingress rule
  → Tunnel catch-all ({ service: "http_status:404" }) now answers for that hostname
  → No 1016 errors, no dangling routes
```

### Concurrency: serializing PUT configurations

`PUT /cfd_tunnel/{id}/configurations` is full-replace. If two deploys land on the same server simultaneously, the second PUT overwrites the first. We need to serialize per-server writes.

**Solution: per-server Durable Object for tunnel config writes.** The void-cell DO already exists for the server (used for WS to the agent). The same DO can mediate all CF API writes for that server's tunnel, using `ctx.blockConcurrencyWhile()` to ensure PUTs happen one at a time.

⚠️ **DO CPU limit caveat:** Durable Objects have 30s CPU time per invocation. `ctx.blockConcurrencyWhile()` counts toward this limit. If the CF API (GET + PUT tunnel config) takes longer than 30s, the DO throws and the deploy fails. Mitigation: implement retry with exponential backoff (3 attempts, 1s/4s/10s delay). In practice CF API responds in <2s, so this only triggers during transient outages.

Pseudocode:

```ts
// Inside the void-cell DO
async updateTunnelIngress(newHostname: string, newService: string) {
  return await ctx.blockConcurrencyWhile(async () => {
    const current = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`,
      { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } }
    ).then(r => r.json());
    
    const ingress = current.result.config.ingress.filter(r => r.hostname !== newHostname);
    ingress.unshift({ hostname: newHostname, service: newService, originRequest: {} });
    ingress.push({ service: "http_status:404" });
    
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ config: { ingress } }),
      }
    );
  });
}
```

DNS record create/delete is naturally idempotent and can be parallel — no DO needed there.

### What the Worker does NOT do

- ❌ Proxy HTTP traffic to containers
- ❌ Terminate TLS for app traffic
- ❌ Buffer or stream app responses
- ❌ Charge CPU time for app requests
- ❌ Become a bottleneck or single point of failure for running apps

### What the Worker DOES do for routing

- ✅ Resolve `prefix → tunnel_id` when a deploy is requested
- ✅ Call CF API to add/remove ingress rules on the appropriate tunnel (via per-server DO)
- ✅ Call CF API to create/delete DNS records (CNAMEs pointing to tunnel)
- ✅ Update D1 (`deployments.hostname`, `deployments.dns_record_id`)
- ✅ Cache the routing table in KV for fast lookup during MCP deploy calls

### Why cloudflared (not Worker-as-proxy, not direct agent IP)

1. **Agent VM has zero inbound ports.** No DDoS surface, no brute-force target.
2. **Worker is not in the data path.** If Worker crashes, deployed apps keep serving. Worker OOM during a deploy burst doesn't take down production traffic.
3. **No Worker CPU/bandwidth cost for app traffic.** A Next.js SSR app doing 100 RPS would burn the free tier in hours if proxied through Worker. Through tunnel, it's free.
4. **TLS termination at CF edge.** No cert management on the agent, automatic renewal.
5. **Stream support, WebSocket support, large uploads all work.** cloudflared handles them natively, no Worker limitations.
6. **Official CF solution.** Maintained, documented, debugged via `cloudflared tail`.

### CF API token permissions

The Worker needs a CF API token with:

- `Account:Cloudflare Tunnel: Edit` — to manage tunnel configurations
- `Zone:DNS: Edit` — to create/delete CNAME records in the user's zone

In self-hosted mode, the user creates this token in their CF dashboard and pastes it into `wrangler secret put CF_API_TOKEN` during setup. We never see it.

### CF API rate limits and our usage budget

The [Cloudflare API global rate limit](https://developers.cloudflare.com/fundamentals/api/reference/limits/) is **1,200 requests per 5 minutes per user/token**. Returns HTTP 429 on excess, with `retry-after` header.

Per deploy lifecycle: 4 CF API calls (PUT config + POST dns on create; PUT config + DELETE dns on teardown). Per redeploy (same hostname): 3 calls (PUT config, DELETE dns, POST dns).

| Activity | Calls | Notes |
|----------|-------|-------|
| New deploy | 2 (PUT config + POST dns) | |
| Teardown / rollback | 2 (DELETE dns + PUT config) | |
| Re-deploy same hostname | 3 (PUT config + DELETE dns + POST dns) | |
| 100 deploys in 5 min (heavy CI) | 200-300 calls | ✅ 4x under limit |
| 1000 deploys in 5 min (pathological) | 2000-3000 calls | ❌ 429 throttling |

**Self-hosted MVP is safe.** Even 100 deploys per 5 minutes is 4x under the limit. The token is per-user, so the limit is per-user — no shared contention.

**Managed mode concern (v0.4):** if all managed users share one CF API token, the rate limit becomes account-wide. At scale this becomes a real bottleneck. Mitigations (deferred):

- Per-region CF API tokens (5 tokens × 1,200 = 6,000/5min)
- KV-based per-user rate limiting before CF API calls
- Long-lived DNS records (create once, update only on hostname change)
- CF for SaaS Custom Hostnames (CF manages the wildcard for us, no per-app DNS)

For MVP, document the limit clearly and move on.

### Tunnel-specific limits

- **Ingress rules per tunnel:** no hard documented limit; hundreds supported. We expect <50 per server in practice.
- **Tunnel replicas:** up to 25 cloudflared instances per tunnel (100 connections). We use 1 per server, headroom for redundancy later.
- **Tunnel deletion:** soft-delete via `DELETE /accounts/{id}/cfd_tunnel/{id}` (sets `deleted_at`). DNS records pointing to the deleted tunnel will 1016. Always delete DNS first (see Lifecycle above).

### Fallback for v0.2 (if CF API quotas become painful)

If the CF API for tunnel configs has rate limits or cost issues at scale, fallback is: agent maintains a long-lived WebSocket to the Worker; Worker proxies HTTP over that WS for app traffic. Loses the "Worker not in path" win but removes CF API dependency. Decision deferred until v0.2 metrics show whether we need it.

---

## Database Schema (D1)

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,           -- ulid
  github_id     TEXT UNIQUE NOT NULL,
  username      TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE oauth_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  provider      TEXT NOT NULL,              -- 'github'
  access_token  TEXT NOT NULL,              -- encrypted with worker secret
  refresh_token TEXT,
  expires_at    INTEGER,
  UNIQUE(user_id, provider)
);

CREATE TABLE api_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  token_hash    TEXT UNIQUE NOT NULL,       -- sha256 of token, never store plain
  scopes        TEXT NOT NULL,              -- "read:projects,write:deploy"
  last_used_at  INTEGER,
  expires_at    INTEGER,                    -- null = never
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE cloud_credentials (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  provider      TEXT NOT NULL CHECK(provider IN ('hetzner','digitalocean')),
  label         TEXT NOT NULL,              -- "prod-hetzner"
  token_enc     TEXT NOT NULL,              -- encrypted with worker secret
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, provider, label)
);

CREATE TABLE servers (
  id                  TEXT PRIMARY KEY,     -- ulid, also used as tunnel name
  user_id             TEXT NOT NULL REFERENCES users(id),
  credential_id       TEXT NOT NULL REFERENCES cloud_credentials(id),
  name                TEXT NOT NULL,
  provider            TEXT NOT NULL,
  provider_server_id  TEXT NOT NULL,         -- Hetzner/DO ID
  region              TEXT NOT NULL,
  size                TEXT NOT NULL,
  ipv4                TEXT,
  status              TEXT NOT NULL CHECK(status IN ('provisioning','active','offline','failed','destroyed')),
  agent_public_key    TEXT,                 -- ed25519 hex
  tunnel_id           TEXT,                 -- cloudflared tunnel UUID
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at        INTEGER
);

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  slug          TEXT NOT NULL,              -- url-safe, used in subdomain
  name          TEXT NOT NULL,
  repo_url      TEXT NOT NULL,              -- https://github.com/owner/repo
  default_branch TEXT NOT NULL DEFAULT 'main',
  default_port  INTEGER NOT NULL DEFAULT 3000,
  server_id     TEXT REFERENCES servers(id),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, slug)
);

CREATE TABLE deployments (
  id            TEXT PRIMARY KEY,           -- ulid
  project_id    TEXT NOT NULL REFERENCES projects(id),
  server_id     TEXT NOT NULL REFERENCES servers(id),
  ref           TEXT NOT NULL,              -- branch/tag/sha
  commit_sha    TEXT,
  image_tag     TEXT,                       -- final docker image tag
  status        TEXT NOT NULL CHECK(status IN ('queued','building','deploying','running','failed','cancelled')),
  build_log     TEXT,                       -- last 16KB, full in R2
  error         TEXT,
  started_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at   INTEGER,
  duration_ms   INTEGER
);

CREATE INDEX idx_deployments_project ON deployments(project_id, started_at DESC);
CREATE INDEX idx_servers_user ON servers(user_id);
```

**D1 free tier limits:** 5GB reads, 100k writes/day, 5M rows stored. Comfortable for thousands of users.

---

## void-agent (Rust)

Single binary, ~8MB RAM resident, ~3MB on disk. Runs as systemd service on Ubuntu 24.04.

### Crate dependencies

```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
tokio-tungstenite = "0.24"            # WS client
reqwest = { version = "0.12", features = ["json", "stream"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
ed25519-dalek = "2"                   # signing
sha2 = "0.10"
ulid = "1"
anyhow = "1"
tracing = "0.1"
tracing-subscriber = "0.3"
```

That's it. No HTTP framework (we're the client), no DB driver, no template engine. The agent is a thin orchestrator.

### Lifecycle

```
1. systemd starts void-agent.service
2. Read /etc/void/config.toml:
   - setup_token, server_id, api_base, tunnel_token, tunnel_id
3. Generate Ed25519 keypair if /var/lib/void/key.priv missing
4. POST to api.void.example.com/cell/register:
   { setup_token, server_id, public_key }
5. Receive { session_ticket, tunnel_id, tunnel_token }
6. Open WS to wss://api.void.example.com/cell/<server_id>?ticket=...
7. Write cloudflared credentials to /etc/cloudflared/<tunnel_id>.json
8. Start cloudflared as child process:
   cloudflared tunnel --config /etc/cloudflared/config.yml run <tunnel_id>
   (config.yml ingress rules are managed by the Worker via CF API;
    cloudflared just executes whatever config it last received)
   Agent monitors cloudflared process via tokio::process::Child, restarts on exit:
   - if exit code ≠ 0, log + restart with backoff (1s, 2s, 4s, max 30s)
   - all deployed apps stay down until cloudflared reconnects
   - heartbeat will still fire (it's a separate WS), so Worker sees agent alive but apps unreachable
9. Enter main loop:
   - on { type: "deploy" } msg:
     * spawn `git clone <repo_url> /tmp/build/<id>`
     * spawn `railpack build /tmp/build/<id> -o my-app:<sha>`
       → stream stdout line-by-line over WS as { type: "log", line }
     * on success: docker run ... → healthcheck → { type: "deploy_done" }
     * Worker (on its side) registers Public Hostname on the tunnel via CF API
   - send heartbeat every 30s
10. On WS disconnect: exponential backoff reconnect (1s, 2s, 4s, ..., max 60s)
11. On /var/lib/void/.stop file: graceful shutdown
```

**Key point:** cloudflared ingress rules are owned by the **Worker** (via CF API), not by the agent. The agent just runs cloudflared. When the Worker adds a Public Hostname, cloudflared fetches the updated config and starts routing. When the Worker removes it, cloudflared stops. This keeps ingress logic in one place (the Worker) and avoids the agent having to talk to CF API directly.

### Cargo build flags

```bash
cargo build --release \
  --target x86_64-unknown-linux-musl \
  -Z build-std=std,panic_abort \
  --profile release-stripped
```

Static binary, no glibc dep, no openssl dep (use rustls). 3-4MB on disk.

### Install (run by cloud-init)

```bash
#!/bin/bash
set -e
curl -fsSL https://github.com/void/agent/releases/latest/download/void-agent-x86_64-unknown-linux-musl -o /usr/local/bin/void-agent
chmod +x /usr/local/bin/void-agent
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
curl -fsSL https://github.com/railwayapp/railpack/releases/latest/download/railpack-x86_64-unknown-linux-gnu -o /usr/local/bin/railpack
chmod +x /usr/local/bin/railpack
mkdir -p /var/lib/void /etc/cloudflared
# tunnel_token is generated by the Worker and passed via cloud-init
# the agent will receive a tunnel_id at registration and write the credentials itself
cat > /etc/void/config.toml <<EOF
server_id = "$SERVER_ID"
setup_token = "$SETUP_TOKEN"
api_base = "https://api.void.example.com"
tunnel_token = "$TUNNEL_TOKEN"
EOF
cat > /etc/systemd/system/void-agent.service <<EOF
[Unit]
Description=void agent
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/bin/void-agent
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now void-agent
```

~80 lines. Fully reproducible.

---

## Security Model

### Network

- **Zero inbound ports** on user VMs (Hetzner/DO firewall denies all inbound by default)
- Agent → Worker: outbound WSS on 443 only
- cloudflared → CF edge: outbound tunnel
- User → App: through CF edge → cloudflared → Docker container on VM

### Secrets

- Cloud provider tokens (Hetzner/DO) — encrypted at rest in D1 with worker secret (Cloudflare secret binding, AES-256-GCM)
- GitHub OAuth tokens — encrypted at rest
- MCP API tokens — stored as SHA-256 hash, never recoverable
- Env vars per project — stored in D1, encrypted, sent over signed WS to agent at deploy time
- Agent Ed25519 private key — generated on disk, never transmitted, signs every WS frame

⚠️ **Known limitations (MVP):**
- All secrets share one encryption key (the Worker secret binding). If it leaks, everything encrypted in D1 is compromised. Per-user DEK (Data Encryption Key) with envelope encryption is deferred to v0.2.
- Build logs (`deployments.build_log` in D1, full in R2) may contain secrets: npm tokens, API keys in console output, env var values leaked during build. R2 does not encrypt at rest by default — logs are stored unencrypted. Mitigation: document that users should not log secrets; v0.2 add R2 server-side encryption + log scrubbing.

### Trust boundaries

```
[ User's machine ]  ←[ AI agent ]→  [ CF Edge / Worker ]  ←[ signed WS ]→  [ void-agent on VM ]  ←[ Docker exec ]→  [ user app ]
                                                ↑                                       ↑
                                          TLS, OAuth/JWT                    Ed25519, no shell
```

No path from Worker to agent's shell. No path from user to agent. No SSH. No way for the user (or attacker who compromises Worker) to `docker exec` into arbitrary user apps — the agent owns the Docker daemon and only runs commands it received over signed WS from Worker.

### Threat model (MVP)

- ✅ Compromised Cloudflare account: rotated Worker secret decrypts stored tokens
- ✅ Compromised user GitHub token: revoke in UI
- ✅ Compromised MCP token: revoke in UI
- ✅ Compromised agent: Ed25519 key + Worker-issued tunnel ID. Rotate.
- ❌ Compromised user VM: attacker has root on their own server. Out of scope.
- ❌ Compromised user Hetzner account: out of scope (this is the user's Hetzner).

---

## Wildcard DNS Setup (self-hosted)

In self-hosted mode the user owns the domain (e.g. `void.example.com`) or uses the default `*.workers.dev` subdomain (free, no setup). For BYO domain, two records in their DNS provider (or Cloudflare if the zone is already on CF):

```
void.example.com.        A     192.0.2.1   ; or use CF Worker custom domain
*.void.example.com.      CNAME void.example.com.
```

Then in Cloudflare for the `void.example.com` zone:
- Add Worker as custom domain for `void.example.com` (or `api.void.example.com`)
- Add Worker route: `*.void.example.com/*` → Worker

That's the static wildcard setup. One A, one CNAME, two CF routes. Done.

**For app hostnames, the Worker manages per-app CNAMEs via the CF API** (NOT covered by the wildcard — see [Routing Layer](#routing-layer-two-path-model) for the full explanation). The wildcard `*.void.example.com` catches every hostname, but each app still needs its own CNAME record pointing to `<tunnel_id>.cfargotunnel.com` because tunnel UUIDs are per-server. The Worker creates these dynamically on every deploy:

```http
POST /zones/{zone_id}/dns_records
{ "type": "CNAME", "proxied": true,
  "name": "my-app.void.example.com",
  "content": "<server-1-tunnel-id>.cfargotunnel.com" }
```

**For the default `*.workers.dev` subdomain:** no DNS setup at all. CF provides the wildcard automatically. App hostnames look like `my-app.void.YOUR-SUB.workers.dev`. This is what most users will use — see the [Self-Hosted Setup](#self-hosted-setup-one-click-deploy-to-workers) wizard for the choice.

**The wizard handles either case automatically:**
- "Use workers.dev subdomain" → no DNS work for the user
- "Use my own domain" → wizard shows the A + CNAME records to add, then verifies via TXT record before proceeding

---

## Domain Model: BYO for Self-Hosted, Shared for Managed

void has two deployment modes with different domain strategies. This is by design, not a missing feature.

### Self-hosted mode (v0.1) — user brings their own domain

The user picks any domain they own (e.g. `void.example.com`). Self-hosted means the Worker runs on **their** Cloudflare account, in **their** zone. Our `void.sh` zone is not accessible to them — we cannot route their Worker traffic through it without handing them our API keys, which would defeat the point of self-hosted.

This is also a feature, not a limitation:

- **No shared abuse surface.** Phishing on a shared `void.sh` would burn our domain reputation; BYO means each user owns their own risk.
- **No shared rate limits.** CF Workers Free is 100k req/day per account. With shared domain, one viral deployment would lock everyone out. BYO means each user has their own quota.
- **White-label friendly.** Corporate users can put void on `void.acme-corp.com` without exposing our brand.
- **No shared cost burden.** CF egress is on the user's account. We pay nothing for their traffic.

### Managed mode (v0.4+) — `*.void.sh` default + custom domain upgrade

When we ship `void.sh` as a hosted product, we run the Workers on our Cloudflare account. In that mode we can offer both:

- `*.void.sh` default subdomain (`my-app.void.sh`) — zero-setup onboarding
- Custom domain support as upgrade (user adds CNAME, we issue CF for SaaS cert, validate)

Same Worker routing logic, different wildcard zone. We do the DNS API work *once* (provision the wildcard in our zone), and per-user hostnames still don't need DNS records — they're caught by the wildcard and resolved by the routing table.

**Managed-mode tradeoffs we accept:**

- **Abuse mitigation:** every managed user app is rate-limited per-user (KV counter) to prevent one account from monopolising the Worker. Phishing reports go to `abuse@void.sh`. We reserve the right to suspend.
- **Shared limits:** we run CF Workers Paid plan ($5/mo + usage) to lift the 100k req/day cap and isolate per-user accounting.
- **Cost recovery:** managed users pay us (subscription covers their CF usage) or accept soft rate limits on the free tier.

These are v0.4 problems, not v0.1. For MVP, ship self-hosted only with BYO.

---

## Self-Hosted Setup (one-click "Deploy to Workers")

**The self-hosted install is itself a one-click "Deploy to Workers" button.** This is industry standard ([Deploy to Railway](https://railway.app/template), [Deploy to Vercel](https://vercel.com/templates), Coolify's one-click install) and is the only acceptable UX for "convenient self-hosted" in 2026. No manual `wrangler secret put` commands, no `d1 create`, no manual KV/R2 setup — the Worker bootstraps its own bindings on first run.

### README button (top of void's GitHub repo)

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/void-sh/void)

Click that button. It opens a CF form pre-filled with this repo. You authorize CF to fork + deploy. Within 60 seconds you have your own `void.YOUR-SUBDOMAIN.workers.dev` URL. That's it.
```

### What happens after "Deploy to Workers" click

```
1. User clicks the button on github.com/void-sh/void
2. CF's deploy UI opens, asks user to confirm fork + which CF account
3. CF forks void-sh/void into user's GitHub (or just deploys without fork, TBD)
4. CF runs `wrangler deploy` on the repo
5. The Worker boots, calls init() which:
   a. checks D1 binding — if missing, run schema migrations (idempotent CREATE TABLE IF NOT EXISTS)
   b. checks KV binding — pre-create ROUTES namespace key with empty object
   c. checks R2 binding — verify void-builds bucket exists (create if not, via CF API with CF_API_TOKEN)
   d. checks CF_API_TOKEN secret — if missing, redirect to /setup/wizard
6. Worker returns the deployed URL to the user
```

**Key insight: the Worker bootstraps its own state on first boot.** No `wrangler d1 create`, no `wrangler kv:namespace create` — those are bound at deploy time but the schema/initial data is created by the Worker's init code. The user only needs ONE secret for bootstrap: `CF_API_TOKEN`, used to create the R2 bucket if it doesn't exist.

### First-run wizard (UI)

After the Worker is live, the user lands on a setup wizard. No SSH, no terminal, no command line. Each step is a form in the web UI:

```
Step 1: Welcome
  "Welcome to your void instance. Let's connect your accounts."
  [ Continue ]

Step 2: Connect GitHub
  "void needs GitHub access to deploy your code and read your repos."
  [ Sign in with GitHub ] → standard OAuth flow
  After success: "✓ Connected as @username"

Step 3: Add a Cloud Provider
  "Which cloud do you want to run your apps on?"
  ○ Hetzner Cloud (recommended, €4/mo minimum)
  ○ DigitalOcean ($6/mo minimum)
  "Paste your API token from the provider's dashboard:"
  [ ____________________________ ]
  [ Hetzner: Account Settings → API Tokens → Read & Write ]
  [ Continue ]

Step 4: Add a Cloudflare API Token
  "void needs a CF API token to create tunnels and DNS records for your apps."
  [ Link to: Create a token with these permissions ]
  Required: Account > Cloudflare Tunnel: Edit, Zone > DNS: Edit
  [ ____________________________ ]
  [ Continue ]

Step 5: Pick a domain
  "void will create a wildcard DNS entry for app URLs."
  ○ Use workers.dev subdomain (free, e.g. void.ваш-subdomain.workers.dev)
  ○ Use my own domain (e.g. void.example.com) — requires DNS setup
  [ Continue ]

Step 6: Install the void GitHub App (optional but recommended)
  "Install the void app on your GitHub repos to enable git push auto-deploy."
  [ Install GitHub App ] → redirects to github.com/apps/void-deployer/installations/new
  After success: "✓ Installed on N repos"

Step 7: Done!
  "Your void is ready. Create your first project →"
  [ Go to Dashboard ]
```

Each step's data is saved progressively to D1 (`users.onboarding_step`), so the user can close the tab and come back. The wizard is **only shown on first run** — detected by absence of `users.onboarding_completed_at` in D1.

### What the wizard needs to do per step

| Step | What void stores | Validation |
|------|------------------|------------|
| 2 | GitHub OAuth tokens (encrypted) | OAuth callback sets `gh_access_token` |
| 3 | Cloud provider API token (encrypted) | Test call to provider: `GET /servers` (Hetzner) or `GET /v2/droplets` (DO) |
| 4 | CF API token (encrypted) | Test call: `GET /user` or `GET /zones/:id` |
| 5 | Wildcard DNS choice | If custom domain: store + show DNS setup instructions, verify with TXT record |
| 6 | GitHub App installation_id | GitHub redirects back with `installation_id` after install |
| 7 | Mark `onboarding_completed_at = now()` | — |

### Requirements for the user (the only ones)

- A Cloudflare account (free tier sufficient) — for the Worker to live in
- A Hetzner or DigitalOcean account — for the VMs that run apps
- A GitHub account — for the code to come from

That's it. No domain required (can use `*.workers.dev` for free). No SSH keys. No `wrangler` installed. No Node.js installed. The whole setup is clicking a button and filling 4 forms in a browser.

### What this enables for the project creation flow

After the wizard, the user lands on a dashboard with one big button: **"New Project"**. Clicking it opens a flow that REPLACES the "create server" + "add project" + "configure env" trio with a single unified flow:

```
"New Project" wizard
1. Pick a GitHub repo (from the repos your GitHub App has access to)
2. Pick a branch (default: main)
3. Configure env vars (optional, or skip)
4. Pick server strategy:
   ○ "Create a new server" (default, void picks Hetzner CX22 in fsn1)
   ○ "Use existing server" (power user, from the servers list)
5. [ Deploy ]

Behind the scenes (if "Create new server"):
  → void creates Hetzner VM via API
  → cloud-init installs agent
  → agent registers, void provisions tunnel
  → first deploy runs
  → DNS record + ingress rule created
  → user sees "Live at https://my-app.void.example.com"
```

For power users who already have servers: the "Use existing server" option lets them pick from a list, or "Add new server" to provision a fresh one separately. But the simple flow (auto-provision) is the default — most users never see "servers" as a separate concept.

### What this changes in the architecture

The Worker gains:

- `src/setup/wizard.ts` — wizard step handlers, OAuth callbacks, validation
- `src/setup/handlers/{github,hetzner,cf,domain}.ts` — per-step validation
- `src/setup/onboarding-state.ts` — D1 queries for wizard progress
- `src/setup/index.ts` — first-run detection + redirect to /setup

The D1 schema gains a column:

```sql
ALTER TABLE users ADD COLUMN onboarding_completed_at INTEGER;
```

The Worker init gains:

- Auto-create R2 bucket if missing
- Auto-migrate D1 schema (idempotent)
- Auto-bootstrap KV namespace with empty config

### What this changes in the SPEC (operationally)

- **No `wrangler secret put` in setup docs** — all secrets come through the wizard (except `CF_API_TOKEN` itself, which the user pastes once in the wizard; the Worker uses it to create the R2 bucket, then keeps it in `wrangler secret` for runtime use)
- **Bootstrap is one click** — Deploy button + wizard = 5 minutes total
- **No "git clone, npm install, wrangler login"** — the void repo is the Worker, CF deploys it directly
- **README is the install flow** — top of README = button, then below = "what just happened" explanation

### Why "Deploy to Workers" is the right pattern

- **Familiar:** every dev has seen this button (Railway, Vercel, Netlify, Cloudflare Pages itself)
- **Trust:** user deploys to their own CF account, void repo is just a template they keep
- **Frictionless:** no installation, no dependencies, no `npm install`, no terminal
- **Reversible:** user owns the Worker, can modify it, can delete it anytime
- **Showcase-able:** can be put on the README, on the landing, on Show HN

The alternative (manual wrangler setup) is for **developers** who want to fork and modify void. The "Deploy to Workers" flow is for **users** who just want to use void. We optimize for the latter; the former is a stretch goal (v0.2 — "clone and customize").

---

---

## MVP Scope (v0.1) — Launch-Ready

These are the v0.1 **launch criteria**. The product is not "shippable" as "the convenient self-hosted Vercel alternative" until all of these work. Showing on Show HN, posting to Reddit, publishing the README — none of it happens before this list is green.

### What works on day one

**Install (the "wow" moment):**
- [x] **One-click "Deploy to Workers" button** on README — forks + deploys to user's CF account in 60s
- [x] **Worker auto-bootstraps** on first run: creates D1 schema, R2 bucket, KV namespace, no manual commands
- [x] **First-run wizard** in UI (7 steps, ~5 minutes total): GitHub → Cloud provider token → CF API token → domain → GitHub App install → done
- [x] Each step is progressive: closing the tab doesn't lose progress

**Daily use (the "convenient" promise):**
- [x] GitHub OAuth login (web UI, 30 sec signup, no new password)
- [x] **"New Project" wizard** — pick repo, branch, env vars, server strategy (auto or BYO) → deploys in one click
- [x] **`git push` auto-deploy** — push to default branch → production, push to PR → preview URL, posted back as PR comment
- [x] **`void_deploy` MCP tool** — manual deploy from AI (alternative to git push, same end result)
- [x] **Preview URLs per PR** — `pr-42-myapp.void.example.com` auto-generated, no config needed
- [x] **Live logs** — xterm.js in browser + MCP stream to AI, real-time, ANSI colors
- [x] Wildcard DNS routing via cloudflared tunnels (`*.void.example.com` or `*.workers.dev`)
- [x] **Power user mode**: existing servers list, "Add server" button, can pick which server hosts which project (advanced flow behind a toggle)

**MCP server (the AI interface):**
- [x] `void_create_project` — pick repo + branch + env, void handles server provision
- [x] `void_deploy` — manual deploy by ref
- [x] `void_list_projects`, `void_list_deployments`, `void_get_logs` — read APIs
- [x] Scoped MCP tokens, SHA-256 hashed, revocable

**Foundation (the things that make the above work):**
- [x] Per-server Ed25519 auth (agent ↔ Worker)
- [x] Cloudflare Tunnel + DNS records managed via CF API
- [x] Heartbeat-based offline detection
- [x] Basic web UI: login, projects list, deployment history, log viewer, settings

### What does **not** ship in v0.1 (honest list)

- ❌ No env var UI in dashboard (use `void_deploy({ env: {...} })` per call instead, or set in `New Project` wizard)
- ❌ No rollback UI (just `void_deploy({ ref: "previous-sha" })` — one MCP call, not zero)
- ❌ No database addons (BYO Postgres/Redis via env var URL — Neon, Supabase, etc.)
- ❌ No custom domains in self-hosted mode (use `*.void.example.com` wildcard; managed `*.void.sh` + custom domains is v0.4)
- ❌ No monorepo (single root = single app)
- ❌ No team management (single user per Cloudflare account)
- ❌ No multi-region (one server = one region)
- ❌ No log persistence beyond last 16KB inline (full logs in R2 but no UI to view, no search)
- ❌ No Hetzner/DO terraform parity (just call their REST API directly)
- ❌ No build cache (every build is cold — Railpack cache is a v0.2 optimization)
- ❌ No "edit project after creation" (delete and recreate for MVP)
- ❌ No SSH escape hatch (whole point is no SSH; if you need it, use a different tool)

This is intentional. Each item above is a v0.2+ milestone, not v0.1. The "convenient" threshold is met by: one-click install + one-click deploy + live logs + MCP + no SSH. **Not** by every feature Vercel has.

### What "convenient" means we explicitly do NOT need for v0.1

- Custom domains — wildcard `*.void.example.com` covers MVP. Custom domains are a v0.4 differentiator, not a v0.1 necessity.
- Image optimization — Railpack-built apps are responsible for their own assets. Vercel's image pipeline is its own infrastructure moat, not something we can replicate.
- **Edge functions / middleware** — see [v0.3 Edge Functions](#edge-functions-via-workers-for-platforms). Possible via Workers for Platforms, but it's an advanced feature, not a v0.1 baseline. Most apps don't need edge code; those that do can wait for v0.3.
- ISR / on-demand revalidation — Next.js apps that need this can configure their own revalidation strategies.
- Web Analytics / RUM — out of scope.
- Self-hosting on a domain other than the one provided (advanced; v0.2 with custom domain support).
- Multiple cloud providers per user (start with Hetzner, add DO in v0.2 if there's demand).

These are not gaps in v0.1, they're the v0.4+ backlog.

---

## Roadmap

### v0.1 — Launch (target: 7-12 dev days, solo with AI assist)
See MVP Scope above. Git push auto-deploy + preview URLs + MCP + edge control plane + cloudflared tunnels. The "convenient self-hosted Vercel alternative" demo.

### v0.2 — Platform (target: 4-6 weeks)
- [ ] Env var management UI (encrypted, per-environment) — replace per-deploy env with persistent config
- [ ] Rollback (keep last N images, atomic switch, one click in UI)
- [ ] Multi-project per server (Docker network isolation)
- [ ] WebSocket-based log persistence (DO storage, 7 days)
- [ ] Full log viewer UI with search and ANSI color
- [ ] Custom domain support (CNAME + CF for SaaS)
- [ ] CLI tool (`void deploy`, `void logs`) that uses the same MCP server
- [ ] Railpack build cache (warm builds in <5s vs 30s cold)
- [ ] DigitalOcean provider (Hetzner-only in v0.1, add DO in v0.2)
- [ ] "Clone and customize" install path — for developers who want to fork void, manual wrangler setup docs (the path I originally wrote before realizing the wizard exists)
- [ ] Edit project settings (currently delete + recreate)

### v0.3 — AI-Native (target: 2-3 months)
- [ ] Self-debugging: AI reads logs via MCP, suggests fixes, applies them, redeploys — fully autonomous loop
- [ ] Usage metrics: per-deploy CPU/RAM/network from cAdvisor
- [ ] Cost tracking: pull Hetzner/DO bills, attribute to projects
- [ ] DO hibernation for log retention (cheaper than current approach)
- [ ] Per-user KV rate limiting refinement
- [ ] **Edge functions via Workers for Platforms** (see below) — parity with Vercel Edge, big differentiator vs Coolify

### v0.4 — Production (target: 4-6 months)
- [ ] Managed Postgres/Redis addons (Turbocharge or Supabase)
- [ ] Team management (RBAC, invites)
- [ ] SSO (SAML, Google Workspace)
- [ ] Audit log
- [ ] Multi-region deployments
- [ ] **Managed void.sh mode** — we run the Workers on our CF account, user brings their own VMs:
  - `*.void.sh` default subdomain on signup (`my-app.void.sh`, zero setup)
  - Custom domain support (CNAME + CF for SaaS cert)
  - CF Workers Paid plan to lift shared limits + per-user rate limiting via KV
  - abuse@void.sh inbox + soft suspension policy
  - Pricing: free tier with rate limits, or $12/mo flat for production quota

### v1.0 — Scale
- [ ] Multi-cloud failover
- [ ] Compliance: SOC 2, GDPR DPA
- [ ] Air-gapped install (CF replacement, e.g. self-hosted CF alternative)

---

## Competitive Landscape

| Project | Stack | Architecture | MCP | Verdict |
|---------|-------|--------------|-----|---------|
| [Vercel](https://vercel.com) | Closed source | Managed edge | Yes (their own) | $$$ — we're the self-hosted answer |
| [Railway](https://railway.com) | Closed source | Managed VMs | No | $ — also makes Railpack, we're complementary |
| [Render](https://render.com) | Closed source | Managed VMs | No | $ — more infra-shaped |
| [Coolify](https://coolify.io) | PHP/Laravel | Self-hosted, SSH-required | No | Heavy. 200MB+ for control plane |
| [Dokku](https://dokku.com) | Bash + plugins | Self-hosted, SSH-required | No | Powerful but CLI-only, no DX |
| [Devpush](https://github.com/hunvreus/devpush) | Python/Flask | Self-hosted, SSH-required | No | Closest to us, but monolith, no MCP |
| [Dokploy](https://dokploy.com) | Next.js + Docker | Self-hosted, SSH-required | No | Single-server focus, not edge |
| [CapRover](https://caprover.com) | Node.js | Self-hosted, SSH-required | No | Older, swarm-based |
| **void** (this) | Rust + CF Workers | Edge-driven, no SSH | **Yes (native)** | The only one with this combo |

**Our wedge:** edge-driven control plane (Workers free) + no SSH (cloudflared tunnels) + MCP-native (AI agents are first-class users, not bolted-on). No one else has this combination.

---

## Why these specific choices

### Why Rust for the agent (not Go)

- "void" in Rust is the unit type. Fits the name.
- 8MB RAM resident vs 15-30MB for Go (smaller heap, no GC pauses for tail latency)
- tokio + tokio-tungstenite is the most mature async WS stack
- Single static binary with musl target, no glibc/openssl hell
- The user already mentioned Rust fluency

### Why Cloudflare Workers (not Fly.io, not a VPS)

- Free tier is real and generous (100k req/day, unlimited HTTP duration, R2 cheap)
- Durable Objects solve the "1000 agents connecting to one control plane" problem with built-in WS hibernation
- Wildcard DNS via Worker is one CNAME, no nginx
- Wildcard TLS via CF is automatic
- Global edge = low latency for AI agents worldwide

### Why Railpack (not Nixpacks, not Buildpacks, not Dockerfile)

- Nixpacks is in maintenance mode, Railway recommends Railpack
- Railpack uses BuildKit, no Nix dependency (faster cold start, smaller image)
- Active development (v0.30.0 released Jun 22, 2026, 1k+ commits, 1.1k stars)
- Same auto-detect DX as Nixpacks
- Outputs OCI image, runs anywhere with Docker

### Why cloudflared (not nginx+Caddy+Let's Encrypt, not Tailscale, not Worker-as-proxy)

- Official CF solution, free, maintained
- No inbound ports needed (outbound tunnel)
- Wildcard cert handled by CF automatically
- **Worker is not in the app data path** — if Worker goes down, deployed apps keep serving. Critical for reliability.
- **No Worker CPU/bandwidth cost for app traffic** — a Next.js SSR app at 100 RPS would burn the free tier in hours if proxied through Worker. Through tunnel it's free.
- Streams, WebSockets, large uploads work natively. Worker has limits on all three.
- Can be replaced with native WS-proxying in v0.2 if we want fewer deps, at the cost of putting Worker back in the data path. Decision deferred.

### Why MCP as primary interface (not just REST)

- 2026 is the AI agent era. Cursor, Claude Code, Windsurf, Cline all support MCP.
- An AI agent can `void_deploy` and stream logs in one round-trip
- MCP's Streamable HTTP transport maps perfectly to our SSE log streaming
- Once an AI knows about void, it can deploy, debug, and iterate without the user ever opening a browser
- This is the wedge no competitor has

---

## License

MIT — free to use, modify, fork, self-host. Build your own void.

---

## Appendix A: Why the original SPEC.md was wrong

The first draft of this spec proposed:
- OpenTofu for IaC (overkill — we're not managing complex infra, we're `docker run`-ing one image)
- Go agent polling KV for tasks (added latency, unnecessary — WS push is better)
- D1 + KV for task queue (overcomplicated — DO RPC is enough)
- WAF blocking (premature — users own their VMs, they can firewall themselves)
- 30s long-polling on Workers (impossible — workers CPU limit would kill it)

The void architecture is the v2 of that spec, with the heavy parts cut.

## Appendix A.2: Why the v0.1 routing spec was wrong (and the correction)

An early draft of the Routing Layer claimed that a single wildcard `*.void.example.com` CNAME would catch all app traffic and that no per-app DNS records were needed. **This was wrong.**

Why it doesn't work: cloudflared tunnels are identified by a per-tunnel UUID. The CNAME target for tunnel-routed traffic must be `<tunnel_id>.cfargotunnel.com` — a UUID that's different for every server. A single wildcard CNAME can only point to ONE tunnel UUID, but we have one tunnel per server. So each app needs its own CNAME record pointing to its server's specific tunnel.

The fix (now in the Routing Layer section): the Worker creates per-app CNAMEs via `POST /zones/{id}/dns_records` on every deploy, and deletes them via `DELETE /zones/{id}/dns_records/{id}` on teardown. Two CF API calls per deploy lifecycle. Within the 1,200/5min rate limit, so no concern for self-hosted MVP.

The lesson: CF's tunnel routing model assumes a static 1:1 mapping between DNS records and tunnels. We have a many:many (many apps to many tunnels, changing over time), so we have to manage the DNS records dynamically. Cost: 2 extra CF API calls per deploy. Benefit: the Worker stays out of the app data path.

## Appendix B: What we'd build if we had infinite time

- Rust-native Railpack alternative (no BuildKit dep, smaller images, ~50% faster)
- eBPF-based container isolation (no Docker daemon, much smaller attack surface)
- WASM agent (single binary, runs on macOS/Linux/FreeBSD, 1MB RAM)
- CRDT-based multi-region state sync (deploy from anywhere, replicate globally)
- Native MCP peer discovery (agents find each other, form clusters)
- AI-suggested infrastructure (AI proposes size/region based on app analysis)

None of these are in scope. Build v0.1 first.
