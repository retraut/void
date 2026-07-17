/**
 * Cloud-init user_data generator — structural validation.
 *
 * Extract the script via `pnpm tsx scripts/extract-cloud-init.mts`
 * (the test sandbox doesn't allow fs writes; the extractor script
 * does it from regular Node).
 */
import { describe, it, expect } from "vitest";
import { buildCloudInit } from "../src/hetzner";

describe("buildCloudInit()", () => {
	it("produces a valid bash user_data script with our test values", () => {
		const userData = buildCloudInit({
			server_id: "srv_test12345678",
			setup_token: "set_test12345678",
			api_base: "wss://void.example.com",
			github_release_tag: "v0.1.0",
		});

		// Structural assertions — catches accidental edits to the
		// template (e.g. removing set -e, breaking the systemd unit)
		expect(userData.startsWith("#!/bin/bash\n")).toBe(true);
		expect(userData).toMatch(/^set -e$/m);
		expect(userData).toContain("exec > >(tee -a /var/log/void-bootstrap.log) 2>&1");
		expect(userData).toContain("=== void-agent bootstrap starting at");
		expect(userData).toContain("=== void-agent bootstrap complete at");

		// cloudflared install
		expect(userData).toContain("cloudflared-linux-${CFD_ARCH}");
		expect(userData).toMatch(/chmod \+x \/usr\/local\/bin\/cloudflared/);

		// void-agent download + extract
		// v0.1.1+ uses `void-agent-{tag}.tar.gz` (fat binary, no arch in
		// the asset name; tag already starts with "v" so no prepending).
		// v0.1.0 used a different name and is unsupported.
		expect(userData).toContain("releases/download/v0.1.0/void-agent-v0.1.0.tar.gz");
		expect(userData).toContain("https://github.com/retraut/void/");
		expect(userData).toContain("tar -xzf void-agent.tar.gz");
		expect(userData).toContain("mv void-agent /usr/local/bin/void-agent");
		expect(userData).toContain('server_id = "srv_test12345678"');
		expect(userData).toContain('setup_token = "set_test12345678"');
		expect(userData).toContain('api_base = "wss://void.example.com"');

		// systemd unit
		expect(userData).toContain("[Unit]");
		expect(userData).toContain("[Service]");
		expect(userData).toContain("ExecStart=/usr/local/bin/void-agent");
		expect(userData).toContain("Restart=always");
		expect(userData).toContain("Nice=-20");
		expect(userData).toContain("OOMScoreAdjust=-1000");
		expect(userData).toContain("WantedBy=multi-user.target");
		expect(userData).toContain("systemctl daemon-reload");
		expect(userData).toContain("systemctl enable --now void-agent.service");

		// Sanity check on size
		expect(userData.length).toBeGreaterThan(500);
	});

	it("inlines our test values verbatim", () => {
		const ud = buildCloudInit({
			server_id: "srv_AAAA",
			setup_token: "set_BBBB",
			api_base: "wss://example.com",
			github_release_tag: "v9.9.9",
		});
		expect(ud).toContain('server_id = "srv_AAAA"');
		expect(ud).toContain('setup_token = "set_BBBB"');
		expect(ud).toContain('api_base = "wss://example.com"');
		expect(ud).toContain("releases/download/v9.9.9/void-agent-v9.9.9.tar.gz");
	});

	it("uses a custom github_repo when provided (fork support)", () => {
		const ud = buildCloudInit({
			server_id: "srv_x",
			setup_token: "set_x",
			api_base: "wss://x",
			github_release_tag: "v0.3.1",
			github_repo: "myfork/void",
		});
		expect(ud).toContain("https://github.com/myfork/void/releases/download/v0.3.1/void-agent-v0.3.1.tar.gz");
	});
});

