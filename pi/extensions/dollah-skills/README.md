# dollah-skills

Adds Codex-style skill mentions that complete, highlight, and load skills into the prompt.

## Install

```bash
pi install npm:@clanker-stuff/dollah-skills
```

## Usage

- Type `$` to complete and highlight a loaded skill name; submitting puts the mentioned skills ahead of your text in Pi's native `/skill:name` block, shown as one collapsible `[skill]` block.
- Input that starts with a registered command, template or skill is left to Pi.

## Requirements

Highlighting uses the shared Pi editor. With another editor installed, highlighting is skipped; skill completion and loading remain available.
