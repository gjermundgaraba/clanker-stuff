# model-history

Interprets physical model attempts and completed response history for Pi extensions.

## Install

```bash
npm install @clanker-stuff/model-history
```

## Usage

Use `inspectModelHistory(branch, newest?)` for the last successful completed response and last physical attempt; pass the just-completed message during `message_end`, before Pi appends it to history. Physical attempts include errors, aborts, and deferred requests; pending messages and unresolved virtual routes are excluded. Use `isVirtualModel(model)` to distinguish physical selections from virtual routes.
