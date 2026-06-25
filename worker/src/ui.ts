/**
 * void Worker — Web UI pages
 *
 * Server-rendered HTML using template literals (no SPA, no build step).
 * xterm.js loaded from CDN for the log viewer.
 */

import { Env } from "./env";

function html(content: string, title: string, opts: { user?: { username: string; avatar_url: string | null } | null } = {}): Response {
	const userBlock = opts.user
		? `<div class="user"><img src="${escape(opts.user.avatar_url || "")}" alt="" width="24" height="24"><span>@${escape(opts.user.username)}</span><a href="/api/auth/logout" class="link-mute">logout</a></div>`
		: `<a href="/api/auth/github" class="btn btn-primary">Sign in</a>`;

	const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escape(title)} · void</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;background:#000;color:#fff;min-height:100vh;padding:24px;line-height:1.5}
  .topbar{display:flex;align-items:center;justify-content:space-between;max-width:1200px;margin:0 auto 32px;padding:14px 20px;background:#0a0a0a;border:1px solid #222;border-radius:12px}
  .logo{font-weight:800;letter-spacing:-0.04em;font-size:1.1rem;display:flex;align-items:center;gap:8px}
  .logo span{color:#666;font-weight:500}
  .nav{display:flex;gap:4px;margin-left:32px}
  .nav a{color:#888;text-decoration:none;padding:6px 12px;border-radius:6px;font-size:0.9rem;font-weight:500}
  .nav a:hover{color:#fff;background:#1a1a1a}
  .nav a.active{color:#fff;background:#1a1a1a}
  .user{display:flex;align-items:center;gap:8px;padding:6px 12px;background:#0a0a0a;border-radius:8px;font-size:0.9rem}
  .user img{border-radius:50%}
  .link-mute{color:#666;text-decoration:none;font-size:0.85rem;margin-left:8px}
  .link-mute:hover{color:#fff}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:6px;font-size:0.9rem;font-weight:600;text-decoration:none;border:1px solid transparent;cursor:pointer}
  .btn-primary{background:#fff;color:#000}
  .btn-secondary{background:#1a1a1a;color:#fff;border-color:#333}
  .container{max-width:1200px;margin:0 auto}
  h1{font-size:1.75rem;font-weight:700;margin-bottom:16px;letter-spacing:-0.02em}
  h2{font-size:1.1rem;font-weight:600;margin:24px 0 12px;color:#aaa;text-transform:uppercase;letter-spacing:0.05em}
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
  .btn-danger{background:#1a0a0a;color:#f44;border-color:#533}
  .btn-danger:hover{background:#2a0a0a;border-color:#f44}
</style>
</head>
<body>
<div class="topbar">
  <div style="display:flex;align-items:center">
    <div class="logo">void<span>// self-hosted Vercel</span></div>
    <div class="nav">
      <a href="/">Home</a>
      <a href="/servers">Servers</a>
      <a href="/projects">Projects</a>
      <a href="/deployments">Deployments</a>
    </div>
  </div>
  ${userBlock}
</div>
<div class="container">
${content}
</div>
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
	return html(body, "Servers", { user });
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
	return html(body, "Projects", { user });
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
	return html(body, "Deployments", { user });
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

	return html(body, `${dep.id} · logs`, { user });
}
