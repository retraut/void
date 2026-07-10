import type {
  DashboardData,
  Deployment,
  LogEntry,
  Metrics,
  Project,
  ServerRow,
  ServerSummary,
  SessionUser,
  SettingsData,
} from "./types";

/**
 * Thin fetch wrapper for the void Worker JSON API.
 *
 * Auth: the browser automatically sends the session cookie (set by
 * /api/auth/dev-login or the GitHub OAuth callback). We never attach a
 * Bearer token in the SPA — all SPA routes are session-cookie protected.
 *
 * 401 means "not logged in" — the caller (useAuth) redirects to login.
 */
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
    credentials: "same-origin",
  });
  if (res.status === 401) {
    const err = new Error("unauthorized") as ApiError;
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    const err = new Error(body.error || body.message || `HTTP ${res.status}`) as ApiError;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export interface ApiError extends Error {
  status?: number;
}

export const api = {
  me: () => apiFetch<{ user: SessionUser }>("/api/me"),

  servers: () => apiFetch<{ servers: ServerSummary[] }>("/api/servers-ui"),

  server: (id: string) => apiFetch<{ server: ServerRow }>(`/api/servers/${id}`),

  serverMetrics: async (id: string): Promise<Metrics | null> => {
    const d = await apiFetch<{ metrics: Metrics | null; last_heartbeat: number }>(
      `/servers/${id}/metrics`,
    );
    return d.metrics;
  },

  deleteServer: (id: string) =>
    apiFetch<{ ok: true; message: string }>(`/api/servers/${id}`, { method: "DELETE" }),

  projects: () => apiFetch<{ projects: Project[] }>("/api/projects"),

  deployments: (params: { project?: string | null; page?: number; perPage?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.project) q.set("project", params.project);
    if (params.page) q.set("page", String(params.page));
    if (params.perPage) q.set("per_page", String(params.perPage ?? 20));
    return apiFetch<{
      deployments: Deployment[];
      page: number;
      per_page: number;
      total: number;
      total_pages: number;
    }>(`/api/deployments?${q.toString()}`);
  },

  deployment: (id: string) => apiFetch<{ deployment: Deployment }>(`/api/deployments/${id}`),

  dashboard: () => apiFetch<DashboardData>("/api/dashboard"),

  devLogin: async (username = "lab") => {
    const res = await fetch("/api/auth/dev-login", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, returnTo: "/dashboard" }),
    });
    if (!res.ok) throw new Error("dev login failed");
    return true;
  },

  settings: () => apiFetch<SettingsData>("/api/settings"),

  logout: () => fetch("/api/auth/logout", { credentials: "same-origin" }),
};

// Passkey (WebAuthn) helpers — the browser drives the ceremony, the
// worker stores the credential. Mirrors the old inline <script> in ui.ts.
export async function passkeyRegisterStart() {
  const res = await fetch("/api/passkey/register/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
  });
  return res.json();
}

export async function passkeyRegisterFinish(name: string, response: unknown) {
  const res = await fetch("/api/passkey/register/finish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ name, response }),
  });
  return res.json();
}

export async function passkeyDelete(id: string) {
  const fd = new FormData();
  fd.append("id", id);
  const res = await fetch("/api/passkey/delete", { method: "POST", body: fd, credentials: "same-origin" });
  return res.ok;
}

/**
 * Subscribe to the server's SSE log stream. Returns an unsubscribe fn.
 * The browser passes the session cookie automatically; no token needed.
 */
export function streamLogs(
  serverId: string,
  deploymentId: string,
  onEntry: (e: LogEntry) => void,
  onStatus: (s: "connecting" | "open" | "closed" | "error") => void,
): () => void {
  const url = `/api/servers/${serverId}/logs?deployment_id=${encodeURIComponent(deploymentId)}`;
  const es = new EventSource(url);
  onStatus("connecting");
  es.onopen = () => onStatus("open");
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data) as LogEntry & { ready?: boolean };
      if (e.ready) return;
      onEntry(e);
    } catch {
      /* ignore malformed */
    }
  };
  es.onerror = () => onStatus("error");
  return () => es.close();
}
