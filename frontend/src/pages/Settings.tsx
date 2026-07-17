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
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="h-5 w-5">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
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
        <Passkeys data={data} onChange={reload} />
        <SystemSettings data={data} />
      </div>
    </div>
  );
}
