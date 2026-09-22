# context

Inspects Pi's current context as a read-only TUI tree with searchable, scrollable details.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/context/index.ts` as a local extension; npm installation is not supported.

## Usage

- Run `/context` to inspect the system prompt, active tools, and retained messages with original/effective content and edit provenance.
- Use `/` to search, h/l to fold, Tab to switch panes, arrows or j/k and Page Up/Down to scroll, Enter for details, and y to copy; the mouse wheel scrolls the pane under the pointer.
- The snapshot shows Pi-side state, not transient context-hook changes or a serialized provider request; token estimates count effective content only, separately from Pi context usage.
