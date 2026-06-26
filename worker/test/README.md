# cloud-init smoke test

Tests the bash user_data that `buildCloudInit()` (in `src/hetzner.ts`)
generates, by running it in a fresh Ubuntu 24.04 container.

## Quick run

```sh
pnpm test:cloud-init
```

This runs (in order):

1. `vitest` — validates the user_data structure (shebang, set -e, key
   strings, inlined test values).
2. `tsx scripts/extract-cloud-init.mts` — writes the real user_data
   (from `buildCloudInit`) to `test/output/user_data.sh`.
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
6. Enable + start the service

The test currently fails at step 3 because there's no real
`void-agent-linux-*.tar.gz` published under any tag — `curl` returns
404 and `set -e` aborts. That's the expected behavior; once you
publish the first release (e.g. `v0.1.0`) with the agent binary
attached, the test will pass end-to-end.

Until then, the test verifies that steps 1 and 2 succeed and the
script structure is correct. Inspect `test/output/user_data.sh` for
the exact bash the agent will execute in production.

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

- `cloud-init.test.ts` — vitest assertions (structure + values)
- `Dockerfile` — Ubuntu 24.04 base, installs curl + ca-certificates,
  runs `user_data.sh` with `|| true`, prints final state
- `../scripts/extract-cloud-init.mts` — generates the real user_data
- `../scripts/test-cloud-init.sh` — orchestrator (`pnpm test:cloud-init`)
- `output/user_data.sh` — generated, gitignored
