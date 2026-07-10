import { motion } from "framer-motion";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { usePolling } from "../hooks";
import { Skeleton, StatusPill } from "../components/ui";
import { shortSha, timeAgo } from "../utils";

export default function DeploymentDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, loading } = usePolling(
    () => (id ? api.deployment(id).then((d) => d.deployment) : Promise.resolve(null)),
    4000,
    !!id,
  );

  if (loading && !data) {
    return (
      <div className="mx-auto max-w-4xl px-8 py-8">
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (!data) {
    return <div className="mx-auto max-w-4xl px-8 py-8 text-void-err">Deployment not found.</div>;
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <button onClick={() => history.back()} className="mb-2 text-xs text-void-dim hover:text-white">
        ← back
      </button>
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{data.project_name ?? "Deployment"}</h1>
        <StatusPill status={data.status} />
      </div>

      <div className="card mb-6 grid grid-cols-2 gap-4 p-5 md:grid-cols-4">
        <Field label="Ref" value={data.ref ?? "—"} />
        <Field label="Commit" value={shortSha(data.commit_sha)} mono />
        <Field label="Server" value={data.server_name ?? "—"} />
        <Field label="Started" value={timeAgo(data.started_at)} />
        <Field label="Status" value={data.status} />
        <Field label="Port" value={data.port ? String(data.port) : "—"} />
        <Field label="Public URL" value={data.public_url ?? "—"} />
        <Field label="Duration" value={data.duration_ms ? `${(data.duration_ms / 1000).toFixed(1)}s` : "—"} />
      </div>

      {data.error && (
        <div className="card mb-6 border-void-err/40 bg-void-err/5 p-4">
          <div className="text-sm font-medium text-void-err">Error</div>
          <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-void-err/90">{data.error}</pre>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="text-xs uppercase tracking-wide text-void-dim">{label}</div>
      <div className={`mt-1 truncate text-sm text-white ${mono ? "font-mono" : ""}`}>{value}</div>
    </motion.div>
  );
}
