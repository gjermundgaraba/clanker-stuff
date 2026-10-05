---
name: librarian
description: Cache and refresh remote Git repositories for local reference research using reusable checkouts.
disable-model-invocation: true
---

# Librarian

Resolve a remote repository reference to a reusable checkout under `${LIBRARIAN_CACHE_ROOT:-$HOME/.cache/checkouts}/<host>/<org>/<repo>`.

Use `checkout.sh` **beside this SKILL.md**, not a script relative to the caller's working directory. Set `skill_dir` to this skill's absolute directory, then run:

```bash
bash "$skill_dir/checkout.sh" https://github.com/mitsuhiko/minijinja --path-only
```

The helper accepts HTTP(S) URLs, SSH references, and `owner/repo` shorthand (which defaults to GitHub over HTTPS). It preserves explicit transports and SSH users. Existing origins must identify the same repository and are never rewritten. Invalid references and symlinks below the cache root cause an error.

1. Clone missing repositories with `--filter=blob:none`; reuse existing checkouts.
2. Refresh from `origin` when stale (default: 300 seconds), using a clean checkout with an upstream on `origin`.
3. Advance by fast-forward only. An unsafe ordinary refresh warns and returns the cached revision.

Call the helper again for later references; refresh is throttled. Add `--force-update` to require a clean checkout matching its freshly fetched upstream:

```bash
bash "$skill_dir/checkout.sh" <repo> --force-update --path-only
```

If any requirement fails, stop and report the error. `--path-only` still prints diagnostics to stderr; a failed forced update exits nonzero without a path. For task-specific edits, create a separate worktree or copy instead of modifying the shared cache.
