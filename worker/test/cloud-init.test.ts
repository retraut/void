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
		// The arch is computed at runtime via `uname -m | sed ...`,
		// inlined directly in the curl URL (not via a separate var).
		expect(userData).toContain("releases/download/v0.1.0/void-agent-linux-");
		expect(userData).toContain("$(uname -m | sed 's/x86_64/x86_64/;s/aarch64/aarch64/')");
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
		expect(ud).toContain("releases/download/v9.9.9/void-agent-linux");
	});
});

