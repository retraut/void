/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        void: {
          bg: "#08080b",
          panel: "#0e0e12",
          panel2: "#141419",
          border: "#1e1e26",
          accent: "#7c5cff",
          accent2: "#22d3ee",
          ok: "#22c55e",
          warn: "#f59e0b",
          err: "#ef4444",
          dim: "#8b8b99",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(124,92,255,0.4), 0 0 24px -4px rgba(124,92,255,0.5)",
      },
      keyframes: {
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
    },
  },
  plugins: [],
};
