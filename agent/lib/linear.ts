const LINEAR_API = "https://api.linear.app/graphql";

export interface LinearResponse {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * Calls the Linear GraphQL API. OAuth access tokens (Vercel Connect) go in
 * the authorization header with a `Bearer` prefix; personal API keys are
 * sent bare — Linear rejects a Bearer-prefixed personal key.
 */
export async function linearRequest(
  query: string,
  variables: Record<string, unknown>,
  token: string,
  tokenIsOAuth: boolean,
): Promise<LinearResponse> {
  const response = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: tokenIsOAuth ? `Bearer ${token}` : token,
    },
    body: JSON.stringify({ query, variables }),
  });
  return { ok: response.ok, status: response.status, body: await response.text() };
}

/**
 * Folds the three GraphQL failure shapes — HTTP error, 200 with an `errors`
 * array, missing `data` — into one error string. Linear returns HTTP 200 for
 * most failures, so `ok` alone is never enough.
 */
export function parseLinear<T>(
  res: LinearResponse,
  operation: string,
): { data: T; error?: undefined } | { data?: undefined; error: string } {
  if (!res.ok) {
    return { error: `${operation} failed: HTTP ${res.status}: ${res.body.slice(0, 500)}` };
  }
  let parsed: { data?: T; errors?: Array<{ message?: string }> };
  try {
    parsed = JSON.parse(res.body) as typeof parsed;
  } catch {
    return { error: `${operation} returned unparseable JSON: ${res.body.slice(0, 200)}` };
  }
  if (parsed.errors?.length) {
    const messages = parsed.errors.map((e) => e.message ?? "unknown error").join("; ");
    return { error: `${operation} failed: ${messages.slice(0, 500)}` };
  }
  if (!parsed.data) return { error: `${operation} returned no data` };
  return { data: parsed.data };
}

/** Linear team ids are UUIDs; team keys like "ENG" are not. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
