# skill-providers

Lets Pi extensions offer skills that do not live on disk to skill mentions.

## Install

```bash
npm install @clanker-stuff/pi-skill-providers
```

## Usage

Announce a `SkillProvider` on `SKILL_PROVIDER_CHANNEL` through `pi.events` at every `session_start`; its `load()` returns `{ location, content }` or `{ error }`. Skills keep the names they were requested by, and `skillBlock()` formats loaded skills for Pi.
