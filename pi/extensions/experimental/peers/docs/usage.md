# Peers

## Tools and command

`peer_send({to, text, replyTo?})` sends `text` to the live session named `to`. Set `replyTo` to the ID of the message being answered; leave it out to ask something new. It fails with an error, so the call shows as failed, when no live session has that name, when the name is this session's own, or when this session has no name of its own to be answered at. `peer_list({})` and `/peers` list the live sessions that have a name. In the TUI, `peers.name` shows ✉ and this session's peer name.

A session's peer name is its Pi session name, set with `/name` or by another extension through `pi.setSessionName`. A rename takes effect at once. Two live sessions cannot share a name: the second one is warned and stays unreachable until one of them is renamed or ends. Print and JSON runs never take a name, since they end with their prompt.

## Questions and answers

A letter sent without `replyTo` is a question. The message the recipient reads gives the ID to pass as `replyTo`.

## Display

The transcript draws each message as a card, including sends made from a Code Mode script and when a session is resumed. A received `peers:message` shows ✉ with the sender and only their text, not the reply instruction the model reads. Each send is also recorded in the sender's session: `peers:sent` holds the letter and shows ↗ with the recipient and text; `peers:undelivered` holds the recipient, text, reason and the live peer names at that moment, and shows ✗. Direct calls to `peer_send` and `peer_list` render as one-line rows.

## Files

Everything lives under `<agent-dir>/data/peers/`:

| Path | Holds |
| --- | --- |
| `names/<sha256 of name>.json` | The session holding the name: name, session ID, pid and working directory |
| `inbox/<session ID>/<sent at>-<id>.json` | A letter waiting for that session: ID, sender and recipient names, text, time sent, and the ID it answers, if any |

Every file is written to a temporary name and renamed into place. A name file whose pid is no longer running counts as free, so a Pi killed with `kill -9` frees its name too. Pids can be reused, so in rare cases a dead session's name stays taken until something else writes it.

## Delivery

Once a second, and at once when its name changes, each session moves its name file to its current name and empties its inbox. Each letter becomes a `peers:message` custom message with `triggerTurn: true`: an idle session starts a turn, and a busy one gets it after its current run. The message names the sender and the letter's ID, and tells the agent to answer with `peer_send` and that ID as `replyTo`.

Each letter file is deleted before its message is handed to Pi, so delivery is at most once: a Pi that dies in between loses the letter rather than repeating it. A letter sent to a session that then quits waits in its inbox and is delivered when that same session is opened again. A letter is never moved to another session, even one that takes the same name later.

A delivered letter says what the sender wrote. It is not a promise that the sender is still running when the reply goes back: if it has ended, the reply fails like a message to any unknown name.
