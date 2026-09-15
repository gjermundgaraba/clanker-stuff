# background-tasks

Runs session-owned background jobs and agent-authored watchers with bounded notifications.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/background-tasks/index.ts` as a local extension; npm installation is not supported.

## Usage

- Ask Pi to start a job with `task_start`; confirm `/tasks resume` to authorize notifications, or inspect and dismiss results on demand.
- Jobs stop on reload, quit, and session replacement—including dev servers.

## Configuration

See [usage and watcher protocol](docs/usage.md) for local loading, limits, ownership, and authoring guidance. Requires POSIX process groups and a live TUI or RPC session.
