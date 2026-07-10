import { motion } from "framer-motion";
import { api } from "../api";
import { usePolling } from "../hooks";
import { Skeleton } from "../components/ui";
import { StatusPill } from "../components/ui";

export default function Projects() {
  const { data, loading } = usePolling(() => api.projects(), 8000);

  if (loading && !data) {
    return (
      <div className="mx-auto max-w-6xl px-8 py-8">
        <Skeleton className="h-40" />
      </div>
    );
  }

  const projects = data?.projects ?? [];

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Projects</h1>
      <p className="mb-6 text-sm text-void-dim">{projects.length} project{projects.length === 1 ? "" : "s"}</p>

      {projects.length === 0 ? (
        <div className="card p-10 text-center text-void-dim">No projects yet.</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((p, i) => (
            <motion.div
              key={p.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
              className="card p-5"
            >
              <div className="flex items-center justify-between">
                <div className="font-medium text-white">{p.name}</div>
                <span className="font-mono text-xs text-void-dim">/{p.slug}</span>
              </div>
              <div className="mt-1 truncate font-mono text-xs text-void-dim">{p.repo_url}</div>
              <div className="mt-4 flex items-center justify-between text-xs text-void-dim">
                <span>
                  {p.server_name ? (
                    <span className="flex items-center gap-1.5">
                      <StatusPill status={p.server_status ?? "offline"} />
                    </span>
                  ) : (
                    "no server"
                  )}
                </span>
                <span>{p.deployment_count} deploys</span>
              </div>
              <div className="mt-3 border-t border-void-border pt-3 font-mono text-xs text-void-dim">
                {p.default_branch} · :{p.default_port}
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
