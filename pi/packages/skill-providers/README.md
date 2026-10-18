# skill-providers

Lets Pi extensions offer skills that do not live on disk to skill mentions.

## Install

```bash
npm install @clanker-stuff/pi-skill-providers
```

## Usage

```ts
import { SKILL_PROVIDER_CHANNEL } from "@clanker-stuff/pi-skill-providers";

pi.on("session_start", () => pi.events.emit(SKILL_PROVIDER_CHANNEL, provider));
```
