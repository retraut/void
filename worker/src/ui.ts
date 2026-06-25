/**
 * void Worker — Web UI pages
 *
 * Server-rendered HTML using template literals (no SPA, no build step).
 * xterm.js loaded from CDN for the log viewer.
 */

import { Env } from "./env";

/**
 * User dropdown menu — click avatar to expand. Pure HTML, no JS.
 * Used in both the landing page and the UI topbar.
 */
function userMenu(user: { username: string; avatar_url: string | null }): string {
	return `<details class="user-menu">
		<summary>
			<img src="${escape(user.avatar_url || "")}" alt="" width="24" height="24">
			<span>@${escape(user.username)}</span>
		</summary>
		<div class="user-menu-pop">
			<a href="/servers">Servers</a>
			<a href="/projects">Projects</a>
			<a href="/deployments">Deployments</a>
			<hr>
			<a href="/api/auth/logout">logout</a>
		</div>
	</details>`;
}

/**
 * Sidebar nav item with inline SVG icon. Lucide-style stroke icons.
 * Icons use currentColor so they inherit text color (active = white, idle = #666).
 */
const ICONS = {
	dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12 12 3l9 9"/><path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10"/><path d="M9 21v-6h6v6"/></svg>`,
	servers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="6" rx="1.5"/><rect x="2" y="15" width="20" height="6" rx="1.5"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`,
	projects: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
	deployments: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>`,
	settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
};

/**
 * Sidebar layout — Vercel-style fixed left nav, scrollable right content.
 * Active item is highlighted via the `current` prop (path prefix match).
 */
function sidebar(current: string, user: { username: string; avatar_url: string | null } | null): string {
	const isActive = (prefix: string) => current === prefix || current.startsWith(prefix + "/") ? "active" : "";
	const items = [
		{ href: "/dashboard", label: "Dashboard", icon: ICONS.dashboard, match: "/dashboard" },
		{ href: "/servers", label: "Servers", icon: ICONS.servers, match: "/servers" },
		{ href: "/projects", label: "Projects", icon: ICONS.projects, match: "/projects" },
		{ href: "/deployments", label: "Deployments", icon: ICONS.deployments, match: "/deployments" },
		{ href: "/settings", label: "Settings", icon: ICONS.settings, match: "/settings" },
	];
	const navItems = items
		.map(
			(it) => `<a class="nav-item ${isActive(it.match)}" href="${it.href}">
				<span class="nav-icon">${it.icon}</span>
				<span>${it.label}</span>
			</a>`,
		)
		.join("");
	const userBlock = user
		? `<div class="sidebar-user">${userMenu(user)}</div>`
		: `<a class="sidebar-signin" href="/api/auth/github?returnTo=%2Fdashboard">Sign in</a>`;

	return `<aside class="sidebar">
		<a class="sidebar-logo" href="/dashboard">void</a>
		<nav class="sidebar-nav">${navItems}</nav>
		<div class="sidebar-footer">${userBlock}</div>
	</aside>`;
}

function html(content: string, title: string, opts: { user?: { username: string; avatar_url: string | null } | null; current?: string } = {}): Response {
	const current = opts.current || "";
	const sidebarBlock = sidebar(current, opts.user || null);

	const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escape(title)} · void</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;background:#000;color:#fff;min-height:100vh;line-height:1.5;display:flex}

  /* Sidebar */
  .sidebar{position:fixed;left:0;top:0;bottom:0;width:220px;background:#0a0a0a;border-right:1px solid #1a1a1a;padding:20px 12px;display:flex;flex-direction:column;gap:24px;z-index:10}
  .sidebar-logo{font-size:1.1rem;font-weight:800;letter-spacing:-0.04em;color:#fff;text-decoration:none;padding:6px 12px}
  .sidebar-nav{display:flex;flex-direction:column;gap:2px;flex:1}
  .nav-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;color:#888;text-decoration:none;font-size:0.9rem;font-weight:500;transition:background 0.1s,color 0.1s}
  .nav-item:hover{background:#141414;color:#fff}
  .nav-item.active{background:#1a1a1a;color:#fff}
  .nav-icon{display:inline-flex;width:16px;height:16px;flex-shrink:0}
  .nav-icon svg{width:16px;height:16px;display:block}
  .sidebar-footer{margin-top:auto;padding-top:12px;border-top:1px solid #1a1a1a}
  .sidebar-user{width:100%}
  .sidebar-user .user-menu summary{width:100%;justify-content:flex-start}
  .sidebar-signin{display:block;text-align:center;padding:8px 12px;border-radius:6px;background:#fff;color:#000;font-size:0.85rem;font-weight:600;text-decoration:none}

  /* Main */
  main{flex:1;margin-left:220px;padding:40px 48px;min-height:100vh;max-width:1400px}
  h1{font-size:1.75rem;font-weight:700;margin-bottom:24px;letter-spacing:-0.02em;display:flex;align-items:center;gap:12px}
  h1 .sub-meta{color:#666;font-weight:500;font-size:0.95rem;margin-left:8px}
  h2{font-size:1rem;font-weight:600;margin:32px 0 12px;color:#aaa;text-transform:uppercase;letter-spacing:0.05em}

  /* Cards / tables (legacy) */
  .card{background:#0a0a0a;border:1px solid #222;border-radius:12px;padding:20px;margin-bottom:16px}
  .empty{padding:60px 20px;text-align:center;color:#666}
  .empty h2{color:#fff;text-transform:none;font-size:1.25rem;margin-bottom:8px}
  table{width:100%;border-collapse:collapse;font-size:0.9rem}
  th{text-align:left;padding:10px 12px;color:#666;font-weight:500;border-bottom:1px solid #1a1a1a;text-transform:uppercase;font-size:0.75rem;letter-spacing:0.05em}
  td{padding:12px;border-bottom:1px solid #1a1a1a}
  tr:hover td{background:#0a0a0a}
  .status{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em}
  .status-running,.status-active,.status-success,.status-queued,.status-building{background:#0a3320;color:#0f0}
  .status-provisioning,.status-pending{background:#33220a;color:#f90}
  .status-failed,.status-offline,.status-cancelled,.status-destroyed,.status-error{background:#330a0a;color:#f44}
  code{background:#1a1a1a;padding:1px 6px;border-radius:4px;color:#888;font-size:0.85em;font-family:ui-monospace,monospace}
  a{color:#6cf;text-decoration:none}
  a:hover{text-decoration:underline}
  .meta{color:#888;font-size:0.85rem}
  .mono{font-family:ui-monospace,monospace;font-size:0.85rem}
  .actions{display:flex;gap:8px;margin-bottom:16px}
  .pill{display:inline-block;padding:2px 8px;background:#1a1a1a;border-radius:4px;font-size:0.75rem;color:#888;margin-right:4px}
  .terminal{background:#000;border:1px solid #222;border-radius:8px;padding:12px;height:60vh;overflow:auto;font-family:ui-monospace,monospace;font-size:13px;line-height:1.4}
  .terminal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .terminal-actions{display:flex;gap:8px}
  .live{color:#0f0;font-size:0.85rem}
  .live::before{content:"●";margin-right:4px;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
  .pager{display:flex;gap:12px;align-items:center;justify-content:flex-end;padding:12px 4px;font-size:0.9rem}
  .pager a{color:#6cf;padding:4px 10px;border:1px solid #333;border-radius:6px;text-decoration:none}
  .pager a:hover{background:#1a1a1a}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:6px;font-size:0.9rem;font-weight:600;text-decoration:none;border:1px solid transparent;cursor:pointer}
  .btn-primary{background:#fff;color:#000}
  .btn-secondary{background:#1a1a1a;color:#fff;border-color:#333}
  .btn-danger{background:#1a0a0a;color:#f44;border-color:#533}
  .btn-danger:hover{background:#2a0a0a;border-color:#f44}

  /* User menu (in sidebar) */
  .user-menu{position:relative;width:100%}
  .user-menu summary{list-style:none;display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer;color:#999;font-size:0.85rem;transition:background 0.15s;user-select:none}
  .user-menu summary::-webkit-details-marker{display:none}
  .user-menu summary:hover{background:#141414;color:#fff}
  .user-menu[open] summary{background:#1a1a1a;color:#fff}
  .user-menu img{border-radius:50%;display:block;width:22px;height:22px}
  .user-menu-pop{position:absolute;bottom:calc(100% + 8px);left:0;right:0;background:#0a0a0a;border:1px solid #222;border-radius:10px;padding:6px;box-shadow:0 -10px 30px rgba(0,0,0,0.5);z-index:10;display:flex;flex-direction:column;gap:2px}
  .user-menu-pop a{display:block;padding:8px 12px;border-radius:6px;color:#ccc;font-size:0.85rem;text-decoration:none;transition:background 0.1s}
  .user-menu-pop a:hover{background:#1a1a1a;color:#fff}
  .user-menu-pop hr{border:0;border-top:1px solid #222;margin:4px 6px}

  /* Dashboard */
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px}
  .stat{background:#0a0a0a;border:1px solid #222;border-radius:12px;padding:20px}
  .stat .label{color:#666;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px}
  .stat .value{font-size:1.75rem;font-weight:700;letter-spacing:-0.02em}
  .stat .sub{color:#888;font-size:0.8rem;margin-top:4px}

  /* Settings */
  .settings-section{margin-bottom:32px}
  .settings-row{display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid #1a1a1a}
  .settings-row:last-child{border-bottom:0}
  .settings-row .label{font-size:0.95rem}
  .settings-row .label small{display:block;color:#666;font-size:0.8rem;margin-top:2px}
  .settings-row .value{color:#888;font-family:ui-monospace,monospace;font-size:0.85rem}

  /* Mobile: collapse sidebar to top bar */
  @media (max-width: 768px) {
    .sidebar{position:static;width:100%;flex-direction:row;padding:12px;gap:12px;border-right:0;border-bottom:1px solid #1a1a1a}
    .sidebar-logo{display:none}
    .sidebar-nav{flex-direction:row;overflow-x:auto;gap:4px;flex:initial}
    .nav-item{padding:6px 10px;font-size:0.8rem}
    .sidebar-footer{margin-top:0;padding-top:0;border-top:0}
    .sidebar-user .user-menu summary{padding:6px 8px}
    main{margin-left:0;padding:24px 16px}
  }
</style>
</head>
<body>
${sidebarBlock}
<main>
${content}
</main>
</body>
</html>`;
	return new Response(page, {
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}

function escape(s: string): string {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function timeAgo(epochSeconds: number | null): string {
	if (!epochSeconds) return "—";
	const diff = Math.floor(Date.now() / 1000 - epochSeconds);
	if (diff < 60) return `${diff}s ago`;
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

// ============== Servers page ==============

export async function renderServersPage(env: Env, user: { username: string; avatar_url: string | null } | null): Promise<Response> {
	const { results } = await env.void_db
		.prepare(
			`SELECT s.id, s.name, s.provider, s.status, s.region, s.size, s.last_seen_at, s.tunnel_id IS NOT NULL AS has_tunnel,
			        (SELECT COUNT(*) FROM deployments d WHERE d.server_id = s.id) AS deployment_count
			 FROM servers s ORDER BY s.created_at DESC`,
		)
		.all<{ id: string; name: string; provider: string; status: string; region: string; size: string; last_seen_at: number | null; has_tunnel: number; deployment_count: number }>();

	const body = `
<h1>Servers</h1>
<div class="actions">
  <a href="https://github.com/void-sh/void" class="btn btn-secondary">+ Add via MCP (void_create_server)</a>
</div>
${results.length === 0
	? `<div class="card empty"><h2>No servers yet</h2><p>Use the <code>void_create_server</code> MCP tool to provision a Hetzner VM. It will auto-install the agent and register with the control plane.</p></div>`
	: `<div class="card"><table>
		<thead><tr>
			<th>Name</th><th>ID</th><th>Provider</th><th>Region</th><th>Size</th>
			<th>Status</th><th>Tunnel</th><th>Deploys</th><th>Last seen</th><th></th>
		</tr></thead>
		<tbody>
		${results
			.map(
				(s) => `
			<tr>
				<td><strong>${escape(s.name)}</strong></td>
				<td><code class="mono">${escape(s.id)}</code></td>
				<td>${escape(s.provider)}</td>
				<td>${escape(s.region || "—")}</td>
				<td>${escape(s.size || "—")}</td>
				<td><span class="status status-${escape(s.status)}">${escape(s.status)}</span></td>
				<td>${s.has_tunnel ? "✓" : "—"}</td>
				<td>${s.deployment_count}</td>
				<td class="meta">${timeAgo(s.last_seen_at)}</td>
				<td>
					<form method="POST" action="/servers/${escape(s.id)}/rotate-session" style="display:inline" onsubmit="return confirm('Rotate session token for ${escape(s.name)}? The agent will be disconnected and must re-register with the new token.')">
						<button class="btn btn-secondary" type="submit" style="padding:4px 10px;font-size:0.8rem">rotate</button>
					</form>
				</td>
			</tr>`,
			)
			.join("")}
		</tbody>
	</table></div>`}`;
	return html(body, "Servers", { user, current: "/servers" });
}

// ============== Projects page ==============

export async function renderProjectsPage(env: Env, user: { username: string; avatar_url: string | null } | null): Promise<Response> {
	const { results } = await env.void_db
		.prepare(
			`SELECT p.id, p.slug, p.name, p.repo_url, p.default_branch, p.default_port,
			        s.name AS server_name, s.id AS server_id,
			        (SELECT COUNT(*) FROM deployments d WHERE d.project_id = p.id) AS deployment_count
			 FROM projects p LEFT JOIN servers s ON s.id = p.server_id
			 ORDER BY p.created_at DESC`,
		)
		.all<{ id: string; slug: string; name: string; repo_url: string; default_branch: string; default_port: number; server_name: string | null; server_id: string | null; deployment_count: number }>();

	const body = `
<h1>Projects</h1>
<div class="actions">
  <a href="https://github.com/void-sh/void" class="btn btn-secondary">+ Add via MCP (void_register_project)</a>
</div>
${results.length === 0
	? `<div class="card empty"><h2>No projects yet</h2><p>Use the <code>void_register_project</code> MCP tool to register a repo. Then point a GitHub webhook at <code>/api/webhooks/github</code> for git push auto-deploy.</p></div>`
	: `<div class="card"><table>
		<thead><tr>
			<th>Name</th><th>Slug</th><th>Repo</th><th>Branch</th><th>Port</th>
			<th>Server</th><th>Deploys</th><th></th>
		</tr></thead>
		<tbody>
		${results
			.map(
				(p) => `
			<tr>
				<td><strong>${escape(p.name)}</strong></td>
				<td><code class="mono">${escape(p.slug)}</code></td>
				<td><a href="${escape(p.repo_url)}" target="_blank" rel="noopener">${escape(p.repo_url.replace("https://github.com/", ""))}</a></td>
				<td><code>${escape(p.default_branch)}</code></td>
				<td>${p.default_port}</td>
				<td>${p.server_name ? escape(p.server_name) : "—"}</td>
				<td>${p.deployment_count}</td>
				<td><a href="/deployments?project=${escape(p.id)}">history →</a></td>
			</tr>`,
			)
			.join("")}
		</tbody>
	</table></div>`}`;
	return html(body, "Projects", { user, current: "/projects" });
}

// ============== Deployments page ==============

export async function renderDeploymentsPage(
	env: Env,
	user: { username: string; avatar_url: string | null } | null,
	projectFilter: string | null,
	page: number = 1,
	perPage: number = 20,
): Promise<Response> {
	const offset = (page - 1) * perPage;

	// Total count for pagination
	const countQuery = projectFilter
		? "SELECT COUNT(*) AS n FROM deployments WHERE project_id = ?"
		: "SELECT COUNT(*) AS n FROM deployments";
	const countRow = projectFilter
		? await env.void_db.prepare(countQuery).bind(projectFilter).first<{ n: number }>()
		: await env.void_db.prepare(countQuery).first<{ n: number }>();
	const total = countRow?.n || 0;
	const totalPages = Math.max(1, Math.ceil(total / perPage));

	const query = projectFilter
		? `SELECT d.id, d.ref, d.status, d.started_at, d.finished_at, d.duration_ms, d.hostname, d.public_url, d.commit_sha,
		        p.name AS project_name, p.slug AS project_slug, s.name AS server_name
		 FROM deployments d LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN servers s ON s.id = d.server_id
		 WHERE d.project_id = ? ORDER BY d.started_at DESC LIMIT ? OFFSET ?`
		: `SELECT d.id, d.ref, d.status, d.started_at, d.finished_at, d.duration_ms, d.hostname, d.public_url, d.commit_sha,
		        p.name AS project_name, p.slug AS project_slug, s.name AS server_name
		 FROM deployments d LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN servers s ON s.id = d.server_id
		 ORDER BY d.started_at DESC LIMIT ? OFFSET ?`;

	const stmt = projectFilter
		? env.void_db.prepare(query).bind(projectFilter, perPage, offset)
		: env.void_db.prepare(query).bind(perPage, offset);
	const { results } = await stmt.all<{
		id: string; ref: string; status: string; started_at: number; finished_at: number | null;
		duration_ms: number | null; hostname: string | null; public_url: string | null; commit_sha: string | null;
		project_name: string | null; project_slug: string | null; server_name: string | null;
	}>();

	const body = `
<h1>Deployments${projectFilter ? ` <span class="meta" style="font-weight:400">— filtered</span>` : ""}</h1>
${results.length === 0
	? `<div class="card empty"><h2>No deployments yet</h2><p>Deployments appear here when you push code (via webhook) or call <code>void_deploy</code>.</p></div>`
	: `<div class="card"><table>
		<thead><tr>
			<th>ID</th><th>Project</th><th>Server</th><th>Ref</th>
			<th>Status</th><th>Started</th><th>Duration</th><th>URL</th><th></th>
		</tr></thead>
		<tbody>
		${results
			.map(
				(d) => `
			<tr>
				<td><code class="mono">${escape(d.id.slice(0, 16))}…</code></td>
				<td>${d.project_name ? escape(d.project_name) : "<em>—</em>"}</td>
				<td>${d.server_name ? escape(d.server_name) : "<em>—</em>"}</td>
				<td><code>${escape(d.ref)}</code>${d.commit_sha ? `<br><span class="meta">${escape(d.commit_sha.slice(0, 7))}</span>` : ""}</td>
				<td><span class="status status-${escape(d.status)}">${escape(d.status)}</span></td>
				<td class="meta">${timeAgo(d.started_at)}</td>
				<td class="meta">${d.duration_ms ? `${(d.duration_ms / 1000).toFixed(1)}s` : "—"}</td>
				<td>${d.public_url ? `<a href="${escape(d.public_url)}" target="_blank" rel="noopener">${escape(d.hostname || d.public_url)}</a>` : d.hostname ? `<code>${escape(d.hostname)}</code>` : "—"}</td>
				<td><a href="/deployments/${escape(d.id)}">logs →</a></td>
			</tr>`,
			)
			.join("")}
		</tbody>
	</table></div>

	<div class="pager">
		<span class="meta">${total} deployment${total === 1 ? "" : "s"} • page ${page} of ${totalPages}</span>
		${page > 1 ? `<a href="?${projectFilter ? `project=${escape(projectFilter)}&` : ""}page=${page - 1}&per_page=${perPage}">← prev</a>` : ""}
		${page < totalPages ? `<a href="?${projectFilter ? `project=${escape(projectFilter)}&` : ""}page=${page + 1}&per_page=${perPage}">next →</a>` : ""}
	</div>`}`;
	return html(body, "Deployments", { user, current: "/deployments" });
}

// ============== Single deployment log viewer ==============

export async function renderDeploymentLogsPage(
	env: Env,
	user: { username: string; avatar_url: string | null } | null,
	deploymentId: string,
): Promise<Response> {
	const dep = await env.void_db
		.prepare(
			`SELECT d.*, s.id AS server_id, s.name AS server_name, p.name AS project_name
			 FROM deployments d LEFT JOIN servers s ON s.id = d.server_id LEFT JOIN projects p ON p.id = d.project_id
			 WHERE d.id = ?`,
		)
		.bind(deploymentId)
		.first<any>();

	if (!dep) {
		return new Response("Deployment not found", { status: 404, headers: { "content-type": "text/plain" } });
	}

	const body = `
<h1>${escape(dep.project_name || "Deployment")} <span class="meta" style="font-weight:400">${escape(dep.id)}</span></h1>
<div class="card" style="margin-bottom:16px">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px">
    <div>
      <h2 style="margin:0 0 4px">Status</h2>
      <span class="status status-${escape(dep.status)}">${escape(dep.status)}</span>
    </div>
    <div>
      <h2 style="margin:0 0 4px">Ref</h2>
      <code>${escape(dep.ref)}</code>${dep.commit_sha ? `<br><span class="meta">${escape(dep.commit_sha.slice(0, 7))}</span>` : ""}
    </div>
    <div>
      <h2 style="margin:0 0 4px">Server</h2>
      ${dep.server_name ? escape(dep.server_name) : "—"}
    </div>
    <div>
      <h2 style="margin:0 0 4px">Started</h2>
      <span class="meta">${timeAgo(dep.started_at)}</span>
    </div>
    <div>
      <h2 style="margin:0 0 4px">Public URL</h2>
      ${dep.public_url ? `<a href="${escape(dep.public_url)}" target="_blank" rel="noopener">${escape(dep.public_url)}</a>` : dep.hostname ? `<code>${escape(dep.hostname)}</code>` : "—"}
    </div>
  </div>
</div>

<div class="card">
  <div class="terminal-header">
    <h2 style="margin:0">Build log</h2>
    <div class="terminal-actions">
      <span id="live-indicator" class="live">streaming</span>
      <button id="reconnect" class="btn btn-secondary" style="padding:4px 10px;font-size:0.8rem">Reconnect</button>
    </div>
  </div>
  <div id="terminal" class="terminal"></div>
</div>

<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-webgl@0.16.0/lib/xterm-addon-webgl.js"></script>
<script>
(function(){
  const term = new Terminal({
    convertEol: true,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 13,
    theme: { background: '#000000', foreground: '#e0e0e0' },
    scrollback: 10000,
  });
  const fitAddon = { proposeDimensions() {} };
  try { term.loadAddon(new WebglAddon.WebglAddon()); } catch(e) {}
  term.open(document.getElementById('terminal'));
  // EventSource: stream logs from /cell/{server_id}/logs
  const es = new EventSource('/cell/${escape(dep.server_id || "")}/logs?deployment_id=${escape(deploymentId)}&token=' + encodeURIComponent(window.location.search.get('token') || ''));
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data);
      if (e.ready) { document.getElementById('live-indicator').textContent = 'ready'; return; }
      if (e.stream === 'status') {
        const s = JSON.parse(e.data || '{}');
        const el = document.querySelector('.status-' + (s.status || 'queued'));
        if (el) { el.className = 'status status-' + s.status; el.textContent = s.status; }
        return;
      }
      // ANSI colorize common patterns
      const line = (e.data || '').replace(/\\u001b\\[[0-9;]*m/g, '');
      term.writeln(line);
    } catch (e) { /* ignore parse errors */ }
  };
  es.onerror = () => {
    document.getElementById('live-indicator').textContent = 'disconnected';
  };
  document.getElementById('reconnect').onclick = () => location.reload();
})();
</script>
`;
	// The log page uses EventSource, but EventSource doesn't support custom headers.
	// So we authenticate the SSE stream via ?token= query param. The browser will pass the session cookie anyway,
	// but for the EventSource to work cross-origin, we use the ?token= fallback. For same-origin (the UI),
	// the cookie is sufficient and the ?token= is ignored.

	return html(body, `${dep.id} · logs`, { user, current: "/deployments" });
}

// ============================================================
// Dashboard
// ============================================================

/**
 * Overview page: stat tiles + recent activity. Queries D1 in parallel
 * to keep latency low. Falls back to 0s on empty DB.
 */
export async function renderDashboardPage(
	env: Env,
	user: { username: string; avatar_url: string | null } | null,
): Promise<Response> {
	const [servers, projects, deploys, recent] = await Promise.all([
		env.void_db.prepare("SELECT COUNT(*) AS n FROM servers").first<{ n: number }>(),
		env.void_db.prepare("SELECT COUNT(*) AS n FROM projects").first<{ n: number }>(),
		env.void_db.prepare("SELECT COUNT(*) AS n FROM deployments WHERE started_at > unixepoch() - 86400").first<{ n: number }>(),
		env.void_db
			.prepare(
				`SELECT d.id, d.status, d.started_at, d.public_url, p.name AS project_name
				 FROM deployments d LEFT JOIN projects p ON p.id = d.project_id
				 ORDER BY d.started_at DESC LIMIT 8`,
			)
			.all<{ id: string; status: string; started_at: number; public_url: string | null; project_name: string | null }>(),
	]);

	const stats = [
		{ label: "Servers", value: servers?.n ?? 0, sub: "active hosts" },
		{ label: "Projects", value: projects?.n ?? 0, sub: "registered repos" },
		{ label: "Deploys (24h)", value: deploys?.n ?? 0, sub: "last 24 hours" },
	];

	const recentRows = (recent?.results || []).map(
		(d) => `<tr>
			<td><code class="mono">${escape(d.id.slice(0, 12))}…</code></td>
			<td>${d.project_name ? escape(d.project_name) : "<em>—</em>"}</td>
			<td><span class="status status-${escape(d.status)}">${escape(d.status)}</span></td>
			<td class="meta">${timeAgo(d.started_at)}</td>
			<td>${d.public_url ? `<a href="${escape(d.public_url)}" target="_blank" rel="noopener">${escape(d.public_url.replace(/^https?:\/\//, ""))}</a>` : "—"}</td>
		</tr>`,
	).join("");

	const body = `
<h1>Dashboard</h1>

<div class="stats">
	${stats
		.map(
			(s) => `<div class="stat">
				<div class="label">${escape(s.label)}</div>
				<div class="value">${s.value}</div>
				<div class="sub">${escape(s.sub)}</div>
			</div>`,
		)
		.join("")}
</div>

<div class="card">
	<h2 style="margin-top:0">Recent deployments</h2>
	${recentRows
		? `<table>
			<thead><tr><th>ID</th><th>Project</th><th>Status</th><th>Started</th><th>URL</th></tr></thead>
			<tbody>${recentRows}</tbody>
		</table>`
		: `<div class="empty"><h2>No deployments yet</h2><p>Deploys appear here when you push code (via webhook) or call <code>void_deploy</code> via MCP.</p></div>`}
</div>
<div class="actions">
	<a href="/servers" class="btn btn-secondary">Manage servers</a>
	<a href="/projects" class="btn btn-secondary">Manage projects</a>
	<a href="/deployments" class="btn btn-secondary">All deployments</a>
</div>
`;

	return html(body, "Dashboard", { user, current: "/dashboard" });
}

// ============================================================
// Settings
// ============================================================

/**
 * Account info + GitHub OAuth status. Reads the current user from
 * the session (which includes gh_access_token — not displayed) to
 * show username + avatar + login provider.
 */
export async function renderSettingsPage(
	env: Env,
	user: { id: string; username: string; avatar_url: string | null } | null,
): Promise<Response> {
	// Look up full user record for accurate info
	const fullUser = user
		? await env.void_db
				.prepare(
					"SELECT id, username, avatar_url, github_id, created_at FROM users WHERE id = ?",
				)
				.bind(user.id)
				.first<{ id: string; username: string; avatar_url: string | null; github_id: string; created_at: number }>()
		: null;

	// Per-user provider credentials (encrypted tokens)
	const { listProviderCredentials } = await import("./credentials");
	const creds = user ? await listProviderCredentials(env, user.id) : [];
	const hetznerCred = creds.find((c) => c.provider === "hetzner");

	const body = `
<h1>Settings</h1>

<div class="card">
	<h2 style="margin-top:0">Account</h2>
	${fullUser
		? `<div class="settings-row">
				<div class="label">Username<small>Your GitHub login</small></div>
				<div class="value">@${escape(fullUser.username)}</div>
			</div>
			<div class="settings-row">
				<div class="label">GitHub ID<small>Immutable</small></div>
				<div class="value">${escape(fullUser.github_id)}</div>
			</div>
			<div class="settings-row">
				<div class="label">Joined<small>Account created</small></div>
				<div class="value">${timeAgo(fullUser.created_at)}</div>
			</div>`
		: `<p class="meta">Not signed in</p>`}
</div>

<div class="card">
	<h2 style="margin-top:0">Cloud providers</h2>
	<div class="settings-row" style="align-items:flex-start;padding:20px 0">
		<div class="label">
			<strong>Hetzner Cloud</strong>
			<small>API token for provisioning VMs in your Hetzner Cloud project. Encrypted at rest with AES-256-GCM.</small>
		</div>
		<div class="value" style="text-align:right">
			${
				hetznerCred
					? `<span class="meta">✓ Token saved ${timeAgo(hetznerCred.created_at)}</span>
					<form method="POST" action="/settings/hetzner/delete" style="margin-top:8px" onsubmit="return confirm('Delete Hetzner API token? Future server creates will fall back to env HETZNER_TOKEN if set, otherwise use stub mode.')">
						<button type="submit" class="btn btn-secondary" style="padding:6px 12px;font-size:0.85rem">Delete token</button>
					</form>`
					: env.HETZNER_TOKEN
						? `<span class="meta">Using env HETZNER_TOKEN (shared)</span>
						<details style="margin-top:8px">
							<summary style="color:#6cf;cursor:pointer;font-size:0.85rem">Override with your own token</summary>
							<form method="POST" action="/settings/hetzner" style="margin-top:12px;display:flex;gap:8px">
								<input type="password" name="token" placeholder="hcloud_xxxxxxxxxxxxxxxx" required style="flex:1;padding:8px 10px;background:#000;border:1px solid #333;border-radius:6px;color:#fff;font-family:ui-monospace,monospace;font-size:0.85rem">
								<button type="submit" class="btn btn-primary" style="padding:8px 14px">Save</button>
							</form>
						</details>`
						: `<form method="POST" action="/settings/hetzner" style="display:flex;gap:8px">
							<input type="password" name="token" placeholder="hcloud_xxxxxxxxxxxxxxxx" required style="flex:1;padding:8px 10px;background:#000;border:1px solid #333;border-radius:6px;color:#fff;font-family:ui-monospace,monospace;font-size:0.85rem">
							<button type="submit" class="btn btn-primary" style="padding:8px 14px">Save</button>
						</form>
						<small style="display:block;margin-top:6px;color:#666">Get a token at <a href="https://console.hetzner.cloud" target="_blank" rel="noopener" style="color:#6cf">console.hetzner.cloud</a> → Security → API Tokens</small>`
			}
		</div>
	</div>
</div>

<div class="card">
	<h2 style="margin-top:0">Authentication</h2>
	<div class="settings-row">
		<div class="label">Sign-in method<small>How you authenticate</small></div>
		<div class="value">GitHub OAuth</div>
	</div>
	<div class="settings-row">
		<div class="label">Session lifetime<small>Cookie TTL</small></div>
		<div class="value">30 days</div>
	</div>
	<div class="actions" style="margin-top:16px">
		<a href="/api/auth/logout" class="btn btn-secondary">Sign out</a>
	</div>
</div>

<div class="card">
	<h2 style="margin-top:0">Danger zone</h2>
	<div class="settings-row">
		<div class="label">Delete account<small>Permanently remove your account and all data</small></div>
		<button class="btn btn-danger" disabled>Delete account</button>
	</div>
</div>
`;

	return html(body, "Settings", { user, current: "/settings" });
}
