# Presence

## Command and CLI

`/who` in Pi and `node <this package>/cli.ts` in a shell print the same table: one line per session with its name (its Pi session name, or its session ID when it has none), its state, its pid and what it is doing. Sessions waiting on you come first, then working ones, then stopped ones.

## States

| State | When |
| --- | --- |
| `stopped` | The session quit, or its process is gone, for example killed or crashed |
| `waiting` | A dialog is open, or the agent is idle with no parked work: it is waiting on you |
| `working` | The agent is running, or it is idle with work parked elsewhere, on a wait or a question to another session |

A dialog wins over a running agent, because a blocking question is waiting on you even mid-run. A running agent wins over parked work.

## Records

Each TUI or RPC Pi keeps `<agent-dir>/data/presence/<pid>.json` current: pid, session ID, session name, working directory, start time, last update, activity (`idle`, `busy` or `dialog`) and since when, the top-level tool running now, its parked work, and `endedAt` after a clean quit. It is rewritten on every agent start and settle, tool start and end, dialog open and close, rename, and parked-work report. Writes go through a temporary file and a rename, never overlap, and the last one always lands. A Pi killed with `kill -9` leaves its last record behind, so a dead pid reads as stopped. Records of dead processes not updated for a day are deleted when any Pi starts. Print and JSON runs keep no record.

## Parked work

Another extension reports what this session has parked with it on `pi.events`, channel `presence:parked` (`PARKED_CHANNEL` in [`@clanker-stuff/presence-protocol`](../../../../packages/presence-protocol)), as `{source, items: [{id, about}]}`. Each report replaces that source's previous one, so a source sends its whole list on every change and an empty list when nothing is left. `about` completes "parked on …". Reports are kept for the life of the session and cleared when it shuts down. [waits](../../waits/docs/usage.md) reports its live waits and [peers](../../peers/docs/usage.md) its unanswered questions.
