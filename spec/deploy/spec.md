# Deployment Specification

**Status:** Target — the current runtime dispatches ordered shell pipelines and
records status, but does not yet provide the general blue-green, health-check,
rollback, durable queue, or seven-day log-retention behavior specified below.

**Current flow:** [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md#2-deployment-dispatch)

## Purpose

Define the deployment lifecycle — how code moves from git push to live URL, including build, deploy, health checks, rollback, and cleanup.

## Requirements

### Requirement: Git-Based Deployments
The system SHALL deploy applications automatically when code is pushed to the default branch.

#### Scenario: Production deploy
- **GIVEN** a push to the `main` or `master` branch
- **WHEN** the webhook is received
- **THEN** the system validates the project exists
- **AND** creates a production deployment
- **AND** assigns a version tag

#### Scenario: Deploy status notifications
- **GIVEN** an active deployment
- **WHEN** the deployment status changes
- **THEN** the control plane sends a status update via WebSocket
- **AND** the agent logs the status locally

### Requirement: Zero-Downtime Deployments
The system SHALL perform zero-downtime deployments by running new containers alongside old ones.

#### Scenario: Blue-green deploy
- **GIVEN** a running application container
- **WHEN** a new deployment is ready
- **THEN** the agent starts a new container
- **AND** waits for the health check to pass
- **THEN** switches the tunnel to the new container
- **AND** stops the old container

### Requirement: Rollback
The system SHALL support rolling back to a previous deployment version.

#### Scenario: Rollback to version
- **GIVEN** a list of previous deployments
- **WHEN** a user or AI requests a rollback to a specific version
- **THEN** the agent pulls the previous Docker image
- **AND** redeploys it following the zero-downtime procedure

### Requirement: Deployment Logs
The system SHALL stream build and runtime logs to the control plane for real-time viewing.

#### Scenario: Build log streaming
- **GIVEN** an active build
- **WHEN** the build produces log output
- **THEN** the agent streams log lines over the WebSocket
- **AND** the control plane stores them in D1 with a TTL of 7 days
