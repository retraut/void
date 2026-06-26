# Control Plane Specification

## Purpose

Define the control plane behavior — a Cloudflare Workers-based API that manages projects, deployments, agents, and provides MCP server capabilities for AI assistants to deploy applications without manual DevOps.

## Requirements

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

### Requirement: Preview URLs
The control plane SHALL generate unique preview URLs for pull request deployments.

#### Scenario: PR preview deployment
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

#### Scenario: Agent disconnect
- **GIVEN** a connected agent
- **WHEN** the WebSocket connection drops
- **THEN** the system marks the agent as offline
- **AND** requeues any in-flight deployments

### Requirement: Secrets Management
The control plane SHALL store and manage encrypted secrets (API keys, database URLs) per environment.

#### Scenario: Store a secret
- **GIVEN** a project with an environment
- **WHEN** a user submits a key-value secret
- **THEN** the system encrypts and stores it in D1
- **AND** the secret is available during builds
