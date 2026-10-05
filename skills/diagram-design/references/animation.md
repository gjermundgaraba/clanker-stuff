# Explanatory motion

Use motion or interactive stepping when requested or when it makes ordered change substantially easier to understand. Choose the interaction for the explanation: progressive reveal, side-by-side state comparison, or explicit previous/next steps may each fit. Static output remains a complete deliverable.

## Meaning and accessibility

Keep the full diagram in the source before JavaScript enhancement. Apply any hidden or partial state only after controls initialize successfully. Provide a complete view for no-JavaScript rendering, printing, reduced motion, and static export.

Use native buttons with visible focus and descriptive labels. For stepping, show the current step and its meaning; announce user-initiated changes through a scoped polite status region. Keep focus stable and avoid intercepting keys outside the figure. Provide pause/replay when timed playback is used. Reduced motion should remove movement while preserving useful manual navigation and readable state changes.

Labels, counts, status words, and outcomes carry the explanation. Color and motion may reinforce them. Avoid decorative movement that competes with the subject, and avoid autoplay unless the requested presentation calls for it.

## Implementation and capture

Keep state and timers local to each figure. Clear pending timers on pause, restart, and page hide. Explicit state transitions are easier to capture than waiting for an arbitrary animation delay. For exportable HTML, a `?motion=static` mode or a visible “Show all” control can expose the complete stable figure.

Scope animation rules so print and reduced-motion CSS can reliably restore full visibility. Wait for fonts and the selected state before capture. Export the complete figure unless the user requested a specific step, and identify that step in the artifact.

Check the actual interaction: keyboard operation, pause/resume when present, complete no-JavaScript rendering, reduced motion, and the chosen export state. The bundled structural checker does not validate playback behavior or require a particular controller.
