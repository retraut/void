import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { api } from "../api";
import { Spinner } from "../components/ui";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  // If already logged in, skip straight to dashboard.
  useEffect(() => {
    api
      .me()
      .then(() => navigate((location.state as any)?.from || "/dashboard", { replace: true }))
      .catch(() => setChecking(false));
  }, [navigate, location.state]);

  const devLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.devLogin("lab");
      navigate("/dashboard", { replace: true });
    } catch (e: any) {
      setError(e?.message || "dev login failed");
    } finally {
      setBusy(false);
    }
  };

  if (checking) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="card w-full max-w-sm p-8"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-void-accent to-void-accent2 shadow-glow" />
          <div>
            <div className="text-xl font-semibold tracking-tight">void</div>
            <div className="text-xs text-void-dim">Best DX. Hetzner pricing. No SSH.</div>
          </div>
        </div>

        <a href="/api/auth/github?returnTo=/dashboard" className="btn-primary w-full">
          Continue with GitHub
        </a>

        <div className="my-4 flex items-center gap-3 text-xs text-void-dim">
          <span className="h-px flex-1 bg-void-border" />
          OR
          <span className="h-px flex-1 bg-void-border" />
        </div>

        <button onClick={devLogin} disabled={busy} className="btn-secondary w-full">
          {busy ? <Spinner size={14} /> : null}
          Continue as lab (test-lab, no GitHub)
        </button>

        {error && <div className="mt-3 text-sm text-void-err">{error}</div>}
      </motion.div>
    </div>
  );
}
