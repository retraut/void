# cloud-init smoke test

Tests the bash user_data that `buildCloudInit()` (in `src/hetzner.ts`)
generates, by running it in a fresh Ubuntu 26.04 container.

## Quick run

```sh
pnpm test:cloud-init
```

This runs (in order):

1. `vitest` — validates the user_data structure (shebang, set -e, key
   strings, inlined test values, correct agent URL for the tag).
2. `tsx scripts/extract-cloud-init.mts` — writes the real user_data
   (from `buildCloudInit`) to `test/output/user_data.sh`, using the
   latest published release (`v0.4.0`) so the download actually works.
3. `docker build -f test/Dockerfile -t void-bootstrap-test .` — builds
   a fresh Ubuntu 26.04 image.
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

As of v0.4.0, the bootstrap reaches step 4 (config write) and
step 5 (systemd unit write) successfully, and the `void-agent`
binary inside the tarball is a real **Linux ELF** (built by the
release workflow on `ubuntu-latest`). The cosmetic `$(... --version)`
echo may still fail in Docker if glibc versions differ between the
build host and the container, but the binary itself runs and the
config + systemd unit are in place — exactly what's needed for a
real Hetzner VM to come up.

## Manual inspection

```sh
cat test/output/user_data.sh
```

The script is also what Hetzner stores in the VM's
`/var/log/cloud-init-output.log` after first boot.

## Why Docker (not the host)

- Reproducible: every run is a fresh `ubuntu:26.04`, no leftover
  state from previous tests.
- Safe: the agent install is destructive (`/usr/local/bin/void-agent`),
  we don't want to touch the host.
- Fast: ~22s per run including `apt-get install` and the cloudflared
  download.
- Doesn't need systemd to be running — we install the systemd unit
  file but don't try to start the service (we can't, no init).

## Files

- `cloud-init.test.ts` — vitest assertions (structure + values + URL)
- `Dockerfile` — Ubuntu 26.04 base, installs curl + ca-certificates,
  runs `user_data.sh` with `|| true`, prints final state
- `../scripts/extract-cloud-init.mts` — generates the real user_data
- `../scripts/test-cloud-init.sh` — orchestrator (`pnpm test:cloud-init`)
- `output/user_data.sh` — generated, gitignored
