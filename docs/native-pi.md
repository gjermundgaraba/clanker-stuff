# Native Pi

These extensions rely on Pi's built-in providers, Code Mode, MCP, coding tools, and compaction. Repository changes do not upgrade installed Pi or alter user settings.

## Settings

Pi defaults to fullscreen terminal mode. Set `"tuiMode": "regular"` or pass `--tui-mode regular` to retain terminal scrollback.

Enable native Code Mode in Pi settings with `"defaultTools": ["+codemode"]`. Set `"codemode": { "mode": "only" }` for code-only declarations, or keep the default hybrid mode. Ordinary coding tools remain `read`, `bash`, `edit`, and `write`; scripts call `tools.<name>()`.

Configure native MCP in `~/.pi/agent/mcp.json` or trusted project `.pi/mcp.json`, under `mcpServers`. Native `/mcp` and `pi mcp list` own discovery, connection, exposure, and authentication; an extension that registers `/mcp` replaces Pi's built-in implementation. Default MCP exposure is `codemode`; scripts discover tools with `searchTools()` and inspect instructions with `describeNamespace()`. Use native `/login` with `openai`.

## Known limits

Native Code Mode uses QuickJS/WASM and its own result, error, and resource semantics. Unawaited nested work can be aborted, but an outer result can finalize before delayed cleanup returns usage. Await nested calls; that does not by itself guarantee settlement when a script fails or is cancelled.

Pi shares native Code Mode workers across all sessions in one process, including subagents: two by default, or `PI_CODEMODE_MAX_WORKERS`. Cancelled workers keep their slots until they exit; a script result or sandbox close can settle before that exit. At capacity, a new script waits up to 60 seconds for a worker and then fails.

Native OpenAI subscription requests omit server output-token caps, so local output limits are not generation or billing ceilings. Quota reporting is unsupported for native OpenAI: `/usage` and the `usage` status report it like any unsupported provider.
