# status-icons

Shares icon families and glyph fallback policy across Pi status renderers.

## Install

```bash
npm install @clanker-stuff/status-icons
```

## Usage

Use `IconFamilySchema`, `GlyphMapSchema`, and `selectGlyph(glyphs, family)` for ASCII, Unicode, and Nerd Font status icons. Nerd falls back to Unicode then ASCII; Unicode falls back to ASCII. Missing variants fall back; an explicit empty string omits the icon and stops fallback.
