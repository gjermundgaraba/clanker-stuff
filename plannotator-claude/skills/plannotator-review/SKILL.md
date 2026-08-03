---
name: plannotator-review
description: Open Plannotator's browser-based code review UI for the current worktree, a specific base, or a pull request URL, then act on the feedback that comes back.
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

# Plannotator Review

Pass `--base <ref>` when requested to review all committed and working-tree changes since that ref. Without `--base`, Plannotator uses its normal current-worktree or pull-request target.

## Code review feedback

!`node "${CLAUDE_SKILL_DIR}/scripts/review-launcher.ts" $ARGUMENTS`

## Your task

If the review above contains feedback or annotations, address them in the same conversation. If no changes were requested (an approval/LGTM-style result), acknowledge that review passed and continue.
