# UI Specification

**Status:** Mixed — the React SPA and session-backed read views exist; project
creation and environment-variable management requirements remain target behavior.

**Architecture:** [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)

## Purpose

Define the behavior of the React SPA served as Worker static assets. The SPA uses
session-backed JSON APIs for projects, deployments, servers, and settings.

## Requirements

### Requirement: Project Context
The UI SHALL separate global Project management from navigation inside one
active Project.

#### Scenario: Enter project
- **GIVEN** a user with multiple Projects
- **WHEN** they choose a Project from the global Projects page
- **THEN** the sidebar changes to Project navigation
- **AND** exposes Overview, Providers, Domains, Servers, Repositories, and Deployments
- **AND** provides an `All projects` back action

### Requirement: Project Setup
The Project page SHALL unlock resources by capability: GitHub enables
repositories, Hetzner enables servers, and Cloudflare enables domains.

### Requirement: Project Dashboard
The UI SHALL display a dashboard with all user projects and their deployment status.

#### Scenario: View projects
- **GIVEN** an authenticated user
- **WHEN** they visit the dashboard
- **THEN** the UI fetches project list from the control plane API
- **AND** displays project name, status, and last deployment time
- **AND** shows a "New Project" button

### Requirement: Deployment Timeline
The UI SHALL show a chronological timeline of deployments for each project.

#### Scenario: View deployment history
- **GIVEN** a selected project
- **WHEN** the user navigates to the deployments view
- **THEN** the UI displays a list of past deployments
- **AND** each entry shows version, status, duration, and timestamp

### Requirement: Settings Page (Target)
The UI SHALL provide a settings page for managing environment variables and project configuration.

#### Scenario: Manage environment variables (Target)
- **GIVEN** a project settings page
- **WHEN** the user adds or updates an environment variable
- **THEN** the UI sends the update to the control plane
- **AND** displays a success confirmation
