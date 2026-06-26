
## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.

## After every `git push` — watch CI

After pushing to a remote, **always** launch a subagent that polls the
GitHub Actions `test` workflow on the just-pushed commit SHA. Wait
for the result. The subagent must report back with one of:
- `success` — done, carry on
- `failure` — the subagent should already have the failure details
  (which job/step, which log lines). Read them, fix, push again,
  re-launch the subagent. Repeat until green.

Why: the local pnpm test / `wrangler deploy` proves nothing about
the actual CI environment (different OS, different jq/Node versions,
no network for the cloud-init container, etc). Catching the failure
NOW means the user sees one green run at the end of the session, not
a half-green repo they have to come back to.

Subagent prompt template — point it at the run ID, tell it to poll
every 20s, report the final conclusion and (if red) the failed
job/step names + the relevant log lines. Use `rtk gh run view` from
`/Users/retraut/Documents/null.sh`.

Workflows to watch:
- `test` — must be green. Covers vitest, agent JSON logging,
  cloud-init smoke test.
- `deploy` — IGNORE for now. It will fail until
  `CLOUDFLARE_API_TOKEN` is added as a GitHub repo secret, and
  that's the user's job to do, not ours.
- `release` — IGNORE. Only runs on `v*` tag push, not on commits.

Implementation note: I already did this once for the NDJSON jq fix
(commit `3d50bd2`), the user liked it, now it's policy.
