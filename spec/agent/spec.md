# Agent Specification

**Status:** Current

**Architecture:** [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)

**Wire contract:** [`../../docs/PROTOCOL.md`](../../docs/PROTOCOL.md)

## Purpose

Define the behavior of the Rust agent running on the user's VPS. The agent is a
thin executor: the control plane sends an ordered pipeline and the agent runs it,
streams logs, reports completion, and reconnects when transport is interrupted.
Build-system, container, and tunnel policy belong to the control plane pipeline.

## Requirements

### Requirement: WebSocket Control Connection
The agent SHALL maintain a persistent WebSocket connection to the control plane for receiving commands.

#### Scenario: Establish connection
- **GIVEN** a configured agent binary
- **WHEN** the agent starts
- **THEN** it loads `server_id`, `api_base`, local identity, and bootstrap/session credentials
- **AND** opens a WebSocket to the control plane URL
- **AND** authenticates in the first `register` frame
- **AND** starts heartbeat transmission only after `registered`

#### Scenario: Receive deployment command
- **GIVEN** an active WebSocket connection
- **WHEN** the control plane sends a valid `pipeline` frame
- **THEN** the agent verifies the signature when a shared secret is configured
- **AND** executes the ordered steps in a per-deployment working directory
- **AND** stops at the first failed or timed-out step

### Requirement: Pipeline Execution
The agent SHALL execute policy-free pipeline steps supplied by the control plane.

#### Scenario: Execute a pipeline
- **GIVEN** a registered agent and a validated pipeline
- **WHEN** execution starts
- **THEN** steps run sequentially through the local shell
- **AND** stdout/stderr are streamed as protocol log frames
- **AND** local JSONL logs are appended for the deployment
- **AND** the agent sends one terminal `deploy_done` frame

#### Scenario: Reject an invalid command signature
- **GIVEN** `agent_shared_secret` is configured
- **WHEN** a pipeline has no signature or an invalid signature
- **THEN** the agent does not execute any step

### Requirement: Reconnection
The agent SHALL recover its control connection without re-bootstrap.

#### Scenario: Reconnect with a session token
- **GIVEN** a previously registered agent
- **WHEN** the WebSocket closes
- **THEN** the agent retries with exponential backoff capped at 60 seconds
- **AND** authenticates with its persisted `session_token`
- **AND** persists a signed token rotation received on the open connection

### Requirement: Resource Reporting
The agent SHALL report supported system resource usage to the control plane periodically.

#### Scenario: Report metrics
- **GIVEN** a running agent
- **WHEN** the five-second heartbeat interval elapses
- **THEN** the agent collects CPU, memory, load average, core count, and pressure tier where supported
- **AND** sends them over the WebSocket connection
