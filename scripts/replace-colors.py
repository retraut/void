#!/usr/bin/env python3
"""Bulk-replace hardcoded colors in the <style> block of worker/src/ui.ts
with var(--name) references. Skips :root{...} blocks so the palette
definitions stay as hex values. Run from the repo root."""
import re
import sys
from pathlib import Path

PATH = Path("worker/src/ui.ts")
content = PATH.read_text()

REPLACEMENTS = [
    # Backgrounds
    (r"#0a0a0a", "var(--bg-alt)"),
    (r"#060606", "var(--bg-deep)"),
    (r"#0f0f0f", "var(--bg-specs)"),
    (r"#101010", "var(--bg-elevated)"),
    (r"#141414", "var(--bg-hover)"),
    (r"#1a0a0a", "var(--error-bg)"),
    (r"#2a0a0a", "var(--error-border)"),
    # Borders
    (r"#1a1a1a", "var(--border)"),
    (r"#222(?!2)", "var(--border-alt)"),
    (r"#333(?!3)", "var(--border-strong)"),
    (r"#444(?!4)", "var(--border-hover)"),
    # Text
    (r"#fff(?!f)", "var(--text)"),
    (r"#ccc(?!c)", "var(--text-2)"),
    (r"#888(?!8)", "var(--text-muted)"),
    (r"#666(?!6)", "var(--text-dim)"),
    (r"#aaa(?!a)", "var(--text-2)"),
    # Accents
    (r"#0f8(?!8)", "var(--accent)"),
    (r"#0f0(?!0)", "var(--success)"),
    (r"#6cf(?!f)", "var(--link)"),
    # Status
    (r"#f90(?!0)", "var(--warning)"),
    (r"#f44(?!4)", "var(--error)"),
    (r"#f55(?!5)", "var(--error)"),
    (r"#0a3320", "var(--success-bg)"),
    (r"#33220a", "var(--warning-bg)"),
    (r"#330a0a", "var(--error-bg)"),
    (r"#1f6b3d", "var(--success-border)"),
    (r"#6b1f1f", "var(--error-border)"),
    (r"#533", "var(--error-border)"),
    # Hetzner brand
    (r"#D50C2D", "var(--hetzner)"),
    # Body bg (last so #000000 isn't matched)
    (r"#000(?!0)", "var(--bg)"),
]


def replace_in_style(match: re.Match) -> str:
    css = match.group(1)
    # Split on :root{...} blocks; even-index parts get the replacement.
    parts = re.split(r"(:root\{[^}]*\})", css)
    for i in range(0, len(parts), 2):
        for pat, repl in REPLACEMENTS:
            parts[i] = re.sub(pat, repl, parts[i])
    return "<style>" + "".join(parts) + "</style>"


new_content, n = re.subn(
    r"<style>(.*?)</style>", replace_in_style, content, flags=re.DOTALL
)
if n != 1:
    sys.exit(f"expected exactly 1 <style> block, got {n}")

PATH.write_text(new_content)
print(f"OK — {len(content)} → {len(new_content)} bytes ({(len(content)-len(new_content)):+d})")
