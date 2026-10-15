# claude-bridge

Uses Claude Code with your Claude subscription as a Pi model provider.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

> [!NOTE] This started as an unofficial port of [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge). It is not affiliated with or endorsed by Anthropic.

## Install

Load `pi/extensions/experimental/claude-bridge/index.ts` as a local extension; npm installation is not supported.

## Usage

Run `/model` and pick a `claude-bridge/…` model; pi's tools, skills, and context files keep working through Claude Code.

## Requirements

A signed-in Claude Code (Pro or Max plan). See [behavior and maintenance](docs/behavior.md).
