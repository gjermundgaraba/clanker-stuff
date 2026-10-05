# model-history

Interprets physical model attempts and completed response history for Pi extensions.

## Install

```bash
npm install @clanker-stuff/model-history
```

## Usage

Use `inspectModelHistory(branch)` for the last successful completed response and last physical attempt; from `turn_end` onward the branch includes the finished response. Physical attempts include errors, aborts, and deferred requests; pending messages and unresolved virtual routes are excluded. Use `isVirtualModel(model)` to distinguish physical selections from virtual routes.
