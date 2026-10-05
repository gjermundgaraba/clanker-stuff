# Reusable skills

This directory is the canonical source for reusable skill folders. See
`README.md` for installation and ownership; do not change installed links
without authorization.

Personal skills belong in the dotfiles repository; `pr-comments` lives there.
Herdr's generated skill is managed separately and is not part of this catalog.
Skills owned by an extension or host plugin remain beside that package.

## Authoring and installation

- Keep each skill self-contained: `SKILL.md`, `agents/`, `references/`, `scripts/`,
  and assets travel together. Resolve relative paths against the skill folder,
  not the invoking repository.
- Edit the sources here and install complete skill
  folders by linking them into both `~/.agents/skills/` (Codex) and
  `~/.claude/skills/` (Claude Code).
  Do not install by linking only `SKILL.md`.
- For a user-invocation-only skill, configure both:
  - `disable-model-invocation: true` in the `SKILL.md` YAML frontmatter.
  - `policy.allow_implicit_invocation: false` in `agents/openai.yaml`.
- Invoke those skills with `$skill-name` in Codex or `/skill-name` in Claude Code.
- Review new files for secrets, private paths, and runtime state before tracking.

Use `AGENTS.md` for instructions; do not create `CLAUDE.md` aliases.
