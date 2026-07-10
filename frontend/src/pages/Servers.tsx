import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { api } from "../api";
import { usePolling } from "../hooks";
import { MetricBar, Skeleton, Spinner, StatusPill } from "../components/ui";
import { clsx, timeAgo } from "../utils";
import type { Metrics, ServerSummary } from "../types";

function ServerCard({ server }: { server: ServerSummary }) {
  const navigate = useNavigate();
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Live metrics for active servers, polled every 3s.
  const { data: metrics } = usePolling<Metrics | null>(
    () => api.serverMetrics(server.id),
    server.status === "active" ? 3000 : 100000,
    server.status === "active",
  );

  const onDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteServer(server.id);
      window.location.reload();
    } catch {
      setDeleting(false);
      setConfirmDel(false);
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 260, damping: 26 }}
      whileHover={{ y: -3 }}
      onClick={() => navigate(`/servers/${server.id}`)}
      className="card group cursor-pointer p-5 transition-shadow hover:border-void-accent/40 hover:shadow-glow"
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-void-accent/15 text-void-accent">
            {server.provider === "hetzner" ? "⬡" : "▣"}
          </div>
          <div>
            <div className="font-medium text-white">{server.name}</div>
            <div className="text-xs text-void-dim">
              {server.region || "—"} · {server.size || "—"}
              {server.hetzner_project_name ? ` · ${server.hetzner_project_name}` : ""}
            </div>
          </div>
        </div>
        <StatusPill status={server.status} />
      </div>

      {server.status === "active" ? (
        <div className="mt-4 space-y-3">
          {metrics ? (
            <>
              <MetricBar label="CPU" percent={metrics.cpu_percent} />
              <MetricBar
                label="Mem"
                percent={metrics.memory_percent}
                detail={`${metrics.memory_mb} MB`}
              />
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs text-void-dim">
              <Spinner size={12} /> awaiting metrics…
            </div>
          )}
        </div>
      ) : (
        <div className="mt-4 text-xs text-void-dim">
          {server.status === "pending" || server.status === "provisioning"
            ? "Waiting for agent to register…"
            : "Agent offline."}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-void-border pt-3 text-xs text-void-dim">
        <span>
          {server.project_repo_url ? (
            <span className="font-mono text-void-dim">{server.project_repo_url}</span>
          ) : (
            "no project"
          )}
        </span>
        <span>
          {server.last_deploy_status ? (
            <>
              {server.last_deploy_ref} · {server.last_deploy_status}
            </>
          ) : (
            timeAgo(server.last_seen_at)
          )}
        </span>
      </div>

      <div
        className="mt-3 flex justify-end"
        onClick={(e) => e.stopPropagation()}
      >
        {confirmDel ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-void-dim">delete?</span>
            <button className="btn-danger px-2 py-1 text-xs" onClick={onDelete} disabled={deleting}>
              {deleting ? <Spinner size={12} /> : "yes"}
            </button>
            <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setConfirmDel(false)}>
              no
            </button>
          </div>
        ) : (
          <button
            className={clsx("px-2 py-1 text-xs text-void-dim opacity-0 transition-opacity group-hover:opacity-100 hover:text-void-err")}
            onClick={() => setConfirmDel(true)}
          >
            delete
          </button>
        )}
      </div>
    </motion.div>
  );
}

export default function Servers() {
  const { data, loading, error, refresh } = usePolling(() => api.servers(), 5000);
  const [search, setSearch] = useState("");

  const servers = data?.servers ?? [];
  const filtered = servers.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Servers</h1>
          <p className="text-sm text-void-dim">{servers.length} server{servers.length === 1 ? "" : "s"}</p>
        </div>
        <div className="flex items-center gap-3">
          <input
            className="input max-w-xs"
            placeholder="Filter by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <a href="/servers/new" className="btn-primary">
            + New server
          </a>
          <button className="btn-secondary" onClick={refresh} title="Refresh">
            ⟳
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : error ? (
        <div className="card p-6 text-void-err">{error}</div>
      ) : filtered.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 p-12 text-center">
          <div className="text-void-dim">No servers match.</div>
          <a href="/servers/new" className="btn-primary">
            + Create your first server
          </a>
        </div>
      ) : (
        <motion.div layout className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence mode="popLayout">
            {filtered.map((s) => (
              <ServerCard key={s.id} server={s} />
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}
