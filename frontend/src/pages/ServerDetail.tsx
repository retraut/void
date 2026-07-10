import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { api, streamLogs } from "../api";
import { usePolling } from "../hooks";
import { MetricBar, Skeleton, StatusPill } from "../components/ui";
import { clsx } from "../utils";
import type { LogEntry, Metrics, ServerRow } from "../types";

function LogViewer({ serverId, deploymentId }: { serverId: string; deploymentId: string }) {
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [autoscroll, setAutoscroll] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    const unsub = streamLogs(serverId, deploymentId, (e) => {
      setLines((prev) => {
        const next = prev.length > 5000 ? prev.slice(prev.length - 5000) : prev;
        return [...next, e];
      });
    }, setStatus);
    return unsub;
  }, [serverId, deploymentId]);

  useEffect(() => {
    if (autoscroll && endRef.current) {
      endRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [lines, autoscroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoscroll(atBottom);
  };

  const dot = status === "open" ? "bg-void-ok" : status === "error" ? "bg-void-err" : "bg-void-warn";

  return (
    <div className="card flex h-[60vh] flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-void-border px-4 py-2">
        <div className="flex items-center gap-2 text-sm">
          <span className={clsx("h-2 w-2 rounded-full", dot)} />
          <span className="text-void-dim">
            {status === "open" ? "live" : status === "error" ? "reconnecting…" : "connecting…"}
          </span>
        </div>
        <button
          className={clsx("btn-secondary px-2 py-1 text-xs", autoscroll && "border-void-accent/40 text-white")}
          onClick={() => setAutoscroll((v) => !v)}
        >
          autoscroll {autoscroll ? "on" : "off"}
        </button>
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="log-term flex-1 overflow-y-auto py-2">
        {lines.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-void-dim">waiting for logs…</div>
        )}
        {lines.map((l, i) => (
          <div
            key={i}
            className={clsx(
              "log-line",
              l.stream === "stderr" ? "log-stderr" : l.stream === "status" ? "log-status" : "log-stdout",
            )}
          >
            {l.data}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

export default function ServerDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: server, loading } = usePolling<ServerRow | null>(
    () => (id ? api.server(id).then((d) => d.server) : Promise.resolve(null)),
    5000,
    !!id,
  );
  const { data: metrics } = usePolling<Metrics | null>(
    () => (id ? api.serverMetrics(id) : Promise.resolve(null)),
    3000,
    !!id,
  );

  if (loading && !server) {
    return (
      <div className="mx-auto max-w-4xl px-8 py-8">
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (!server) {
    return <div className="mx-auto max-w-4xl px-8 py-8 text-void-err">Server not found.</div>;
  }

  const deploymentId = server.id; // cell buffers logs by server for live tail

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <button onClick={() => history.back()} className="mb-2 text-xs text-void-dim hover:text-white">
            ← back
          </button>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{server.name}</h1>
            <StatusPill status={server.status} />
          </div>
          <div className="mt-1 text-sm text-void-dim">
            {server.region || "—"} · {server.size || "—"} · {server.ip_address || "no IP"}
          </div>
        </div>
      </div>

      {server.status === "active" && metrics && (
        <motion.div layout className="card mb-6 grid grid-cols-2 gap-5 p-5">
          <MetricBar label="CPU" percent={metrics.cpu_percent} />
          <MetricBar label="Mem" percent={metrics.memory_percent} detail={`${metrics.memory_mb} MB`} />
        </motion.div>
      )}

      <div className="mb-3 text-sm font-medium text-void-dim">Live logs</div>
      <LogViewer serverId={server.id} deploymentId={deploymentId} />
    </div>
  );
}
