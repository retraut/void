/**
 * void Worker — Web UI pages
 *
 * Server-rendered HTML using template literals (no SPA, no build step).
 * xterm.js loaded from CDN for the log viewer.
 */

import { Env } from "./env";
import type { Metrics } from "./protocol";

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
 * If `currentProject` is set, a switcher is shown at the top of the sidebar.
 */
function sidebar(
	current: string,
	user: { username: string; avatar_url: string | null } | null,
	currentProject: { id: string; name: string; slug: string } | null,
	projects: Array<{ id: string; name: string; slug: string }>,
): string {
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

	// Project switcher — shown only if user has at least one project.
	// Native <select> + onchange=submit keeps it zero-JS and works on mobile.
	const switcher = projects.length > 0
		? `<form method="POST" action="/projects/select" class="project-switcher">
			<label class="switcher-label">PROJECT</label>
			<select name="project_id" onchange="this.form.submit()" aria-label="Switch project">
				<option value="" ${!currentProject ? "selected" : ""}>All projects</option>
				${projects
					.map(
						(p) => `<option value="${escape(p.id)}" ${currentProject?.id === p.id ? "selected" : ""}>${escape(p.name)}</option>`,
					)
					.join("")}
			</select>
			<noscript><button type="submit" class="btn btn-secondary" style="margin-top:6px;width:100%">Switch</button></noscript>
		</form>`
		: "";

	const userBlock = user
		? `<div class="sidebar-user">${userMenu(user)}</div>`
		: `<a class="sidebar-signin" href="/api/auth/github?returnTo=%2Fdashboard">Sign in</a>`;

	return `<aside class="sidebar">
		<div class="sidebar-head">
			<a class="sidebar-logo" href="/dashboard">void</a>
			<button class="sidebar-collapse" type="button" aria-label="Toggle sidebar" title="Collapse sidebar"></button>
		</div>
		${switcher}
		<nav class="sidebar-nav">${navItems}</nav>
		<div class="sidebar-footer">${userBlock}</div>
	</aside>`;
}

function html(
	content: string,
	title: string,
	opts: {
		user?: { id: string; username: string; avatar_url: string | null } | null;
		current?: string;
		currentProject?: { id: string; name: string; slug: string } | null;
		projects?: Array<{ id: string; name: string; slug: string }>;
	} = {},
): Response {
	const current = opts.current || "";
	const sidebarBlock = sidebar(
		current,
		opts.user || null,
		opts.currentProject || null,
		opts.projects || [],
	);

	const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escape(title)} · void</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}

  /* === Tokyo Night palette (night variant) ===
     All theme colors live here. Hardcoded hex values throughout the
     rest of the stylesheet reference these via var(). To re-skin the
     app, swap this block — nothing else needs to change. */
  :root{
    --bg:#1a1b26;
    --bg-alt:#16161e;
    --bg-deep:#0f0f14;
    --bg-elevated:#24283b;
    --bg-hover:#292e42;
    --bg-specs:#1f2335;
    --bg-input:#0f0f14;
    --border:#292e42;
    --border-alt:#2a2f45;
    --border-strong:#3b4261;
    --border-hover:#565f89;
    --text:#c0caf5;
    --text-2:#a9b1d6;
    --text-muted:#9aa5ce;
    --text-dim:#565f89;
    --accent:#9ece6a;
    --link:#7aa2f7;
    --success:#9ece6a;
    --success-bg:#1f3a2a;
    --success-border:#2d5a3e;
    --warning:#e0af68;
    --warning-bg:#3a2e1a;
    --warning-border:#5a4a2a;
    --error:#f7768e;
    --error-bg:#3a1f2a;
    --error-border:#5a2a3a;
    --hetzner:#D50C2D;
    --sidebar-w:220px;
    --sidebar-w-collapsed:56px;
  }

  /* === Sidebar layout: collapsible on desktop, drawer on mobile ===
     Desktop: button at the bottom of the sidebar toggles
       body.sidebar-collapsed, which collapses the sidebar to icons-only
       (--sidebar-w-collapsed). State is persisted in localStorage.
     Mobile: sidebar is position:fixed, transformed off-screen by
       default; the .menu-toggle button in <main> adds body.sidebar-open
       which slides it in over a dimmed backdrop. */
  .menu-toggle{display:none;position:fixed;top:12px;left:12px;z-index:50;width:40px;height:40px;align-items:center;justify-content:center;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;color:var(--text);cursor:pointer;transition:background 0.15s}
  .menu-toggle:hover{background:var(--bg-hover)}
  .menu-toggle svg{width:20px;height:20px;display:block}
  .sidebar-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:40;opacity:0;transition:opacity 0.2s}
  body.sidebar-open .sidebar-backdrop{display:block;opacity:1}
  body.sidebar-open{overflow:hidden}
  .sidebar-head{display:flex;align-items:center;justify-content:space-between;gap:4px;padding:0 4px 0 8px}
  .sidebar-collapse{flex-shrink:0;width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:6px;background:transparent;border:1px solid var(--border);color:var(--text-muted);cursor:pointer;font-size:0.95rem;line-height:1;transition:background 0.15s,color 0.15s,border-color 0.15s}
  .sidebar-collapse:hover{background:var(--bg-hover);color:var(--text);border-color:var(--border-strong)}
  body:not(.sidebar-collapsed) .sidebar-collapse::before{content:"«";font-weight:700}
  body.sidebar-collapsed .sidebar-collapse::before{content:"»";font-weight:700}
  body.sidebar-collapsed .sidebar{width:var(--sidebar-w-collapsed);padding:20px 8px;gap:16px}
  body.sidebar-collapsed .sidebar-head{justify-content:center;padding:0;gap:2px}
  body.sidebar-collapsed .sidebar-logo{font-size:0;padding:0;text-align:center;letter-spacing:0;flex:initial}
  body.sidebar-collapsed .sidebar-logo::first-letter{font-size:1.4rem;color:var(--text)}
  body.sidebar-collapsed .project-switcher,
  body.sidebar-collapsed .sidebar-user .user-menu summary span,
  body.sidebar-collapsed .sidebar-signin,
  body.sidebar-collapsed .nav-item span:not(.nav-icon){display:none}
  body.sidebar-collapsed .nav-item{justify-content:center;padding:10px;gap:0}
  body.sidebar-collapsed .sidebar-user .user-menu summary{justify-content:center;padding:6px}
  body.sidebar-collapsed main{margin-left:var(--sidebar-w-collapsed)}

  body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.5;display:flex}

  /* Sidebar */
  .sidebar{position:fixed;left:0;top:0;bottom:0;width:220px;background:var(--bg-alt);border-right:1px solid var(--border);padding:20px 12px;display:flex;flex-direction:column;gap:24px;z-index:10}
  .sidebar-logo{font-size:1.1rem;font-weight:800;letter-spacing:-0.04em;color:var(--text);text-decoration:none;padding:6px 12px}
  .sidebar-nav{display:flex;flex-direction:column;gap:2px;flex:1}
  .nav-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;color:var(--text-muted);text-decoration:none;font-size:0.9rem;font-weight:500;transition:background 0.1s,color 0.1s}
  .nav-item:hover{background:var(--bg-hover);color:var(--text)}
  .nav-item.active{background:var(--border);color:var(--text)}
  .nav-icon{display:inline-flex;width:16px;height:16px;flex-shrink:0}
  .nav-icon svg{width:16px;height:16px;display:block}
  .sidebar-footer{margin-top:auto;padding-top:12px;border-top:1px solid var(--border)}
  .sidebar-user{width:100%}
  .sidebar-user .user-menu summary{width:100%;justify-content:flex-start}
  .sidebar-signin{display:block;text-align:center;padding:8px 12px;border-radius:6px;background:var(--text);color:var(--bg);font-size:0.85rem;font-weight:600;text-decoration:none}

  /* Main */
  main{flex:1;margin-left:220px;padding:40px 48px;min-height:100vh;max-width:1400px}
  h1{font-size:1.75rem;font-weight:700;margin-bottom:24px;letter-spacing:-0.02em;display:flex;align-items:center;gap:12px}
  h1 .sub-meta{color:var(--text-dim);font-weight:500;font-size:0.95rem;margin-left:8px}
  h2{font-size:1rem;font-weight:600;margin:32px 0 12px;color:var(--text-2);text-transform:uppercase;letter-spacing:0.05em}

  /* Cards / tables (legacy) */
  .card{background:var(--bg-alt);border:1px solid var(--border-alt);border-radius:12px;padding:20px;margin-bottom:20px}
  .empty{padding:60px 20px;text-align:center;color:var(--text-dim)}
  .empty h2{color:var(--text);text-transform:none;font-size:1.25rem;margin-bottom:8px}
  table{width:100%;border-collapse:collapse;font-size:0.9rem}
  th{text-align:left;padding:10px 12px;color:var(--text-dim);font-weight:500;border-bottom:1px solid var(--border);text-transform:uppercase;font-size:0.75rem;letter-spacing:0.05em}
  td{padding:12px;border-bottom:1px solid var(--border)}
  tr:hover td{background:var(--bg-alt)}
  .status{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em}
  .status-running,.status-active,.status-success,.status-queued,.status-building{background:var(--success-bg);color:var(--success)}
  .status-provisioning,.status-pending{background:var(--warning-bg);color:var(--warning)}
  .status-failed,.status-offline,.status-cancelled,.status-destroyed,.status-error{background:var(--error-bg);color:var(--error)}
  code{background:var(--border);padding:1px 6px;border-radius:4px;color:var(--text-muted);font-size:0.85em;font-family:ui-monospace,monospace}
  a{color:var(--link);text-decoration:none}
  a:hover{text-decoration:underline}
  .meta{color:var(--text-muted);font-size:0.85rem}
  .mono{font-family:ui-monospace,monospace;font-size:0.85rem}
  .actions{display:flex;gap:8px;margin-bottom:16px}
  .pill{display:inline-block;padding:2px 8px;background:var(--border);border-radius:4px;font-size:0.75rem;color:var(--text-muted);margin-right:4px}
  .terminal{background:var(--bg);border:1px solid var(--border-alt);border-radius:8px;padding:12px;height:60vh;overflow:auto;font-family:ui-monospace,monospace;font-size:13px;line-height:1.4}
  .terminal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .terminal-actions{display:flex;gap:8px}
  .live{color:var(--success);font-size:0.85rem}
  .live::before{content:"●";margin-right:4px;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
  .pager{display:flex;gap:12px;align-items:center;justify-content:flex-end;padding:12px 4px;font-size:0.9rem}
  .pager a{color:var(--link);padding:4px 10px;border:1px solid var(--border-strong);border-radius:6px;text-decoration:none}
  .pager a:hover{background:var(--border)}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:6px;font-size:0.9rem;font-weight:600;text-decoration:none;border:1px solid transparent;cursor:pointer;transition:opacity 0.15s,background 0.15s}
  .btn-primary{background:var(--text);color:var(--bg)}
  .btn-secondary{background:var(--border);color:var(--text);border-color:var(--border-strong)}
  .btn:disabled{opacity:0.4;cursor:not-allowed;background:var(--border)!important;color:var(--text-dim)!important;border-color:var(--border-alt)!important}
  .btn-danger{background:var(--error-bg);color:var(--error);border-color:var(--error-border)}
  .btn-danger:hover{background:var(--error-border);border-color:var(--error)}

  /* Project switcher (top of sidebar) */
  .project-switcher{margin-bottom:8px;padding-bottom:16px;border-bottom:1px solid var(--border)}
  .switcher-label{color:var(--text-dim);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:6px;padding:0 4px;font-weight:600}
  .project-switcher select{width:100%;background:var(--bg-alt);border:1px solid var(--border-alt);border-radius:8px;color:var(--text);padding:8px 10px;font-size:0.85rem;font-family:inherit;cursor:pointer;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'><path d='M6 9l6 6 6-6'/></svg>");background-repeat:no-repeat;background-position:right 10px center;padding-right:28px}
  .project-switcher select:hover{border-color:var(--border-strong)}
  .project-switcher select:focus{outline:none;border-color:var(--link)}

  /* User menu (in sidebar) */
  .user-menu{position:relative;width:100%}
  .user-menu summary{list-style:none;display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer;color:#999;font-size:0.85rem;transition:background 0.15s;user-select:none}
  .user-menu summary::-webkit-details-marker{display:none}
  .user-menu summary:hover{background:var(--bg-hover);color:var(--text)}
  .user-menu[open] summary{background:var(--border);color:var(--text)}
  .user-menu img{border-radius:50%;display:block;width:22px;height:22px}
  .user-menu-pop{position:absolute;bottom:calc(100% + 8px);left:0;right:0;background:var(--bg-alt);border:1px solid var(--border-alt);border-radius:10px;padding:6px;box-shadow:0 -10px 30px rgba(0,0,0,0.5);z-index:10;display:flex;flex-direction:column;gap:2px}
  .user-menu-pop a{display:block;padding:8px 12px;border-radius:6px;color:var(--text-2);font-size:0.85rem;text-decoration:none;transition:background 0.1s}
  .user-menu-pop a:hover{background:var(--border);color:var(--text)}
  .user-menu-pop hr{border:0;border-top:1px solid var(--border-alt);margin:4px 6px}

  /* Dashboard */
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px}
  .stat{background:var(--bg-alt);border:1px solid var(--border-alt);border-radius:12px;padding:20px}
  .stat .label{color:var(--text-dim);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px}
  .stat .value{font-size:1.75rem;font-weight:700;letter-spacing:-0.02em}
  .stat .sub{color:var(--text-muted);font-size:0.8rem;margin-top:4px}

  /* Settings */
  .settings-section{margin-bottom:32px}
  .settings-row{display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--border)}
  .settings-row:last-child{border-bottom:0}
  .settings-row .label{font-size:0.95rem}
  .settings-row .label small{display:block;color:var(--text-dim);font-size:0.8rem;margin-top:2px}
  .settings-row .value{color:var(--text-muted);font-family:ui-monospace,monospace;font-size:0.85rem}

  /* Form: option cards (radio inputs styled as clickable cards) */
  .form-section{margin-bottom:32px}
  .form-section h2{margin:0 0 12px;color:var(--text);text-transform:none;font-size:1.1rem;font-weight:600;letter-spacing:-0.01em}
  .form-section .form-hint{color:var(--text-dim);font-size:0.85rem;margin:0 0 14px}
  .option-grid{display:grid;gap:10px}
  .option-grid.cols-4{grid-template-columns:repeat(auto-fill,minmax(170px,1fr))}
  .option-grid.cols-3{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
  .option-card{
    display:block;position:relative;
    padding:14px 16px;
    border:1px solid var(--border-alt);border-radius:10px;
    background:var(--bg-alt);cursor:pointer;
    transition:all 0.15s;
  }
  .option-card:hover{border-color:var(--border-hover);background:var(--bg-elevated)}
  .option-card input[type="radio"]{position:absolute;opacity:0;pointer-events:none;width:0;height:0}
  .option-card:has(input:checked){
    border-color:var(--accent);
    background:linear-gradient(135deg, rgba(0,255,136,0.08) 0%, rgba(0,255,136,0.02) 100%);
    box-shadow:0 0 0 1px var(--accent), 0 0 24px rgba(0,255,136,0.10);
  }
  .option-card .oc-name{font-weight:600;color:var(--text);font-size:0.95rem}
  .option-card .oc-sub{font-size:0.78rem;color:var(--text-muted);margin-top:2px}
  .option-card .oc-specs{font-size:0.8rem;color:#999;margin-top:6px;display:flex;flex-wrap:wrap;gap:6px 10px}
  .option-card .oc-specs span{color:var(--text-2)}
  .option-card .oc-price{font-size:0.95rem;font-weight:700;color:var(--accent);margin-top:8px;letter-spacing:-0.01em}
  .option-card .oc-check{position:absolute;top:10px;right:12px;width:14px;height:14px;border-radius:50%;border:1.5px solid var(--border-hover)}
  .option-card:has(input:checked) .oc-check{background:var(--accent);border-color:var(--accent);box-shadow:0 0 8px var(--accent)}
  .option-card .oc-check::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid var(--bg);border-width:0 2px 2px 0;transform:rotate(45deg);opacity:0}
  .option-card:has(input:checked) .oc-check::after{opacity:1}
  .option-row{
    display:flex;align-items:center;gap:12px;
    padding:12px 16px;
    border:1px solid var(--border-alt);border-radius:8px;
    background:var(--bg-alt);cursor:pointer;margin-bottom:8px;
    transition:all 0.15s;
  }
  .option-row:hover{border-color:var(--border-hover)}
  .option-row input[type="radio"]{margin:0;accent-color:var(--accent)}
  .option-row:has(input:checked){border-color:var(--accent);background:rgba(0,255,136,0.05)}
  .option-row .or-name{font-weight:500;color:var(--text)}
  .option-row .or-sub{color:var(--text-muted);font-size:0.8rem;margin-left:auto}

  .form-input{
    width:100%;padding:10px 14px;
    background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;
    color:var(--text);font-size:1rem;font-family:ui-monospace,monospace;
    box-sizing:border-box;transition:border-color 0.15s;
  }
  .form-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,255,136,0.15)}
  .form-input:invalid{border-color:var(--error-border)}
  .form-actions{display:flex;gap:10px;justify-content:flex-end;padding-top:16px;border-top:1px solid var(--border);margin-top:8px}
  .form-error{background:var(--error-bg);border:1px solid var(--error-border);color:var(--error);padding:14px 18px;border-radius:8px;margin-bottom:20px;font-size:0.9rem;line-height:1.55;white-space:pre-line}
.form-error a{color:var(--link);text-decoration:underline}

  /* Advanced section — collapsed by default. Use native <details> for
     accessibility and zero-JS, but style the disclosure arrow + summary. */
  details.adv{border:1px solid var(--border);border-radius:10px;background:var(--bg-alt);margin-top:24px;overflow:hidden}
  details.adv>summary{list-style:none;cursor:pointer;padding:14px 18px;display:flex;align-items:center;gap:12px;user-select:none;color:#999;transition:color 0.15s, background 0.15s}
  details.adv>summary:hover{color:var(--text);background:var(--bg-elevated)}
  details.adv>summary::-webkit-details-marker{display:none}
  details.adv>summary::before{content:"▸";display:inline-block;font-size:0.7rem;transition:transform 0.2s;color:var(--text-dim);width:12px;flex-shrink:0}
  details.adv[open]>summary::before{transform:rotate(90deg);color:var(--accent)}
  details.adv>summary strong{color:var(--text);font-weight:600;font-size:0.95rem;letter-spacing:-0.01em}
  details.adv .adv-body{padding:16px 18px 18px;border-top:1px solid var(--border)}
  details.adv .adv-summary{color:var(--text-muted);font-size:0.85rem;margin-left:auto;font-family:ui-monospace,monospace}
  details.adv .adv-summary code{background:var(--border);padding:1px 6px;border-radius:4px;color:var(--accent);font-size:0.8rem}

  /* Connected-account widget — one compact card that says "you're
     logged in as @you via GitHub, here's your session info, and a
     way to sign out". Green glow signals "active/connected". */
  .connected-account{
    display:flex;align-items:center;gap:18px;
    padding:20px 24px;
    border:1px solid rgba(0,255,136,0.18);
    border-radius:12px;
    background:
      linear-gradient(135deg, rgba(0,255,136,0.05) 0%, rgba(0,255,136,0) 60%),
      linear-gradient(180deg, var(--bg-alt) 0%, #050505 100%);
    position:relative;overflow:hidden;
    margin-bottom:24px;
    box-shadow:
      0 0 0 1px rgba(0,255,136,0.05),
      0 0 32px rgba(0,255,136,0.05),
      inset 0 1px 0 rgba(0,255,136,0.08);
  }
  .connected-account::before{
    content:"";position:absolute;inset:0;pointer-events:none;
    background:radial-gradient(ellipse 50% 90% at 0% 50%, rgba(0,255,136,0.10) 0%, transparent 65%);
  }
  .ca-icon{
    position:relative;flex-shrink:0;
    width:48px;height:48px;
    display:flex;align-items:center;justify-content:center;
    border-radius:12px;
    background:rgba(0,255,136,0.08);
    color:var(--accent);
    border:1px solid rgba(0,255,136,0.25);
    box-shadow:0 0 18px rgba(0,255,136,0.18);
  }
  .ca-icon svg{width:26px;height:26px;display:block}
  .ca-pulse{
    position:absolute;top:-2px;right:-2px;
    width:10px;height:10px;border-radius:50%;
    background:var(--accent);
    box-shadow:0 0 10px var(--accent), 0 0 4px var(--accent);
    border:2px solid var(--bg-alt);
    animation:ca-pulse 2.4s ease-in-out infinite;
  }
  @keyframes ca-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(1.35)}}
  .ca-info{flex:1;min-width:0;position:relative}
  .ca-name{font-size:1.1rem;font-weight:600;color:var(--text);letter-spacing:-0.01em}
  .ca-meta{
    font-size:0.85rem;color:var(--text-muted);margin-top:3px;
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  }
  .ca-provider{color:var(--accent);font-weight:500}
  .ca-sep{color:var(--border-strong)}
  .ca-logout{
    color:var(--text-muted);font-size:0.85rem;text-decoration:none;
    padding:8px 14px;border-radius:8px;
    border:1px solid var(--border-alt);
    background:rgba(255,255,255,0.02);
    transition:all 0.15s;flex-shrink:0;font-weight:500;
    position:relative;
  }
  .ca-logout:hover{color:var(--error);border-color:var(--error-border);background:rgba(255,85,85,0.06);text-decoration:none}

  /* Server card grid (replaces the old table) */
  .server-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px}
  .server-card{
    background:linear-gradient(180deg, var(--bg-alt) 0%, var(--bg-deep) 100%);
    border:1px solid var(--border);border-radius:14px;
    padding:20px;
    display:flex;flex-direction:column;gap:14px;
    transition:border-color 0.15s, transform 0.15s;
    position:relative;overflow:hidden;
  }
  .server-card:hover{border-color:var(--border-strong);transform:translateY(-1px)}
  .server-card::before{content:"";position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)}
  .sc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
  .sc-name{font-size:1.05rem;font-weight:600;color:var(--text);letter-spacing:-0.01em}
  .sc-id{margin-top:3px}
  .sc-id code{background:transparent;padding:0;color:var(--text-dim);font-size:0.72rem;font-family:ui-monospace,monospace}
  .sc-specs{display:flex;flex-wrap:wrap;gap:6px}
  .sc-specs span{font-size:0.72rem;color:var(--text-muted);background:var(--bg-specs);border:1px solid var(--border);padding:3px 8px;border-radius:6px;font-weight:500;letter-spacing:0.02em}
  .sc-project{color:var(--hetzner) !important;border-color:rgba(213,12,45,0.25) !important;background:rgba(213,12,45,0.06) !important}
  .sc-tunnel{color:var(--accent) !important;border-color:rgba(0,255,136,0.25) !important;background:rgba(0,255,136,0.06) !important}
  .sc-specs-hw{color:var(--text-2) !important;background:linear-gradient(135deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01)) !important;font-family:ui-monospace,monospace !important;font-variant-numeric:tabular-nums}
  .sc-provider{color:var(--text-2) !important;background:rgba(255,255,255,0.03) !important;border-color:var(--border) !important;font-family:ui-monospace,monospace !important}
  /* Latest deployment line on the card — repo @ ref (sha) · status · age */
  .sc-deploy{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
  .sc-deploy code{background:transparent;padding:0;color:var(--text-2);font-size:0.78rem;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sc-deploy-ref{color:var(--text-muted);font-size:0.76rem;font-family:ui-monospace,monospace}
  .sc-deploy-sha{color:var(--text-dim);font-size:0.72rem;font-family:ui-monospace,monospace}
  .sc-deploy-status{font-size:0.66rem !important;padding:1px 7px !important;text-transform:capitalize;letter-spacing:0.02em}
  .sc-deploy-age{color:var(--text-dim);font-size:0.72rem;margin-left:auto;font-family:ui-monospace,monospace}
  .sc-meta{display:flex;flex-direction:column;gap:5px;padding-top:8px;border-top:1px solid var(--bg-hover)}
  .sc-meta-row{display:flex;align-items:center;justify-content:space-between;font-size:0.8rem}
  .sc-meta-label{color:var(--text-dim);text-transform:uppercase;letter-spacing:0.04em;font-size:0.7rem;font-weight:600}
  .sc-meta-row code{background:transparent;padding:0;color:var(--text-2);font-size:0.8rem}
  .sc-actions{display:flex;gap:6px;padding-top:4px}

  /* Provisioning state — animated progress bar + spinner so the
     user sees the server is being created in real time. Polls every
     10s; when the agent registers the status flips to 'active' and
     these visuals disappear. */
  .server-card.provisioning{border-color:rgba(0,255,136,0.18);background:linear-gradient(180deg, rgba(0,255,136,0.02) 0%, var(--bg-deep) 100%)}
  .sc-progress{height:3px;background:var(--border);border-radius:2px;overflow:hidden;position:relative;margin-top:-4px}
  .sc-progress::after{content:"";position:absolute;top:0;left:0;width:30%;height:100%;background:linear-gradient(90deg, transparent, var(--accent), transparent);animation:sc-progress-anim 1.5s linear infinite}
  @keyframes sc-progress-anim{0%{left:-30%}100%{left:100%}}
  .sc-progress-wait{display:flex;align-items:center;gap:6px;color:var(--text-muted);font-size:0.78rem;padding-top:4px}
  .sc-spinner{display:inline-block;width:10px;height:10px;border:2px solid var(--border-strong);border-top-color:var(--accent);border-radius:50%;animation:sc-spin 0.8s linear infinite;flex-shrink:0}
  @keyframes sc-spin{to{transform:rotate(360deg)}}
  .sc-elapsed{color:var(--text-dim);font-size:0.72rem;margin-left:auto;font-family:ui-monospace,monospace}
  @media (max-width: 768px){.server-grid{grid-template-columns:1fr}}
  .provider-widget{
    display:flex;align-items:center;gap:18px;
    padding:20px 24px;
    border:1px solid rgba(213,12,45,0.18);
    border-radius:12px;
    background:
      linear-gradient(135deg, rgba(213,12,45,0.05) 0%, rgba(213,12,45,0) 60%),
      linear-gradient(180deg, var(--bg-alt) 0%, #050505 100%);
    position:relative;overflow:hidden;
    box-shadow:
      0 0 0 1px rgba(213,12,45,0.05),
      0 0 32px rgba(213,12,45,0.05),
      inset 0 1px 0 rgba(213,12,45,0.08);
  }
  .provider-widget::before{
    content:"";position:absolute;inset:0;pointer-events:none;
    background:radial-gradient(ellipse 50% 90% at 0% 50%, rgba(213,12,45,0.10) 0%, transparent 65%);
  }
  .pw-icon{
    position:relative;flex-shrink:0;
    width:48px;height:48px;
    display:flex;align-items:center;justify-content:center;
    border-radius:10px;overflow:hidden;
    box-shadow:0 0 18px rgba(213,12,45,0.20), 0 2px 8px rgba(0,0,0,0.4);
    text-decoration:none;
    transition:transform 0.15s, box-shadow 0.15s;
  }
  .pw-icon:hover{transform:scale(1.05);box-shadow:0 0 24px rgba(213,12,45,0.35), 0 2px 12px rgba(0,0,0,0.5)}
  .pw-icon:active{transform:scale(0.98)}
  .pw-icon svg{width:100%;height:100%;display:block}
  .pw-pulse{
    position:absolute;top:-2px;right:-2px;
    width:10px;height:10px;border-radius:50%;
    background:var(--hetzner);
    box-shadow:0 0 10px var(--hetzner), 0 0 4px var(--hetzner);
    border:2px solid var(--bg-alt);
    animation:pw-pulse 2.4s ease-in-out infinite;
  }
  @keyframes pw-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(1.35)}}
  .pw-info{flex:1;min-width:0;position:relative}
  .pw-name{font-size:1.05rem;font-weight:600;color:var(--text);letter-spacing:-0.01em;display:flex;align-items:center;gap:8px}
  .pw-tag{font-size:0.65rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--hetzner);background:rgba(213,12,45,0.10);border:1px solid rgba(213,12,45,0.25);padding:2px 6px;border-radius:4px;font-weight:700}
  .pw-meta{font-size:0.85rem;color:var(--text-muted);margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .pw-status-ok{color:var(--hetzner);font-weight:500}
  .pw-status-missing{color:var(--text-dim)}
  .pw-sep{color:var(--border-strong)}
  .pw-action{flex-shrink:0;position:relative}

  /* Toast (top of page, auto-dismiss) */
  .toast{display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:10px;margin-bottom:24px;font-size:0.9rem;animation:toast-in 280ms cubic-bezier(.34,1.56,.64,1) both;box-shadow:0 4px 20px rgba(0,0,0,0.4)}
  .toast-success{background:var(--success-bg);border:1px solid var(--success-border);color:var(--success)}
  .toast-error{background:var(--error-bg);border:1px solid var(--error-border);color:var(--error)}
  @keyframes toast-in{from{transform:translateY(-12px);opacity:0}to{transform:translateY(0);opacity:1}}
  .toast-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;font-weight:700;flex-shrink:0}
  .toast-success .toast-icon{background:var(--success-border);color:var(--text)}
  .toast-error .toast-icon{background:var(--error-border);color:var(--text)}
  .toast-msg{flex:1;line-height:1.4}
  .toast-close{background:transparent;border:0;color:inherit;opacity:0.5;cursor:pointer;font-size:1.2rem;line-height:1;padding:4px 8px;border-radius:4px;transition:opacity 0.15s}
  .toast-close:hover{opacity:1;background:rgba(255,255,255,0.05)}

  /* Mobile: sidebar becomes a slide-in drawer (Jira-style). The
     drawer markup is always present; the .menu-toggle button opens it
     by adding body.sidebar-open. Desktop collapse state is ignored on
     mobile — the drawer always shows the full sidebar. */
  @media (max-width: 768px) {
    .menu-toggle{display:flex}
    .sidebar{
      position:fixed;left:0;top:0;bottom:0;
      width:280px;
      padding:20px 16px;
      transform:translateX(-100%);
      transition:transform 0.2s ease-out;
      z-index:60;
      border-right:1px solid var(--border);
      border-bottom:0;
    }
    body.sidebar-open .sidebar{transform:translateX(0)}
    /* Collapse button is desktop-only — on mobile the drawer always
       shows the full sidebar. */
    .sidebar-collapse{display:none}
    /* Cancel the desktop collapse rules inside the drawer */
    body.sidebar-collapsed .sidebar{width:280px;padding:20px 16px;transform:translateX(-100%);gap:24px}
    body.sidebar-collapsed .sidebar-head{justify-content:space-between;padding:0 4px 0 8px;gap:4px}
    body.sidebar-collapsed .sidebar-logo{font-size:1.1rem;padding:6px 12px;text-align:left;letter-spacing:-0.04em;flex:1}
    body.sidebar-collapsed .sidebar-logo::first-letter{font-size:inherit;color:inherit}
    body.sidebar-collapsed .project-switcher,
    body.sidebar-collapsed .sidebar-user .user-menu summary span{display:flex}
    body.sidebar-collapsed .nav-item{justify-content:flex-start;padding:8px 12px;gap:10px}
    body.sidebar-collapsed .nav-item span:not(.nav-icon){display:inline}
    body.sidebar-collapsed .sidebar-user .user-menu summary{justify-content:flex-start;padding:8px 10px}
    body.sidebar-collapsed main{margin-left:0}
    /* Anchor user-menu popover to the right edge of the drawer */
    .user-menu-pop{right:0;left:auto;min-width:200px}

    main{margin-left:0;padding:64px 16px 20px}

    /* Typography */
    h1{font-size:1.35rem;margin-bottom:18px;gap:8px;flex-wrap:wrap}
    h1 .sub-meta{font-size:0.85rem;margin-left:0}
    h2{font-size:0.95rem;margin:24px 0 10px}

    /* Top-of-page action bar (e.g. + New server) */
    .actions{flex-wrap:wrap;gap:6px}
    .actions .btn{flex:1 1 auto;justify-content:center;min-width:0}

    /* Form footer (e.g. New server "Create server" / "Cancel") */
    .form-actions{flex-direction:column;gap:8px;align-items:stretch}
    .form-actions .btn{width:100%;justify-content:center}
    .form-actions a{text-align:center}

    /* Tables — CSS-only horizontal scroll. The <table> becomes a
       scrollable block; inner thead/tbody/tr keep table layout; cells
       go nowrap so columns don't collapse. */
    .card > table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}
    .card > table th,.card > table td{white-space:nowrap;padding:10px 8px}
    table.scroll{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
    table.scroll th,table.scroll td{white-space:nowrap}

    /* Stats grid */
    .stats{grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
    .stat{padding:16px}
    .stat .value{font-size:1.4rem}

    /* Cards */
    .card{padding:16px;margin-bottom:16px}
    .card.empty{padding:40px 16px}
    .empty h2{font-size:1.1rem}

    /* Settings rows (label + form side-by-side) — stack vertically */
    .settings-row{flex-direction:column;align-items:stretch;gap:10px;padding:12px 0}
    .settings-row .label{padding-right:0}
    .settings-row .value{min-width:0;width:100%}
    .settings-row .value form{flex-direction:column;align-items:stretch;width:100%}
    .settings-row .value form textarea,
    .settings-row .value form input{min-width:0 !important;width:100%}
    .settings-row .value form .btn{width:100%}
    .settings-row .value form > .btn-danger{margin-top:6px}

    /* Connected-account card */
    .connected-account{flex-wrap:wrap;gap:12px;padding:16px}
    .connected-account .ca-icon{order:1}
    .connected-account .ca-info{order:2;flex:1 1 100%;min-width:0}
    .connected-account .ca-logout{order:3;flex:1 1 100%;text-align:center;justify-content:center}

    /* Hetzner provider widget */
    .provider-widget{flex-wrap:wrap;gap:12px;padding:16px}
    .provider-widget .pw-icon{order:1}
    .provider-widget .pw-info{order:2;flex:1 1 100%;min-width:0}
    .provider-widget .pw-action{order:3;flex:1 1 100%;display:flex}
    .provider-widget .pw-action form{width:100%}
    .provider-widget .pw-action .btn{width:100%}

    /* Hetzner token form */
    #hetzner-form{flex-direction:column;align-items:stretch;gap:8px}
    #hetzner-form > div{flex:initial;min-width:0;width:100%}
    #hetzner-form .btn{width:100%}

    /* Passkey add form */
    #passkey-add-form{flex-wrap:wrap}
    #passkey-add-form input{flex:1 1 100%}
    #passkey-add-form .btn{width:100%}

    /* Server card */
    .server-card{padding:16px;gap:12px}
    .sc-head{flex-wrap:wrap;gap:8px}
    .sc-name{font-size:1rem}
    .sc-specs{gap:4px}
    .sc-actions{flex-wrap:wrap;gap:6px}
    .sc-actions form{flex:1 1 auto}
    .sc-actions .btn{width:100%}

    /* Buttons — iOS HIG: 44pt min tap target */
    .btn{min-height:40px;padding:10px 14px}
    .btn:disabled{padding:10px 14px}

    /* Toasts */
    .toast{padding:10px 12px;gap:10px;margin-bottom:16px;font-size:0.85rem;flex-wrap:wrap}
    .toast-msg{word-break:break-word;min-width:0;flex:1 1 200px}

    /* xterm terminal (deployment logs) */
    .terminal{height:50vh;min-height:240px;padding:10px}

    /* New-server wizard option cards */
    .option-card{padding:12px 14px}
    .option-card .oc-name{font-size:0.9rem}
    .option-card .oc-price{font-size:0.9rem}
    .option-row{padding:10px 12px;flex-wrap:wrap}
    .option-row .or-sub{margin-left:0;width:100%}

    /* Advanced disclosure */
    details.adv>summary{padding:12px 14px;gap:10px;flex-wrap:wrap}
    details.adv>summary strong{font-size:0.9rem}
    details.adv .adv-summary{font-size:0.78rem;margin-left:0;width:100%;text-align:left}
    details.adv .adv-body{padding:14px}

    /* Deployment detail header grid */
    .card > div[style*="grid-template-columns"]{grid-template-columns:1fr !important;gap:12px}
    .card > div[style*="display:grid"] > div h2{margin:0 0 4px}

    /* Pager */
    .pager{flex-wrap:wrap;justify-content:center;padding:8px 4px;gap:8px;font-size:0.85rem}
    .pager span{flex:1 1 100%;text-align:center}

    /* Form input — iOS no-zoom */
    .form-input{font-size:16px}
    input[type="text"],input[type="password"]{font-size:16px}
  }

  /* Tiny phones (iPhone SE 1st gen, 320px). */
  @media (max-width: 480px) {
    body{font-size:14px}
    .menu-toggle{top:8px;left:8px;width:36px;height:36px}
    .sidebar{width:85vw;max-width:320px}
    body.sidebar-collapsed .sidebar{width:85vw;max-width:320px}
    main{padding:56px 12px 16px}
    h1{font-size:1.2rem;margin-bottom:14px}
    h2{font-size:0.88rem}
    .stat{padding:14px}
    .stat .value{font-size:1.3rem}
    .stat .label{font-size:0.7rem}
    .card{padding:14px}
    .terminal{height:45vh;min-height:200px}
    .form-input,input[type="text"],input[type="password"]{font-size:16px}
  }
</style>
</head>
<body>
<button class="menu-toggle" type="button" aria-label="Open menu">
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
</button>
<div class="sidebar-backdrop"></div>
${sidebarBlock}
<main>
${content}
</main>
<script>
(function(){
  // Desktop sidebar collapse (persisted in localStorage).
  var COLLAPSE_KEY = 'void-sidebar-collapsed';
  try { if (localStorage.getItem(COLLAPSE_KEY) === '1') document.body.classList.add('sidebar-collapsed'); } catch(e) {}
  var collapseBtn = document.querySelector('.sidebar-collapse');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', function(){
      var willCollapse = !document.body.classList.contains('sidebar-collapsed');
      document.body.classList.toggle('sidebar-collapsed', willCollapse);
      try { localStorage.setItem(COLLAPSE_KEY, willCollapse ? '1' : '0'); } catch(e) {}
    });
  }

  // Mobile drawer
  var menuBtn = document.querySelector('.menu-toggle');
  var backdrop = document.querySelector('.sidebar-backdrop');
  function setDrawer(open){
    document.body.classList.toggle('sidebar-open', open);
    if (menuBtn) menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  if (menuBtn) menuBtn.addEventListener('click', function(){
    setDrawer(!document.body.classList.contains('sidebar-open'));
  });
  if (backdrop) backdrop.addEventListener('click', function(){ setDrawer(false); });
  // Close drawer when a nav link is tapped (mobile UX)
  document.querySelectorAll('.sidebar a').forEach(function(a){
    a.addEventListener('click', function(){
      if (window.matchMedia('(max-width: 768px)').matches) setDrawer(false);
    });
  });
  // Esc closes the drawer
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') setDrawer(false); });
  // Resize to desktop: close drawer automatically
  var wasMobile = window.matchMedia('(max-width: 768px)').matches;
  window.addEventListener('resize', function(){
    var isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (wasMobile && !isMobile) setDrawer(false);
    wasMobile = isMobile;
  });
})();
</script>
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

export async function renderServersPage(
	c: any,
	user: { id: string; username: string; avatar_url: string | null } | null,
	flash: { kind: string | null; msg: string | null } = { kind: null, msg: null },
): Promise<Response> {
	const env = c.env;
	const { getCurrentProject } = await import("./state");
	const currentProject = await getCurrentProject(c);

	// Flash toast (top of page, auto-dismisses 8s — long enough to read
	// the provisioning ETA)
	const toast = flash.kind && flash.msg
		? `<div class="toast toast-${escape(flash.kind)}" id="toast">
			<span class="toast-icon">${flash.kind === "success" ? "✓" : "✕"}</span>
			<span class="toast-msg">${escape(flash.msg)}</span>
			<button type="button" class="toast-close" onclick="document.getElementById('toast').remove()" aria-label="Dismiss">×</button>
		</div>
		<script>setTimeout(function(){var t=document.getElementById('toast');if(t)t.remove()},8000)</script>`
		: "";

	// /servers shows ALL of the user's servers regardless of which
	// project is selected in the sidebar (the project filter is for
	// /dashboard and /deployments, not servers). Previously used an
	// INNER JOIN which hid newly-created servers that aren't yet linked
	// to a project.
	const { results } = await env.void_db
		.prepare(
			`SELECT s.id, s.name, s.provider, s.status, s.region, s.size, s.last_seen_at, s.tunnel_id IS NOT NULL AS has_tunnel,
			        s.hetzner_project_name, s.provider_server_id, s.ip_address,
			        s.created_at,
			        (SELECT COUNT(*) FROM deployments d WHERE d.server_id = s.id) AS deployment_count,
			        p.repo_url AS project_repo_url,
			        (SELECT ref FROM deployments d
			           WHERE d.server_id = s.id ORDER BY d.started_at DESC LIMIT 1) AS last_deploy_ref,
			        (SELECT commit_sha FROM deployments d
			           WHERE d.server_id = s.id ORDER BY d.started_at DESC LIMIT 1) AS last_deploy_commit,
			        (SELECT status FROM deployments d
			           WHERE d.server_id = s.id ORDER BY d.started_at DESC LIMIT 1) AS last_deploy_status,
			        (SELECT started_at FROM deployments d
			           WHERE d.server_id = s.id ORDER BY d.started_at DESC LIMIT 1) AS last_deploy_at
			 FROM servers s
			 LEFT JOIN projects p ON p.server_id = s.id
			 WHERE s.user_id = ?
			 ORDER BY s.created_at DESC`,
		)
		.bind(user!.id)
		.all<{
			id: string; name: string; provider: string; status: string; region: string; size: string;
			last_seen_at: number | null; has_tunnel: number; deployment_count: number;
			hetzner_project_name: string | null; provider_server_id: string | null;
			ip_address: string | null; created_at: number;
			project_repo_url: string | null;
			last_deploy_ref: string | null; last_deploy_commit: string | null;
			last_deploy_status: string | null; last_deploy_at: number | null;
		}>();

	// Pre-fetch live metrics from DO for active servers (parallel, won't slow down the rest of the page).
	const metricsByServerId = new Map<string, Metrics>();
	await Promise.allSettled(
		results.filter((s) => s.status === "active").map(async (s) => {
			try {
				const cellId = c.env.void_cell.idFromName(s.id);
				const stub = c.env.void_cell.get(cellId);
				const resp = await stub.fetch(`https://cell/${s.id}/metrics`);
				if (!resp.ok) return;
				const data: any = await resp.json();
				if (data.metrics) metricsByServerId.set(s.id, data.metrics as Metrics);
			} catch {
				// DO may not exist yet (agent never connected) — skip.
			}
		}),
	);

	const body = `
${toast}
<h1>Servers</h1>
<div class="actions">
  <a href="/servers/new" class="btn btn-primary">+ New server</a>
  <a href="https://github.com/void-sh/void" class="btn btn-secondary">via MCP (void_create_server)</a>
  <button class="btn btn-secondary" id="sync-all-btn" type="button" title="Re-check all servers' status with Hetzner">⟳ Sync all</button>
</div>
${results.length === 0
		? `<div class="card empty">
			<h2>No servers yet</h2>
			<p style="margin-bottom:16px">Provision a Hetzner Cloud VM. The void-agent auto-installs via cloud-init and registers with the control plane — no SSH, no manual setup.</p>
			<a href="/servers/new" class="btn btn-primary">+ Create your first server</a>
		</div>`
		: `<div class="server-grid" id="server-grid">
		${results.map((s) => renderServerCard(s, metricsByServerId.get(s.id))).join("")}
		</div>

<script>
// Auto-poll /api/servers every 10s for live status updates (D1 data only,
// no Hetzner calls). Pauses when the tab is hidden to save CPU.
(function(){
  var grid = document.getElementById('server-grid');
  if (!grid) return;
  function fmtTimeAgo(epoch){
    if (!epoch) return '—';
    var d = Math.floor(Date.now()/1000 - epoch);
    if (d < 60) return d + 's ago';
    if (d < 3600) return Math.floor(d/60) + 'm ago';
    if (d < 86400) return Math.floor(d/3600) + 'h ago';
    return Math.floor(d/86400) + 'd ago';
  }
  function paint(s){
    var isProv = s.status === 'provisioning';
    var elapsed = '';
    if (isProv && s.created_at) {
      var d = Math.floor(Date.now()/1000 - s.created_at);
      if (d < 60) elapsed = d + 's';
      else if (d < 3600) elapsed = Math.floor(d/60) + 'm';
      else elapsed = Math.floor(d/3600) + 'h';
    }
    var hw = (s.cpu != null && s.memory != null) ? '<span class="sc-specs-hw">' + s.cpu + ' vCPU · ' + s.memory + ' GB · ' + (s.disk != null ? s.disk : '?') + ' GB SSD</span>' : '';
    var providerLabel = (s.provider === 'manual' || !s.provider) ? 'manual' : s.provider;
    var repo = s.project_repo_url ? s.project_repo_url.replace(/^https?:\/\/(github\.com\/)?/, '').replace(/\.git$/, '') : null;
    var deployLine = s.last_deploy_ref ? '<div class="sc-meta-row"><span class="sc-meta-label">Deployed</span><span class="sc-deploy">' +
        (repo ? '<code class="mono">' + repo + '</code>' : '') +
        '<span class="sc-deploy-ref">' + (s.last_deploy_ref || '') + '</span>' +
        (s.last_deploy_commit ? '<span class="sc-deploy-sha mono">' + String(s.last_deploy_commit).slice(0,7) + '</span>' : '') +
        '<span class="status status-' + (s.last_deploy_status || 'queued') + ' sc-deploy-status">' + (s.last_deploy_status || 'queued') + '</span>' +
        '<span class="sc-deploy-age">' + fmtTimeAgo(s.last_deploy_at) + '</span>' +
      '</span></div>' : '';
    return '<div class="server-card' + (isProv ? ' provisioning' : '') + '" data-id="' + s.id + '">' +
      '<div class="sc-head">' +
        '<div class="sc-name">' + (s.name || '—') + '</div>' +
        '<span class="status status-' + s.status + '">' + s.status + '</span>' +
      '</div>' +
      (isProv ? '<div class="sc-progress"></div>' : '') +
      '<div class="sc-specs">' +
        (s.region ? '<span>' + s.region + '</span>' : '') +
        (s.size ? '<span>' + s.size + '</span>' : '') +
        hw +
        '<span class="sc-provider">' + providerLabel + '</span>' +
        (s.hetzner_project_name ? '<span class="sc-project">' + s.hetzner_project_name + '</span>' : '') +
      '</div>' +
      '<div class="sc-meta">' +
        (s.ip_address ? '<div class="sc-meta-row"><span class="sc-meta-label">IP</span><code class="mono">' + s.ip_address + '</code></div>' : '') +
        deployLine +
        '<div class="sc-meta-row"><span class="sc-meta-label">Deploys</span><span>' + s.deployment_count + '</span></div>' +
        '<div class="sc-meta-row"><span class="sc-meta-label">Last seen</span><span>' + fmtTimeAgo(s.last_seen_at) + '</span></div>' +
        '<div class="sc-meta-row"><span class="sc-meta-label">Created</span><span>' + fmtTimeAgo(s.created_at) + '</span></div>' +
        '<div class="sc-metrics" style="display:none" data-id="' + s.id + '">' +
          '<div class="sc-meta-row"><span class="sc-meta-label">CPU</span><span class="sc-metrics-cpu-' + s.id + '">\u2014</span></div>' +
          '<div class="sc-meta-row"><span class="sc-meta-label">Mem</span><span class="sc-metrics-mem-' + s.id + '">\u2014</span></div>' +
        '</div>' +
      '</div>' +
      (isProv ? '<div class="sc-progress-wait"><span class="sc-spinner"></span>Waiting for agent to register…<span class="sc-elapsed">' + elapsed + '</span></div>' : '') +
      '<div class="sc-actions">' +
        (s.provider_server_id && s.status !== 'destroyed' ? '<button class="btn btn-secondary sc-sync" data-id="' + s.id + '" style="padding:5px 10px;font-size:0.78rem">⟳ Sync</button>' : '') +
        '<button class="btn btn-danger sc-delete" data-id="' + s.id + '" data-name="' + (s.name || '').replace(/"/g, '&quot;') + '" style="padding:5px 10px;font-size:0.78rem">delete</button>' +
      '</div>' +
    '</div>';
  }
  async function poll(){
    if (document.hidden) return;
    try {
      var resp = await fetch('/api/servers-ui', { headers: { 'accept': 'application/json' } });
      if (!resp.ok) return;
      var data = await resp.json();
      if (!data.servers) return;
      // Re-render the grid (cheap — D1 typically has < 100 rows)
      grid.innerHTML = data.servers.map(paint).join('');
      // Fetch live metrics for active servers (also polled on own timer)
      data.servers.forEach(function(srv){
        if (srv.status !== 'active') return;
        fetchMetrics(srv.id);
      });
    } catch (e) {}
  }
  // Metrics poll: check every 5s so CPU/memory appear quickly after
  // the agent connects / the page loads.
  var activeIds = [];
  function refreshActiveIds(){
    var cards = document.querySelectorAll('.server-card');
    activeIds = [];
    cards.forEach(function(c){
      if (!c.classList.contains('provisioning')) activeIds.push(c.dataset.id);
    });
  }
  setInterval(function(){
    if (document.hidden) return;
    refreshActiveIds();
    activeIds.forEach(fetchMetrics);
  }, 5000);
  async function fetchMetrics(serverId){
    try {
      var resp = await fetch('/servers/' + serverId + '/metrics');
      if (!resp.ok) return;
      var data = await resp.json();
      if (!data.metrics) return;
      var el = document.querySelector('.sc-metrics[data-id="' + serverId + '"]');
      if (!el) return;
      el.style.display = '';
      el.querySelector('.sc-metrics-cpu-' + serverId).textContent = data.metrics.cpu_percent.toFixed(1) + '%';
      el.querySelector('.sc-metrics-mem-' + serverId).textContent = data.metrics.memory_percent.toFixed(1) + '% (' + data.metrics.memory_mb.toFixed(0) + ' MB)';
    } catch (e) {}
  }
  // Click handlers for sync/delete (delegated)
  grid.addEventListener('click', function(e){
    var t = e.target;
    if (t.classList.contains('sc-sync')) {
      e.preventDefault();
      t.disabled = true; t.textContent = 'syncing…';
      var fd = new FormData();
      fetch('/servers/' + t.dataset.id + '/sync', { method: 'POST', body: fd })
        .then(function(r){ if (r.ok) location.reload(); else { t.disabled = false; t.textContent = '⟳ Sync'; alert('Sync failed'); } })
        .catch(function(){ t.disabled = false; t.textContent = '⟳ Sync'; });
    }
    if (t.classList.contains('sc-delete')) {
      if (!confirm("Delete server '" + t.dataset.name + "'? This will try to delete the VM in Hetzner and remove it from void.")) {
        e.preventDefault();
      } else {
        t.disabled = true; t.textContent = 'deleting…';
        // Submit a form to /servers/:id/delete (since we used a button
        // in the JSON-painted version, not a form). Use fetch + redirect.
        var fd = new FormData();
        fetch('/servers/' + t.dataset.id + '/delete', { method: 'POST', body: fd })
          .then(function(){ window.location.reload(); })
          .catch(function(){ t.disabled = false; t.textContent = 'delete'; alert('Delete failed'); });
      }
    }
  });
  // "Sync all" button: hit /servers/:id/sync for each card in sequence
  var syncAll = document.getElementById('sync-all-btn');
  if (syncAll) {
    syncAll.addEventListener('click', function(){
      var btns = grid.querySelectorAll('.sc-sync');
      if (!btns.length) { alert('No servers with Hetzner IDs to sync.'); return; }
      syncAll.disabled = true;
      var orig = syncAll.textContent;
      var done = 0;
      btns.forEach(function(b){
        b.disabled = true; b.textContent = 'syncing…';
        fetch('/servers/' + b.dataset.id + '/sync', { method: 'POST' })
          .then(function(){ done++; b.textContent = '✓'; b.disabled = false; })
          .catch(function(){ done++; b.textContent = '✕'; b.disabled = false; })
          .finally(function(){
            if (done === btns.length) {
              syncAll.disabled = false;
              syncAll.textContent = orig;
              poll(); // refresh
            }
          });
      });
    });
  }
  // Poll every 10s
  setInterval(poll, 10000);
})();
</script>`}`;
	const allProjects = user ? await env.void_db
		.prepare("SELECT id, name, slug FROM projects WHERE user_id = ? ORDER BY created_at DESC")
		.bind(user.id)
		.all<{ id: string; name: string; slug: string }>() : { results: [] };
	return html(body, "Servers", {
		user,
		current: "/servers",
		currentProject,
		projects: allProjects.results,
	});
}

/**
 * Render a single server card. Used in the /servers grid and by the
 * auto-poll JS (which re-renders the same structure from JSON).
 */
function renderServerCard(s: {
	id: string; name: string; provider: string; status: string; region: string; size: string;
	last_seen_at: number | null; created_at: number; has_tunnel: number; deployment_count: number;
	hetzner_project_name: string | null; provider_server_id: string | null;
	ip_address: string | null; cpu: number | null; memory: number | null; disk: number | null;
	project_repo_url: string | null;
	last_deploy_ref: string | null; last_deploy_commit: string | null;
	last_deploy_status: string | null; last_deploy_at: number | null;
}, metrics?: Metrics): string {
	const isProvisioning = s.status === "provisioning";
	const elapsed = isProvisioning && s.created_at ? timeAgo(s.created_at) : "";
	const hasSpecs = s.cpu != null && s.memory != null;
	const providerLabel = s.provider === "manual" ? "manual" : (s.provider || "—");
	// Latest deployment summary — mirrors what Vercel/Coolify/Railway show
	// on a server/deployment card: what's deployed + its status + when.
	const deployRepo = s.project_repo_url
		? s.project_repo_url.replace(/^https?:\/\/(github\.com\/)?/, "").replace(/\.git$/, "")
		: null;
	const deployLine = s.last_deploy_ref
		? `<div class="sc-meta-row"><span class="sc-meta-label">Deployed</span><span class="sc-deploy">
				${deployRepo ? `<code class="mono">${escape(deployRepo)}</code>` : ""}
				<span class="sc-deploy-ref">${escape(s.last_deploy_ref)}</span>
				${s.last_deploy_commit ? `<span class="sc-deploy-sha mono">${escape(s.last_deploy_commit.slice(0, 7))}</span>` : ""}
				<span class="status status-${escape(s.last_deploy_status || "queued")} sc-deploy-status">${escape(s.last_deploy_status || "queued")}</span>
				<span class="sc-deploy-age">${timeAgo(s.last_deploy_at)}</span>
			</span></div>`
		: "";
	return `<div class="server-card${isProvisioning ? " provisioning" : ""}" data-id="${escape(s.id)}">
		<div class="sc-head">
			<div>
				<div class="sc-name">${escape(s.name)}</div>
				<div class="sc-id"><code class="mono">${escape(s.id)}</code></div>
			</div>
			<span class="status status-${escape(s.status)}">${escape(s.status)}</span>
		</div>
		${isProvisioning ? `<div class="sc-progress" title="Provisioning — agent will register in ~30-60s"></div>` : ""}
		<div class="sc-specs">
			${s.region ? `<span>${escape(s.region)}</span>` : ""}
			${s.size ? `<span>${escape(s.size)}</span>` : ""}
			${hasSpecs ? `<span class="sc-specs-hw" title="Specs">${s.cpu} vCPU · ${s.memory} GB · ${s.disk ?? "?"} GB SSD</span>` : ""}
			<span class="sc-provider" title="Provider">${escape(providerLabel)}</span>
			${s.hetzner_project_name ? `<span class="sc-project">${escape(s.hetzner_project_name)}</span>` : ""}
			${s.has_tunnel ? `<span class="sc-tunnel" title="Cloudflare tunnel active">↗ tunnel</span>` : ""}
		</div>
		<div class="sc-meta">
			${s.ip_address ? `<div class="sc-meta-row"><span class="sc-meta-label">IP</span><code class="mono">${escape(s.ip_address)}</code></div>` : ""}
			${deployLine}
			<div class="sc-meta-row"><span class="sc-meta-label">Deploys</span><span>${s.deployment_count}</span></div>
			<div class="sc-meta-row"><span class="sc-meta-label">Last seen</span><span>${timeAgo(s.last_seen_at)}</span></div>
			<div class="sc-meta-row"><span class="sc-meta-label">Created</span><span>${timeAgo(s.created_at)}</span></div>
			<div class="sc-metrics" style="${metrics ? "" : "display:none"}" data-id="${escape(s.id)}">
				<div class="sc-meta-row"><span class="sc-meta-label">CPU</span><span class="sc-metrics-cpu-${escape(s.id)}">${metrics ? `${metrics.cpu_percent.toFixed(1)}%` : "\u2014"}</span></div>
				<div class="sc-meta-row"><span class="sc-meta-label">Mem</span><span class="sc-metrics-mem-${escape(s.id)}">${metrics ? `${metrics.memory_percent.toFixed(1)}% (${Math.round(metrics.memory_mb)} MB)` : "\u2014"}</span></div>
			</div>
		</div>
		${isProvisioning ? `<div class="sc-progress-wait"><span class="sc-spinner"></span>Waiting for agent to register…<span class="sc-elapsed">${escape(elapsed)}</span></div>` : ""}
		<div class="sc-actions">
			${s.provider_server_id && s.status !== "destroyed" ? `<form method="POST" action="/servers/${escape(s.id)}/sync" style="display:inline" title="Re-check status with Hetzner">
				<button class="btn btn-secondary" type="submit" style="padding:5px 10px;font-size:0.78rem">⟳ Sync</button>
			</form>` : ""}
			<form method="POST" action="/servers/${escape(s.id)}/delete" style="display:inline" onsubmit="return confirm('Delete server ${escape(s.name)}? This will try to delete the VM in Hetzner and remove it from void.')">
				<button class="btn btn-danger" type="submit" style="padding:5px 10px;font-size:0.78rem">delete</button>
			</form>
		</div>
	</div>`;
}

// ============== Projects page ==============

export async function renderProjectsPage(
	c: any,
	user: { id: string; username: string; avatar_url: string | null } | null,
): Promise<Response> {
	const env = c.env;
	const { getCurrentProject } = await import("./state");
	const currentProject = await getCurrentProject(c);
	const projects = user ? await env.void_db
		.prepare("SELECT id, name, slug FROM projects WHERE user_id = ? ORDER BY created_at DESC")
		.bind(user.id)
		.all<{ id: string; name: string; slug: string }>() : { results: [] };

	const { results } = await env.void_db
		.prepare(
			`SELECT p.id, p.slug, p.name, p.repo_url, p.default_branch, p.default_port,
			        s.name AS server_name, s.id AS server_id,
			        (SELECT COUNT(*) FROM deployments d WHERE d.project_id = p.id) AS deployment_count
			 FROM projects p LEFT JOIN servers s ON s.id = p.server_id
			 WHERE p.user_id = ?
			 ORDER BY p.created_at DESC`,
		)
		.bind(user!.id)
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
	return html(body, "Projects", {
		user,
		current: "/projects",
		currentProject,
		projects: projects.results,
	});
}

// ============== Deployments page ==============

export async function renderDeploymentsPage(
	c: any,
	user: { id: string; username: string; avatar_url: string | null } | null,
	projectFilter: string | null,
	page: number = 1,
	perPage: number = 20,
): Promise<Response> {
	const env = c.env;
	const { getCurrentProject } = await import("./state");
	const currentProject = await getCurrentProject(c);
	const projects = user ? await env.void_db
		.prepare("SELECT id, name, slug FROM projects WHERE user_id = ? ORDER BY created_at DESC")
		.bind(user.id)
		.all<{ id: string; name: string; slug: string }>() : { results: [] };

	// If no explicit projectFilter, use the current project from cookie.
	const effectiveFilter = projectFilter || currentProject?.id || null;
	const offset = (page - 1) * perPage;

	// Total count for pagination
	const countQuery = effectiveFilter
		? "SELECT COUNT(*) AS n FROM deployments WHERE project_id = ?"
		: "SELECT COUNT(*) AS n FROM deployments";
	const countRow = effectiveFilter
		? await env.void_db.prepare(countQuery).bind(effectiveFilter).first<{ n: number }>()
		: await env.void_db.prepare(countQuery).first<{ n: number }>();
	const total = countRow?.n || 0;
	const totalPages = Math.max(1, Math.ceil(total / perPage));

	const query = effectiveFilter
		? `SELECT d.id, d.ref, d.status, d.started_at, d.finished_at, d.duration_ms, d.hostname, d.public_url, d.commit_sha,
		        p.name AS project_name, p.slug AS project_slug, s.name AS server_name
		 FROM deployments d LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN servers s ON s.id = d.server_id
		 WHERE d.project_id = ? ORDER BY d.started_at DESC LIMIT ? OFFSET ?`
		: `SELECT d.id, d.ref, d.status, d.started_at, d.finished_at, d.duration_ms, d.hostname, d.public_url, d.commit_sha,
		        p.name AS project_name, p.slug AS project_slug, s.name AS server_name
		 FROM deployments d LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN servers s ON s.id = d.server_id
		 ORDER BY d.started_at DESC LIMIT ? OFFSET ?`;

	const stmt = effectiveFilter
		? env.void_db.prepare(query).bind(effectiveFilter, perPage, offset)
		: env.void_db.prepare(query).bind(perPage, offset);
	const { results } = await stmt.all<{
		id: string; ref: string; status: string; started_at: number; finished_at: number | null;
		duration_ms: number | null; hostname: string | null; public_url: string | null; commit_sha: string | null;
		project_name: string | null; project_slug: string | null; server_name: string | null;
	}>();

	const body = `
<h1>Deployments${currentProject ? ` <span class="sub-meta">— ${escape(currentProject.name)}</span>` : ""}</h1>
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
	return html(body, "Deployments", {
		user,
		current: "/deployments",
		currentProject,
		projects: projects.results,
	});
}

// ============== Single deployment log viewer ==============

export async function renderDeploymentLogsPage(
	c: any,
	user: { id: string; username: string; avatar_url: string | null } | null,
	deploymentId: string,
): Promise<Response> {
	const env = c.env;
	const { getCurrentProject } = await import("./state");
	const currentProject = await getCurrentProject(c);
	const projects = user ? await env.void_db
		.prepare("SELECT id, name, slug FROM projects WHERE user_id = ? ORDER BY created_at DESC")
		.bind(user.id)
		.all<{ id: string; name: string; slug: string }>() : { results: [] };

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
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<script>
(function(){
  // Smaller font on phones so build logs don't scroll off the right edge;
  // xterm ignores CSS font-size (the canvas is sized from fontSize option).
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const term = new Terminal({
    convertEol: true,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: isMobile ? 10 : 13,
    theme: { background: '#000000', foreground: '#e0e0e0' },
    scrollback: 10000,
  });
  // FitAddon sizes the terminal to its container — without it, xterm
  // renders 80 cols regardless of viewport, which is unreadable on a
  // 360px phone. Re-fit on resize/orientation change.
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  try { term.loadAddon(new WebglAddon.WebglAddon()); } catch(e) {}
  term.open(document.getElementById('terminal'));
  fitAddon.fit();
  window.addEventListener('resize', () => { try { fitAddon.fit(); } catch(e) {} });
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

	return html(body, `${dep.id} · logs`, {
		user,
		current: "/deployments",
		currentProject,
		projects: projects.results,
	});
}

// ============================================================
// Dashboard
// ============================================================

/**
 * Overview page: stat tiles + recent activity. Queries D1 in parallel
 * to keep latency low. Falls back to 0s on empty DB.
 */
export async function renderDashboardPage(
	c: any,
	user: { id: string; username: string; avatar_url: string | null } | null,
): Promise<Response> {
	const env = c.env;
	const { getCurrentProject } = await import("./state");
	const currentProject = await getCurrentProject(c);
	const projectId = currentProject?.id || null;

	// Project list for the sidebar switcher
	const allProjects = user ? await env.void_db
		.prepare("SELECT id, name, slug FROM projects WHERE user_id = ? ORDER BY created_at DESC")
		.bind(user.id)
		.all<{ id: string; name: string; slug: string }>() : { results: [] };

	// Filter queries by current project (1:1 project→server via projects.server_id)
	const [servers, projects, deploys, recent] = await Promise.all([
		projectId
			? env.void_db.prepare("SELECT COUNT(*) AS n FROM servers s INNER JOIN projects p ON p.server_id = s.id WHERE p.id = ? AND p.user_id = ?").bind(projectId, user.id).first<{ n: number }>()
			: env.void_db.prepare("SELECT COUNT(*) AS n FROM servers WHERE user_id = ?").bind(user.id).first<{ n: number }>(),
		projectId
			? env.void_db.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ? AND id = ?").bind(user.id, projectId).first<{ n: number }>()
			: env.void_db.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?").bind(user.id).first<{ n: number }>(),
		projectId
			? env.void_db.prepare("SELECT COUNT(*) AS n FROM deployments WHERE project_id = ? AND started_at > unixepoch() - 86400").bind(projectId).first<{ n: number }>()
			: env.void_db.prepare("SELECT COUNT(*) AS n FROM deployments WHERE started_at > unixepoch() - 86400").first<{ n: number }>(),
		projectId
			? env.void_db
				.prepare(
					`SELECT d.id, d.status, d.started_at, d.public_url, p.name AS project_name
					 FROM deployments d LEFT JOIN projects p ON p.id = d.project_id
					 WHERE d.project_id = ? ORDER BY d.started_at DESC LIMIT 8`,
				)
				.bind(projectId)
				.all<{ id: string; status: string; started_at: number; public_url: string | null; project_name: string | null }>()
			: env.void_db
				.prepare(
					`SELECT d.id, d.status, d.started_at, d.public_url, p.name AS project_name
					 FROM deployments d LEFT JOIN projects p ON p.id = d.project_id
					 ORDER BY d.started_at DESC LIMIT 8`,
				)
				.all<{ id: string; status: string; started_at: number; public_url: string | null; project_name: string | null }>(),
	]);

	const stats = [
		{ label: "Servers", value: servers?.n ?? 0, sub: currentProject ? "in this project" : "active hosts" },
		{ label: "Projects", value: projects?.n ?? 0, sub: currentProject ? "selected" : "registered repos" },
		{ label: "Deploys (24h)", value: deploys?.n ?? 0, sub: currentProject ? "this project, 24h" : "last 24 hours" },
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
<h1>Dashboard${currentProject ? ` <span class="sub-meta">— ${escape(currentProject.name)}</span>` : ""}</h1>

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

	return html(body, "Dashboard", {
		user,
		current: "/dashboard",
		currentProject,
		projects: allProjects.results,
	});
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
	c: any,
	user: { id: string; username: string; avatar_url: string | null } | null,
	flash: { kind: string | null; msg: string | null } = { kind: null, msg: null },
): Promise<Response> {
	const env = c.env;
	const { getCurrentProject } = await import("./state");
	const currentProject = await getCurrentProject(c);
	const projects = user ? await env.void_db
		.prepare("SELECT id, name, slug FROM projects WHERE user_id = ? ORDER BY created_at DESC")
		.bind(user.id)
		.all<{ id: string; name: string; slug: string }>() : { results: [] };

	// Flash toast (rendered at top, auto-dismisses after 4s)
	const toast = flash.kind && flash.msg
		? `<div class="toast toast-${escape(flash.kind)}" id="toast">
			<span class="toast-icon">${flash.kind === "success" ? "✓" : "✕"}</span>
			<span class="toast-msg">${escape(flash.msg)}</span>
			<button type="button" class="toast-close" onclick="document.getElementById('toast').remove()" aria-label="Dismiss">×</button>
		</div>
		<script>setTimeout(function(){var t=document.getElementById('toast');if(t)t.remove()},4000)</script>`
		: "";

	// Look up full user record for accurate info
	const fullUser = user
		? await env.void_db
				.prepare(
					"SELECT id, username, avatar_url, github_id, created_at FROM users WHERE id = ?",
				)
				.bind(user.id)
				.first<{ id: string; username: string; avatar_url: string | null; github_id: string; created_at: number }>()
		: null;

	// Per-user provider credentials
	const { listProviderCredentials } = await import("./credentials");
	const creds = user ? await listProviderCredentials(env, user.id) : [];
	const hetznerCred = creds.find((c) => c.provider === "hetzner");

	// Passkeys for the Authentication section
	const { listPasskeys } = await import("./passkey");
	const passkeys = user ? await listPasskeys(env, user.id) : [];

	// System settings — list of keys currently overridden in D1
	// (so we can show "Set" vs "Falling back to env" in the UI).
	const { listOverriddenSystemTokens, SYSTEM_KEYS } = await import("./system-settings");
	const overriddenSystemTokens = user ? await listOverriddenSystemTokens(env) : new Set();

	const body = `
${toast}
<h1>Settings</h1>

${fullUser
	? `<div class="connected-account">
		<div class="ca-icon">
			<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
			<span class="ca-pulse" title="Active session"></span>
		</div>
		<div class="ca-info">
			<div class="ca-name">@${escape(fullUser.username)}</div>
			<div class="ca-meta">
				<span class="ca-provider">GitHub</span>
				<span class="ca-sep">·</span>
				<span>joined ${timeAgo(fullUser.created_at)}</span>
				${passkeys.length > 0 ? `<span class="ca-sep">·</span><span>${passkeys.length} passkey${passkeys.length === 1 ? "" : "s"}</span>` : ""}
				<span class="ca-sep">·</span>
				<span>session 30d</span>
			</div>
		</div>
		<a class="ca-logout" href="/api/auth/logout" title="Sign out of void">Sign out</a>
	</div>`
	: `<p class="meta">Not signed in</p>`}

<div class="card" style="padding:28px 28px">
	<h2 style="margin-top:0">Cloud providers</h2>
	<p class="meta" style="margin:0 0 20px;font-size:0.85rem;line-height:1.5">Connect a cloud provider to provision servers. Your API token is encrypted at rest with AES-256-GCM and only used to call the provider's API for your account.</p>

	<div class="provider-widget">
		<a class="pw-icon" href="https://console.hetzner.cloud" target="_blank" rel="noopener" title="Open Hetzner Cloud Console">
			<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
				<rect width="32" height="32" rx="6" fill="#D50C2D"/>
				<path d="M9 7v18h3v-7h8v7h3V7h-3v8h-8V7z" fill="white"/>
			</svg>
			${hetznerCred ? '<span class="pw-pulse" title="Connected"></span>' : ''}
		</a>
		<div class="pw-info">
			<div class="pw-name">Hetzner Cloud <span class="pw-tag">Official</span></div>
			<div class="pw-meta">
				${
					hetznerCred
						? `<span class="pw-status-ok">✓ Token saved ${timeAgo(hetznerCred.created_at)}</span>${hetznerCred.verified_datacenters ? `<span class="pw-sep">·</span><span>${hetznerCred.verified_datacenters} datacenters reachable</span>` : ""}`
						: `<span class="pw-status-missing">Not configured</span><span class="pw-sep">·</span><span>Add your API token to provision VMs</span>`
				}
			</div>
		</div>
		<div class="pw-action">
			${
				hetznerCred
					? `<form method="POST" action="/settings/hetzner/delete" onsubmit="return confirm('Delete Hetzner API token? New server creates will fall back to env HETZNER_TOKEN if set, otherwise use stub mode.')">
							<button type="submit" class="btn btn-secondary" style="padding:8px 14px;font-size:0.85rem">Delete token</button>
						</form>`
					: ``
			}
		</div>
	</div>

	${
		!hetznerCred
			? `<form method="POST" action="/settings/hetzner" id="hetzner-form" style="margin-top:16px;display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
					<div style="flex:1;min-width:240px;position:relative">
						<input type="password" name="token" id="hetzner-token" placeholder="Hetzner API token" autocomplete="off" spellcheck="false" style="width:100%;padding:10px 32px 10px 12px;background:#000;border:1px solid #333;border-radius:8px;color:#fff;font-family:ui-monospace,monospace;font-size:0.9rem;box-sizing:border-box">
						<span id="hetzner-check" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:0.95rem;pointer-events:none;display:none"></span>
					</div>
					<button type="button" id="hetzner-test" class="btn btn-secondary" style="padding:10px 16px" disabled>Test</button>
					<button type="submit" id="hetzner-submit" class="btn btn-primary" style="padding:10px 16px" disabled>Save</button>
				</form>
				<small id="hetzner-error" style="display:block;margin-top:8px;color:#f55;min-height:1em;font-size:0.8rem"></small>
				<small id="hetzner-hint" style="display:block;margin-top:8px;color:#666;font-size:0.8rem">Get a token at <a href="https://console.hetzner.cloud" target="_blank" rel="noopener" style="color:#D50C2D">console.hetzner.cloud</a> → Security → API Tokens</small>
				${env.HETZNER_TOKEN ? `<small style="display:block;margin-top:8px;color:#666;font-size:0.8rem">Tip: env HETZNER_TOKEN is also set as a fallback for this deployment.</small>` : ""}
				<script>
				(function(){
					var input = document.getElementById('hetzner-token');
					var submit = document.getElementById('hetzner-submit');
					var testBtn = document.getElementById('hetzner-test');
					var check = document.getElementById('hetzner-check');
					var error = document.getElementById('hetzner-error');
					var form = document.getElementById('hetzner-form');
					var pattern = /^[A-Za-z0-9_=+-]{30,}$/;
					function validate(){
						var v = input.value.trim();
						if(!v){submit.disabled=true;testBtn.disabled=true;check.style.display='none';input.style.borderColor='#333';error.textContent='';return}
						if(pattern.test(v)){
							submit.disabled=false;testBtn.disabled=false;check.textContent='✓';check.style.color='#0f0';check.style.display='inline';
							input.style.borderColor='#1f6b3d';error.textContent='';
						} else {
							submit.disabled=true;testBtn.disabled=true;
							input.style.borderColor='#6b1f1f';
							if(v.length<30) error.textContent='Token too short';
							else error.textContent='Invalid characters in token (only letters, digits, _, =, +, -)';
						}
					}
					input.addEventListener('input', validate);
					form.addEventListener('submit', function(e){
						if(!pattern.test(input.value.trim())){e.preventDefault();input.focus();return false}
					});
					testBtn.addEventListener('click', function(){
						if(!pattern.test(input.value.trim()))return;
						var orig = testBtn.textContent; testBtn.disabled=true; testBtn.textContent='Testing…';
						var fd = new FormData(); fd.append('token', input.value.trim());
						fetch('/settings/hetzner/test', { method:'POST', body: fd })
							.then(function(r){ return r.json().then(function(j){return{ok:r.ok,json:j}}) })
							.then(function(res){
								if(res.ok && res.json && res.json.ok){
									check.textContent='✓';check.style.color='#0f0';check.style.display='inline';
									input.style.borderColor='#1f6b3d';error.style.color='#0f0';
									error.textContent='Token works — verified by Hetzner API ('+(res.json.datacenters||0)+' datacenters reachable)';
								} else {
									check.style.display='none';input.style.borderColor='#6b1f1f';
									error.style.color='#f55';
									error.textContent=(res.json && res.json.reason) || 'Verification failed';
								}
							})
							.catch(function(e){
								check.style.display='none';input.style.borderColor='#6b1f1f';
								error.style.color='#f55';error.textContent='Network error: '+(e.message||e);
							})
							.finally(function(){ testBtn.disabled=false; testBtn.textContent=orig; });
					});
				})();
				</script>`
			: ``
	}
</div>

<div class="card">
	<h2 style="margin-top:0">Passkeys</h2>
	<p class="meta" style="margin:0 0 16px;font-size:0.85rem">Use your device's biometric (TouchID, FaceID, Windows Hello) or a hardware key to sign in — no password, no GitHub round-trip.</p>

	${passkeys.length === 0
		? `<p class="meta" style="margin:0 0 16px">No passkeys yet. Add one below.</p>`
		: `<table style="margin-bottom:16px">
			<thead><tr><th>Name</th><th>Added</th><th>Last used</th><th></th></tr></thead>
			<tbody>
			${passkeys
				.map(
					(p) => `<tr>
					<td><strong>${escape(p.name)}</strong></td>
					<td class="meta">${timeAgo(p.created_at)}</td>
					<td class="meta">${p.last_used_at ? timeAgo(p.last_used_at) : "never"}</td>
					<td>
						<form method="POST" action="/api/passkey/delete" style="display:inline" onsubmit="return confirm('Delete this passkey? You will not be able to use it to sign in anymore.')">
							<input type="hidden" name="id" value="${escape(p.id)}">
							<button type="submit" class="btn btn-secondary" style="padding:4px 10px;font-size:0.8rem">delete</button>
						</form>
					</td>
				</tr>`,
				)
				.join("")}
			</tbody>
		</table>`}

	<form id="passkey-add-form" onsubmit="addPasskey(event)" style="display:flex;gap:8px;align-items:center">
		<input type="text" id="passkey-name" placeholder="MacBook TouchID, iPhone 15 Pro, YubiKey 5..." maxlength="64" autocomplete="off" style="flex:1;padding:8px 10px;background:#000;border:1px solid #333;border-radius:6px;color:#fff;font-size:0.9rem;font-family:inherit;box-sizing:border-box">
		<button type="submit" id="passkey-add-btn" class="btn btn-primary" style="padding:8px 14px">+ Add passkey</button>
	</form>
	<small id="passkey-msg" style="display:block;margin-top:8px;font-size:0.85rem;min-height:1.2em"></small>
</div>
</div>

<div class="card">
	<details>
		<summary style="cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;user-select:none">
			<h2 style="margin:0;display:inline">System settings <span class="pill" style="background:#1a1a1a;color:#888;border:1px solid #333;font-size:0.7rem;vertical-align:middle;margin-left:8px">advanced</span></h2>
			<span class="meta" style="font-size:0.8rem">${
				overriddenSystemTokens.size > 0
					? `${overriddenSystemTokens.size} of ${SYSTEM_KEYS.length} set in panel`
					: `all ${SYSTEM_KEYS.length} falling back to env`
			}</span>
		</summary>
		<p class="meta" style="margin:16px 0;font-size:0.85rem;line-height:1.5">
			Operator-managed tokens. Encrypted at rest with AES-256-GCM.
			If unset, the worker falls back to environment variables (if any).
			The deploy workflow only ships <code>GITHUB_CLIENT_ID</code> and
			<code>GITHUB_CLIENT_SECRET</code> — set everything else here.
		</p>
	${
		SYSTEM_KEYS.map((k) => {
			const isSet = overriddenSystemTokens.has(k.key);
			return `<div class="settings-row" style="align-items:flex-start;padding:18px 0">
				<div class="label" style="flex:1;padding-right:20px">
					<strong>${escape(k.label)}</strong>
					<small>${escape(k.description)}</small>
					${
						k.warning
							? `<small style="color:#f90;display:flex;align-items:center;gap:4px;margin-top:4px">⚠ ${escape(k.warning)}</small>`
							: ""
					}
					<div style="margin-top:6px">
						${
							isSet
								? `<span class="pill" style="background:rgba(0,255,136,0.12);color:#0f8;border:1px solid rgba(0,255,136,0.25);font-size:0.72rem">✓ Set in panel</span>`
								: `<span class="pill" style="background:#1a1a1a;color:#888;border:1px solid #222;font-size:0.72rem">Falling back to env</span>`
						}
					</div>
				</div>
				<div class="value" style="flex:1;min-width:300px">
					<form method="POST" action="/settings/system/${escape(k.key)}" style="display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap">
						${
							k.textarea
								? `<textarea name="value" placeholder="${escape(k.placeholder)}" rows="6" autocomplete="off" spellcheck="false" style="flex:1;min-width:280px;padding:8px 10px;background:#000;border:1px solid #333;border-radius:6px;color:#fff;font-family:ui-monospace,monospace;font-size:0.8rem;box-sizing:border-box;resize:vertical"></textarea>`
								: `<input type="password" name="value" placeholder="${escape(k.placeholder)}" autocomplete="off" spellcheck="false" style="flex:1;min-width:240px;padding:8px 10px;background:#000;border:1px solid #333;border-radius:6px;color:#fff;font-family:ui-monospace,monospace;font-size:0.85rem;box-sizing:border-box">`
						}
						<button type="submit" class="btn btn-primary" style="padding:8px 14px;white-space:nowrap">Save</button>
						${
							isSet
								? `<button type="submit" formaction="/settings/system/${escape(k.key)}/delete" formmethod="POST" class="btn btn-danger" style="padding:8px 14px;white-space:nowrap" onclick="return confirm('Clear ${escape(k.label)}? Worker will fall back to env var (or fail if env not set either).')">Clear</button>`
								: ""
						}
					</form>
				</div>
			</div>`;
		}).join("")
	}
	</details>
</div>

<div class="card">
	<h2 style="margin-top:0">Danger zone</h2>
	<div class="settings-row">
		<div class="label">Delete account<small>Permanently remove your account and all data</small></div>
		<button class="btn btn-danger" disabled>Delete account</button>
	</div>
</div>

<!-- Passkey JS — loaded as a module from jsdelivr's +esm endpoint.
     startRegistration handles all base64url ↔ ArrayBuffer conversion
     and the create() / get() Promise wrappers. -->
<script type="module">
import { startRegistration } from 'https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@13.1.0/+esm';

window.addPasskey = async function(e) {
  e.preventDefault();
  const nameEl = document.getElementById('passkey-name');
  const btn = document.getElementById('passkey-add-btn');
  const msg = document.getElementById('passkey-msg');
  const name = (nameEl.value || '').trim() || 'Passkey';
  msg.style.color = '#888';
  msg.textContent = 'Starting…';
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = 'Working…';
  try {
    const optsResp = await fetch('/api/passkey/register/start', { method: 'POST' });
    if (!optsResp.ok) {
      const j = await optsResp.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + optsResp.status));
    }
    const opts = await optsResp.json();
    let attResp;
    try {
      attResp = await startRegistration({ optionsJSON: opts });
    } catch (regErr) {
      throw new Error(regErr && regErr.name === 'NotAllowedError'
        ? 'Cancelled or no authenticator available'
        : ((regErr && regErr.message) || 'Registration failed'));
    }
    const verifyResp = await fetch('/api/passkey/register/finish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, response: attResp })
    });
    const result = await verifyResp.json();
    if (!result.ok) throw new Error(result.error || 'Verification failed');
    msg.style.color = '#0f0';
    msg.textContent = '✓ Passkey added — reloading…';
    setTimeout(() => location.reload(), 600);
  } catch (err) {
    msg.style.color = '#f55';
    msg.textContent = '✕ ' + (err.message || err);
    btn.disabled = false;
    btn.textContent = origText;
  }
};
</script>
`;

	return html(body, "Settings", {
		user,
		current: "/settings",
		currentProject,
		projects: projects.results,
	});
}

// ============================================================
// New server (provisioning wizard)
// ============================================================

/**
 * /servers/new — pick a Hetzner location, size, image, and name; submit
 * to create a real VM. Catalog is fetched from the Hetzner API (cached
 * in KV) using the user's per-user token if set, else env HETZNER_TOKEN.
 *
 * If no token is available anywhere, the form is replaced with a
 * friendly "add your token first" message and a link to /settings.
 */
export async function renderNewServerPage(
	c: any,
	user: { id: string; username: string; avatar_url: string | null } | null,
	opts: {
		error?: string | null;
		values?: { name?: string; region?: string; size?: string; image?: string };
	} = {},
): Promise<Response> {
	const env = c.env;
	const { getCurrentProject } = await import("./state");
	const currentProject = await getCurrentProject(c);
	const projects = user ? await env.void_db
		.prepare("SELECT id, name, slug FROM projects WHERE user_id = ? ORDER BY created_at DESC")
		.bind(user.id)
		.all<{ id: string; name: string; slug: string }>() : { results: [] };

	const { getProviderToken } = await import("./credentials");
	const { listServerTypes, listLocations, listImages } = await import("./hetzner");

	const token = user
		? await getProviderToken(env, user.id, "hetzner")
		: (env.HETZNER_TOKEN || null);

	// Flash toast (e.g. "Catalog refreshed") — read from ?toast=&msg= query
	const flashKind = c.req.query("toast");
	const flashMsg = c.req.query("msg");
	const toast = flashKind && flashMsg
		? `<div class="toast toast-${escape(flashKind)}" id="toast">
			<span class="toast-icon">${flashKind === "success" ? "✓" : "✕"}</span>
			<span class="toast-msg">${escape(flashMsg)}</span>
			<button type="button" class="toast-close" onclick="document.getElementById('toast').remove()" aria-label="Dismiss">×</button>
		</div>
		<script>setTimeout(function(){var t=document.getElementById('toast');if(t)t.remove()},6000)</script>`
		: "";

	let types: any[] = [];
	let locations: any[] = [];
	let images: any[] = [];
	let catalogError: string | null = null;

	if (token) {
		try {
			[types, locations, images] = await Promise.all([
				listServerTypes(env, token),
				listLocations(env, token),
				listImages(env, token, { architecture: "x86" }),
			]);
		} catch (e: any) {
			catalogError = e?.message || String(e);
		}
	}

	const v = opts.values || {};
	const selRegion = (r: string) => v.region === r ? "checked" : "";
	const selSize = (s: string) => v.size === s ? "checked" : (v.size ? "" : (s === "cx22" ? "checked" : ""));

	// Default OS image — explicit, not dynamic. The void agent is built
	// and tested on Ubuntu LTS; we pin to the LTS we know works. The
	// user can change it in the "Advanced" section if they want. If the
	// Hetzner catalog returns zero images, we treat that as a real
	// failure (the Hetzner API or the token is broken) — see the
	// images-empty check in the body builder below.
	const DEFAULT_IMAGE = "ubuntu-26.04";
	const defaultImage = v.image || DEFAULT_IMAGE;
	const selImage = (i: string) => v.image === i ? "checked" : (v.image ? "" : (i === DEFAULT_IMAGE ? "checked" : ""));

	// No token at all → "add token" card
	const body = !token
		? `
<h1>New server</h1>
<div class="card">
	<div style="text-align:center;padding:40px 20px">
		<div style="font-size:3rem;margin-bottom:16px;color:#D50C2D;opacity:0.6">⚠</div>
		<h2 style="margin:0 0 12px;color:#fff;font-size:1.25rem;text-transform:none">Hetzner token required</h2>
		<p class="meta" style="margin:0 0 20px;max-width:480px;margin-left:auto;margin-right:auto">
			To provision real Hetzner Cloud VMs we need an API token with read+write scope.
			Add yours in <a href="/settings" style="color:#6cf">/settings → Cloud providers</a>,
			or ask the operator to set the <code>HETZNER_TOKEN</code> env var for server-wide use.
		</p>
		<a href="/settings" class="btn btn-primary">Add Hetzner token</a>
	</div>
</div>
`
		: `
${toast}
<h1>New server</h1>
<div class="actions" style="margin-bottom:16px;align-items:center">
  <form method="POST" action="/api/hetzner/catalog/refresh" style="display:inline" title="Force-refresh server types, locations, and images from Hetzner (1h cache by default)">
    <button class="btn btn-secondary" type="submit" style="padding:6px 12px;font-size:0.78rem">⟳ Refresh catalog</button>
  </form>
  <label style="display:inline-flex;align-items:center;gap:6px;color:#888;font-size:0.82rem;margin-left:8px;cursor:pointer">
    <input type="checkbox" id="show-all-types" style="accent-color:#0f8"> Show all server types
  </label>
  <span class="meta" style="margin-left:auto;font-size:0.75rem">Default: under €50/mo · Catalog cached 1h per token</span>
</div>
<p class="meta" style="margin:0 0 20px">Pick a location, server type, image, and a name. Provisioning takes ~30 seconds. Agent auto-registers when cloud-init completes.</p>

${opts.error ? `<div class="form-error">✕ ${escape(opts.error)}</div>` : ""}
${catalogError ? `<div class="form-error">✕ Failed to load Hetzner catalog: ${escape(catalogError)}. Check your token in <a href="/settings" style="color:#6cf;text-decoration:underline">/settings</a>.</div>` : ""}
${
	!catalogError && (images.length === 0 || locations.length === 0 || types.length === 0)
		? `<div class="form-error">✕ Hetzner API returned an empty catalog (${images.length} images, ${locations.length} locations, ${types.length} server types). This usually means the Hetzner Cloud API is down or your token is restricted. Check <a href="https://status.hetzner.cloud" target="_blank" rel="noopener" style="color:#6cf;text-decoration:underline">status.hetzner.cloud</a> and your <a href="/settings" style="color:#6cf;text-decoration:underline">/settings</a>.</div>`
		: ""
}

<form method="POST" action="/servers/new" id="new-server-form">
	<div class="form-section">
		<h2>Location</h2>
		<p class="form-hint">Where to physically provision the VM. Closer = lower latency.</p>
		<div class="option-grid cols-4">
		${locations
			.map(
				(loc) => `<label class="option-card">
					<input type="radio" name="region" value="${escape(loc.name)}" ${selRegion(loc.name) || (!v.region && loc.name === "fsn1") ? "checked" : ""}>
					<div class="oc-name">${escape(loc.name.toUpperCase())}</div>
					<div class="oc-sub">${escape(loc.city)} · ${escape(loc.country)}</div>
					<span class="oc-check"></span>
				</label>`,
			)
			.join("")}
		</div>
	</div>

	<div class="form-section">
		<h2>Server type</h2>
		<p class="form-hint">vCPU + RAM + SSD. List is filtered by your selected location.</p>
		<div class="option-grid cols-3" id="type-grid">
		${types
			.map(
				(t) => `<label class="option-card" data-locations="${escape(t.available_locations.join(","))}" data-price="${t.price_monthly}">
					<input type="radio" name="size" value="${escape(t.name)}" ${selSize(t.name)}>
					<div class="oc-name">${escape(t.name)}</div>
					<div class="oc-specs"><span>${t.cores} vCPU</span><span>${t.memory} GB RAM</span><span>${t.disk} GB SSD</span></div>
					<div class="oc-price">${escape(t.price_display)}</div>
					<span class="oc-check"></span>
				</label>`,
			)
			.join("")}
		</div>
		<small id="type-empty" style="display:none;color:#f90;margin-top:8px">No server types under €50/mo available in this location. Toggle "Show all" or try a different one.</small>
	</div>

	<details class="adv">
		<summary>
			<strong>Advanced</strong>
			<span class="adv-summary">Image: <code id="adv-image">${escape((v.image || defaultImage))}</code></span>
		</summary>
		<div class="adv-body">
			<p class="form-hint" style="margin-top:0">OS image. The void-agent is built and tested on Ubuntu LTS — the default is the latest LTS available. Other distros work but are experimental.</p>
			${images
				.map(
					(img) => `<label class="option-row">
						<input type="radio" name="image" value="${escape(img.name)}" ${selImage(img.name)} onchange="document.getElementById('adv-image').textContent = this.value">
						<div class="or-name">${escape(img.name)}</div>
						<div class="or-sub">${escape(img.os_flavor)}${img.os_version ? " " + escape(img.os_version) : ""}${img.rapid_deploy ? " · rapid deploy" : ""}</div>
					</label>`,
				)
				.join("")}
		</div>
	</details>

	<div class="form-section">
		<h2>Name</h2>
		<p class="form-hint">Lowercase letters, digits, dashes. 1-32 chars. Used in agent config and DNS.</p>
		<input type="text" name="name" id="name-input" class="form-input" placeholder="my-server" value="${escape(v.name || "")}" required pattern="[a-z][a-z0-9-]{0,31}" maxlength="32" autocomplete="off" spellcheck="false">
	</div>

	<div class="form-actions">
		<a href="/servers" class="btn btn-secondary">Cancel</a>
		<button type="submit" class="btn btn-primary" id="submit-btn">Create server</button>
	</div>
</form>

<script>
// Disable the submit button on submit to prevent double-clicks, and
// generate a default name from the selected region+type if the user
// didn't fill in one.
(function(){
  var form = document.getElementById('new-server-form');
  if (!form) return;
  var submit = document.getElementById('submit-btn');
  var nameInput = document.getElementById('name-input');
  var typeGrid = document.getElementById('type-grid');
  var typeEmpty = document.getElementById('type-empty');

  // Filter the server type list by:
  //   1. selected location (data-locations)
  //   2. price ≤ 50 EUR/mo (data-price) — keep the default view focused
  //      on cheap shared instances; user can toggle "Show all" to see
  //      dedicated/large types
  // "Show all types" checkbox bypasses both filters.
  function filterTypes(){
    if (!typeGrid) return;
    if (showAll && showAll.checked) {
      // Escape hatch — show every type, no filtering
      typeGrid.querySelectorAll('.option-card[data-locations]').forEach(function(card){
        card.style.display = '';
      });
      if (typeEmpty) typeEmpty.style.display = 'none';
      return;
    }
    var regionEl = form.querySelector('input[name="region"]:checked');
    var region = regionEl ? regionEl.value : '';
    if (!region) return;
    var priceLimit = 50; // EUR/mo
    var firstVisible = null;
    var cards = typeGrid.querySelectorAll('.option-card[data-locations]');
    cards.forEach(function(card){
      var locs = (card.getAttribute('data-locations') || '').split(',');
      var price = parseFloat(card.getAttribute('data-price') || '999');
      var ok = locs.indexOf(region) !== -1 && price <= priceLimit;
      card.style.display = ok ? '' : 'none';
      if (ok && !firstVisible) firstVisible = card;
    });
    // Auto-pick the first visible type, and clear the name if it was
    // auto-generated from a now-hidden type so the user sees the new pick.
    if (firstVisible) {
      var input = firstVisible.querySelector('input[type="radio"]');
      if (input) input.checked = true;
    }
    if (typeEmpty) typeEmpty.style.display = firstVisible ? 'none' : 'block';
  }

  // Re-filter when the user picks a different location
  form.querySelectorAll('input[name="region"]').forEach(function(r){
    r.addEventListener('change', filterTypes);
  });
  // "Show all types" escape hatch — bypass the per-location filter
  // when the user has been bitten by it (Hetzner inventory ≠ pricing).
  var showAll = document.getElementById('show-all-types');
  if (showAll) {
    showAll.addEventListener('change', filterTypes);
  }
  filterTypes(); // initial pass

  form.addEventListener('submit', function(){
    if (!nameInput.value.trim()) {
      var region = (form.querySelector('input[name="region"]:checked') || {}).value || 'srv';
      var size = (form.querySelector('input[name="size"]:checked') || {}).value || 'cx';
      nameInput.value = (region + '-' + size).toLowerCase();
    }
    submit.disabled = true;
    submit.textContent = 'Provisioning…';
  });
})();
</script>
`;

	return html(body, "New server", {
		user,
		current: "/servers",
		currentProject,
		projects: projects.results,
	});
}
