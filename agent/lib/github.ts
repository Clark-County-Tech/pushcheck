const GITHUB_API = "https://api.github.com";

export interface GitHubResponse {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * Calls the GitHub REST API with the pushcheck PAT when configured
 * (unauthenticated works for public repos at a low rate limit).
 */
export async function githubRequest(
  path: string,
  options: { accept?: string; method?: string; json?: unknown } = {},
): Promise<GitHubResponse> {
  const headers: Record<string, string> = {
    accept: options.accept ?? "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "pushcheck-agent",
  };
  const token = process.env.PUSHCHECK_GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.json !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${GITHUB_API}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
  });
  return { ok: response.ok, status: response.status, body: await response.text() };
}

/** Truncates text at limit bytes-ish (code points), appending an explicit marker. */
export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, limit)}\n\n[truncated at ${limit} characters — only the content above is visible]`,
    truncated: true,
  };
}
