import { defineInstructions } from "eve/instructions";

// Resolved once at build time (eve bakes the markdown into the compiled
// manifest). On Vercel that matches runtime, since env changes require a
// redeploy; the tool independently hard-gates `off` and unconfigured
// deployments at runtime, so a stale prompt can never cause filing.
const POLICIES = {
  off: "Escalation is disabled. Never call `escalate_to_linear`.",
  security:
    "Escalate only findings that belong under the **Security** section of " +
    "the report (leaked or committed credentials, exposed endpoints). Debug " +
    "leftovers and changelog notes never qualify.",
  serious:
    "Escalate all Security-section findings, plus any other finding urgent " +
    "enough that Chris should act before his next push — broken auth, " +
    "data-loss risk, a migration that would corrupt data. Routine debug " +
    "leftovers and changelog notes never qualify.",
  all:
    "Escalate every push that has at least one finding in any of the three " +
    "report sections. A clean all-clear push is never escalated.",
} as const;

const raw = process.env.PUSHCHECK_ESCALATION ?? "security";
const policy: keyof typeof POLICIES = raw in POLICIES ? (raw as keyof typeof POLICIES) : "security";

const procedure =
  policy === "off"
    ? ""
    : `

When findings match this policy, call \`escalate_to_linear\` exactly once per
push — one issue covering all escalation-worthy findings — **before** posting
the commit comment, so the comment can link the issue. If the tool returns
\`skipped\`, continue without escalating. If it returns an error or a warning,
still post the commit comment and note the escalation problem in it.`;

export default defineInstructions({
  markdown: `# Escalation

Active escalation policy: **${policy}**. ${POLICIES[policy]}${procedure}`,
});
