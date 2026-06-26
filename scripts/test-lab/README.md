# void test-lab

Local development environment for testing the void-agent end-to-end
without Hetzner, Cloudflare Tunnels, or production D1.

## Two-phase model

The test-lab has two pieces of state, each with its own lifecycle:

1. **Dev environment** (fast, idempotent — `up.sh` / `down.sh`)
   - wrangler dev (CF Worker on `localhost:8787`)
   - D1 binding (local SQLite)
   - The Bearer token + D1 user needed to talk to `/api/*`

2. **Agent VM** (heavy, kept around — `agent-vm.sh`)
   - OrbStack VM (ubuntu:26.04) running the void-agent
   - Takes ~2 minutes to create (orb's hardcoded 30s "didn't start"
     check always fires; we poll for up to 5 min)
   - **Stays running between dev sessions.** Bring the dev env
     up/down as much as you want; the VM is reusable.

This split means you can `down.sh` to free your CPU and `up.sh`
to resume hacking in seconds, without waiting 2 min for a fresh
VM every time.

## What you get

```
macOS host
  ├── wrangler dev (localhost:8787)         D1 + DO + agent WS
  ├── OrbStack VM (ubuntu:26.04, amd64)     void-agent + docker + systemd
  └── Test Runner                            scripts/test-lab/{deploy,logs,servers}.sh
```

The same `POST /api/servers/register` endpoint used in production
issues a one-time setup_token. Both the Hetzner one-click flow and
the manual flow (test-lab) end up at the same D1 row, the same WS
handshake, the same `session_token` rotation. The only difference
is *where* the setup_token is delivered:

- **Hetzner path**: embedded in cloud-init by the control plane
- **Test-lab path**: returned in the API response, written to
  `/etc/void/config.toml` on the OrbStack VM by the cloud-init
  script rendered in `agent-vm.sh create`

## Prerequisites

```bash
brew install orbstack jq
# docker (for any container-based test scenarios)
# rust (cargo) — installed by rustup if not present
# node + pnpm — for wrangler and the worker
```

The Bearer token used by the test-lab scripts is read from
`worker/.dev.vars` (look for `VOID_BEARER_TOKEN`). Set it there
once and the scripts pick it up automatically.

For the panel UI (logging in without GitHub OAuth), also set:

```
VOID_DEV_AUTH = "1"
```

This exposes a "Continue as lab (test-lab, no GitHub)" button on
the landing page. The dev-login route (`POST /api/auth/dev-login`)
is a `404` by default — only enabled when this env is set. NEVER
set it in production: it lets anyone reach the worker log in as
any user.

## First-time setup

```bash
# 1. Seed D1 with a 'lab' user (one-time)
scripts/test-lab/provision.sh

# 2. Create the OrbStack VM (~2 min)
scripts/test-lab/agent-vm.sh create

# 3. Bring up the dev env
scripts/test-lab/up.sh
```

## Daily workflow

```bash
# Already created the VM once. Just bring the dev env up:
scripts/test-lab/up.sh

# Work — poke the worker, watch the agent, deploy, etc.
scripts/test-lab/servers.sh
scripts/test-lab/deploy.sh srv_abc123 https://github.com/retraut/void-examples-hello
scripts/test-lab/logs.sh srv_abc123 <deployment_id>

# Stop the dev env (keeps the VM):
scripts/test-lab/down.sh

# Resume (registration is preserved, agent reconnects with session_token):
scripts/test-lab/up.sh

# When you're done with the lab (rarely):
scripts/test-lab/down.sh
scripts/test-lab/agent-vm.sh destroy --purge
```

## Commands

| Command | What |
|---|---|
| `provision.sh` | Seed D1 with `usr_lab` user (idempotent) |
| `agent-vm.sh status` | Show VM name, state, IP |
| `agent-vm.sh create` | Create VM + apply cloud-init (≈2 min) |
| `agent-vm.sh destroy` | Stop VM, keep on disk |
| `agent-vm.sh destroy --purge` | Delete VM (image gone) |
| `agent-vm.sh ssh` | SSH into the VM |
| `agent-vm.sh ip` | Print the VM's IP |
| `up.sh` | Start wrangler dev + verify VM + register (idempotent) |
| `down.sh` | Stop wrangler dev (VM kept) |
| `down.sh --full` | Stop wrangler dev + remove scratch dir |
| `servers.sh` | List registered servers |
| `deploy.sh <srv_id> <repo_url> [ref] [build] [serve] [port]` | Trigger deploy |
| `logs.sh <srv_id> <deployment_id>` | Tail deployment logs (SSE) |

### Note: api_base

The control plane derives `api_base` from the request URL when `POST /api/servers/register` is called, which gives `wss://127.0.0.1:8787`. From inside the VM that's the VM itself, not the host. `up.sh` automatically rewrites it to the host's OrbStack-bridge IP (the VM's default route gateway) so the agent can actually reach wrangler dev. Manual runs of the bootstrap script need to do the same rewrite.

## When something's wrong

| Symptom | First check |
|---|---|
| `provision.sh` says "user not created" | `cat .test-lab/wrangler.log` for wrangler dev startup errors |
| `agent-vm.sh create` times out at 5 min | `cat .test-lab/orb-create.log` for orb's error output |
| `up.sh` says "agent VM not running" | `scripts/test-lab/agent-vm.sh status` — start with `agent-vm.sh create` |
| Agent shows `pending` in `servers.sh` | `orb -m void-lab journalctl -u void-agent -f` inside the VM |
| `api/servers/register` returns 412 | You forgot `provision.sh` — D1 has no user yet |
| `deploy.sh` returns no deployment_id | Check `servers.sh` to confirm the server is `active` (not `pending`) |

## State on disk

`.test-lab/` (gitignored):

```
.test-lab/
├── wrangler.pid          # PID of the wrangler dev process
├── wrangler.log          # wrangler dev stdout/stderr
├── registration.json     # last /api/servers/register response
├── user-data.sh          # cloud-init rendered for the OrbStack VM
└── orb-create.log        # output of `orb create` (debugging)
```

`agent-vm.sh destroy --purge` removes the VM.
`down.sh --full` removes the whole `.test-lab/` dir.
