/**
 * The plain label for what a waiting session waits for (FR-38, 0029). The server keeps Claude
 * Code's own `waitingFor` value, or "needs input" when there is none, in `attentionReason`, so
 * notifications compare that, and a change in this wording alone never notifies.
 */
export function waitingLabel(reason: string | null | undefined): string {
  if (reason === "permission prompt") return "Waiting on a permission prompt";
  if (reason === "input needed") return "Waiting on your answer";
  return "Needs you in Claude Code";
}

/** Shown on a waiting session's row: the dashboard never answers a prompt (C-20). */
export const ANSWER_IN_CLAUDE_CODE = "Answer it in Claude Code.";
