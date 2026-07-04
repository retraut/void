.PHONY: test test-apt test-file test-user test-docker test-all clean

# ── Unit tests (fast, MockBackend) ──────────────────────────
test:
	cargo test

test-apt:
	cargo test engine::apt::

test-file:
	cargo test engine::file::

test-user:
	cargo test engine::user::

test-systemd:
	cargo test engine::systemd::

test-docker:
	cargo test --features docker engine::docker::

test-module:
	cargo test engine::module::

test-runner:
	cargo test engine::runner::

test-backend:
	cargo test engine::backend::

# ── All unit tests ───────────────────────────────────────────
test-all:
	cargo test --features docker

# ── Integration tests (need Docker daemon) ──────────────────
test-integration:
	../scripts/test-config-apply.sh --no-build

test-integration-docker:
	../scripts/test-docker-apply.sh --no-build

# ── Build ────────────────────────────────────────────────────
build:
	cargo build --release

build-docker:
	cargo build --release --features docker

# ── Full pipeline: build + test ──────────────────────────────
ci: test-all
ci-full: build build-docker test-all test-integration test-integration-docker

# ── Clean ────────────────────────────────────────────────────
clean:
	cargo clean
