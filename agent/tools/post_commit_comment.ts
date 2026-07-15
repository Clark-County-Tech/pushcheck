import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubRequest } from "../lib/github";

// Hidden marker that makes reposting detectable: eve re-runs a step
// interrupted mid-execution, so posting must be idempotent per commit.
const MARKER = "<!-- pushcheck -->";

export default defineTool({
  description:
    "Post the review report as a comment on a commit. Posts at most one " +
    "pushcheck comment per commit: if one already exists, returns it instead.",
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    sha: z.string().min(1).describe("The push's head commit SHA"),
    body: z.string().min(1).describe("The report, as GitHub-flavored markdown"),
  }),
  async execute({ owner, repo, sha, body }) {
    const commentsPath = `/repos/${owner}/${repo}/commits/${sha}/comments`;

    const existing = await githubRequest(commentsPath);
    if (existing.ok) {
      const comments = JSON.parse(existing.body) as Array<{
        body?: string;
        html_url?: string;
      }>;
      const mine = comments.find((c) => c.body?.includes(MARKER));
      if (mine) return { alreadyPosted: true, url: mine.html_url };
    }

    const created = await githubRequest(commentsPath, {
      method: "POST",
      json: { body: `${body}\n\n${MARKER}` },
    });
    if (!created.ok) {
      return {
        error: `Posting the comment failed: HTTP ${created.status}: ${created.body.slice(0, 500)}`,
      };
    }
    const comment = JSON.parse(created.body) as { html_url?: string };
    return { alreadyPosted: false, url: comment.html_url };
  },
});
