import { useState } from "react";
import { motion } from "framer-motion";
import { api } from "../api";
import { Spinner } from "../components/ui";

export default function Settings() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const saveHetzner = async (e: React.FormEvent) => {
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
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? "save failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Settings</h1>

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card p-6">
        <h2 className="font-medium">Hetzner token</h2>
        <p className="mt-1 text-sm text-void-dim">
          Stored encrypted. Used to provision servers and read the catalog. Verified live on save.
        </p>
        <form onSubmit={saveHetzner} className="mt-4 flex gap-3">
          <input
            className="input flex-1"
            type="password"
            placeholder="Hetzner API token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button className="btn-primary" disabled={busy || !token}>
            {busy ? <Spinner size={14} /> : "Save"}
          </button>
        </form>
        {msg && (
          <div className={`mt-3 text-sm ${msg.kind === "ok" ? "text-void-ok" : "text-void-err"}`}>
            {msg.text}
          </div>
        )}
      </motion.div>

      <div className="card mt-4 p-6">
        <h2 className="font-medium">Auth</h2>
        <p className="mt-1 text-sm text-void-dim">
          Session cookie based. Use <code className="font-mono">/api/auth/dev-login</code> in the test-lab
          or connect GitHub OAuth in production.
        </p>
        <button className="btn-secondary mt-4" onClick={() => api.logout().then(() => (window.location.href = "/login"))}>
          Log out everywhere
        </button>
      </div>
    </div>
  );
}
