import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubRequest, truncate } from "../lib/github";

const MAX_DIFF_CHARS = 100_000;
const DIFF_ACCEPT = "application/vnd.github.diff";

export default defineTool({
  description:
    "Fetch one unified diff covering every commit in a push (base...head compare). " +
    "Falls back to the head commit's diff alone when the range cannot be compared " +
    "(new branch, force push).",
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    base: z
      .string()
      .min(1)
      .describe("The push's `before` SHA; all zeros for a new branch"),
    head: z.string().min(1).describe("The push's head SHA"),
  }),
  async execute({ owner, repo, base, head }) {
    const repoPath = `/repos/${owner}/${repo}`;
    let fallbackReason: string | null = null;

    if (/^0+$/.test(base)) {
      fallbackReason = "base SHA is all zeros (new branch)";
    } else {
      const compare = await githubRequest(
        `${repoPath}/compare/${base}...${head}`,
        { accept: DIFF_ACCEPT },
      );
      if (compare.ok) {
        const { text, truncated } = truncate(compare.body, MAX_DIFF_CHARS);
        return { scope: "full push range", diff: text, truncated };
      }
      fallbackReason = `compare ${base.slice(0, 12)}...${head.slice(0, 12)} failed with HTTP ${compare.status} (often a force push making the range uncomparable)`;
    }

    const commit = await githubRequest(`${repoPath}/commits/${head}`, {
      accept: DIFF_ACCEPT,
    });
    if (!commit.ok) {
      return {
        error: `Could not fetch a diff. Fallback to head commit also failed with HTTP ${commit.status}: ${commit.body.slice(0, 500)}`,
        fallbackReason,
      };
    }
    const { text, truncated } = truncate(commit.body, MAX_DIFF_CHARS);
    return {
      scope: "head commit only — earlier commits in this push are not shown",
      fallbackReason,
      diff: text,
      truncated,
    };
  },
});
