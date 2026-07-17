import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { useAuth } from "../hooks";
import { api } from "../api";
import type { Project } from "../types";

const GLOBAL_NAV = [
  { to: "/projects", label: "Projects", icon: "⑂" },
  { to: "/settings", label: "Account settings", icon: "⚙" },
];

const PROJECT_NAV = [
  { suffix: "", label: "Overview", icon: "▦" },
  { suffix: "/providers", label: "Providers", icon: "◇" },
  { suffix: "/domains", label: "Domains", icon: "◎" },
  { suffix: "/servers", label: "Servers", icon: "⬡" },
  { suffix: "/repositories", label: "Repositories", icon: "⑂" },
  { suffix: "/deployments", label: "Deployments", icon: "↻" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("void_sidebar_collapsed") === "1");
  const pathProjectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null;
  const queryProjectId = new URLSearchParams(location.search).get("project");
  const projectId = pathProjectId || queryProjectId;
  const project = projects.find((item) => item.id === projectId) ?? null;

  useEffect(() => {
    if (!user) return;
    api.projects().then(({ projects: rows }) => setProjects(rows)).catch(() => setProjects([]));
  }, [user, location.pathname]);

  const onLogout = () => {
    window.location.assign("/api/auth/logout");
  };

  // Do not paint the authenticated shell while the session is being
  // checked. The route guard owns the loading/unauthorized state.
  if (loading || !user) return <>{children}</>;

  const toggleSidebar = () => {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem("void_sidebar_collapsed", next ? "1" : "0");
      return next;
    });
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className={`relative flex shrink-0 flex-col border-r border-void-border bg-void-panel/60 backdrop-blur transition-[width] duration-300 ease-out ${collapsed ? "w-[72px]" : "w-64"}`}>
        <Link to="/projects" className={`flex h-[72px] items-center gap-2 ${collapsed ? "justify-center px-2" : "px-5"}`} title="Projects">
          <div className="void-sidebar-mark"><span>∅</span></div>
          {!collapsed && <span className="text-lg font-semibold tracking-tight">void</span>}
        </Link>
        <button
          type="button"
          onClick={toggleSidebar}
          className="absolute -right-3 top-6 z-20 flex h-6 w-6 items-center justify-center rounded-full border border-void-border bg-void-panel2 text-xs text-void-dim shadow-lg transition-colors hover:border-void-accent/50 hover:text-white"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? "›" : "‹"}
        </button>

        {projectId ? (
          <>
            <div className={`${collapsed ? "px-2 pb-3" : "px-3 pb-4"}`}>
              <Link
                to="/projects"
                className={`mb-3 flex items-center gap-2 text-xs text-void-dim transition-colors hover:text-white ${collapsed ? "justify-center rounded-lg px-2 py-2" : "px-2"}`}
                title="All projects"
              >
                <span>←</span>{!collapsed && <span>All projects</span>}
              </Link>
              {!collapsed && <div className="rounded-xl border border-void-border bg-void-panel2 px-3 py-3">
                <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-void-dim">Project</div>
                <div className="mt-1 truncate text-sm font-medium text-white">{project?.name ?? "Loading…"}</div>
                {project?.is_default ? <div className="mt-1 text-[10px] text-void-accent">default</div> : null}
              </div>}
            </div>
            <nav className={`flex-1 space-y-1 ${collapsed ? "px-2" : "px-3"}`}>
              {PROJECT_NAV.map((item) => {
                const to = `/projects/${projectId}${item.suffix}`;
                const active = item.suffix
                  ? location.pathname.startsWith(to)
                  : location.pathname === to;
                return <SidebarLink key={item.label} to={to} label={item.label} icon={item.icon} active={active} collapsed={collapsed} />;
              })}
            </nav>
          </>
        ) : (
          <>
            {!collapsed && <div className="px-5 pb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-void-dim">Project</div>}
            <nav className={`flex-1 space-y-1 ${collapsed ? "px-2 pt-2" : "px-3"}`}>
              {GLOBAL_NAV.map((item) => (
                <SidebarLink
                  key={item.to}
                  to={item.to}
                  label={item.label}
                  icon={item.icon}
                  active={location.pathname === item.to}
                  collapsed={collapsed}
                />
              ))}
            </nav>
          </>
        )}

        <div className={`border-t border-void-border ${collapsed ? "p-2" : "p-3"}`}>
          <div className={`flex items-center gap-2 py-1.5 ${collapsed ? "flex-col px-0" : "px-2"}`}>
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-void-accent/20 text-xs font-semibold text-void-accent">
              {user?.username?.[0]?.toUpperCase() ?? "?"}
            </div>
            {!collapsed && <div className="min-w-0 flex-1 truncate text-sm text-white">{user?.username ?? "—"}</div>}
            <button onClick={onLogout} className="rounded-md px-2 py-1 text-xs text-void-dim hover:text-void-err" title="Log out" aria-label="Log out">{collapsed ? "↪" : "exit"}</button>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

function SidebarLink({ to, label, icon, active, collapsed }: { to: string; label: string; icon: string; active: boolean; collapsed: boolean }) {
  return (
    <NavLink to={to} title={collapsed ? label : undefined} aria-label={label} className={`relative flex items-center rounded-lg py-2 text-sm transition-colors ${collapsed ? "justify-center px-2" : "gap-3 px-3"} ${active ? "text-white" : "text-void-dim hover:text-white"}`}>
      {active && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-lg bg-void-accent/12 ring-1 ring-void-accent/30" transition={{ type: "spring", stiffness: 300, damping: 30 }} />}
      <span className="relative z-10 w-4 text-center">{icon}</span>
      {!collapsed && <span className="relative z-10">{label}</span>}
    </NavLink>
  );
}
