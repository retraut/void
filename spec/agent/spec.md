# Agent Specification

## Purpose

Define the behavior of the Rust agent running on the user's VPS — responsible for building, deploying, and managing Docker containers with zero SSH access via cloudflared tunnels.

## Requirements

### Requirement: WebSocket Control Connection
The agent SHALL maintain a persistent WebSocket connection to the control plane for receiving commands.

#### Scenario: Establish connection
- **GIVEN** a configured agent binary
- **WHEN** the agent starts
- **THEN** it reads the assigned API token from the environment
- **AND** opens a WebSocket to the control plane URL
- **AND** authenticates with the token

#### Scenario: Receive deployment command
- **GIVEN** an active WebSocket connection
- **WHEN** the control plane sends a `deploy` command with a project ID and git ref
- **THEN** the agent clones the repository at the specified ref
- **AND** initiates the build process

### Requirement: Build Applications
The agent SHALL build applications using Railpack or Dockerfile.

#### Scenario: Build with Railpack
- **GIVEN** a cloned repository with no Dockerfile
- **WHEN** the agent runs Railpack
- **THEN** it auto-detects the framework
- **AND** produces a Docker image

#### Scenario: Build with Dockerfile
- **GIVEN** a cloned repository with a Dockerfile
- **WHEN** the agent detects a Dockerfile
- **THEN** it builds the image using `docker build`

### Requirement: Cloudflared Tunnel
The agent SHALL expose deployed applications via cloudflared tunnels without opening firewall ports.

#### Scenario: Create tunnel
- **GIVEN** a running Docker container
- **WHEN** the container is ready to serve traffic
- **THEN** the agent starts a cloudflared tunnel pointing to the container port
- **AND** reports the tunnel URL to the control plane

#### Scenario: Tunnel health check
- **GIVEN** an active cloudflared tunnel
- **WHEN** the tunnel connection drops
- **THEN** the agent restarts the tunnel
- **AND** notifies the control plane of the new URL

### Requirement: Resource Reporting
The agent SHALL report system resource usage (CPU, memory, disk) to the control plane periodically.

#### Scenario: Report metrics
- **GIVEN** a running agent
- **WHEN** 60 seconds have passed since the last report
- **THEN** the agent collects CPU, memory, and disk metrics
- **AND** sends them over the WebSocket connection
