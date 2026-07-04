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

# ── Legacy integration tests (CI uses these) ────────────────
test-integration:
	../scripts/test-config-apply.sh --no-build

# ── Comprehensive integration tests (need OrbStack VM) ──────
test-integration-apt:
	../scripts/test-integration-apt.sh

test-integration-file:
	../scripts/test-integration-file.sh

test-integration-user:
	../scripts/test-integration-user.sh

test-integration-docker:
	../scripts/test-integration-docker.sh

test-integration-all: test-integration-apt test-integration-file test-integration-user test-integration-docker

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
