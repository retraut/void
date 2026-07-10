export type ServerStatus =
  | "pending"
  | "provisioning"
  | "active"
  | "offline"
  | "failed"
  | "destroyed";

export interface Metrics {
  cpu_percent: number;
  memory_mb: number;
  memory_percent: number;
  load_avg: [number, number, number] | null;
  cpu_count: number | null;
  pressure_tier: "light" | "medium" | "high" | "extra-high" | null;
}

export interface ServerSummary {
  id: string;
  name: string;
  provider: string;
  status: ServerStatus;
  region: string | null;
  size: string | null;
  last_seen_at: number | null;
  has_tunnel: number;
  deployment_count: number;
  hetzner_project_name: string | null;
  provider_server_id: string | null;
  ip_address: string | null;
  created_at: number;
  project_repo_url: string | null;
  last_deploy_ref: string | null;
  last_deploy_commit: string | null;
  last_deploy_status: string | null;
  last_deploy_at: number | null;
}

export interface ServerRow {
  id: string;
  user_id: string | null;
  name: string;
  provider: string | null;
  provider_server_id: string | null;
  ip_address: string | null;
  region: string | null;
  size: string | null;
  agent_public_key: string | null;
  setup_token: string | null;
  setup_token_consumed_at: number | null;
  session_token: string | null;
  session_token_created_at: number | null;
  tunnel_id: string | null;
  tunnel_name: string | null;
  tunnel_token: string | null;
  status: ServerStatus;
  created_at: number;
  last_seen_at: number | null;
  hetzner_project_id: number | null;
  hetzner_project_name: string | null;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  repo_url: string | null;
  default_branch: string;
  default_port: number;
  build_command: string | null;
  serve_command: string | null;
  server_id: string | null;
  server_name: string | null;
  server_status: string | null;
  deployment_count: number;
}

export type DeploymentStatus =
  | "queued"
  | "building"
  | "deploying"
  | "running"
  | "failed"
  | "cancelled";

export interface Deployment {
  id: string;
  project_id: string | null;
  server_id: string | null;
  ref: string | null;
  commit_sha: string | null;
  image_tag: string | null;
  hostname: string | null;
  public_url: string | null;
  dns_record_id: string | null;
  port: number | null;
  status: DeploymentStatus;
  build_log: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  // joined
  project_name?: string;
  project_slug?: string;
  server_name?: string;
}

export interface DashboardData {
  servers: Array<{ id: string; name: string; status: ServerStatus; last_seen_at: number | null }>;
  projects: Array<{ id: string; name: string; slug: string; repo_url: string | null }>;
  deployments_24h: number;
  recent_deployments: Array<{
    id: string;
    ref: string | null;
    status: DeploymentStatus;
    started_at: number;
    project_name: string | null;
  }>;
}

export interface SessionUser {
  id: string;
  username: string;
  avatar_url: string | null;
}

export interface LogEntry {
  deployment_id: string;
  stream: "stdout" | "stderr" | "status";
  data: string;
  ts: number;
}

export interface SettingsData {
  user: {
    id: string;
    username: string;
    avatar_url: string | null;
    github_id: string;
    created_at: number;
  } | null;
  hetzner_cred: {
    provider: string;
    created_at: number;
    verified_datacenters: number | null;
  } | null;
  passkeys: Array<{
    id: string;
    name: string;
    created_at: number;
    last_used_at: number | null;
  }>;
  system_keys: Array<{
    key: string;
    label: string;
    description: string;
    envVar: string;
    placeholder: string;
    textarea?: boolean;
    warning?: string;
  }>;
  overridden: string[];
  env_has_hetzner_token: boolean;
}
