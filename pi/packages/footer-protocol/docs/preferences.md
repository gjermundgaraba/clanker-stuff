# Footer configuration and icon preferences

Import the pure `FooterConfig` contract, `DEFAULT_CONFIG`, `cloneFooterConfig`, and `parseFooterConfig` from `@clanker-stuff/footer-protocol/config`. Filesystem loading and saving belong to consumers. The parser validates the entire strict configuration, so a valid icon field inside an invalid configuration is not a valid saved preference.

Icon-family and glyph-map schemas/types, and glyph fallback selection, live in `@clanker-stuff/status-icons`. Footer accepts either a literal glyph or a glyph map; mapped glyphs use the shared selector. Border uses the same family/fallback policy while additionally rejecting terminal and formatting controls other than ZWJ/ZWNJ in its glyph strings.

`FOOTER_ICON_PREFERENCE_REQUEST_EVENT` accepts only:

```ts
{ protocol: FOOTER_PROTOCOL_VERSION, type: "icon-preference-request" }
```

The host replies on `FOOTER_ICON_PREFERENCE_EVENT`:

```ts
{ protocol: FOOTER_PROTOCOL_VERSION, type: "icon-preference", iconFamily: "nerd" }
```

Both messages have strict exported schemas (`FooterIconPreferenceRequestSchema` and `FooterIconPreferenceSchema`). The host also announces its committed preference on startup and save, even when footer rendering is disabled. Unsaved previews do not broadcast. Unsupported or malformed requests are ignored.

Consumers that can operate without the footer host may read the saved configuration first, then subscribe and request the running host's preference. The request reconciles updates between the read and subscription, and the running host's validated committed state.
