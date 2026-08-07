# Footer redesign research

## Purpose

This is the short evidence record behind `architecture.md`. It is not a second specification or implementation plan.

## Upstream constraints

Inspection of pi's documentation and installed implementation established:

- `ctx.ui.setFooter()` owns one replace-only custom-footer slot.
- `setFooter(undefined)` restores the built-in footer.
- `footerData.getExtensionStatuses()` exposes current native statuses but no status-change subscription or metadata.
- Pi requests a render when a native status changes, so the host must read the current map during render.
- `pi.events` is synchronous, transient, process-local, and survives extension reloads.
- `ctx.ui.custom()` supports the spatial editor and diagnostics.
- `getAgentDir()` is the correct global configuration root.
- `message_end` occurs before the completed message is persisted to session history.

These constraints require one cooperative owner, a ready/instance handshake, explicit listener cleanup, synchronous rendering, and post-persistence session accounting.

## Existing implementation

The old footer combines layout, Git, provider authentication, nine quota adapters, caching, and `/usage`. Git already runs asynchronously outside render and remains a useful host collector. Provider quota code is independent of layout and belongs in the standalone usage contributor.

Native statuses were previously flattened into one line with special handling for selected keys. Virtual status widgets remove those host-specific integrations.

## Projects reviewed

| Project | Useful evidence |
| --- | --- |
| `pi-footer-manager` | One cooperative owner is practical when pi cannot compose footer slots. |
| `pi-fancy-footer` | Versioned upsert/remove events, ready replay, and a spatial editor fit the problem. |
| `wobondar/pi-footer` | Live preview and explicit save are useful; its broader settings surface is unnecessary here. |
| `pi-powerline-footer` | Native statuses can become individually configurable items. |
| `ccstatusline` | Progressive disclosure keeps persistent output quiet while configuration remains discoverable. |
| Starship | Stable module IDs and separate alignment groups are durable configuration concepts. |

The rejected patterns were arbitrary contributor render callbacks, `globalThis` registries, pi monkey-patching, automatic font detection, and coupling editor or transcript behavior to footer ownership.

## Decisions supported

- One cooperative host owns layout and rendering.
- Native statuses remain compatible through virtual widgets.
- Rich contributors publish bounded semantic snapshots, not callbacks.
- Ready messages carry a fresh host instance ID.
- Rows are the sole placement authority.
- Rendering stays pure, synchronous, and width-safe.
- The editor mirrors rows and opens a bounded selector only for the active cell.
- One default plus Reset replaces presets.
- Truncation replaces shrink/hide behavior.
- Unicode is default; ASCII and Nerd Font are explicit modes.
- Provider usage remains an optional standalone contributor with native fallback.

## Primary sources

### Pi

- <https://pi.dev/docs/latest/extensions>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/custom-footer.ts>
- Installed pi TUI documentation and `SelectList` implementation

### Footer and statusline projects

- <https://github.com/sergiobonfiglio/pi-footer-manager>
- <https://github.com/mavam/pi-fancy-footer>
- <https://github.com/wobondar/pi-footer>
- <https://github.com/nicobailon/pi-powerline-footer>
- <https://github.com/sirmalloc/ccstatusline>
- <https://starship.rs/config/>
