import { NavLink, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useAuth } from "../hooks";
import { clsx } from "../utils";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: "▦" },
  { to: "/servers", label: "Servers", icon: "⬡" },
  { to: "/projects", label: "Projects", icon: "⑂" },
  { to: "/deployments", label: "Deployments", icon: "↻" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-60 shrink-0 flex-col border-r border-void-border bg-void-panel/60 backdrop-blur">
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-void-accent to-void-accent2 shadow-glow" />
          <span className="text-lg font-semibold tracking-tight">void</span>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                clsx(
                  "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                  isActive ? "text-white" : "text-void-dim hover:text-white",
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <motion.span
                      layoutId="nav-active"
                      className="absolute inset-0 rounded-lg bg-void-accent/12 ring-1 ring-void-accent/30"
                      transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    />
                  )}
                  <span className="relative z-10 w-4 text-center">{item.icon}</span>
                  <span className="relative z-10">{item.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-void-border p-3">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-void-accent/20 text-xs font-semibold text-void-accent">
              {user?.username?.[0]?.toUpperCase() ?? "?"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-white">{user?.username ?? "—"}</div>
            </div>
            <button
              onClick={onLogout}
              className="rounded-md px-2 py-1 text-xs text-void-dim hover:text-void-err"
              title="Log out"
            >
              exit
            </button>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
