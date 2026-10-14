# dollah-skills

Adds Codex-style skill mentions that complete, highlight, and load skills into the prompt.

## Install

```bash
pi install npm:@clanker-stuff/dollah-skills
```

## Usage

Type `$` to complete and highlight a loaded skill name; submitting appends its `SKILL.md` instructions to that user message, including queued messages. Skill bodies are recorded in history, like native `/skill:name`, and mentions inside them do not load other skills.

## Requirements

Highlighting uses the shared Pi editor. With another editor installed, highlighting is skipped; skill completion and loading remain available.
