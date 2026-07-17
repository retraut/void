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
  project_id: string;
  project_name: string | null;
  last_deploy_ref: string | null;
  last_deploy_commit: string | null;
  last_deploy_status: string | null;
  last_deploy_at: number | null;
}

export interface ServerRow {
  id: string;
  user_id: string | null;
  project_id: string;
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
  inventory_collected_at: number | null;
  inventory: ServerInventory | null;
}

export interface ServerInventory {
  hostname: string | null;
  os: string | null;
  kernel: string | null;
  architecture: string | null;
  uptime_seconds: number | null;
  cpu_count: number | null;
  total_memory_mb: number | null;
  disk: {
    total_gb: number;
    used_gb: number;
    used_percent: number;
  } | null;
  network: {
    addresses: string[];
    primary_ipv4: string | null;
    open_ports: Array<{
      protocol: string;
      address: string;
      port: number;
      process: string | null;
    }>;
  } | null;
  firewall: {
    backend: string | null;
    active: boolean;
    summary: string[];
  } | null;
  ssh: {
    port: number;
    password_authentication: boolean | null;
    permit_root_login: string | null;
    users: Array<{
      username: string;
      uid: number;
      shell: string;
      keys: Array<{
        type: string;
        fingerprint: string;
        comment: string;
      }>;
    }>;
  } | null;
  certificates: Array<{
    name: string;
    issuer: string | null;
    expires_at: string | null;
  }>;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  is_default: number;
  created_at: number;
  github_login: string | null;
  github_avatar_url: string | null;
  repository_count: number;
  server_count: number;
  deployment_count: number;
}

export interface GithubConnection {
  id: string;
  github_id: string;
  login: string;
  avatar_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface Repository {
  id: string;
  project_id: string;
  github_repo_id: string;
  slug: string;
  name: string;
  full_name: string;
  private: number;
  clone_url: string;
  default_branch: string;
  default_port: number;
  build_command: string | null;
  serve_command: string | null;
  created_at: number;
  deployment_count: number;
  last_deploy_status: string | null;
  last_deploy_at: number | null;
}

export interface ProjectServer {
  id: string;
  name: string;
  provider: string;
  status: ServerStatus;
  region: string | null;
  size: string | null;
  last_seen_at: number | null;
  ip_address: string | null;
  created_at: number;
  deployment_count: number;
}

export interface ProjectDetail {
  project: Project;
  github_connection: GithubConnection | null;
  hetzner_connection: {
    provider: "hetzner";
    verified_datacenters: number | null;
    created_at: number;
  } | null;
  cloudflare_connection: {
    provider: "cloudflare";
    metadata_json: string | null;
    created_at: number;
  } | null;
  repositories: Repository[];
  servers: ProjectServer[];
}

export interface CloudflareDomain {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  name_servers: string[];
}

export interface GithubRepositoryOption {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  html_url: string;
  default_branch: string;
  description: string | null;
  updated_at: string;
}

export interface ServerCatalog {
  server_types: Array<{
    name: string;
    description: string;
    cores: number;
    memory: number;
    disk: number;
    price_display: string;
    available_locations: string[];
  }>;
  locations: Array<{ name: string; city: string; country: string }>;
  images: Array<{ name: string; description: string; os_version: string | null }>;
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
  repository_id: string | null;
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
  repository_name?: string;
  repository_slug?: string;
  server_name?: string;
}

export interface DashboardData {
  servers: Array<{ id: string; name: string; status: ServerStatus; last_seen_at: number | null }>;
  projects: Array<{ id: string; name: string; slug: string }>;
  deployments_24h: number;
  recent_deployments: Array<{
    id: string;
    ref: string | null;
    status: DeploymentStatus;
    started_at: number;
    project_name: string | null;
    repository_name: string | null;
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
}
