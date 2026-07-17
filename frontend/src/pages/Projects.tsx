import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { api } from "../api";
import { usePolling } from "../hooks";
import { Skeleton, Spinner } from "../components/ui";

export default function Projects() {
  const navigate = useNavigate();
  const { data, loading, refresh } = usePolling(() => api.projects(), 8000);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const { project } = await api.createProject(name);
      localStorage.setItem("void_project_id", project.id);
      await refresh();
      navigate(`/projects/${project.id}`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setCreating(false);
    }
  };

  if (loading && !data) {
    return <div className="mx-auto max-w-6xl px-8 py-8"><Skeleton className="h-40" /></div>;
  }

  const projects = data?.projects ?? [];

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-void-dim">
            A project groups providers, domains, repositories, servers, and deployments.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate((value) => !value)}>
          + New project
        </button>
      </div>

      {showCreate && (
        <form onSubmit={create} className="card mb-6 flex items-start gap-3 p-4">
          <input
            className="input flex-1"
            placeholder="Project name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
          <button className="btn-primary" disabled={!name.trim() || creating}>
            {creating ? <Spinner size={14} /> : "Create"}
          </button>
          {error && <span className="self-center text-sm text-void-err">{error}</span>}
        </form>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {projects.map((project, index) => (
          <motion.div
            key={project.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.04 }}
          >
            <Link
              to={`/projects/${project.id}`}
              onClick={() => localStorage.setItem("void_project_id", project.id)}
              className="card block p-5 transition-colors hover:border-void-accent/50"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-white">{project.name}</div>
                {project.is_default ? (
                  <span className="pill bg-void-accent/15 text-void-accent">default</span>
                ) : (
                  <span className="font-mono text-xs text-void-dim">/{project.slug}</span>
                )}
              </div>
              <div className="mt-4 flex items-center gap-2 text-xs">
                <span className={project.github_login ? "text-void-ok" : "text-void-warn"}>
                  {project.github_login ? `GitHub @${project.github_login}` : "GitHub not connected"}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 border-t border-void-border pt-4 text-center">
                <Count label="repos" value={project.repository_count} />
                <Count label="servers" value={project.server_count} />
                <Count label="deploys" value={project.deployment_count} />
              </div>
            </Link>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-lg font-semibold text-white">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-void-dim">{label}</div>
    </div>
  );
}
