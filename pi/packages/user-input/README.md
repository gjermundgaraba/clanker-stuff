# user-input

Coordinates cancellable prompts across Pi extensions.

## Install

```bash
npm install @clanker-stuff/pi-user-input
```

## Usage

Import `runQueuedPrompt` from `@clanker-stuff/pi-user-input/queue` to serialize prompts on the same Pi UI. Prompt callbacks must honor their abort signal and settle after removing their UI.
