# Test Lab Specification

**Status:** Current developer-environment contract.

**Runbook:** [`../../scripts/test-lab/README.md`](../../scripts/test-lab/README.md)

## Purpose

Define the local test lab environment for developing and testing the void agent against the control plane without external infrastructure (Hetzner, Cloudflare tunnels, production D1).

## Architecture

```
macOS host
  ├── wrangler dev (localhost:8787)
  │     ├── D1 local (SQLite)
  │     ├── Durable Object VoidCell
  │     ├── HTTP API + UI + MCP
  │     └── agent WebSocket endpoint
  │
  ├── OrbStack VM (ubuntu:noble + systemd)
  │     ├── void-agent binary
  │     ├── docker.io (daemon)
  │     ├── git, build-essential
  │     ├── cloudflared (optional)
  │     └── /etc/void/config.toml
  │
  └── Test Runner
        └── MCP client / curl / script
```

## Requirements

### Requirement: Self-Contained Environment

The test lab SHALL run entirely on the developer's machine with no external dependencies.

#### Scenario: Start lab
- **GIVEN** a macOS machine with OrbStack, Docker, Node.js, Rust
- **WHEN** `scripts/test-lab/up.sh` is run
- **THEN** `wrangler dev` starts on localhost:8787
- **AND** an OrbStack VM (ubuntu:noble) is created
- **AND** the void agent is compiled and copied to the VM
- **AND** the agent registers with the local control plane

#### Scenario: Stop lab
- **GIVEN** a running test lab
- **WHEN** `scripts/test-lab/down.sh` is run
- **THEN** the OrbStack VM is deleted
- **AND** `wrangler dev` is stopped
- **AND** local D1 state is cleaned up

### Requirement: Agent Registration

The test lab SHALL use the same generic `POST /api/servers/register` endpoint as production.

#### Scenario: Register via API
- **GIVEN** `wrangler dev` is running
- **WHEN** the setup script calls `POST /api/servers/register` with Bearer token
- **THEN** it receives `{ server_id, setup_token, api_base }`
- **AND** writes `/etc/void/config.toml` on the VM with these values
- **AND** starts `void-agent` as a systemd service
- **AND** the agent connects via WebSocket and sends `register`
- **AND** the server appears in `GET /api/servers` with status `active`

### Requirement: Test Scenarios

The test lab SHALL support running predefined test scenarios against the agent.

#### Scenario: Deploy a static site
- **GIVEN** a registered agent
- **WHEN** `void_deploy` MCP tool is called with a simple static repo
- **THEN** the agent clones the repo
- **AND** runs the build command
- **AND** starts the serve process
- **AND** health check passes
- **AND** `deploy_done` is sent with status `success`
- **AND** logs are streamed via SSE

#### Scenario: Deploy failure
- **GIVEN** a registered agent
- **WHEN** `void_deploy` is called with an invalid repo URL
- **THEN** `git clone` fails
- **AND** `deploy_done` is sent with status `failed`
- **AND** error message contains the failure reason

#### Scenario: Agent reconnect
- **GIVEN** a registered agent
- **WHEN** the WebSocket disconnects (control plane restarts)
- **THEN** the agent reconnects with `session_token`
- **AND** resumes normal operation without re-registration

#### Scenario: Shutdown
- **GIVEN** a registered agent
- **WHEN** `shutdown` frame is sent
- **THEN** the agent calls `exit(0)`
- **AND** the server appears offline

### Requirement: Tools

The test lab SHALL provide CLI tools for common operations.

#### Scenario: List servers
- **GIVEN** running `wrangler dev`
- **WHEN** `scripts/test-lab/servers.sh` is run
- **THEN** it calls `GET /api/servers` and formats the output

#### Scenario: Deploy
- **GIVEN** a registered agent
- **WHEN** `scripts/test-lab/deploy.sh <server_id> <repo_url>` is run
- **THEN** it calls `void_deploy` MCP tool and streams logs until completion

#### Scenario: Tail logs
- **GIVEN** an active deployment
- **WHEN** `scripts/test-lab/logs.sh <server_id> <deployment_id>` is run
- **THEN** it subscribes to SSE and prints log lines in real-time
