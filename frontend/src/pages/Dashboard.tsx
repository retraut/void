import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { api } from "../api";
import { usePolling } from "../hooks";
import { Skeleton, StatusPill } from "../components/ui";
import { timeAgo } from "../utils";
import type { DeploymentStatus } from "../types";

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="card p-5"
    >
      <div className="text-xs uppercase tracking-wide text-void-dim">{label}</div>
      <div className="mt-2 text-3xl font-semibold text-white">{value}</div>
      {sub && <div className="mt-1 text-xs text-void-dim">{sub}</div>}
    </motion.div>
  );
}

export default function Dashboard() {
  const { data, loading } = usePolling(() => api.dashboard(), 5000);

  if (loading && !data) {
    return (
      <div className="mx-auto max-w-6xl px-8 py-8">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const servers = data?.servers ?? [];
  const active = servers.filter((s) => s.status === "active").length;

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="mb-6 text-sm text-void-dim">Edge PaaS overview</p>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Servers" value={servers.length} sub={`${active} active`} />
        <Stat label="Projects" value={data?.projects.length ?? 0} />
        <Stat label="Deploys 24h" value={data?.deployments_24h ?? 0} />
        <Stat label="Last seen" value={servers[0] ? timeAgo(servers[0].last_seen_at) : "—"} />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium">Recent deployments</h2>
          </div>
          <div className="space-y-2">
            {(data?.recent_deployments ?? []).length === 0 && (
              <div className="text-sm text-void-dim">No deployments yet.</div>
            )}
            {(data?.recent_deployments ?? []).map((d, i) => (
              <motion.div
                key={d.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
                className="flex items-center justify-between rounded-lg border border-void-border px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-white">{d.project_name ?? "—"}</div>
                  <div className="text-xs text-void-dim">{d.ref}</div>
                </div>
                <div className="flex items-center gap-3">
                  <StatusPill status={d.status as DeploymentStatus} />
                  <span className="text-xs text-void-dim">{timeAgo(d.started_at)}</span>
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        <div className="card p-5">
          <div className="mb-3 font-medium">Servers</div>
          <div className="space-y-2">
            {servers.map((s) => (
              <Link
                key={s.id}
                to={`/servers/${s.id}`}
                className="flex items-center justify-between rounded-lg border border-void-border px-3 py-2 transition-colors hover:border-void-accent/40"
              >
                <span className="text-sm text-white">{s.name}</span>
                <span className="flex items-center gap-3">
                  <StatusPill status={s.status} />
                  <span className="text-xs text-void-dim">{timeAgo(s.last_seen_at)}</span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
