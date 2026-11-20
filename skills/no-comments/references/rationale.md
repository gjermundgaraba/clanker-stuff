# Rationale trace

Answer from the record, not the code: read the commits and PR discussions that introduced the target and each later change, and other sources if the trail is thin. Cite what the authors wrote, mark your own inferences as inferences, and say what the record does not answer.

Find the record with:

- `git log -L <start>,<end>:<file>` for a line range, or `git log -S '<text>'` for a string, to list the commits that introduced and changed it.
- `git blame -w -C <file>` to find the last commit per line across whitespace changes and moves.
- `gh api repos/{owner}/{repo}/commits/<sha>/pulls` and `gh pr view <number> --comments` for the PR and its discussion, when the repository has a GitHub remote.
