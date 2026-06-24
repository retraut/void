# void

**Vercel DX. Hetzner bill. No SSH.**

Self-hosted, edge-driven PaaS with MCP-native AI deploys. Push to git → live URL. Your AI calls `void_deploy` from Cursor. No SSH, no dashboard, no DevOps.

## What is this?

void is the **convenient self-hosted alternative to Vercel** for the AI coding era. It's a Cloudflare Worker (control plane) + a Rust agent (runs on your Hetzner/DO VPS) + cloudflared tunnels (no open ports). Git push auto-deploys, MCP tools let your AI deploy, preview URLs are automatic per PR.

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
┌─────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│  AI Assistant   │     │  Control Plane        │     │  Your VM              │
│  (Cursor/Claude)│────▶│  Cloudflare Workers   │────▶│  Hetzner/DO VPS       │
│                 │     │  + Hono + D1          │     │  Rust agent           │
│                 │     │  + KV + R2            │     │  + Docker             │
└─────────────────┘     │  + Durable Objects    │     │  + Railpack builds    │
                        │  + MCP server         │     │  + cloudflared tunnel │
                        └──────────────────────┘     └──────────────────────┘
```

- **Control plane** runs on Cloudflare Workers (free tier up to ~1000 active users)
- **Agent** is a Rust binary (~8MB RAM) running on your VPS
- **App traffic** flows User → CF edge → cloudflared tunnel → Docker container (no Worker in data path)
- **Worker is not in app data path** — if Worker goes down, deployed apps keep serving

## Status

🚧 **v0.1 in development.** See [SPEC.md](docs/SPEC.md) for the full technical specification.

Current focus: GitHub App auto-deploy, MCP server, first-run wizard, cloudflared tunnel setup.

## License

MIT — see [LICENSE](LICENSE).

## Links

- [Full spec](docs/SPEC.md)
- [Why void exists](docs/SPEC.md#why-void-exists)
- [v0.1 launch criteria](docs/SPEC.md#mvp-scope-v01--launch-ready)
