# dollah-skills

Adds Codex-style skill mentions that complete, highlight, and load skills into the prompt.

## Install

```bash
pi install npm:@clanker-stuff/dollah-skills
```

## Usage

Type `$` to complete and highlight a loaded skill name; submitting while Pi is idle loads the complete `SKILL.md` into that turn's prompt. Queued messages load no skills and show a warning; queue `/skill:name` instead.

## Requirements

Highlighting uses the shared Pi editor. With another editor installed, highlighting is skipped; skill completion and loading remain available.
