import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { api } from "../api";
import { usePolling } from "../hooks";
import { Skeleton, Spinner, StatusPill } from "../components/ui";
import type { GithubRepositoryOption, Repository, ServerCatalog } from "../types";
import { timeAgo } from "../utils";

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const { data, loading, refresh } = usePolling(() => id ? api.project(id) : Promise.reject(new Error("missing project")), 7000, !!id);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const section = location.pathname.split("/")[3] || "overview";

  useEffect(() => {
    if (id) localStorage.setItem("void_project_id", id);
  }, [id]);

  if (loading && !data) return <div className="mx-auto max-w-6xl px-8 py-8"><Skeleton className="h-56" /></div>;
  if (!data || !id) return <div className="mx-auto max-w-6xl px-8 py-8 text-void-err">Project not found.</div>;

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.connectProjectGithub(id, token);
      setToken("");
      setMessage({ ok: true, text: "GitHub account connected." });
      await refresh();
    } catch (reason) {
      setMessage({ ok: false, text: (reason as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-7 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{data.project.name}</h1>
            {data.project.is_default ? <span className="pill bg-void-accent/15 text-void-accent">default</span> : null}
          </div>
          <p className="mt-1 font-mono text-xs text-void-dim">{data.project.id}</p>
        </div>
        <div className="flex gap-2 text-sm text-void-dim">
          <span>{data.repositories.length} repositories</span><span>·</span><span>{data.servers.length} servers</span>
        </div>
      </div>

      {section === "overview" && <ProjectOverview data={data} />}

      {section === "providers" && <div className="space-y-6">
        {!data.github_connection ? <section className="card border-void-warn/30 p-6">
          <div className="flex items-start gap-4">
            <GithubMark />
            <div className="flex-1">
              <h2 className="font-medium text-white">GitHub</h2>
              <p className="mt-1 max-w-2xl text-sm text-void-dim">
                Connect a fine-grained token to import repositories into this Project.
              </p>
              <form onSubmit={connect} className="mt-4 flex gap-3">
                <input className="input flex-1" type="password" placeholder="github_pat_… or ghp_…" value={token} onChange={(event) => setToken(event.target.value)} />
                <button className="btn-primary" disabled={!token || busy}>{busy ? <Spinner size={14} /> : "Connect GitHub"}</button>
              </form>
              <a className="mt-3 inline-block text-xs text-void-accent hover:underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create fine-grained token ↗</a>
              {message && <p className={`mt-2 text-sm ${message.ok ? "text-void-ok" : "text-void-err"}`}>{message.text}</p>}
            </div>
          </div>
        </section> : <section className="card flex items-center gap-4 p-5">
            <GithubMark />
            <div className="flex-1">
              <div className="font-medium text-white">@{data.github_connection.login}</div>
              <div className="text-xs text-void-ok">GitHub connected · Project scope</div>
            </div>
            <span className="pill bg-void-ok/10 text-void-ok">ready</span>
		  </section>}
        <HetznerConnection projectId={id} connection={data.hetzner_connection} onChange={refresh} />
        <CloudflareConnection projectId={id} connection={data.cloudflare_connection} onChange={refresh} />
      </div>}

      {section === "domains" && <DomainsPanel projectId={id} connected={!!data.cloudflare_connection} />}
      {section === "servers" && (
        <ServersPanel
          projectId={id}
          servers={data.servers}
          onChange={refresh}
          hetznerConnected={!!data.hetzner_connection}
        />
      )}
      {section === "repositories" && (data.github_connection
        ? <RepositoriesPanel projectId={id} repositories={data.repositories} servers={data.servers} onChange={refresh} />
        : <ConnectionRequired provider="GitHub" target={`/projects/${id}/providers`} resource="repositories" />)}
      {section === "deployments" && <ProjectDeployments projectId={id} />}
    </div>
  );
}

function ProjectOverview({ data }: { data: Awaited<ReturnType<typeof api.project>> }) {
  const cards = [
    { label: "GitHub", value: data.github_connection ? `@${data.github_connection.login}` : "Not connected", ready: !!data.github_connection, to: "providers" },
    { label: "Providers", value: `${Number(!!data.github_connection) + Number(!!data.hetzner_connection) + Number(!!data.cloudflare_connection)} connected`, ready: !!data.github_connection || !!data.hetzner_connection || !!data.cloudflare_connection, to: "providers" },
    { label: "Domains", value: data.cloudflare_connection ? "Available from Cloudflare" : "Connect Cloudflare", ready: !!data.cloudflare_connection, to: "domains" },
    { label: "Servers", value: `${data.servers.length}`, ready: !!data.hetzner_connection, to: "servers" },
    { label: "Repositories", value: `${data.repositories.length}`, ready: !!data.github_connection, to: "repositories" },
  ];
  return <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
    {cards.map((card) => <Link key={card.label} to={card.to} className="card block p-5 transition-colors hover:border-void-accent/50">
      <div className="flex items-center justify-between"><span className="text-sm text-void-dim">{card.label}</span><span className={`h-2 w-2 rounded-full ${card.ready ? "bg-void-ok" : "bg-void-warn"}`} /></div>
      <div className="mt-3 font-medium text-white">{card.value}</div>
    </Link>)}
  </div>;
}

function CloudflareConnection({ projectId, connection, onChange }: { projectId: string; connection: { metadata_json: string | null; created_at: number } | null; onChange: () => Promise<unknown> | unknown }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = connection?.metadata_json ? (JSON.parse(connection.metadata_json) as { zones?: number }).zones ?? 0 : 0;
  const connect = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { await api.connectProjectCloudflare(projectId, token); setToken(""); await onChange(); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="card p-5">
    <div className="flex items-start gap-4">
      <CloudflareMark />
      <div className="flex-1">
        <div className="flex items-center justify-between gap-4"><div><h2 className="font-medium text-white">Cloudflare</h2><p className="text-xs text-void-dim">Domains and DNS for this Project</p></div>{connection ? <span className="pill bg-void-ok/10 text-void-ok">connected · {zones} domains</span> : <span className="pill bg-void-warn/10 text-void-warn">required for domains</span>}</div>
        {!connection && <form onSubmit={connect} className="mt-4 flex gap-3"><input className="input flex-1" type="password" placeholder="Cloudflare API token with Zone read access" value={token} onChange={(event) => setToken(event.target.value)} /><button className="btn-primary" disabled={!token || busy}>{busy ? <Spinner size={14} /> : "Connect Cloudflare"}</button></form>}
        {!connection && <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-void-accent hover:underline">Create Cloudflare token ↗</a>}
        {error && <p className="mt-2 text-sm text-void-err">{error}</p>}
      </div>
    </div>
  </section>;
}

function DomainsPanel({ projectId, connected }: { projectId: string; connected: boolean }) {
  const { data, loading, error } = usePolling(() => api.projectDomains(projectId), 15000, connected);
  if (!connected) return <ConnectionRequired provider="Cloudflare" target={`/projects/${projectId}/providers`} resource="domains" />;
  if (loading && !data) return <Skeleton className="h-40" />;
  if (error) return <div className="card p-6 text-void-err">{error}</div>;
  const domains = data?.domains ?? [];
  return <section className="card overflow-hidden">
    <div className="border-b border-void-border p-5"><h2 className="font-medium text-white">Cloudflare domains</h2><p className="mt-1 text-xs text-void-dim">Zones available to this Project token</p></div>
    {domains.length === 0 ? <div className="p-8"><Empty text="No domains are available to this Cloudflare token." /></div> : <div className="divide-y divide-void-border">{domains.map((domain) => <div key={domain.id} className="flex items-center justify-between px-5 py-4"><div><div className="font-medium text-white">{domain.name}</div><div className="mt-1 text-xs text-void-dim">{domain.name_servers.join(" · ")}</div></div><StatusPill status={domain.paused ? "paused" : domain.status} /></div>)}</div>}
  </section>;
}

function ProjectDeployments({ projectId }: { projectId: string }) {
  const { data, loading, error } = usePolling(() => api.deployments({ project: projectId, perPage: 50 }), 7000);
  if (loading && !data) return <Skeleton className="h-40" />;
  if (error) return <div className="card p-6 text-void-err">{error}</div>;
  const deployments = data?.deployments ?? [];
  return <section className="card p-5"><div className="mb-4"><h2 className="font-medium text-white">Deployments</h2><p className="text-xs text-void-dim">Only deployments from this Project</p></div><div className="space-y-3">{deployments.length === 0 && <Empty text="No deployments in this Project." />}{deployments.map((deployment) => <Link key={deployment.id} to={`/deployments/${deployment.id}?project=${projectId}`} className="flex items-center justify-between rounded-xl border border-void-border p-4 hover:border-void-accent/40"><div><div className="font-medium text-white">{deployment.repository_name || deployment.id}</div><div className="mt-1 text-xs text-void-dim">{deployment.ref || "—"} · {timeAgo(deployment.started_at)}</div></div><StatusPill status={deployment.status} /></Link>)}</div></section>;
}

function ConnectionRequired({ provider, target, resource }: { provider: string; target: string; resource: string }) {
  return <section className="card border-void-warn/30 p-8 text-center"><div className="text-lg font-medium text-white">Connect {provider} first</div><p className="mt-2 text-sm text-void-dim">{provider} unlocks {resource} inside this Project.</p><Link to={target} className="btn-primary mt-5">Open providers</Link></section>;
}

function HetznerConnection({ projectId, connection, onChange }: { projectId: string; connection: { verified_datacenters: number | null; created_at: number } | null; onChange: () => Promise<unknown> | unknown }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { await api.connectProjectHetzner(projectId, token); setToken(""); await onChange(); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="card mb-6 p-5">
    <div className="flex items-start gap-4">
      <HetznerMark />
      <div className="flex-1">
        <div className="flex items-center justify-between"><div><h2 className="font-medium text-white">Hetzner Cloud</h2><p className="text-xs text-void-dim">Project-scoped provisioning credential</p></div>{connection ? <span className="pill bg-void-ok/10 text-void-ok">connected · {connection.verified_datacenters ?? 0} datacenters</span> : <span className="pill bg-void-warn/10 text-void-warn">required for servers</span>}</div>
        {!connection && <form onSubmit={connect} className="mt-4 flex gap-3"><input className="input flex-1" type="password" placeholder="Hetzner API token with read/write scope" value={token} onChange={(event) => setToken(event.target.value)} /><button className="btn-primary" disabled={!token || busy}>{busy ? <Spinner size={14} /> : "Connect Hetzner"}</button></form>}
        {!connection && <a href="https://console.hetzner.cloud" target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-void-accent hover:underline">Open Hetzner console ↗</a>}
        {error && <p className="mt-2 text-sm text-void-err">{error}</p>}
      </div>
    </div>
  </section>;
}

function RepositoriesPanel({ projectId, repositories, servers, onChange }: { projectId: string; repositories: Repository[]; servers: Array<{ id: string; name: string; status: string }>; onChange: () => Promise<unknown> | unknown }) {
  const navigate = useNavigate();
  const [showAdd, setShowAdd] = useState(false);
  const [options, setOptions] = useState<GithubRepositoryOption[]>([]);
  const [selected, setSelected] = useState("");
  const [build, setBuild] = useState("");
  const [serve, setServe] = useState("");
  const [port, setPort] = useState(3000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});

  const open = async () => {
    setShowAdd(true); setBusy(true); setError(null);
    try {
      const result = await api.availableGithubRepositories(projectId);
      setOptions(result.repositories);
      setSelected(String(result.repositories[0]?.id ?? ""));
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };

  const add = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await api.addProjectRepository(projectId, { github_repo_id: Number(selected), build_command: build, serve_command: serve, default_port: port });
      setShowAdd(false); setBuild(""); setServe(""); await onChange();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };

  const deploy = async (repository: Repository) => {
    const serverId = targets[repository.id] || servers.find((server) => server.status === "active")?.id;
    if (!serverId) { setError("Add an active server to deploy this repository."); return; }
    setBusy(true); setError(null);
    try {
      const result = await api.deployProjectRepository(projectId, { repository_id: repository.id, server_id: serverId });
      navigate(`/deployments/${result.deployment_id}?project=${projectId}`);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <section className="card p-5">
      <div className="mb-4 flex items-center justify-between"><div><h2 className="font-medium text-white">Repositories</h2><p className="text-xs text-void-dim">Imported from the connected GitHub account</p></div><button className="btn-secondary" onClick={open}>+ Add</button></div>
      {showAdd && <form onSubmit={add} className="mb-4 space-y-3 rounded-xl border border-void-border bg-void-bg/40 p-4">
        {busy && options.length === 0 ? <Spinner /> : <>
          <select className="input" value={selected} onChange={(event) => setSelected(event.target.value)}>{options.map((repo) => <option key={repo.id} value={repo.id}>{repo.full_name}{repo.private ? " · private" : ""}</option>)}</select>
          <div className="grid grid-cols-2 gap-2"><input className="input" placeholder="Build command (optional)" value={build} onChange={(event) => setBuild(event.target.value)} /><input className="input" placeholder="Serve command" value={serve} onChange={(event) => setServe(event.target.value)} /></div>
          <input className="input" type="number" min={1} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} />
          <div className="flex gap-2"><button className="btn-primary" disabled={!selected || busy}>Add repository</button><button type="button" className="btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button></div>
        </>}
      </form>}
      <div className="space-y-3">
        {repositories.length === 0 && <Empty text="No repositories in this Project." />}
        {repositories.map((repository) => <motion.div layout key={repository.id} className="rounded-xl border border-void-border p-4">
          <div className="flex justify-between gap-3"><div><div className="font-medium text-white">{repository.full_name}</div><div className="mt-1 text-xs text-void-dim">{repository.default_branch} · :{repository.default_port} · {repository.private ? "private" : "public"}</div></div>{repository.last_deploy_status ? <StatusPill status={repository.last_deploy_status} /> : null}</div>
          <div className="mt-4 flex gap-2"><select className="input" value={targets[repository.id] || ""} onChange={(event) => setTargets((value) => ({ ...value, [repository.id]: event.target.value }))}><option value="">Choose active server…</option>{servers.filter((server) => server.status === "active").map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</select><button className="btn-primary whitespace-nowrap" disabled={busy || servers.every((server) => server.status !== "active")} onClick={() => deploy(repository)}>Deploy</button></div>
        </motion.div>)}
      </div>
      {error && <p className="mt-3 text-sm text-void-err">{error}</p>}
    </section>
  );
}

function ServersPanel({ projectId, servers, onChange, hetznerConnected }: { projectId: string; servers: Array<{ id: string; name: string; status: string; region: string | null; size: string | null; last_seen_at: number | null }>; onChange: () => Promise<unknown> | unknown; hetznerConnected: boolean }) {
  const [showAdd, setShowAdd] = useState(false);
  const [catalog, setCatalog] = useState<ServerCatalog | null>(null);
  const [name, setName] = useState("void-server");
  const [region, setRegion] = useState("");
  const [size, setSize] = useState("");
  const [image, setImage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableTypes = useMemo(() => catalog?.server_types.filter((type) => !region || type.available_locations.includes(region)) ?? [], [catalog, region]);
  const open = async () => {
    setShowAdd(true); setBusy(true); setError(null);
    try {
      const result = await api.projectServerCatalog(projectId); setCatalog(result);
      setRegion(result.locations[0]?.name || ""); setSize(result.server_types[0]?.name || ""); setImage(result.images[0]?.name || "");
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (availableTypes.length && !availableTypes.some((type) => type.name === size)) setSize(availableTypes[0].name); }, [availableTypes, size]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { await api.addProjectServer(projectId, { name, region, size, image }); setShowAdd(false); await onChange(); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };

  return <section className="card p-5">
    <div className="mb-4 flex items-center justify-between"><div><h2 className="font-medium text-white">Servers</h2><p className="text-xs text-void-dim">Deployment targets owned by this Project</p></div><button className="btn-secondary" onClick={open} disabled={!hetznerConnected}>+ Add</button></div>
    {showAdd && <form onSubmit={add} className="mb-4 space-y-3 rounded-xl border border-void-border bg-void-bg/40 p-4">
      {busy && !catalog ? <Spinner /> : catalog ? <><input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="server-name" /><div className="grid grid-cols-2 gap-2"><select className="input" value={region} onChange={(event) => setRegion(event.target.value)}>{catalog.locations.map((location) => <option key={location.name} value={location.name}>{location.name} · {location.city}</option>)}</select><select className="input" value={size} onChange={(event) => setSize(event.target.value)}>{availableTypes.map((type) => <option key={type.name} value={type.name}>{type.name} · {type.cores} CPU · {type.memory} GB · {type.price_display}</option>)}</select></div><select className="input" value={image} onChange={(event) => setImage(event.target.value)}>{catalog.images.map((item) => <option key={item.name} value={item.name}>{item.description || item.name}</option>)}</select><div className="flex gap-2"><button className="btn-primary" disabled={busy}>Provision server</button><button type="button" className="btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button></div></> : null}
    </form>}
    <div className="space-y-3">{servers.length === 0 && <Empty text="No servers in this Project." />}{servers.map((server) => <Link key={server.id} to={`/servers/${server.id}?project=${projectId}`} className="block rounded-xl border border-void-border p-4 transition-colors hover:border-void-accent/40"><div className="flex items-center justify-between"><div><div className="font-medium text-white">{server.name}</div><div className="mt-1 text-xs text-void-dim">{server.region || "—"} · {server.size || "—"} · {timeAgo(server.last_seen_at)}</div></div><StatusPill status={server.status} /></div></Link>)}</div>
    {error && <p className="mt-3 text-sm text-void-err">{error}{error.includes("Hetzner") ? <> · <Link className="text-void-accent underline" to={`/projects/${projectId}/providers`}>Open providers</Link></> : null}</p>}
  </section>;
}

function Empty({ text }: { text: string }) { return <div className="rounded-xl border border-dashed border-void-border p-7 text-center text-sm text-void-dim">{text}</div>; }
function GithubMark() {
  return <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-black shadow-sm" aria-label="GitHub">
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden="true">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.4-1.27.74-1.56-2.57-.29-5.28-1.29-5.28-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.11c.98 0 1.95.13 2.87.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.07.79 2.16v3.25c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  </div>;
}

function HetznerMark() {
  return <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#d50c2d] text-white shadow-sm" aria-label="Hetzner Cloud">
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="currentColor" aria-hidden="true">
      <path d="M5.5 4.5h3.3v5.8h6.4V4.5h3.3v15h-3.3v-6.2H8.8v6.2H5.5z" />
    </svg>
  </div>;
}

function CloudflareMark() {
  return <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#f48120]/15 shadow-sm" aria-label="Cloudflare">
    <svg viewBox="0 0 32 24" className="h-7 w-8" aria-hidden="true">
      <path fill="#f48120" d="M20.8 19.7H7.1a5.1 5.1 0 0 1-.5-10.2A7.8 7.8 0 0 1 21.7 8a5.9 5.9 0 0 1-.9 11.7Z" />
      <path fill="#faae40" d="M24.6 19.7h-9.8a4.2 4.2 0 0 1 7.9-2.1 3.2 3.2 0 0 1 1.9-.6 1.4 1.4 0 1 1 0 2.7Z" />
    </svg>
  </div>;
}
