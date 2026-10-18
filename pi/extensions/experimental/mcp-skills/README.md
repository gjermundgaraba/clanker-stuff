# mcp-skills

Loads skills that MCP servers serve with the MCP Skills extension as part of Pi's own skill list.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/mcp-skills/index.ts` as a local extension; npm installation is not supported.

## Usage

- Skills from servers in `mcp.json` appear in Pi's skill list as `<server>:<name>`; the model loads one with `read` after you approve it, and its files are stored so its scripts can run.
- Run `/skill:<server>:<name>` to invoke one yourself, `/mcp-skills` to see servers, skills, and why any are not offered, or `/mcp-skills forget` to drop every approval and stored skill.

## Configuration

No setup beyond Pi's `mcp.json`; see [how MCP skills load and what needs approval](docs/behavior.md).
