import { motion } from "framer-motion";
import { clsx, STATUS_COLORS } from "../utils";

export type LoadTier = "light" | "medium" | "high" | "extra-high";

const LOAD_TIER_META: Record<LoadTier, { label: string; cls: string; bar: string }> = {
  light: {
    label: "light",
    cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    bar: "#10b981",
  },
  medium: {
    label: "medium",
    cls: "bg-lime-500/15 text-lime-300 border-lime-500/30",
    bar: "#84cc16",
  },
  high: {
    label: "high",
    cls: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    bar: "#f59e0b",
  },
  "extra-high": {
    label: "extra-high",
    cls: "bg-red-600/20 text-red-300 border-red-600/40",
    bar: "#dc2626",
  },
};

/** Classify load average (per-core) into a pressure tier. */
export function loadTier(loadPerCore: number): LoadTier {
  if (loadPerCore < 0.7) return "light";
  if (loadPerCore < 1.5) return "medium";
  if (loadPerCore < 3.0) return "high";
  return "extra-high";
}

/**
 * Load-average pressure badge. Prefers the agent-computed `tier`
 * (authoritative — it knows the core count), falling back to a local
 * classification from `load_avg[0]` / `cpu_count`. Shows a colored tier
 * (light=green → extra-high=bright red), a mini fill bar, and the raw
 * 1-min value. Hover for the full 1/5/15-minute load average.
 */
export function LoadBadge({
  load_avg,
  cpu_count,
  tier,
}: {
  load_avg: [number, number, number] | null;
  cpu_count?: number | null;
  tier?: LoadTier | null;
}) {
  const load = load_avg?.[0] ?? null;
  if (load == null) {
    return <span className="pill bg-void-dim/15 text-void-dim">LA —</span>;
  }
  const cores = Math.max(1, cpu_count ?? 1);
  const resolved = tier ?? loadTier(load / cores);
  const meta = LOAD_TIER_META[resolved];
  // Fill fraction for the mini bar: map per-core 0..4 → 0..100%.
  const frac = Math.min(100, (load / cores / 4) * 100);
  return (
    <span
      className={clsx("pill border", meta.cls)}
      title={
        load_avg
          ? `Load average (1/5/15 min): ${load_avg[0].toFixed(2)} / ${load_avg[1].toFixed(2)} / ${load_avg[2].toFixed(2)}\n` +
            `${cores} cpu · ${(load / cores).toFixed(2)} per core · tier: ${resolved}`
          : `Load: ${load.toFixed(2)} · tier: ${resolved}`
      }
    >
      <span className="relative h-1.5 w-8 overflow-hidden rounded-full bg-black/30">
        <motion.span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ background: meta.bar }}
          animate={{ width: `${frac}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        />
      </span>
      <span className="font-mono">{load.toFixed(2)}</span>
      <span className="opacity-80">{meta.label}</span>
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={clsx("pill", STATUS_COLORS[status] ?? "bg-void-dim/15 text-void-dim")}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <motion.span
      className="inline-block rounded-full border-2 border-void-border border-t-void-accent"
      style={{ width: size, height: size }}
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 0.8, ease: "linear" }}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("skeleton rounded-lg", className)} />;
}

export function AnimatedNumber({ value, suffix = "" }: { value: number; suffix?: string }) {
  return (
    <motion.span
      key={Math.round(value)}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      {value.toFixed(0)}
      {suffix}
    </motion.span>
  );
}

/** Animated horizontal bar for CPU / memory percentage. */
export function MetricBar({ label, percent, detail }: { label: string; percent: number; detail?: string }) {
  const color = percent > 85 ? "#ef4444" : percent > 65 ? "#f59e0b" : "#7c5cff";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-void-dim">{label}</span>
        <span className="font-mono text-white">
          <AnimatedNumber value={percent} suffix="%" />
          {detail && <span className="ml-1 text-void-dim">{detail}</span>}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-void-border">
        <motion.div
          className="h-full rounded-full"
          style={{ background: color }}
          animate={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        />
      </div>
    </div>
  );
}
