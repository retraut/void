export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "never";
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function shortSha(sha: string | null | undefined): string {
  if (!sha) return "—";
  return sha.slice(0, 7);
}

export function clsx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export const STATUS_COLORS: Record<string, string> = {
  active: "bg-void-ok/15 text-void-ok",
  provisioning: "bg-void-accent2/15 text-void-accent2",
  pending: "bg-void-warn/15 text-void-warn",
  offline: "bg-void-dim/15 text-void-dim",
  failed: "bg-void-err/15 text-void-err",
  destroyed: "bg-void-dim/15 text-void-dim",
  queued: "bg-void-dim/15 text-void-dim",
  building: "bg-void-warn/15 text-void-warn",
  deploying: "bg-void-accent2/15 text-void-accent2",
  running: "bg-void-ok/15 text-void-ok",
  cancelled: "bg-void-dim/15 text-void-dim",
};
