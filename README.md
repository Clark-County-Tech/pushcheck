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
                                                            └─ post_commit_comment  report on the head commit
```

The Action ([.github/workflows/pushcheck.yml](.github/workflows/pushcheck.yml)) is deliberately dumb: one authenticated `curl` sending the repo, branch, and `before`/`head` SHAs. Everything else happens in the agent's durable session, which runs to completion with no client attached — the Action doesn't wait for the review.

### Design notes

- **A push is not a commit.** Pushes often batch several commits, so the diff comes from GitHub's compare API (`before...head`) — one review per push. New branches (all-zeros `before`) and force pushes fall back to the head commit's diff, and the report says so.
- **Idempotent comments.** eve re-runs steps interrupted mid-execution, so `post_commit_comment` tags every comment with a hidden marker and returns the existing comment instead of double-posting.
- **Locked-down harness.** eve ships shell, file, and web tools by default; this agent needs none of them, so they're all disabled ([`agent/tools/*.ts`](agent/tools) via `disableTool()`). The model's entire capability surface is the three GitHub tools.
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

## Watching a repo

For each repo you want reviewed:

1. Copy [.github/workflows/pushcheck.yml](.github/workflows/pushcheck.yml) into `.github/workflows/`.
2. Add an Actions **secret** `PUSHCHECK_PASSWORD` — the shared password.
3. Add an Actions **variable** `PUSHCHECK_URL` — your deployment URL, no trailing slash.
4. Make sure the PAT grants access to that repo.

Push to `main` or `dev` and check the head commit for the comment. This repo watches itself — its own pushes get reviewed by the deployed agent.

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
  agent.ts             model config
  channels/eve.ts      HTTP route auth (basic auth + Vercel OIDC + local dev)
  lib/github.ts        shared GitHub API helper
  tools/               fetch_push_diff, fetch_file, post_commit_comment
                       + disabled built-ins (bash, file, web tools)
.github/workflows/
  pushcheck.yml        the drop-in Action
```

## Roadmap

- 1Password (`op run`) wiring for local secrets
- Linear escalation for serious findings
- Optional quiet mode (comment only when something's found)
