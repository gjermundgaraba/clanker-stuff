---
name: plannotator-annotate
description: Open Plannotator's annotation UI for a file, folder, or URL, then act on the returned annotations. Use when the user explicitly invokes this skill to annotate content in Plannotator.
---

# Plannotator Annotate

1. Run `plannotator annotate <target>` from the current working directory, appending only the options the user supplied.
2. Wait for the browser annotation session and command to finish.
3. Handle the result:
   - For annotated feedback, address it directly.
   - For approval without feedback, reply `Approved.` and stop.
   - For approval with notes, retain the notes as non-blocking guidance without revising the target.
   - For dismissal or empty output, reply `Annotation session closed.` and stop.

Run the command yourself. Do not ask the user to paste shell syntax into chat.
