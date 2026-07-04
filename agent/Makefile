.PHONY: test test-all ci build clean

# ── Unit tests ────────────────────────────────────────────────
test:
	cargo test

test-all:
	cargo test

# ── Build ────────────────────────────────────────────────────
build:
	cargo build --release

# ── Full pipeline: build + test ──────────────────────────────
ci: test build

# ── Clean ────────────────────────────────────────────────────
clean:
	cargo clean
