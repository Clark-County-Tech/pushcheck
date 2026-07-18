import { connect } from "@vercel/connect/eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { isUuid, linearRequest, parseLinear } from "../lib/linear";

// App-scoped Connect provider: issues are authored by the app identity, and
// token rotation stays inside Vercel Connect. The connector UID must match
// the one created by `vercel connect create linear`.
const linearAuth = connect({
  connector: process.env.LINEAR_CONNECTOR ?? "linear/pushcheck",
  principalType: "app",
});

// Linear caps issue titles; slice rather than fail on an overlong one.
const MAX_TITLE_CHARS = 255;

const DEDUPE_QUERY = `query Dedupe($marker: String!) {
  issues(filter: { description: { contains: $marker } }, first: 5) {
    nodes { id identifier title url }
  }
}`;

const TEAM_QUERY = `query TeamByKey($key: String!) {
  teams(filter: { key: { eq: $key } }) { nodes { id key } }
}`;

const LABEL_QUERY = `query LabelByName($name: String!) {
  issueLabels(filter: { name: { eq: $name } }) { nodes { id name } }
}`;

const LABEL_CREATE = `mutation CreateLabel($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id name } }
}`;

const ISSUE_CREATE = `mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier title url } }
}`;

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export default defineTool({
  description:
    "File one Linear issue escalating this push's findings. Files at most " +
    "one issue per push: if one already exists for this head SHA, returns it " +
    "instead. Returns { skipped } when escalation is off or Linear is not " +
    "configured. Never include secret values in the title or findings.",
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    branch: z.string().min(1),
    headSha: z.string().min(1).describe("The push's head commit SHA"),
    beforeSha: z
      .string()
      .min(1)
      .optional()
      .describe("The push's `before` SHA, to link the full compare range"),
    title: z
      .string()
      .min(1)
      .describe("Issue title, e.g. 'pushcheck: AWS key committed to myrepo main'"),
    findings: z
      .string()
      .min(1)
      .describe(
        "Markdown summary of all escalation-worthy findings from this push. " +
          "Reference file, line, and credential type only — never secret values",
      ),
  }),
  async execute({ owner, repo, branch, headSha, beforeSha, title, findings }, ctx) {
    // The severity tiers (security/serious/all) are enforced by the
    // instructions, not here; the tool hard-gates only `off` and an
    // unconfigured deployment.
    const policy = process.env.PUSHCHECK_ESCALATION ?? "security";
    if (policy === "off") {
      return { skipped: true, reason: "escalation policy is 'off'" };
    }
    const teamEnv = process.env.LINEAR_TEAM_ID;
    if (!teamEnv) {
      return {
        skipped: true,
        reason: "Linear escalation is not configured (LINEAR_TEAM_ID unset)",
      };
    }

    // A personal API key wins over Connect so a deployment without Connect
    // access still works; app-scoped Connect auth is non-interactive, so a
    // token failure is terminal and comes back as data.
    let token: string;
    let tokenIsOAuth: boolean;
    const apiKey = process.env.LINEAR_API_KEY;
    if (apiKey) {
      token = apiKey;
      tokenIsOAuth = false;
    } else {
      try {
        ({ token } = await ctx.getToken(linearAuth));
        tokenIsOAuth = true;
      } catch (err) {
        return {
          error:
            `Linear authentication failed: ${err instanceof Error ? err.message : String(err)}. ` +
            "Run `vercel connect create linear` for this project or set LINEAR_API_KEY.",
        };
      }
    }

    // Marker line that makes refiling detectable: eve re-runs a step
    // interrupted mid-execution, so filing must be idempotent per push.
    // Scoped to owner/repo so mirrors sharing a SHA each get their issue.
    const marker = `pushcheck-marker: ${owner}/${repo}@${headSha}`;
    const dedupe = parseLinear<{ issues: { nodes: IssueNode[] } }>(
      await linearRequest(DEDUPE_QUERY, { marker }, token, tokenIsOAuth),
      "Duplicate lookup",
    );
    if (dedupe.data && dedupe.data.issues.nodes.length > 0) {
      const issue = dedupe.data.issues.nodes[0];
      return { alreadyFiled: true, identifier: issue.identifier, url: issue.url };
    }
    const dedupeWarning = dedupe.error
      ? `duplicate lookup failed (${dedupe.error}) — a duplicate issue is possible`
      : undefined;

    let teamId = teamEnv;
    if (!isUuid(teamEnv)) {
      const teams = parseLinear<{ teams: { nodes: Array<{ id: string; key: string }> } }>(
        await linearRequest(TEAM_QUERY, { key: teamEnv }, token, tokenIsOAuth),
        "Team lookup",
      );
      if (teams.error !== undefined) return { error: teams.error };
      const team = teams.data.teams.nodes[0];
      if (!team) {
        return { error: `No Linear team found with key '${teamEnv}' — check LINEAR_TEAM_ID` };
      }
      teamId = team.id;
    }

    // The label is best-effort: a lookup or creation failure never blocks
    // filing the issue, it only surfaces as a warning in the result.
    let labelIds: string[] | undefined;
    let labelWarning: string | undefined;
    const labelName = process.env.LINEAR_LABEL;
    if (labelName) {
      const found = parseLinear<{ issueLabels: { nodes: Array<{ id: string }> } }>(
        await linearRequest(LABEL_QUERY, { name: labelName }, token, tokenIsOAuth),
        "Label lookup",
      );
      if (found.data?.issueLabels.nodes[0]) {
        labelIds = [found.data.issueLabels.nodes[0].id];
      } else if (found.data) {
        const created = parseLinear<{
          issueLabelCreate: { success: boolean; issueLabel?: { id: string } };
        }>(
          await linearRequest(LABEL_CREATE, { input: { name: labelName, teamId } }, token, tokenIsOAuth),
          "Label creation",
        );
        if (created.data?.issueLabelCreate.issueLabel) {
          labelIds = [created.data.issueLabelCreate.issueLabel.id];
        } else {
          labelWarning =
            `label '${labelName}' could not be created` +
            (created.error ? ` (${created.error})` : "") +
            " — issue filed without it";
        }
      } else {
        labelWarning = `label lookup failed (${found.error}) — issue filed without a label`;
      }
    }

    // An all-zeros `before` means a new branch or force push: no real range.
    const compareLine =
      beforeSha && !/^0+$/.test(beforeSha)
        ? `\nPush range: https://github.com/${owner}/${repo}/compare/${beforeSha}...${headSha}`
        : "";
    const description =
      `Escalated by pushcheck from a push to **${owner}/${repo}** branch **${branch}**.\n` +
      `Commit: https://github.com/${owner}/${repo}/commit/${headSha}${compareLine}\n\n` +
      `${findings}\n\n---\n${marker}`;

    const input: Record<string, unknown> = {
      teamId,
      title: title.slice(0, MAX_TITLE_CHARS),
      description,
    };
    if (labelIds) input.labelIds = labelIds;
    if (process.env.LINEAR_PROJECT_ID) input.projectId = process.env.LINEAR_PROJECT_ID;

    const created = parseLinear<{ issueCreate: { success: boolean; issue?: IssueNode } }>(
      await linearRequest(ISSUE_CREATE, { input }, token, tokenIsOAuth),
      "Filing the issue",
    );
    if (created.error !== undefined) return { error: created.error };
    const issue = created.data.issueCreate.issue;
    if (!created.data.issueCreate.success || !issue) {
      return { error: "Filing the issue failed: issueCreate reported success: false" };
    }
    return {
      alreadyFiled: false,
      identifier: issue.identifier,
      url: issue.url,
      ...(labelWarning && { labelWarning }),
      ...(dedupeWarning && { dedupeWarning }),
    };
  },
});
