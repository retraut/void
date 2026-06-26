# cloud-init smoke test

Tests the bash user_data that `buildCloudInit()` (in `src/hetzner.ts`)
generates, by running it in a fresh Ubuntu 24.04 container.

## Quick run

```sh
pnpm test:cloud-init
```

This runs (in order):

1. `vitest` — validates the user_data structure (shebang, set -e, key
   strings, inlined test values, correct agent URL for the tag).
2. `tsx scripts/extract-cloud-init.mts` — writes the real user_data
   (from `buildCloudInit`) to `test/output/user_data.sh`, using the
   latest published release (`v0.3.1`) so the download actually works.
3. `docker build -f test/Dockerfile -t void-bootstrap-test .` — builds
   a fresh Ubuntu 24.04 image.
4. `docker run --rm void-bootstrap-test` — runs the user_data and
   prints the bootstrap log.

## What it actually tests

The bootstrap script does (in order):

1. Create state dirs (`/var/lib/void`, `/etc/void`)
2. Install `cloudflared` (downloads from GitHub releases)
3. Download the `void-agent` binary from GitHub releases
4. Write `/etc/void/config.toml` (server_id, setup_token, api_base)
5. Install the `void-agent.service` systemd unit
6. Enable + start the service (needs systemd as PID 1 — won't run
   in a plain Docker container, but works in a real Hetzner VM)

The script uses `set -e` so any failure aborts. The Docker test runs
the script with `|| true` to keep the build going and then inspects
the state via a follow-up `RUN` step.

## Current state

The bootstrap reaches step 4 (config write) and step 5 (systemd unit
write) successfully. The script then aborts because the `void-agent`
binary in the v0.3.1 tarball is a **macOS Mach-O** binary, not a
**Linux ELF** — so the cosmetic `$(... --version)` subshell fails
with "Exec format error". In a real Hetzner VM (where systemd is PID
1 and the agent binary is a real Linux ELF), the script completes
end-to-end.

**Two things need to happen for the test to fully pass:**

1. The agent tarball needs to contain a Linux ELF binary (cross-compile
   from macOS, or build on Linux). This is a one-time release-time fix.
2. The systemd `enable --now` step needs systemd as PID 1 — which is
   a Docker limitation. We can spin up a privileged container with
   `docker run --privileged --tmpfs /run --tmpfs /run/lock:noexec,...`
   and `ENTRYPOINT ["/sbin/init"]` for a real systemd test, but the
   smoke test as-is is enough to validate the script structure.

## Manual inspection

```sh
cat test/output/user_data.sh
```

The script is also what Hetzner stores in the VM's
`/var/log/cloud-init-output.log` after first boot.

## Why Docker (not the host)

- Reproducible: every run is a fresh `ubuntu:24.04`, no leftover
  state from previous tests.
- Safe: the agent install is destructive (`/usr/local/bin/void-agent`),
  we don't want to touch the host.
- Fast: ~22s per run including `apt-get install` and the cloudflared
  download.
- Doesn't need systemd to be running — we install the systemd unit
  file but don't try to start the service (we can't, no init).

## Files

- `cloud-init.test.ts` — vitest assertions (structure + values + URL)
- `Dockerfile` — Ubuntu 24.04 base, installs curl + ca-certificates,
  runs `user_data.sh` with `|| true`, prints final state
- `../scripts/extract-cloud-init.mts` — generates the real user_data
- `../scripts/test-cloud-init.sh` — orchestrator (`pnpm test:cloud-init`)
- `output/user_data.sh` — generated, gitignored
