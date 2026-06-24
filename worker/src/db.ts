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

CREATE TABLE IF NOT EXISTS servers (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	name TEXT,
	provider TEXT,
	provider_server_id TEXT,
	ip_address TEXT,
	region TEXT,
	size TEXT,
	agent_public_key TEXT,
	tunnel_id TEXT,
	status TEXT CHECK(status IN ('provisioning','active','offline','failed','destroyed')) DEFAULT 'provisioning',
	created_at INTEGER DEFAULT (unixepoch()),
	last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	server_id TEXT,
	slug TEXT,
	name TEXT,
	repo_url TEXT,
	default_branch TEXT DEFAULT 'main',
	default_port INTEGER DEFAULT 3000,
	created_at INTEGER DEFAULT (unixepoch()),
	UNIQUE(user_id, slug)
);

CREATE TABLE IF NOT EXISTS deployments (
	id TEXT PRIMARY KEY,
	project_id TEXT,
	server_id TEXT,
	ref TEXT,
	commit_sha TEXT,
	image_tag TEXT,
	hostname TEXT,
	dns_record_id TEXT,
	status TEXT CHECK(status IN ('queued','building','deploying','running','failed','cancelled')) DEFAULT 'queued',
	build_log TEXT,
	error TEXT,
	started_at INTEGER DEFAULT (unixepoch()),
	finished_at INTEGER,
	duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_servers_user ON servers(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
`;

let migrated = false;

export async function ensureSchema(db: D1Database): Promise<void> {
	if (migrated) return;
	const statements = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
	for (const sql of statements) {
		await db.prepare(sql).run();
	}
	migrated = true;
}
