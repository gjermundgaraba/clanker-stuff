# skill-providers

Lets Pi extensions offer skills that do not live on disk to skill mentions.

## Install

```bash
npm install @clanker-stuff/pi-skill-providers
```

## Usage

Announce a `SkillProvider` on `SKILL_PROVIDER_CHANNEL` through `pi.events` at every `session_start`; its `load()` returns `{ name, location, content }` or `{ error }`, and `skillBlock()` formats loaded skills for Pi.
