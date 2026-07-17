# CLI Specification

**Status:** Planned — no CLI package is currently present.

**Architecture:** [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)

## Purpose

Define behavior of the `void` command-line interface — used for project setup, deployment management, and AI assistant integration.

## Requirements

### Requirement: Init Command
The CLI SHALL provide an `init` command to set up a new void project.

#### Scenario: Initialize project
- **GIVEN** a user in a git repository
- **WHEN** they run `void init`
- **THEN** the CLI prompts for a project name and GitHub repo
- **AND** creates the necessary configuration files

### Requirement: Deploy Command
The CLI SHALL provide a `deploy` command to trigger manual deployments.

#### Scenario: Manual deploy
- **GIVEN** a configured void project
- **WHEN** the user runs `void deploy`
- **THEN** the CLI sends a deploy request to the control plane API
- **AND** displays the deployment status

### Requirement: Logs Command
The CLI SHALL provide a `logs` command to view real-time deployment logs.

#### Scenario: Stream logs
- **GIVEN** a deployment in progress
- **WHEN** the user runs `void logs <deployment-id>`
- **THEN** the CLI connects to the log stream
- **AND** displays log lines in real time
