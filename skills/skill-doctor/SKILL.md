---
name: "skill-doctor"
description: "Grades agent skills by scoring agent conversations for efficiency, code quality, procedure compliance, and verbosity, then drafts concrete skill edits and a shareable report. Use when the user wants their agent setup graded from real conversation history, or asks which of their installed skills are actually working."
disable-model-invocation: true
metadata:
  upstream-source: "https://github.com/warpdotdev/common-skills"
  upstream-path: ".agents/skills/skill-doctor/"
  upstream-revision: "acb107ab1096bd62243952878d8a09a40cc9e1b9"
  upstream-relationship: "adapted"
  upstream-license: "MIT"
  upstream-license-file: "LICENSE"
  upstream-baseline-kind: "recorded"
---
# skill-doctor

Grade the user's agent setup by scoring recent local agent conversations, then propose concrete skill edits and render one shareable report page.

The report can cover conversations in the current repository, conversations in selected projects, or all local conversations. It can evaluate project skills alone or project and global skills together.

Everything runs locally. Never upload transcripts, session files, or any excerpt of them anywhere. The only shareable artifact is the report the user chooses to post.

Let `SKILL_ROOT` be the directory containing this SKILL.md.

## Step 0: Start the run

### Verify the executing harness

Read `$SKILL_ROOT/references/supported-harnesses.md` and identify the harness executing this skill from the runtime context. If it is unsupported or cannot be identified confidently, follow the reference's stop behavior. Do not create a report directory or read conversation history.

### Ask which conversations to grade

First check whether the current directory is inside a git repository:

```bash
git rev-parse --show-toplevel
```

Use the harness's user-question tool when available.

When a current repository is available, ask **“Which conversations should I grade?”** with:

1. **Conversations in this repository** — recommended.
2. **All conversations**.
3. **Choose projects to analyze**.

When there is no current repository, ask the same question with:

1. **All conversations** — recommended.
2. **Choose projects to analyze**.

If the user chooses projects, ask for one or more project paths. Expand and validate every path as a git repository before continuing. The run produces one combined report across those projects.

### Ask which skills to evaluate

Then ask **“Which skills should I evaluate?”** with:

1. **Project skills + global skills** — recommended.
2. **Project skills only**.

For an all-conversations run, “Project skills” means skills from local git repositories inferred from the conversations' working directories. “All conversations” selects the project scope; it does not remove the lookback window or sampling. After these answers, state the window and sampling policy below, then proceed.

Never write artifacts into the user's repo. Create one fresh, collision-free scratch directory per run and use it as `REPORT_DIR` for every artifact:

```bash
REPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/skill-doctor-XXXXXXXX")"
```

## Step 1: Collect
Build the collector arguments from the startup answers:

- Current repository: `--repo "$REPO"`.
- Selected projects: repeat `--repo PATH` for every project.
- All conversations: `--all-conversations`.
- Project and global skills: add `--include-global-skills`.
- Project skills only: do not add `--include-global-skills`.
- Exclude the current audit with `--exclude-session ID` when its session ID is available. The collector also excludes `CODEX_THREAD_ID` automatically. If the executing harness does not expose its ID, identify this audit in the local source before scoring and exclude it; disclose any unresolved self-inclusion.

```bash
python3 "$SKILL_ROOT/scripts/collect_sessions.py" \
  --out "$REPORT_DIR" \
  <conversation-scope arguments> \
  <skill-scope arguments>
```

By default `--harness auto` scans every locally available supported source. Read `$SKILL_ROOT/references/supported-harnesses.md` for source identifiers, storage details, skill locations, and source-specific override flags.

### Sampling policy

Default to **10% of eligible conversations**, rounded up, with a floor of 12 or all available conversations when fewer exist. For 4,289 eligible conversations this selects 429. Use 5% for an explicitly requested lighter pass, or `--sample-percent 100` for a census. Ten percent is a practical default, not a statistical guarantee for the letter grade; honor a user-specified size or coverage target.

The collector uses a recorded random seed and proportional sampling across project, harness, calendar week, and detected-skill status. It includes conversations without detected skills and groups existing worktrees by their common repository. There are no per-skill or no-skill caps. Small groups can receive no sample; inspect `sampling.strata` rather than claiming every project or skill was assessed.

Keep targeted reviews of underrepresented skills separate from the representative sample and its overall scores. Related sessions covering one investigation are correlated evidence: identify those groups during scoring and do not count them as independent repetitions supporting an edit. Do not deduplicate unrelated conversations merely because they share a project.

Useful flags:

- `--harness VALUE` — which local session sources to scan; use the reference's collector IDs.
- `--repo PATH` — include a project; repeatable.
- `--all-conversations` — do not filter conversations by project.
- `--include-global-skills` — also grade global skills.
- `--days N` — lookback window (default 45).
- `--sample-percent N` — percentage of eligible conversations (default 10; 100 for a census).
- `--min-sessions N` — small-scope floor (default 12, bounded by availability).
- `--max-sessions N` — optional explicit cap; no default cap. Disclose when it reduces the target.
- `--seed N` — reproducible sampling seed (default 0).
- `--exclude-session ID` — exclude a session before sampling; repeatable.
- `--skills-dir PATH` — nonstandard skill locations.
- `--include-subagents` — include child or sidechain sessions.

Read `$REPORT_DIR/inventory.json`. If `sessions_sampled` is 0, tell the user there is nothing recent to score in the selected conversation scope (suggest raising `--days` or choosing different projects) and stop. If `skills_found` is 0, continue — the report becomes a case for creating skills, and `skill_coverage` is 0.

Report the eligible count, selected count, actual percentage, exclusions, and any cap before scoring. Do not silently substitute a smaller sample. If execution stops partway through, report the completed subset and its limitations.

## Step 2: Score each sampled transcript

Scoring is based on efficiency, code quality, procedure compliance, and verbosity for the sessions sampled. Process datasets of 50 transcripts or fewer in a single batch. For datasets with more than 50 transcripts, use parallel batches (20 transcripts per batch recommended). Score batches in the current local agent process, or delegate only to local child agents that keep transcript contents on the user's machine. Pass the following rubrics as context:

- `$SKILL_ROOT/scorers/efficiency.md`
- `$SKILL_ROOT/scorers/code-quality.md`
- `$SKILL_ROOT/scorers/procedure-compliance.md`
- `$SKILL_ROOT/scorers/verbosity.md`

Instructions: For each transcript in `$REPORT_DIR/transcripts/`, read it and judge it against all four rubrics. For each scorer record: label, numeric score (from the rubric's label table), and a 1–3 sentence reason citing specifics from the transcript. Apply the code-quality scorer only where the transcript shows code changes; otherwise record `insufficient_evidence` and exclude that result from the code-quality average and failed-conversation filter.

Condensed transcripts are an index, not complete evidence. Before judging a potentially omitted action or code change, read the relevant original messages, tool payloads, patches, and validation from the local source identified in the transcript and inventory. Preserve recovered evidence in scratch when needed by a scoring batch. Do not infer missing work from truncation, or replace an unavailable historical patch with the current checkout. If code evidence remains unavailable, record the limitation and use `insufficient_evidence`; if a session cannot be scored at all, exclude it from the grade and disclose that count. Increasing the sample size does not repair missing evidence.

## Step 3: Aggregate

- `raw_efficiency` = mean of efficiency scores across all scored sessions.
- `raw_code_quality` = mean of code-quality scores, excluding `insufficient_evidence`. If no session had enough evidence, set it to 0.5 and say so in the findings.
- `raw_procedure_compliance` = mean of procedure-compliance scores across all scored sessions.
- `raw_verbosity` = mean of verbosity scores across all scored sessions.
- Curve qualitative rubric means into letter-grade report scores with `curve(score) = 0.5 + 0.5 * score`.
- `efficiency = curve(raw_efficiency)`.
- `code_quality = curve(raw_code_quality)`.
- `procedure_compliance = curve(raw_procedure_compliance)`.
- `verbosity = curve(raw_verbosity)`.
- `skill_coverage` = fraction of scored representative-sample sessions where at least one installed skill was detected. If `skills_found` is 0, coverage is 0.
- `overall = 0.25 * efficiency + 0.25 * code_quality + 0.2 * procedure_compliance + 0.15 * verbosity + 0.15 * skill_coverage.`

Then, define `failed_conversations` from each conversation's raw, uncurved scorer results. A conversation fails when at least one applicable efficiency, code-quality, procedure-compliance, or verbosity score is below `0.5`. An `insufficient_evidence` result does not make a conversation fail. Use only `failed_conversations` as evidence for skill-improvement suggestions and draft skill edits.

Then derive the substance:

- `top_findings`: the 3 most impactful, specific patterns across sessions. These lead the report and the spoken summary. Make each summary concrete and concise, following the STE-100 standard.
- `suggestions`: concrete skill changes, if any. Each names a skill (existing or proposed-new) and a specific change: a trigger-description fix so it fires when it should, a missing step or check, a command to encode, a new skill to create. Suggestions must trace back to observed waste or defects in `failed_conversations`, not generic best practices — cite the failed session, scorer, and moment that motivated each one. An installed skill that never triggered in a failed conversation is usually a description problem and worth a suggestion of its own.

## Step 4: Draft skill edits

Follow `$SKILL_ROOT/references/skill-improvements.md` to propose improvements to project skills based only on `failed_conversations`.

1. Read the skill's current file (path is in `inventory.json`).
2. Write the full improved version to `$REPORT_DIR/proposed/<skill-name>/SKILL.md`, changing only what the evidence justifies. Improve the parts the sessions actually exercised: the trigger description that failed to fire, the missing preflight check, the step the agent had to figure out by trial and error.
3. Produce a unified diff between current and proposed (`diff -u <current> <proposed>`) and put it in the suggestion's `diff` field so it renders in the report.

For a proposed-new skill, write the complete new SKILL.md to the same `proposed/` directory and set `diff` to its full content as an addition.

Do not modify the user's real skill files in this step.

## Step 5: Write report.json and render
Write `$REPORT_DIR/report.json`. Store the curved `efficiency`, `code_quality`, `procedure_compliance`, and `verbosity` values, literal `skill_coverage`, and weighted `overall` in `scores`; do not store the raw rubric means there. Copy `inventory.sampling` into `sampling`, and record evidence gaps, correlated sessions, targeted supplements, and any incomplete scoring in `limitations`. Set `stats.code_quality_applicable` to the count of code-quality verdicts excluding `insufficient_evidence`; zero labels the fallback in the report and share image. Set `stats.skills_used` to unique detected skill names in the scored sample, not the entire scanned window. Detection can include inspecting or editing a skill; it does not prove successful invocation.

```json
{
  "title": "Agent Skill Report",
  "generated_at": "<ISO timestamp>",
  "harness": "<harness from inventory.json>",
  "handle": "<repo_name from inventory.json>",
  "stats": {
    "sessions_analyzed": 0, "sessions_scanned": 0,
    "skills_found": 0, "skills_used": 0, "window_days": 45,
    "code_quality_applicable": 0
  },
  "sampling": {},
  "limitations": [],
  "scores": {
    "efficiency": 0.0,
    "code_quality": 0.0,
    "procedure_compliance": 0.0,
    "verbosity": 0.0,
    "skill_coverage": 0.0,
    "overall": 0.0
  },
  "top_findings": ["", "", ""],
  "suggestions": [
    {
      "skill": "",
      "change": "<one-sentence summary of the edit>",
      "evidence": "<which session(s) and what happened that motivates this>",
      "proposed_path": "<path under proposed/, if an edit was drafted>",
      "diff": "<unified diff, or full content for a new skill>"
    }
  ]
}
```

```bash
python3 "$SKILL_ROOT/scripts/render_report.py" "$REPORT_DIR/report.json" --open
```

This writes a single self-contained `$REPORT_DIR/report.html` and attempts to open it in the default browser. The scorecard, findings, and suggested skill edits appear on one page. Long diffs are collapsed behind a "show more" toggle, and a "share as png" button exports a 1200x675 share image locally. There is no separate card file to open or screenshot.

## Step 6: Output

Tell the user the grade and the three findings, in text, alongside the scored/eligible count and actual percentage. Label the grade as describing the sample. Disclose a code-quality fallback rather than presenting it as an approval.

Finish every response with this exact summary, substituting the absolute `REPORT_DIR` path:

- Your agent skill report: file://$REPORT_DIR/report.html

Want me to apply these suggestions to your skills?
