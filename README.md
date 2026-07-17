# void

**Best-in-class DX. Hetzner pricing. No SSH.**

Self-hosted, edge-driven PaaS with MCP-native AI deploys. Push to git → live URL. Your AI calls `void_deploy` via MCP. No SSH, no dashboard, no DevOps.

## What is this?

void is a self-hosted, edge-driven PaaS for the AI coding era. It's a Cloudflare Worker (control plane) + a Rust agent (runs on your Hetzner/DO VPS) + cloudflared tunnels (no open ports). Git push auto-deploys, MCP tools let your AI deploy, preview URLs are automatic per PR.

Zero DevOps. Zero CI. Zero lock-in. Zero idle cost. Zero friction.

## Quick start

**For users** (one-click install — coming in v0.1):

1. Click the "Deploy to Cloudflare" button below
2. Walk through the 7-step setup wizard (GitHub → cloud provider → CF API token)
3. Click "New Project" → pick a repo → deploy
4. Your app is live at `my-app.<your-subdomain>.workers.dev`

**For developers** (clone and modify):

```bash
git clone https://github.com/retraut/void
cd void
pnpm install
pnpm --filter @void/worker dev
```

## Architecture

```
┌─────────────────┐     ┌────────────────────────┐     ┌──────────────────────┐
│ Browser / MCP / │────▶│ Cloudflare Worker      │────▶│ User-owned VM        │
│ GitHub webhook  │     │ Hono + D1 + KV         │ WS  │ Rust agent           │
└─────────────────┘     │ + per-server VoidCell  │     │ thin step executor   │
                        └────────────────────────┘     └──────────┬───────────┘
                                                               │ local port
User request ─────────▶ Cloudflare edge ─────▶ tunnel ──────────┘
```

- **Control plane** owns authentication, product state, orchestration, and routing configuration
- **VoidCell** owns the ephemeral connection, recent metrics, and log fan-out for one server
- **Agent** is a Rust binary that validates and executes ordered steps on your VPS
- **App traffic** flows User → CF edge → cloudflared tunnel → application process (no Worker in data path)
- **Worker is not in app data path** — if Worker goes down, deployed apps keep serving

See [Current architecture](docs/ARCHITECTURE.md) for component ownership,
state boundaries, failure modes, and known gaps.

## Status

🚧 **v0.1 in development.** See the [documentation map](docs/README.md) and
[current architecture](docs/ARCHITECTURE.md) for implementation-oriented docs.

Current focus: GitHub App auto-deploy, MCP server, first-run wizard, cloudflared tunnel setup.

## License

MIT — see [LICENSE](LICENSE).

## Links

- [Documentation map](docs/README.md)
- [Current architecture](docs/ARCHITECTURE.md)
- [Historical product/target spec](docs/SPEC.md)
- [Agent protocol](docs/PROTOCOL.md)
- [Why void exists](docs/SPEC.md#why-void-exists)
- [v0.1 launch criteria](docs/SPEC.md#mvp-scope-v01--launch-ready)
