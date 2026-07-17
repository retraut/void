import type { Env } from "./env";
import { decrypt, encrypt, getEncryptionKey } from "./crypto";

const GITHUB_API = "https://api.github.com";

export interface GithubAccount {
	id: number;
	login: string;
	avatar_url: string | null;
}
export interface GithubRepository {
	id: number;
	name: string;
	full_name: string;
	private: boolean;
	clone_url: string;
	html_url: string;
	default_branch: string;
	description: string | null;
	updated_at: string;
}

async function githubFetch<T>(token: string, path: string): Promise<T> {
	const response = await fetch(`${GITHUB_API}${path}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "void-paas",
		},
	});
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			throw new Error("GitHub rejected the token; check token access and repository permissions");
		}
		throw new Error(`GitHub API returned HTTP ${response.status}`);
	}
	return (await response.json()) as T;
}

export async function verifyGithubToken(token: string): Promise<GithubAccount> {
	if (token.length < 20 || token.length > 255 || /\s/.test(token)) {
		throw new Error("invalid GitHub token format");
	}
	return await githubFetch<GithubAccount>(token, "/user");
}

export async function saveGithubConnection(
	env: Env,
	userId: string,
	projectId: string,
	token: string,
): Promise<GithubAccount> {
	const account = await verifyGithubToken(token);
	const encrypted = await encrypt(getEncryptionKey(env), token);
	const id = `ghc_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
	await env.void_db
		.prepare(
			`INSERT INTO github_connections
			 (id, project_id, user_id, github_id, login, avatar_url, encrypted_token, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
			 ON CONFLICT(project_id) DO UPDATE SET
			   user_id = excluded.user_id,
			   github_id = excluded.github_id,
			   login = excluded.login,
			   avatar_url = excluded.avatar_url,
			   encrypted_token = excluded.encrypted_token,
			   updated_at = unixepoch()`,
		)
		.bind(id, projectId, userId, String(account.id), account.login, account.avatar_url, encrypted)
		.run();
	return account;
}

export async function getGithubToken(env: Env, projectId: string): Promise<string | null> {
	const row = await env.void_db
		.prepare("SELECT encrypted_token FROM github_connections WHERE project_id = ?")
		.bind(projectId)
		.first<{ encrypted_token: string }>();
	if (!row) return null;
	return await decrypt(getEncryptionKey(env), row.encrypted_token);
}

export async function listGithubRepositories(env: Env, projectId: string): Promise<GithubRepository[]> {
	const token = await getGithubToken(env, projectId);
	if (!token) throw new Error("connect a GitHub account first");
	return await githubFetch<GithubRepository[]>(
		token,
		"/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
	);
}

export async function getGithubRepository(
	env: Env,
	projectId: string,
	repositoryId: string,
): Promise<GithubRepository> {
	const token = await getGithubToken(env, projectId);
	if (!token) throw new Error("connect a GitHub account first");
	if (!/^\d+$/.test(repositoryId)) throw new Error("invalid GitHub repository ID");
	return await githubFetch<GithubRepository>(token, `/repositories/${repositoryId}`);
}

/** Git credential transport without embedding the token in the clone URL/command. */
export function githubCloneEnv(token: string): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${btoa(`x-access-token:${token}`)}`,
		GIT_TERMINAL_PROMPT: "0",
	};
}
