import type { ReactNode } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { usePolling } from "../hooks";
import { MetricBar, Skeleton, StatusPill } from "../components/ui";
import { timeAgo } from "../utils";
import type { Metrics, ServerInventory, ServerRow } from "../types";

function InfoCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="mb-4 font-medium text-white">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-[0.14em] text-void-dim">{label}</div>
      <div className="mt-1 break-words text-sm text-white">{value || "—"}</div>
    </div>
  );
}

function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`].filter(Boolean).join(" ");
}

function BooleanValue({ value }: { value: boolean | null | undefined }) {
  if (value == null) return <span className="text-void-dim">unknown</span>;
  return <span className={value ? "text-void-warn" : "text-void-ok"}>{value ? "enabled" : "disabled"}</span>;
}

function SystemCard({ inventory }: { inventory: ServerInventory | null }) {
  return (
    <InfoCard title="System">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Hostname" value={inventory?.hostname} />
        <Field label="OS" value={inventory?.os} />
        <Field label="Kernel" value={inventory?.kernel} />
        <Field label="Architecture" value={inventory?.architecture} />
        <Field label="Uptime" value={formatUptime(inventory?.uptime_seconds)} />
        <Field label="Inventory" value={inventory ? "collected" : "not collected"} />
      </div>
    </InfoCard>
  );
}

function ResourcesCard({ inventory, metrics }: { inventory: ServerInventory | null; metrics: Metrics | null }) {
  return (
    <InfoCard title="Resources">
      <div className="space-y-4">
        {metrics ? (
          <div className="grid grid-cols-2 gap-4">
            <MetricBar label="CPU" percent={metrics.cpu_percent} />
            <MetricBar label="Memory" percent={metrics.memory_percent} detail={`${Math.round(metrics.memory_mb)} MB`} />
          </div>
        ) : <p className="text-sm text-void-dim">Waiting for live metrics…</p>}
        <div className="grid grid-cols-2 gap-4">
          <Field label="CPU cores" value={inventory?.cpu_count} />
          <Field label="Total memory" value={inventory?.total_memory_mb != null ? `${Math.round(inventory.total_memory_mb)} MB` : null} />
          <Field label="Disk used" value={inventory?.disk ? `${inventory.disk.used_gb.toFixed(1)} / ${inventory.disk.total_gb.toFixed(1)} GB` : null} />
          <Field label="Disk usage" value={inventory?.disk ? `${inventory.disk.used_percent}%` : null} />
        </div>
      </div>
    </InfoCard>
  );
}

function FirewallCard({ inventory }: { inventory: ServerInventory | null }) {
  const firewall = inventory?.firewall;
  const ports = inventory?.network?.open_ports ?? [];
  return (
    <InfoCard title="Firewall & network">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Firewall" value={firewall ? `${firewall.backend || "unknown"} · ${firewall.active ? "active" : "inactive"}` : null} />
        <Field label="Primary IPv4" value={inventory?.network?.primary_ipv4} />
      </div>
      <div className="mt-5">
        <div className="text-xs uppercase tracking-[0.14em] text-void-dim">Listening ports</div>
        {ports.length === 0 ? <p className="mt-2 text-sm text-void-dim">No listening ports reported.</p> : (
          <div className="mt-2 flex flex-wrap gap-2">
            {ports.map((port) => <span key={`${port.protocol}-${port.address}-${port.port}`} className="pill bg-void-dim/15 font-mono text-void-dim">{port.protocol} {port.address}:{port.port}{port.process ? ` · ${port.process}` : ""}</span>)}
          </div>
        )}
      </div>
    </InfoCard>
  );
}

function SshCard({ inventory }: { inventory: ServerInventory | null }) {
  const ssh = inventory?.ssh;
  return (
    <InfoCard title="SSH access">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Port" value={ssh?.port} />
        <Field label="Password auth" value={<BooleanValue value={ssh?.password_authentication} />} />
        <Field label="Root login" value={ssh?.permit_root_login} />
      </div>
      <div className="mt-5 space-y-3">
        <div className="text-xs uppercase tracking-[0.14em] text-void-dim">Users and authorized keys</div>
        {!ssh ? <p className="text-sm text-void-dim">SSH inventory not collected.</p> : ssh.users.length === 0 ? <p className="text-sm text-void-dim">No interactive users reported.</p> : ssh.users.map((user) => (
          <div key={user.username} className="rounded-xl border border-void-border p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-white">{user.username}</span>
              <span className="text-xs text-void-dim">uid {user.uid} · {user.shell}</span>
            </div>
            {user.keys.length > 0 ? <div className="mt-2 space-y-1 text-xs text-void-dim">{user.keys.map((key) => <div key={key.fingerprint} className="font-mono break-all">{key.type} · {key.fingerprint}{key.comment ? ` · ${key.comment}` : ""}</div>)}</div> : <div className="mt-2 text-xs text-void-dim">No authorized keys</div>}
          </div>
        ))}
      </div>
    </InfoCard>
  );
}

function CertificatesCard({ inventory }: { inventory: ServerInventory | null }) {
  const certificates = inventory?.certificates ?? [];
  return (
    <InfoCard title="Certificates">
      {certificates.length === 0 ? <p className="text-sm text-void-dim">No Let’s Encrypt certificates reported.</p> : <div className="space-y-3">{certificates.map((certificate) => <div key={certificate.name} className="flex items-center justify-between gap-4 rounded-xl border border-void-border p-3"><div><div className="font-medium text-white">{certificate.name}</div><div className="mt-1 text-xs text-void-dim">{certificate.issuer || "Unknown issuer"}</div></div><span className="shrink-0 text-xs text-void-dim">expires {certificate.expires_at || "unknown"}</span></div>)}</div>}
    </InfoCard>
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

  if (loading && !server) return <div className="mx-auto max-w-5xl px-8 py-8"><Skeleton className="h-40" /></div>;
  if (!server) return <div className="mx-auto max-w-5xl px-8 py-8 text-void-err">Server not found.</div>;

  const ip = server.ip_address || server.inventory?.network?.primary_ipv4;
  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <div className="mb-6">
        <button onClick={() => history.back()} className="mb-2 text-xs text-void-dim hover:text-white">← back</button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{server.name}</h1>
          <StatusPill status={server.status} />
        </div>
        <div className="mt-1 text-sm text-void-dim">{ip || "no IP"} · {server.inventory?.os || server.provider || "server"} · inventory {timeAgo(server.inventory_collected_at)}</div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <SystemCard inventory={server.inventory} />
        <ResourcesCard inventory={server.inventory} metrics={metrics} />
        <FirewallCard inventory={server.inventory} />
        <SshCard inventory={server.inventory} />
        <div className="lg:col-span-2"><CertificatesCard inventory={server.inventory} /></div>
      </div>
    </div>
  );
}
