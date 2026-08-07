# codex-resume-history

Adds Codex's resume command to the invoking fish or zsh shell's history when a session ends.

## Install

Install this directory as a Codex plugin, then approve its `SessionEnd` hook with `/hooks`.

## Usage

Install the [shell history hook](../shell-resume-history/docs/setup.md), then exit Codex normally; `codex resume <session-id>` appears at the next prompt.

## Requirements

`jq` on `PATH` and the fish or zsh hook from `shell-resume-history`.
