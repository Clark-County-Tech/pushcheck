# pushcheck

An [eve](https://eve.dev) agent that reviews every direct push to my GitHub repos and posts a short sanity report as a commit comment.

I'm a solo developer — I push straight to `main`/`dev` with no pull requests, so nothing ever gets a second pair of eyes. pushcheck is that second pair of eyes: within a minute or two of a push, the head commit gets a review comment covering the entire push.

## What it checks

- **Security** — leaked keys or tokens, committed `.env` values, exposed endpoints or credentials. Findings reference the file, line, and credential type only; secret values are never reproduced in the comment.
- **Debug leftovers** — `console.log` calls, hardcoded test data, stray TODOs.
- **Changelog** — changes substantial enough to deserve a docs/changelog note, with a suggested entry ready to paste.

Clean pushes get a one-line "all clear" — silence always means the pipeline broke, never that the push was fine.

## How it works

```
git push ──► GitHub Action ──► POST /eve/v1/session ──► eve agent on Vercel
                (one curl,        (HTTP Basic auth)         │
                fire & forget)                              ├─ fetch_push_diff   one unified diff for the whole push
                                                            ├─ fetch_file        context when a hunk is ambiguous
                                                            ├─ escalate_to_linear   files a Linear issue for policy-matching findings
                                                            └─ post_commit_comment  report on the head commit
```

The Action ([.github/workflows/pushcheck.yml](.github/workflows/pushcheck.yml)) is deliberately dumb: one authenticated `curl` sending the repo, branch, and `before`/`head` SHAs. Everything else happens in the agent's durable session, which runs to completion with no client attached — the Action doesn't wait for the review.

### Design notes

- **A push is not a commit.** Pushes often batch several commits, so the diff comes from GitHub's compare API (`before...head`) — one review per push. New branches (all-zeros `before`) and force pushes fall back to the head commit's diff, and the report says so.
- **Idempotent comments and issues.** eve re-runs steps interrupted mid-execution, so `post_commit_comment` tags every comment with a hidden marker and returns the existing comment instead of double-posting, and `escalate_to_linear` does the same for issues with a visible marker line (see [Linear escalation](#linear-escalation)).
- **Locked-down harness.** eve ships shell, file, and web tools by default; this agent needs none of them, so they're all disabled ([`agent/tools/*.ts`](agent/tools) via `disableTool()`). The model's entire capability surface is four custom tools: three for GitHub plus `escalate_to_linear`.
- **Fail-closed auth.** The session endpoint requires HTTP Basic credentials (shared secret with the Action), and the basic-auth entry is only added to the auth chain when its env var is actually set — an unconfigured deployment can't accept blank credentials.
- **Explicit degradation.** Diffs truncate past 100 KB with a visible marker, fallbacks state their reason, and tool failures come back as data so the agent reports them in the comment instead of dying silently.

## Stack

[eve](https://eve.dev) 0.24.3 (exact-pinned) · TypeScript · Vercel · model via Vercel AI Gateway (OIDC — no provider API keys) · pnpm

## Deploying your own

1. Clone, `pnpm install`, and link a Vercel project (`vercel link`).
2. Create a **fine-grained GitHub PAT** with *Contents: read & write* on the repos you want watched.
3. Generate a shared password: `openssl rand -base64 32`.
4. Set both env vars in Vercel (production + development):
   | Variable | Value |
   |---|---|
   | `PUSHCHECK_GITHUB_TOKEN` | the PAT |
   | `PUSHCHECK_BASIC_PASSWORD` | the shared password |
5. `vercel deploy --prod` and note your deployment URL.
6. Optional: wire up [Linear escalation](#linear-escalation) so serious findings also land in your Linear workspace.

## Watching a repo

For each repo you want reviewed:

1. Copy [.github/workflows/pushcheck.yml](.github/workflows/pushcheck.yml) into `.github/workflows/`.
2. Add an Actions **secret** `PUSHCHECK_PASSWORD` — the shared password.
3. Add an Actions **variable** `PUSHCHECK_URL` — your deployment URL, no trailing slash.
4. Make sure the PAT grants access to that repo.

Push to `main` or `dev` and check the head commit for the comment. This repo watches itself — its own pushes get reviewed by the deployed agent.

## Linear escalation

When a push's findings match the escalation policy, the agent files **one Linear issue per push** — before posting the commit comment, so the comment links the issue and the issue links the commit. Escalation is optional: with no Linear configuration the agent behaves exactly as before.

### One-time setup

Credentials run through [Vercel Connect](https://vercel.com/docs/connect) (beta), so no Linear secret is ever stored — Connect owns the OAuth app, token rotation, and refresh (Linear OAuth tokens expire daily and rotate, so a static token wouldn't survive anyway):

1. In the linked project, run `vercel connect create linear` and name the app `pushcheck`, so the connector UID is `linear/pushcheck` (any other name works if you set `LINEAR_CONNECTOR` to the UID you got). The CLI opens a browser where you authorize Linear so Vercel can create the OAuth app in your workspace. You're done when the CLI prints `Success! linear connector created`.
   > If the browser afterwards lands on another **Configure Connector** form — possibly complaining that a connector with that name already exists — the CLI already finished. Close the tab; don't create a second connector.
2. Install the connector into your workspace: `vercel connect open linear/pushcheck`, then under **Installations** click **Add Installation** and authorize your Linear workspace. This is the actor=app consent that lets the connector mint tokens — without it the tool fails with `App authorization required (client_installation_required)`. The dashboard's **Test App Token** button confirms it works. (Ignore **Add Trigger Destination** — that's webhooks, which pushcheck doesn't use.)
3. Set the env vars below in Vercel and redeploy.

This is a *customer-owned connector*: the OAuth app lives in your Linear workspace and you manage it. Connect bills **$3 per 10,000 token requests** — pushcheck fetches at most one token per reviewed push (cached in-process), so this rounds to pennies.

Issues are authored by the pushcheck app identity. If you set `LINEAR_API_KEY` instead (the no-Connect fallback), issues are filed as the key's owner — you.

### Configuration

| Variable | Value |
|---|---|
| `PUSHCHECK_ESCALATION` | `security` (default) · `serious` · `all` · `off` |
| `LINEAR_TEAM_ID` | your team key — the prefix on issue identifiers like `ENG-123`, also under Linear **Settings → Teams**. (A team UUID works too; keys are resolved via the API) |
| `LINEAR_LABEL` | optional label *name*. **Create it in the team yourself** (Team settings → Labels): the app identity is typically not allowed to create labels, and the tool then files issues without the label (label problems never block filing) |
| `LINEAR_PROJECT_ID` | optional project UUID (UUID only — keys are not resolved) |
| `LINEAR_API_KEY` | optional personal API key, used instead of Connect when set |
| `LINEAR_CONNECTOR` | optional Connect connector UID override (default `linear/pushcheck`) |

Policy meanings: `security` escalates only Security-section findings; `serious` adds anything urgent enough to act on before the next push; `all` escalates any push with at least one finding (clean pushes never escalate); `off` disables escalation entirely.

Changing the policy requires a redeploy: the policy line in the agent's prompt is resolved at build time. The tool independently re-checks `off`/unconfigured at runtime, so a stale prompt can never cause filing while escalation is disabled.

### Deduplication

Every escalated issue's description ends with a visible footer line:

```
pushcheck-marker: <owner>/<repo>@<head-sha>
```

Before filing, the tool searches Linear for an issue containing that marker and returns the existing issue instead of creating a duplicate. This is what makes eve's step re-runs safe — the Linear counterpart of the hidden HTML marker on commit comments (visible here because Linear may strip HTML comments from descriptions).

## Local development

```bash
pnpm install
vercel env pull .env.local   # secrets + gateway token
pnpm dev                     # eve dev TUI at http://127.0.0.1:2000
```

Simulate a push (no auth needed on localhost):

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Push to <owner>/<repo> branch main: before SHA <base>, head SHA <head>"}'
```

## Layout

```
agent/
  instructions.md      the reviewer prompt (rubric + rules)
  instructions/
    escalation.ts      escalation policy fragment, built from PUSHCHECK_ESCALATION
  agent.ts             model config
  channels/eve.ts      HTTP route auth (basic auth + Vercel OIDC + local dev)
  lib/github.ts        shared GitHub API helper
  lib/linear.ts        shared Linear GraphQL helper
  tools/               fetch_push_diff, fetch_file, escalate_to_linear,
                       post_commit_comment
                       + disabled built-ins (bash, file, web tools)
.github/workflows/
  pushcheck.yml        the drop-in Action
```

## Roadmap

- 1Password (`op run`) wiring for local secrets
- Optional quiet mode (comment only when something's found)

## License

[MIT](LICENSE)
