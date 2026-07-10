import { motion } from "framer-motion";
import { clsx, STATUS_COLORS } from "../utils";

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
