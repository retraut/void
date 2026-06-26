import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
	test: {
		// On CI: add the `github-actions` reporter alongside the default one.
		// The default reporter still writes to stdout (for the log), the
		// github-actions reporter does two things automatically:
		//   1. Emits `::error file=...,line=...` annotations for every
		//      failing assertion — these show up inline in the PR diff
		//      (orange/red boxes next to the offending lines).
		//   2. Writes a clean job summary to $GITHUB_STEP_SUMMARY with
		//      per-file/test stats, flaky-test detection, and permalinks
		//      to the source lines (uses $GITHUB_REPOSITORY, $GITHUB_SHA,
		//      $GITHUB_WORKSPACE — all set by Actions automatically).
		// Locally: just the default reporter (no noisy annotations).
		reporters: process.env.GITHUB_ACTIONS === "true" ? ["default", "github-actions"] : ["default"],
	},
});
