# Control Plane Specification

**Status:** Mixed — generic registration, MCP dispatch, webhook dispatch, and
session-backed read APIs exist; preview comments, disconnect requeue, and some
project-management behavior below remain target behavior.

**Architecture:** [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)

## Purpose

Define the control plane behavior — a Cloudflare Workers-based API that manages projects, deployments, agents, and provides MCP server capabilities for AI assistants to deploy applications without manual DevOps.

## Requirements

### Requirement: Project Aggregate
The control plane SHALL use Project as the ownership boundary for connected
accounts, repositories, servers, and deployments.

#### Scenario: Bootstrap default project
- **GIVEN** an authenticated user with no Project
- **WHEN** the panel loads
- **THEN** the system creates one `Default Project`

#### Scenario: Deploy within project boundary
- **GIVEN** a repository and an active server in the same Project
- **WHEN** the user deploys the repository to that server
- **THEN** the deployment records both Project and repository ownership
- **AND** a server from another Project is rejected

#### Scenario: Connect project accounts and providers
- **GIVEN** a Project
- **WHEN** the user connects GitHub, Hetzner, or Cloudflare credentials
- **THEN** credentials are verified, encrypted, and scoped to that Project
- **AND** GitHub, Hetzner, and Cloudflare can be connected independently

### Requirement: Project Management
The control plane SHALL allow users to create, list, and manage projects linked to GitHub repositories.

#### Scenario: Create project from GitHub repo
- **GIVEN** a user with a valid GitHub installation
- **WHEN** they request to create a project with a repository URL
- **THEN** the system registers the project in D1
- **AND** returns a unique project ID and subdomain

#### Scenario: List user projects
- **GIVEN** a user with existing projects
- **WHEN** they request a project list
- **THEN** the system returns all projects with their status and deployment URLs

### Requirement: Deployment Trigger
The control plane SHALL trigger deployments via git push webhooks and MCP tool calls.

#### Scenario: Deploy on git push
- **GIVEN** a project with a linked repository
- **WHEN** a git push webhook is received
- **THEN** the system creates a deployment record in D1
- **AND** signals the agent to start the deployment process

#### Scenario: Deploy via MCP tool
- **GIVEN** an AI assistant with MCP access
- **WHEN** the assistant calls `void_deploy` with a project ID
- **THEN** the system validates the request
- **AND** queues a new deployment

### Requirement: Preview URLs (Target)
The control plane SHALL generate unique preview URLs for pull request deployments.

#### Scenario: PR preview deployment (Target)
- **GIVEN** a pull request is opened against a linked repository
- **WHEN** the agent completes a preview build
- **THEN** the system registers a preview URL at `<branch>.<project>.workers.dev`
- **AND** posts the URL as a PR comment

### Requirement: Agent Registration
The control plane SHALL maintain persistent WebSocket connections to agents running on user VPS instances.

#### Scenario: Agent connects
- **GIVEN** a running agent on a VPS
- **WHEN** the agent establishes a WebSocket connection
- **THEN** the system authenticates the agent via API token
- **AND** registers it as available for deployments

#### Scenario: Agent disconnect (Target)
- **GIVEN** a connected agent
- **WHEN** the WebSocket connection drops
- **THEN** the system marks the agent as offline
- **AND** requeues any in-flight deployments

### Requirement: Generic Server Registration
The control plane SHALL provide a provider-agnostic registration endpoint that creates a server record with a one-time setup token. All providers (Hetzner, Scaleway, DigitalOcean, manual) use the same endpoint — the provider-specific part is only about how the VM gets provisioned with the agent.

#### Scenario: Register a server (generic)
- **GIVEN** a user requesting to add a server
- **WHEN** they call `POST /api/servers/register`
- **THEN** the system generates `server_id` (srv_xxx) and `setup_token` (set_xxx)
- **AND** inserts a row in D1 with status `pending`
- **AND** returns `{ server_id, setup_token, api_base, config_toml }`

#### Scenario: Hetzner provisions via cloud-init
- **GIVEN** a D1 server record with `setup_token`
- **WHEN** the Hetzner provider script is invoked
- **THEN** it builds cloud-init containing the `server_id` and `setup_token`
- **AND** calls the Hetzner API to create a VM
- **AND** the agent on the VM auto-registers via WebSocket

#### Scenario: Manual provisioning (OrbStack, any Linux)
- **GIVEN** a D1 server record with `setup_token`
- **WHEN** a user provisions a VM manually
- **THEN** they write the config (including `setup_token`) to `/etc/void/config.toml`
- **AND** start the agent — it connects and registers via WebSocket

#### Scenario: Provider scripts are decoupled
- **GIVEN** the `POST /api/servers/register` endpoint
- **WHEN** a new provider (Scaleway, DO, etc.) needs to be added
- **THEN** only a new provider script is written (calls register + creates VM)
- **AND** no control plane changes are needed — the registration flow is identical

### Requirement: Test Lab Environment
The control plane SHALL support a fully local development environment for testing agent scenarios without external infrastructure.

#### Scenario: Local dev with OrbStack
- **GIVEN** a developer machine with OrbStack and Docker
- **WHEN** `wrangler dev` is running locally
- **THEN** an OrbStack VM (ubuntu:noble) connects to the local control plane
- **AND** registers via the generic endpoint
- **AND** receives `deploy` commands, executes them, reports back
- **AND** all state is in local D1 (SQLite), no external dependencies

#### Scenario: Cleanup
- **GIVEN** a test lab VM
- **WHEN** the test session ends
- **THEN** the VM is destroyed via `orb delete`
- **AND** the D1 row is cleaned up or marked as destroyed
