/**
 * void Worker — D1 schema migrations (idempotent, run on first request)
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	github_id TEXT UNIQUE,
	username TEXT,
	avatar_url TEXT,
	gh_access_token TEXT,
	onboarding_completed_at INTEGER,
	created_at INTEGER DEFAULT (unixepoch())
);

-- Top-level aggregate. The product calls this a "Project". Projects keeps
-- the storage name unambiguous next to deployable repositories.
CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	slug TEXT NOT NULL,
	is_default INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	UNIQUE(user_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, created_at);

CREATE TABLE IF NOT EXISTS github_connections (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL UNIQUE,
	user_id TEXT NOT NULL,
	github_id TEXT NOT NULL,
	login TEXT NOT NULL,
	avatar_url TEXT,
	encrypted_token TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_github_connections_user ON github_connections(user_id);

CREATE TABLE IF NOT EXISTS servers (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	project_id TEXT NOT NULL,
	name TEXT,
	provider TEXT,
	provider_server_id TEXT,
	ip_address TEXT,
	region TEXT,
	size TEXT,
	cpu INTEGER,
	memory INTEGER,
	disk INTEGER,
	inventory_json TEXT,
	inventory_collected_at INTEGER,
	agent_public_key TEXT,
	setup_token TEXT,
	setup_token_consumed_at INTEGER,
	session_token TEXT,
	session_token_created_at INTEGER,
	tunnel_id TEXT,
	tunnel_name TEXT,
	tunnel_token_encrypted TEXT,
	status TEXT CHECK(status IN ('pending','provisioning','active','offline','failed','destroyed')) DEFAULT 'pending',
	created_at INTEGER DEFAULT (unixepoch()),
	last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS repositories (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	github_connection_id TEXT NOT NULL,
	github_repo_id TEXT NOT NULL,
	slug TEXT,
	name TEXT,
	full_name TEXT NOT NULL,
	private INTEGER NOT NULL DEFAULT 0,
	clone_url TEXT NOT NULL,
	default_branch TEXT DEFAULT 'main',
	default_port INTEGER DEFAULT 3000,
	build_command TEXT,
	serve_command TEXT,
	created_at INTEGER DEFAULT (unixepoch()),
	UNIQUE(project_id, github_repo_id),
	UNIQUE(project_id, slug)
);

CREATE TABLE IF NOT EXISTS deployments (
	id TEXT PRIMARY KEY,
	repository_id TEXT,
	project_id TEXT NOT NULL,
	server_id TEXT,
	ref TEXT,
	commit_sha TEXT,
	image_tag TEXT,
	hostname TEXT,
	public_url TEXT,
	dns_record_id TEXT,
	port INTEGER,
	status TEXT CHECK(status IN ('queued','building','deploying','running','failed','cancelled')) DEFAULT 'queued',
	build_log TEXT,
	error TEXT,
	started_at INTEGER DEFAULT (unixepoch()),
	finished_at INTEGER,
	duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_deployments_repository ON deployments(repository_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_servers_user ON servers(user_id);
CREATE INDEX IF NOT EXISTS idx_servers_project ON servers(project_id);
CREATE INDEX IF NOT EXISTS idx_repositories_project ON repositories(project_id, created_at);

CREATE TABLE IF NOT EXISTS provider_credentials (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	provider TEXT NOT NULL,
	encrypted_token TEXT NOT NULL,
	verified_datacenters INTEGER,
	metadata_json TEXT,
	created_at INTEGER DEFAULT (unixepoch()),
	UNIQUE(project_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_provider_credentials_project ON provider_credentials(project_id);

CREATE TABLE IF NOT EXISTS passkeys (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	credential_id TEXT UNIQUE NOT NULL,
	credential_public_key BLOB NOT NULL,
	counter INTEGER NOT NULL DEFAULT 0,
	transports TEXT,
	name TEXT NOT NULL,
	created_at INTEGER DEFAULT (unixepoch()),
	last_used_at INTEGER,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);
CREATE INDEX IF NOT EXISTS idx_passkeys_credential ON passkeys(credential_id);

-- System settings - operator-managed tokens stored in the panel.
-- Encrypted with ENCRYPTION_KEY at rest. Set/cleared via /settings.
-- Only the OAuth secrets (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET)
-- are set via GitHub Actions at deploy time, everything else is here.
CREATE TABLE IF NOT EXISTS system_settings (
	key TEXT PRIMARY KEY,
	encrypted_value TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
`;

let initialized = false;

export async function ensureSchema(db: D1Database): Promise<void> {
	if (initialized) return;
	const statements = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
	for (const sql of statements) {
		await db.prepare(sql).run();
	}
	initialized = true;
}
