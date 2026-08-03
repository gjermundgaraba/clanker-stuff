---
name: plannotator-review
description: Open Plannotator's browser-based code review UI for the current worktree, a specific base, or a pull request URL, then act on the returned feedback. Use when the user explicitly invokes this skill to review code in Plannotator.
---

# Plannotator Review

Pass `--base <ref>` when requested to review all committed and working-tree changes since that ref. Without `--base`, Plannotator uses its normal current-worktree or pull-request target.

1. From the current working directory, run `node` with the absolute path to this skill's `scripts/review-launcher.ts`, appending only the target or options supplied.
2. Wait for the browser review and command to finish.
3. Handle the result:
   - For empty output or `Review session closed without feedback.`, reply `Review session closed.` and stop.
   - For an explicit approval or LGTM-style result, acknowledge that the review passed and stop.
   - Otherwise, address the returned feedback in the same conversation.

Run the command yourself. Do not ask the user to paste shell syntax into chat.
