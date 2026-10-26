# mcp-test-server

Runs a local MCP server over stdio or HTTP for testing Pi's MCP features against a folder of dummy skills.

## Install

Workspace-only: run `vp install` at the repository root; the server runs from source with Node.

## Usage

- Run `pi -e pi/lab/mcp-test-server/pi.ts` to connect it as `test` for that session only, or add `node <repo>/pi/lab/mcp-test-server/cli.ts` to `mcp.json`.
- Run `node pi/lab/mcp-test-server/cli.ts --http 8080` to serve `http://127.0.0.1:8080/mcp` instead; `--help` lists the options.

## Configuration

It serves the dummy skills in `skills/` with the MCP Skills extension; `--skills <dir>` serves another folder and `--no-skills` turns skills off. Over stdio it reads the skills when it starts, so restart it to pick up edits; over HTTP it reads them on every request.
