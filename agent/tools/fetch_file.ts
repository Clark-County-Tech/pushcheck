import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubRequest, truncate } from "../lib/github";

const MAX_FILE_CHARS = 50_000;

export default defineTool({
  description:
    "Fetch a file's full contents at a given ref, for context when a diff hunk " +
    "is too ambiguous to judge on its own.",
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    path: z.string().min(1).describe("Repo-relative file path"),
    ref: z.string().min(1).describe("Commit SHA or branch to read the file at"),
  }),
  async execute({ owner, repo, path, ref }) {
    const response = await githubRequest(
      `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      { accept: "application/vnd.github.raw+json" },
    );
    if (!response.ok) {
      return {
        error: `Could not fetch ${path} at ${ref}: HTTP ${response.status}: ${response.body.slice(0, 500)}`,
      };
    }
    const { text, truncated } = truncate(response.body, MAX_FILE_CHARS);
    return { path, ref, content: text, truncated };
  },
});
