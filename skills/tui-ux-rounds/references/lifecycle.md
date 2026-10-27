# Tester lifecycle

How to start, wait for and clean up the two testers. Keep every tab and pane ID you create in `ids.txt` in the run directory, so cleanup closes exactly those.

## Start

For each tester (one Claude Code, one Codex), with its own name such as `r7-claude`:

```sh
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --label <name> --no-focus --cwd <run dir>
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --label <name>-app --no-focus --cwd <sandbox>
```

Read each `.result.root_pane.pane_id`. Always pass `--workspace`: without it a tab opens in whichever workspace the user has focused, which may be another project's.

Put both pane IDs in the brief. Start agents in the run directory, which is not a git repo: Codex asks whether to trust a git repo it starts in, and nobody is there to answer.

```sh
herdr agent start <name> --kind claude --pane <agent pane> -- --dangerously-skip-permissions
herdr agent start <name> --kind codex --pane <agent pane> -- --dangerously-bypass-approvals-and-sandbox
```

Testers skip permissions because an approval prompt would stall an unattended round. What keeps them safe is the setup, not their good intentions: separate sandboxes, app state pointed into them, background network actions off, the brief's NEVER rules, and the safety audit at triage. When the project note can't name such a guard for a destructive action, have testers open its confirmation and cancel instead of confirming.

## Wait

Prompt and wait in one call per tester, in the background (Claude: `run_in_background`; Codex: a background session, or wait on each in turn):

```sh
herdr agent prompt <name> "Read <brief> and do it. Your name is <name>." --wait --timeout 3600000
```

A standalone `herdr agent wait` right after a prompt can return the idle state from before the prompt; `prompt --wait` waits for the turn to start. When it returns:

- **Done** only when the tester's report file exists and is from this round.
- **Blocked** (an approval or trust prompt): read the pane (`herdr agent read <name> --source recent-unwrapped --lines 60`). Don't answer it yourself; back out with Esc or ask the user.
- **Timed out or stalled**: read the pane, record the tester as unfinished, and don't re-send the prompt blindly. One tester's report is still a round.

To check on testers without the whole machine's agent list: `herdr agent list | jq -c '.result.agents[] | select(.name // "" | startswith("<prefix>")) | [.name, .agent_status]'`.

## Clean up

Once both reports exist: close the tabs in `ids.txt` (closing an agent tab ends the agent), quit your app tab unless the user wants it, then delete or reset the sandboxes. Check that no app process survived (`pgrep -fl <app>`). Report anything you left open and why.
