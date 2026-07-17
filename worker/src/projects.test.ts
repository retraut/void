import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema } from "./db";
import { createProject, ensureDefaultProject, projectSlug } from "./projects";
import { githubCloneEnv } from "./github-connections";
import { getProviderToken, setProviderToken } from "./credentials";

beforeAll(async () => {
	await ensureSchema(env.void_db);
});

describe("Project aggregate", () => {
	it("normalizes project slugs", () => {
		expect(projectSlug("  My Platform / Prod ")).toBe("my-platform-prod");
	});

	it("creates exactly one default project per user", async () => {
		const userId = `usr_test_${crypto.randomUUID()}`;
		await env.void_db
			.prepare("INSERT INTO users (id, username, created_at) VALUES (?, 'test', unixepoch())")
			.bind(userId)
			.run();
		const first = await ensureDefaultProject(env, userId);
		const second = await ensureDefaultProject(env, userId);
		expect(first.id).toBe(second.id);
		expect(first.id).toMatch(/^[0-9a-f]{32}$/);
		expect(first.name).toBe("Default Project");
		expect(first.is_default).toBe(1);
	});

	it("creates additional projects with unique slugs", async () => {
		const userId = `usr_test_${crypto.randomUUID()}`;
		await env.void_db
			.prepare("INSERT INTO users (id, username, created_at) VALUES (?, 'test', unixepoch())")
			.bind(userId)
			.run();
		await ensureDefaultProject(env, userId);
		const one = await createProject(env, userId, "Customer API");
		const two = await createProject(env, userId, "Customer API");
		expect(one.slug).toBe("customer-api");
		expect(two.slug).toBe("customer-api-2");
		expect(one.id).toMatch(/^[0-9a-f]{32}$/);
		expect(two.id).toMatch(/^[0-9a-f]{32}$/);
	});

	it("isolates provider credentials by project", async () => {
		const userId = `usr_test_${crypto.randomUUID()}`;
		await env.void_db
			.prepare("INSERT INTO users (id, username, created_at) VALUES (?, 'test', unixepoch())")
			.bind(userId)
			.run();
		const first = await ensureDefaultProject(env, userId);
		const second = await createProject(env, userId, "Second");
		await setProviderToken(env, userId, "hetzner", "token-for-first-project", first.id, 4);
		await setProviderToken(env, userId, "hetzner", "token-for-second-project", second.id, 4);
		await setProviderToken(env, userId, "cloudflare", "cloudflare-for-first-project", first.id, undefined, { zones: 2 });
		expect(await getProviderToken(env, userId, "hetzner", first.id)).toBe("token-for-first-project");
		expect(await getProviderToken(env, userId, "hetzner", second.id)).toBe("token-for-second-project");
		expect(await getProviderToken(env, userId, "cloudflare", first.id)).toBe("cloudflare-for-first-project");
	});
});

describe("GitHub clone credentials", () => {
	it("uses Git environment config instead of credentials in the repository URL", () => {
		const token = "github_pat_secret-value";
		const vars = githubCloneEnv(token);
		expect(vars.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
		expect(vars.GIT_CONFIG_VALUE_0).toContain("AUTHORIZATION: basic ");
		expect(JSON.stringify(vars)).not.toContain(`https://x-access-token:${token}@`);
	});
});
