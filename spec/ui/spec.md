# UI Specification

## Purpose

Define the behavior of the void web dashboard — a Cloudflare Worker-rendered UI for managing projects, viewing deployments, and configuring settings.

## Requirements

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

### Requirement: Settings Page
The UI SHALL provide a settings page for managing environment variables and project configuration.

#### Scenario: Manage environment variables
- **GIVEN** a project settings page
- **WHEN** the user adds or updates an environment variable
- **THEN** the UI sends the update to the control plane
- **AND** displays a success confirmation
