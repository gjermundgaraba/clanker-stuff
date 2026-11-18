# Event modeling

Commands, the domain events they cause, and the read models those events project, across ordered stages.

Arrange numbered stages left to right with three fixed lanes: **Command** above **Event** above **Read model**. A command is an imperative request, an event a past-tense fact, and a read model a view or projection; name each role in text, not color alone. Draw a directed `emits` link from command to event and a `projects` link from event to read model only when the source supplies it, and label an unknown link as a gap. Stage order is scenario order, not measured time; split a branching scenario or use a [flowchart](type-flowchart.md).

Use [sequence](type-sequence.md) for actor lifelines and replies, [data flow](type-data-flow.md) for movement between systems, and [timeline](type-timeline.md) for dated occurrences. Do not infer an event store, broker, persistence, or delivery guarantee from this view. A useful overview holds up to six stages with one command, event, and read model each and at most two accent uses; split richer scenarios into overview and detail.

Stage groups can carry `data-event-stage` and `data-stage-order`, role nodes `data-event-kind` and a printed `data-event-id`, and links `data-event-rel`, `data-from`, and `data-to` within their stage. Label an illustrative scenario as such.

Geometry examples: [event modeling](../assets/example-event-modeling.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
