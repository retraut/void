/**
 * Tests for server-register.ts.
 *
 * renderAgentConfigToml is pure (no D1 / env access) so we can
 * unit-test it directly. registerServerForUser itself is covered
 * by the integration test in scripts/test-lab/.
 */

import { describe, expect, it } from "vitest";
import { renderAgentConfigToml } from "./server-register";

describe("renderAgentConfigToml()", () => {
	const base = {
		api_base: "wss://void.example.com",
		server_id: "srv_abc123",
		setup_token: "set_def456",
	};

	it("emits the required fields", () => {
		const out = renderAgentConfigToml(base);
		expect(out).toContain("api_base = \"wss://void.example.com\"");
		expect(out).toContain("server_id = \"srv_abc123\"");
		expect(out).toContain("setup_token = \"set_def456\"");
	});

	it("emits optional fields only when present", () => {
		const out = renderAgentConfigToml(base);
		expect(out).not.toContain("state_dir");
		expect(out).not.toContain("public_url_template");
		expect(out).not.toContain("agent_shared_secret");
	});

	it("escapes backslashes and double quotes in values", () => {
		const out = renderAgentConfigToml({
			...base,
			public_url_template: 'https://"weird"\\host/{port}',
		});
		// backslash becomes \\, quote becomes \"
		expect(out).toContain('public_url_template = "https://\\"weird\\"\\\\host/{port}"');
	});

	it("writes a trailing newline so the file is POSIX-correct", () => {
		const out = renderAgentConfigToml(base);
		expect(out.endsWith("\n")).toBe(true);
	});

	it("includes a header comment explaining the file", () => {
		const out = renderAgentConfigToml(base);
		expect(out).toMatch(/^# void-agent config/);
		expect(out).toMatch(/# Written by/);
		// The setup_token is documented as single-use
		expect(out).toMatch(/single-use/);
	});
});
