# Language, rhythm, and voice

Use for repeated verbal patterns or tone calibration. Apply edits in context, not as a banned-word detector.

| Pattern | Editing choice |
| --- | --- |
| Inflated vocabulary: “delve”, “tapestry”, “pivotal”, “showcase”, “testament”, “underscore”, “interplay”, “intricate”, “garner”, “enduring”, “vibrant”, “crucial”, “additionally”, an abstract “landscape”, “quietly”, “robust”, “gate/gated/gating” | Prefer a familiar precise word when it preserves the meaning. Keep technical uses of “robust” and “gate/gated/gating”; ordinary formal vocabulary and literal uses can stay. |
| Marketing buzzwords: “revolutionary”, “game-changing”, “disruptive”, “cutting-edge”, “next-generation”, “seamless”, “transformative”, “innovative”, “enterprise-grade”, “purpose-built”, “unlock”, “unleash”, “synergy”; stock phrases such as “take it to the next level”, “what comes next”, “helped shape” | Name the capability, result, or role the source supplies; otherwise cut the word or flag the unsupported claim. Do not invent a feature or metric. Keep literal and established technical uses, such as a seamless pipe, next-generation sequencing, or unlocking a mutex. |
| Catch-all nouns: “ecosystem”, “platform”, “framework”, “solution”, “space” for a market or field | Name the specific thing the source identifies: the products, partners, codebase, or market. Keep the word when it names something specific, such as a named platform or a software framework. If the source never identifies the referent, keep the word rather than guess. |
| Fancy synonyms for plain words: “utilize”, “leverage”, “facilitate”, “enhance”, “numerous”, “in the event that” | Use “use”, “help”, “improve”, “many”, or “if” when the meaning is the same. Keep a term with a precise domain sense, such as financial leverage. |
| Unnecessary nominalizations: “we performed validation of the input” | Prefer “we validated the input” when the actor, tense, and meaning stay the same. Keep nouns that name precise domain concepts. |
| Borrowed technical metaphors: a “lever” for a change, a “surface” for an API, “substrate”, “wedge”, “vector” for a way, “locus”, “nexus”, “vantage”, “primitive” as a noun, “harness”, “bedrock”, “scaffolding”, “modality”, “paradigm”, “gold-plating”, “ratchet”, “evacuate” for moving code, “endgame”, “north star”, “flywheel” | Prefer the concrete word: “base”, “add”, “way”, “more than the job needs”, “move out”, “the last phase”. Name the actual operation or thing only when the source establishes it. Preserve precise domain terminology, such as a test harness or a language primitive, and meaningful author metaphors; do not infer a mechanism from vague wording. |
| Copula avoidance: “serves as”, “stands as”, “boasts”, “features” | Use “is”, “are”, or “has” where equivalent. Preserve quantities such as “over 3,000”. |
| Negative parallelism: “not just X, but Y”; trailing “no guessing”; “This does not mean X. It means Y.” | State the relationship directly or make the negation a real clause. Keep contrasts that correct an actual misconception or carry information in both halves, including equivalent constructions in other languages. |
| Forced groups of three and synonym cycling | Keep each substantive item; use a consistent name for the same subject. |
| Repeated sentence openings | Merge sentences or vary their openings when repetition is mechanical. Keep deliberate repetition that serves the author's rhythm. |
| False ranges: “from X to Y” without a scale | Name the actual topics without introducing a new medium, topic, or scope. |
| Passive voice and subjectless fragments | Name the actor only when the input establishes it. Passive voice is useful when the actor is unknown. |
| Filler and excessive hedging | Shorten wording while retaining real uncertainty: “in order to” becomes “to”, “due to the fact that” becomes “because”, “it is important to note that”, “it's worth noting that”, “it bears mentioning that”, and a leading “Interestingly,” or “Importantly,” go, and “could potentially possibly affect” becomes “may affect”. Keep a sentence adverb when it carries a judgment the sentence does not otherwise express, such as marking one point as outranking the others. |
| Adverbs propping up weak verbs: “runs quickly”, “significantly improves” | Use a stronger verb or the number the source supplies. Without a number, keep the claim's strength rather than inventing a measurement. |
| Mannered prose: personified code (“the plan holds it”), figurative verbs (“rides along”, “stands on”), stock framing phrases | Say it literally when a literal phrase exists: “a dial worth turning” becomes “a parameter worth varying”. Keep metaphors that are the author's own voice in personal writing. |
| Authority tropes and theatrical openers | Cut “the real question”, “at its core”, “Honestly?”, “This is where X comes in”, or “The answer is simple” when they add ceremony rather than meaning, then say what X does or give the answer. Replace a bare verdict such as “The demand is real” with the evidence the source supplies; without evidence, state the claim plainly, such as “There is demand for X”, rather than invent data. |
| Self-answered questions: “The result? A 40% drop.”, “Why does this matter? Because...”, “So what changed?” | State the answer as a sentence: “The result was a 40% drop.” Keep questions the reader would actually ask, such as FAQ headings or a problem the text goes on to investigate, and questions the text leaves open. |
| Manufactured punchlines and staccato drama | Combine repetitive fragments. Keep a short sentence when it earns emphasis. |
| Aphorism formulas | Express the supported concrete claim; do not manufacture an explanation for an ambiguous metaphor. |
| Invented objections and fake alternatives: “I'm not saying”, “You might think”, “A tempting approach would be” | Remove defenses against unraised objections, retaining any substantive claim. Keep attributed objections and alternatives a reader would actually weigh. |

## Staging instead of stating

Empty contrasts, repetitive closers, empty aphorisms, staged openers, and invented objections are the strongest cues. One occurrence can justify removing the framing when it adds no meaning. Casual announcements such as “one thing that bit me, so pay attention” can stage a point just as mechanically as “let's dive in.” Preserve any actual experience expressed in the opener.

## Rhythm by rule

Check across paragraphs: three parallel examples followed by a lesson can form a forced triad, and a recurring one-line closer can repeat each section's point. Change structure without dropping distinct examples, rankings, or simultaneous actions. Cut a sentence after an example, scene, or number that merely explains what it already showed, including “That distinction matters”, “This shows the importance of...”, or “It was a lesson in patience”. Keep a closer that adds a fact or consequence the example does not establish. A short sentence that adds information can stay. Passive voice and hedging are weak cues alone; keep unknown actors, real uncertainty, scope statements, and necessary notices.

## Plain speech

Technical and reference prose should say what something does, not how it feels. “SQL you can read” or “the database stays close at hand” name a feeling; “`.toSQL()` returns the exact query string” or “a column rename fails the build” name a mechanism. Ask what the sentence tells the reader to do or know. A sentence that could appear unchanged in another project's documentation usually says nothing about this one. Replace it with the mechanism or number only when the source or task context supplies one; otherwise cut it when it carries no claim, or keep it and flag the gap. Do not invent the mechanism.

Split a sentence the reader has to reread to parse, or drop clauses that add nothing. One idea per sentence is a good default, not a quota. Likewise, keep each paragraph to one main point, and split a paragraph that changes subject partway.

## Over-compression

Notes pasted into prose often drop articles and verbs, use arrows or symbols for relationships, and abbreviate terms the reader must decode. Write whole sentences, and spell out arrows and abbreviations the audience may not know. Keep standard identifiers, units, and abbreviations the audience uses.

Before: “Parser rejects bad date → exit 2, no write.”

After: “The parser rejects a bad date, exits with code 2, and writes nothing.”

Commit subjects, tables, changelogs, and other terse formats can stay terse when that is the convention.

## Author voice

If a sample is supplied, use its sentence lengths, vocabulary, paragraph openings, transitions, punctuation, and recurring expressions to calibrate the edit. Keep colloquial words rather than upgrading them to formal synonyms.

Personal essays may keep humor, opinions, mixed feelings, asides, and first person already present in the source. Technical and reference text can be neutral and plain. Vary rhythm where it helps, but do not invent opinions, experiences, uncertainty, or tangents to make prose feel human.

Before: “The experiment produced interesting results. The agents generated 3 million lines of code. Some developers were impressed while others were skeptical. The implications remain unclear.”

After: “The agents generated 3 million lines of code. The results were interesting: some developers were impressed, others skeptical. What this means is still unclear.”

The rewrite preserves the stated assessment and disagreement without inventing overnight work, a personal reaction, or the proportions of each group.
