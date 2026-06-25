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
	setup_token TEXT,
	setup_token_consumed_at INTEGER,
	session_token TEXT,
	session_token_created_at INTEGER,
	tunnel_id TEXT,
	tunnel_name TEXT,
	tunnel_token_encrypted TEXT,
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
	build_command TEXT,
	serve_command TEXT,
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

CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_servers_user ON servers(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
`;

// Idempotent column additions (for migrating existing tables created by an older schema).
// SQLite doesn't support IF NOT EXISTS on ALTER TABLE ADD COLUMN, so we catch the error.
const COLUMN_MIGRATIONS: Array<{ table: string; column: string; type: string }> = [
	{ table: "servers", column: "tunnel_id", type: "TEXT" },
	{ table: "servers", column: "tunnel_name", type: "TEXT" },
	{ table: "servers", column: "tunnel_token", type: "TEXT" },
	{ table: "servers", column: "setup_token", type: "TEXT" },
	{ table: "servers", column: "setup_token_consumed_at", type: "INTEGER" },
	{ table: "servers", column: "session_token", type: "TEXT" },
	{ table: "servers", column: "session_token_created_at", type: "INTEGER" },
	{ table: "servers", column: "tunnel_token_encrypted", type: "TEXT" },
	{ table: "projects", column: "build_command", type: "TEXT" },
	{ table: "projects", column: "serve_command", type: "TEXT" },
	{ table: "deployments", column: "hostname", type: "TEXT" },
	{ table: "deployments", column: "public_url", type: "TEXT" },
	{ table: "deployments", column: "dns_record_id", type: "TEXT" },
	{ table: "deployments", column: "port", type: "INTEGER" },
];

let migrated = false;

export async function ensureSchema(db: D1Database): Promise<void> {
	if (migrated) return;
	const statements = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
	for (const sql of statements) {
		await db.prepare(sql).run();
	}
	for (const m of COLUMN_MIGRATIONS) {
		try {
			await db.prepare(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.type}`).run();
		} catch (e: any) {
			// "duplicate column name" is fine — means it already exists
			if (!String(e?.message || e).includes("duplicate column")) {
				// re-throw if it's a different error
				throw e;
			}
		}
	}
	migrated = true;
}
