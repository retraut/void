# void test-lab

Local development environment for testing the void-agent end-to-end
without Hetzner, Cloudflare Tunnels, or production D1.

## What you get

```
macOS host
  ├── wrangler dev (localhost:8787)         D1 + DO + agent WS
  ├── OrbStack VM (ubuntu:24.04)            void-agent + docker + systemd
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
  script rendered in `up.sh`

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

## Usage

```bash
# Bring up the lab
scripts/test-lab/up.sh

# Show what was registered
scripts/test-lab/servers.sh

# Trigger a deploy on the registered VM
scripts/test-lab/deploy.sh srv_abc123 https://github.com/retraut/void-examples-hello

# Stream logs for that deployment
scripts/test-lab/logs.sh srv_abc123 <deployment_id>

# Tear it all down
scripts/test-lab/down.sh            # keeps the .test-lab/ dir for next time
scripts/test-lab/down.sh --full     # also removes the scratch dir
```

## When the cloud-init fails

The bootstrap script is intentionally minimal — it assumes:
- Ubuntu 24.04+ with systemd
- A real `void-agent` release at v0.4.0+ on github.com/retraut/void
  (override with `VOID_AGENT_RELEASE_TAG=vX.Y.Z up.sh`)
- Network access from the VM to github.com + github-releases.cloudflare.net

If any of those are missing, `up.sh` will report success (the VM
boots, the cloud-init runs) but the agent never registers. Check
`orb -m void-lab journalctl -u void-agent` and the bootstrap log
at `/var/log/void-bootstrap.log` inside the VM.

## Files

- `lib.sh` — shared helpers (logging, prereqs, wrangler lifecycle, Bearer)
- `up.sh` — full setup (wrangler + register + cloud-init + orb)
- `down.sh` — full teardown (orb + wrangler)
- `servers.sh` — list registered servers
- `deploy.sh` — call `void_deploy` MCP tool
- `logs.sh` — stream logs for a deployment (SSE)

## State on disk

`.test-lab/` (gitignored — added to `.gitignore` by the first
`up.sh` run, but you can do it manually):

```
.test-lab/
├── wrangler.pid          # PID of the wrangler dev process
├── wrangler.log          # wrangler dev stdout/stderr
├── registration.json     # last /api/servers/register response
└── user-data.sh          # cloud-init rendered for the OrbStack VM
```

`down.sh --full` removes the whole dir.
