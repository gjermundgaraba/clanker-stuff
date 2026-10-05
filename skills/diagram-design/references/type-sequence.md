# Sequence

Messages between participants over time.

Participants have vertical lifelines; time advances down the page. Horizontal messages point from sender to receiver. Activation bars show intervals of execution/control, nested for reentrant calls; they are not decorative full-length strips. Self-calls loop back to the same lifeline. Vertical spacing expresses order unless a measured time scale is explicitly supplied.

Use a declared notation consistently. In UML-style notation, synchronous calls use solid lines with filled heads, asynchronous messages solid lines with open heads, and replies dashed lines with open heads. The retained upstream examples use a custom convention (dashed filled-head replies, dashed open-head async); their legends document it. Do not mix the two grammars or let a highlight turn a reply into a call.

Frame conditional regions: `alt` has guarded alternatives separated by dividers; `opt` has one guarded optional region; `loop` names its repetition/exit condition. Frames span the participating lifelines, and guards sit above their region's first message. Leave enough vertical space for guard labels and activations. Message count and fragment depth follow the actual protocol; use linked detail views when they improve readability without losing branches.

Geometry examples: [sequence](../assets/example-sequence.html) · [sequence-oauth](../assets/example-sequence-oauth.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
