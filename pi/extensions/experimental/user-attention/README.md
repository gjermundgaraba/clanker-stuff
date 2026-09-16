# user-attention

Sends attention notifications while pi continues working.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/user-attention/index.ts` as a local extension; npm installation is not supported.

## Usage

The agent uses `send_message_to_user_async` for blockers, important findings or requested status updates; it returns immediately without collecting an answer or approval.
