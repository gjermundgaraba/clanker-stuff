# Subagents

The collaboration tools, prompts, and mailbox text are adapted from the OpenAI Codex revision pinned in `UPSTREAM`. Keep tool names, argument names, and result shapes aligned with it where Pi can execute them truthfully, and record each deliberate difference in `docs/protocols.md`.

Prefer Pi's native mechanisms over extension-owned machinery: deliver mail through Pi's custom-message queues, acknowledge it from the transcript, and let Pi own continuation, retries, and compaction. Add a guard around a native mechanism only with an integration test that fails without it and a one-line comment naming the failure mode.

Before changing behavior, read `docs/protocols.md`. Keep `package.json` `files` in step with the runtime modules; `tests/package.smoke.test.ts` loads the packed extension and checks the files it does not import.
