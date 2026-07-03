
## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.

## Rust Rules

### Dependency Management
- `cargo update` updates deps within semver. For major bumps, edit `Cargo.toml` manually.
- When upgrading deps to latest, also upgrade Rust toolchain (`rustup install stable` + update CI `toolchain: stable`).
- Check MSRV of new deps before bumping: `cargo info <crate>` shows `rust-version:`.
- After dep upgrades, `cargo check` and `cargo check --features docker` must pass.
- **Always use the latest version of every crate.** When a new major version is available:
  1. Bump the version in `Cargo.toml`
  2. Run `cargo check` — fix all compilation errors
  3. Check the new crate's API docs/changelog for breaking changes
  4. Update usage to match the new API
  5. Never pin to an older version to avoid fixing code — upgrade the code.

### Test Patterns
- Unit tests go in `#[cfg(test)] mod tests { ... }` inside each module file (idiomatic Rust).
- Use `#[cfg(test)]` on struct definitions AND on every `impl` block referencing those types.
- If a test helper (e.g. `MockBackend`) is used from multiple files, don't gate it with `#[cfg(test)]` — instead gate each `impl` block.
- Use `Arc::new(MockBackend::new())` directly, not `let mb = MockBackend::new(); let b: Arc<dyn SystemBackend> = Arc::new(mb);`.

### Fixing Warnings
- NEVER use `#[allow(dead_code)]` unless there's an explicit reason documented in a comment.
- Fix dead code by:
  - Removing unused fields/functions
  - Gating with `#[cfg(test)]` for test utilities
  - Prefixing with `_` for intentionally unused variables
  - Actually using the variable/field in logic
- Run `cargo test` and `cargo check` locally before pushing.
- CI and local Rust MUST be the same version. CI uses `stable` — run `rustup update stable` locally to match.

### CI Monitoring
- After every push, watch CI with a polling loop, not a subagent.
- Use `rtk gh run list -w test -L 3 --json headSha,databaseId` to find run by commit SHA.
- Use `rtk gh run watch <id>` to wait for completion.
- Use `rtk gh run view <id> --log > /tmp/ci.log` + `grep "warning:" /tmp/ci.log` to check ALL warnings.
- Strip ANSI codes with python3 before grepping.
- Check warnings in BOTH build and test output.

### Definition of Done
- `cargo check` passes with 0 errors, 0 warnings
- `cargo check --features docker` passes with 0 errors, 0 warnings
- `cargo test` passes with 0 warnings
- `cargo test --features docker` passes with 0 warnings
- `cargo check --release` passes with 0 errors, 0 warnings
- CI `test` workflow: ALL jobs green, 0 warnings in any step log

## After every `git push` — watch CI

After pushing to a remote, **always** poll the GitHub Actions `test`
workflow on the just-pushed commit SHA until it completes. Read the
full log, grep for `warning:`, fix any warnings found, push again.
Repeat until green with zero warnings.

Why: the local pnpm test / `wrangler deploy` proves nothing about
the actual CI environment (different OS, different jq/Node versions,
no network for the cloud-init container, etc).

Use `rtk gh run view` from `/Users/retraut/Documents/null.sh`.

Workflows to watch:
- `test` — must be green AND zero warnings.
- `deploy` — IGNORE for now.
- `release` — IGNORE.
