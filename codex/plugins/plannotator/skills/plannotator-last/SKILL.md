---
name: plannotator-last
description: Open Plannotator on the latest rendered Codex response, then use the returned annotations to revise the response or continue. Use when the user explicitly invokes this skill to annotate the assistant's last response.
---

# Plannotator Last

Do not send commentary or a status message before running the command; that message could become the response being annotated.

1. Run `plannotator last`, appending only the options the user supplied.
2. Wait for the browser annotation session and command to finish.
3. Handle the result:
   - For annotated feedback, incorporate it into the follow-up response.
   - For approval without feedback, reply `Approved.` and stop.
   - For approval with notes, retain the notes as non-blocking guidance without redoing the response.
   - For dismissal or empty output, reply `Annotation session closed.` and stop.

Run the command yourself. Do not ask the user to paste shell syntax into chat.
