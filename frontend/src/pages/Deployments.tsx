import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { api } from "../api";
import { usePolling } from "../hooks";
import { Skeleton, StatusPill } from "../components/ui";
import { shortSha, timeAgo } from "../utils";
import type { Deployment, DeploymentStatus } from "../types";

export default function Deployments() {
  const [page, setPage] = useState(1);
  const { data, loading } = usePolling(
    () => api.deployments({ page, perPage: 20 }),
    6000,
  );

  const list: Deployment[] = data?.deployments ?? [];

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Deployments</h1>

      {loading && !data ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="card p-10 text-center text-void-dim">No deployments yet.</div>
      ) : (
        <>
          <div className="space-y-2">
            {list.map((d, i) => (
              <motion.div
                key={d.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
              >
                <Link
                  to={`/deployments/${d.id}`}
                  className="card flex items-center justify-between p-4 transition-colors hover:border-void-accent/40"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm text-white">{d.project_name ?? "—"}</div>
                    <div className="text-xs text-void-dim">
                      {d.ref} · <span className="font-mono">{shortSha(d.commit_sha)}</span> ·{" "}
                      {d.server_name ?? "—"}
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <StatusPill status={d.status as DeploymentStatus} />
                    <span className="text-xs text-void-dim">{timeAgo(d.started_at)}</span>
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>

          <div className="mt-5 flex items-center justify-center gap-3 text-sm">
            <button
              className="btn-secondary px-3 py-1"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← prev
            </button>
            <span className="text-void-dim">
              page {data?.page} / {data?.total_pages ?? 1}
            </span>
            <button
              className="btn-secondary px-3 py-1"
              disabled={page >= (data?.total_pages ?? 1)}
              onClick={() => setPage((p) => p + 1)}
            >
              next →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
