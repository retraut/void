import { useCallback, useState } from "react";
import { motion } from "framer-motion";
import { startRegistration } from "@simplewebauthn/browser";
import { api, passkeyDelete, passkeyRegisterFinish, passkeyRegisterStart } from "../api";
import { usePolling } from "../hooks";
import { Spinner } from "../components/ui";
import { timeAgo } from "../utils";
import type { SettingsData } from "../types";

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card p-6">
      <h2 className="font-medium">{title}</h2>
      {desc && <p className="mt-1 text-sm text-void-dim">{desc}</p>}
      <div className="mt-4">{children}</div>
    </motion.div>
  );
}

function CloudProviders({ data }: { data: SettingsData }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/settings/hetzner", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        credentials: "same-origin",
        body: new URLSearchParams({ token }).toString(),
      });
      if (res.ok) {
        setMsg({ kind: "ok", text: "Hetzner token saved & verified." });
        setToken("");
      } else {
        const url = new URL(res.url);
        setMsg({ kind: "err", text: url.searchParams.get("msg") ?? "save failed" });
      }
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("token", token);
      const res = await fetch("/settings/hetzner/test", { method: "POST", body: fd, credentials: "same-origin" });
      const j = await res.json();
      if (j.ok) setMsg({ kind: "ok", text: `Token works — ${j.datacenters} datacenters reachable.` });
      else setMsg({ kind: "err", text: j.reason ?? "verification failed" });
    } finally {
      setTesting(false);
    }
  };

  const del = async () => {
    await fetch("/settings/hetzner/delete", { method: "POST", credentials: "same-origin" });
    window.location.reload();
  };

  const cred = data.hetzner_cred;
  return (
    <Section
      title="Cloud providers"
      desc="Connect a cloud provider to provision servers. Your API token is encrypted at rest and only used to call the provider's API."
    >
      <div className="flex items-start gap-4 rounded-xl border border-void-border bg-void-bg/40 p-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#D50C2D]/15 text-[#ff5a6e]">
          H
        </div>
        <div className="flex-1">
          <div className="font-medium text-white">Hetzner Cloud</div>
          <div className="text-xs text-void-dim">
            {cred ? (
              <span className="text-void-ok">✓ Token saved {timeAgo(cred.created_at)}</span>
            ) : (
              <span className="text-void-warn">Not configured</span>
            )}
            {cred?.verified_datacenters ? (
              <span> · {cred.verified_datacenters} datacenters reachable</span>
            ) : null}
          </div>
        </div>
        {cred && (
          <button className="btn-secondary" onClick={del}>
            Delete token
          </button>
        )}
      </div>

      {!cred && (
        <form onSubmit={save} className="mt-4 flex flex-wrap items-start gap-3">
          <input
            className="input flex-1"
            type="password"
            placeholder="hcloud_xxxxxxxxxxxxxxxx"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="button" className="btn-secondary" onClick={test} disabled={!token || testing}>
            {testing ? <Spinner size={14} /> : "Test"}
          </button>
          <button className="btn-primary" disabled={!token || busy}>
            {busy ? <Spinner size={14} /> : "Save"}
          </button>
        </form>
      )}
      {msg && (
        <div className={`mt-3 text-sm ${msg.kind === "ok" ? "text-void-ok" : "text-void-err"}`}>{msg.text}</div>
      )}
      {!cred && data.env_has_hetzner_token && (
        <p className="mt-2 text-xs text-void-dim">Tip: env HETZNER_TOKEN is also set as a fallback for this deployment.</p>
      )}
    </Section>
  );
}

function Passkeys({ data, onChange }: { data: SettingsData; onChange: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const opts = await passkeyRegisterStart();
      const response = await startRegistration(opts);
      const res = await passkeyRegisterFinish(name || "Passkey", response);
      if (res.ok) {
        setName("");
        onChange();
      } else {
        setMsg(res.error ?? "registration failed");
      }
    } catch (e: any) {
      setMsg(e?.message ?? "cancelled");
    } finally {
      setBusy(false);
    }
  };

  const del = async (id: string) => {
    await passkeyDelete(id);
    onChange();
  };

  return (
    <Section
      title="Passkeys"
      desc="Use your device's biometric (TouchID, FaceID, Windows Hello) or a hardware key to sign in — no password, no GitHub round-trip."
    >
      {data.passkeys.length > 0 ? (
        <div className="mb-4 overflow-hidden rounded-lg border border-void-border">
          {data.passkeys.map((p) => (
            <div key={p.id} className="flex items-center justify-between border-b border-void-border px-3 py-2 last:border-0">
              <div>
                <div className="text-sm text-white">{p.name}</div>
                <div className="text-xs text-void-dim">
                  added {timeAgo(p.created_at)} · last used {p.last_used_at ? timeAgo(p.last_used_at) : "never"}
                </div>
              </div>
              <button className="btn-secondary px-2 py-1 text-xs" onClick={() => del(p.id)}>
                delete
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mb-4 text-sm text-void-dim">No passkeys yet. Add one below.</p>
      )}
      <form onSubmit={add} className="flex items-center gap-3">
        <input
          className="input flex-1"
          placeholder="MacBook TouchID, iPhone 15 Pro, YubiKey 5…"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn-primary" disabled={busy}>
          {busy ? <Spinner size={14} /> : "+ Add passkey"}
        </button>
      </form>
      {msg && <p className="mt-2 text-xs text-void-err">{msg}</p>}
    </Section>
  );
}

function SystemSettings({ data }: { data: SettingsData }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);

  const save = async (key: string) => {
    const value = values[key];
    if (value === undefined || value === "") return;
    const fd = new URLSearchParams({ value });
    const res = await fetch(`/settings/system/${key}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      credentials: "same-origin",
      body: fd.toString(),
    });
    if (res.ok) {
      setSaved(key);
      setValues((v) => ({ ...v, [key]: "" }));
      setTimeout(() => setSaved(null), 2500);
    }
  };

  const del = async (key: string) => {
    await fetch(`/settings/system/${key}/delete`, { method: "POST", credentials: "same-origin" });
    setSaved(key);
    setTimeout(() => setSaved(null), 2500);
  };

  return (
    <Section
      title="System settings"
      desc="Operator-managed tokens, encrypted at rest. If unset, the worker falls back to environment variables. GitHub OAuth secrets ship via the deploy workflow."
    >
      <div className="space-y-4">
        {data.system_keys.map((k) => {
          const isSet = data.overridden.includes(k.key);
          return (
            <div key={k.key} className="rounded-lg border border-void-border p-4">
              <div className="flex items-center justify-between">
                <div className="font-medium text-white">{k.label}</div>
                <span
                  className={`pill ${isSet ? "bg-void-ok/15 text-void-ok" : "bg-void-dim/15 text-void-dim"}`}
                >
                  {isSet ? "set in panel" : "env fallback"}
                </span>
              </div>
              <p className="mt-1 text-xs text-void-dim">{k.description}</p>
              {k.warning && <p className="mt-1 text-xs text-void-warn">⚠ {k.warning}</p>}
              <div className="mt-3 flex items-center gap-2">
                {k.textarea ? (
                  <textarea
                    className="input min-h-[72px] flex-1 font-mono text-xs"
                    placeholder={k.placeholder}
                    value={values[k.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [k.key]: e.target.value }))}
                  />
                ) : (
                  <input
                    className="input flex-1"
                    placeholder={k.placeholder}
                    value={values[k.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [k.key]: e.target.value }))}
                  />
                )}
                <button className="btn-primary" disabled={!values[k.key]} onClick={() => save(k.key)}>
                  Save
                </button>
                {isSet && (
                  <button className="btn-secondary" onClick={() => del(k.key)}>
                    Clear
                  </button>
                )}
              </div>
              {saved === k.key && <p className="mt-2 text-xs text-void-ok">Saved.</p>}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

export default function Settings() {
  const { data, loading, refresh } = usePolling<SettingsData | null>(() => api.settings(), 10000);
  const reload = useCallback(() => refresh(), [refresh]);

  if (loading && !data) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-8">
        <Spinner />
      </div>
    );
  }
  if (!data) return <div className="mx-auto max-w-3xl px-8 py-8 text-void-err">Failed to load settings.</div>;

  const u = data.user;
  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Settings</h1>

      {u && (
        <div className="card mb-4 flex items-center justify-between p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-void-accent/20 text-void-accent">
              {u.username[0]?.toUpperCase()}
            </div>
            <div>
              <div className="font-medium text-white">@{u.username}</div>
              <div className="text-xs text-void-dim">
                GitHub · joined {timeAgo(u.created_at)} · session 30d
              </div>
            </div>
          </div>
          <a href="/api/auth/logout" className="btn-secondary">
            Sign out
          </a>
        </div>
      )}

      <div className="space-y-4">
        <CloudProviders data={data} />
        <Passkeys data={data} onChange={reload} />
        <SystemSettings data={data} />
      </div>
    </div>
  );
}
