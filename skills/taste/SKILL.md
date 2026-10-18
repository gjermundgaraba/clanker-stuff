---
name: taste
disable-model-invocation: true
description: Design, refine, or review any user interface (web, native, mobile, desktop, terminal) for deliberate hierarchy, spacing, type, colour, copy, and states instead of generated defaults.
license: MIT AND Apache-2.0
metadata:
  upstream-source: "https://github.com/Leonxlnx/taste-skill"
  upstream-path: "skills/"
  upstream-revision: "f624f37a8c650b9cc550253104925efe4c8de246"
  upstream-relationship: "adapted"
  upstream-license: "MIT"
  upstream-license-file: "LICENSE"
  upstream-baseline-kind: "recorded"
  upstream-impeccable-source: "https://github.com/pbakaus/impeccable"
  upstream-impeccable-path: ".agents/skills/impeccable/"
  upstream-impeccable-revision: "9304afa97f89b30609e4c538584fb3e0cd4df013"
  upstream-impeccable-relationship: "adapted"
  upstream-impeccable-license: "Apache-2.0"
  upstream-impeccable-license-file: "LICENSE.impeccable"
  upstream-impeccable-baseline-kind: "recorded"
  upstream-emil-source: "https://github.com/emilkowalski/skills"
  upstream-emil-path: "skills/"
  upstream-emil-revision: "2d228630ba1446365f614a108cb8252f1feda202"
  upstream-emil-relationship: "adapted"
  upstream-emil-license: "MIT"
  upstream-emil-license-file: "LICENSE.emil"
  upstream-emil-baseline-kind: "recorded"
---

# Taste

Apply this to the UI the user names: build it, improve it, or review it. For a review, report findings without editing unless asked. For an existing UI, work inside its stack, design system, and platform conventions; fix in place with small, reviewable changes rather than rewriting. Do not add a colour, face, or other building block the system lacks without asking, and if the concept itself is wrong, say so instead of slipping a redesign into a polish pass. Project rules and the platform's own guidelines for standard controls outrank anything here.

## Translate to the medium first

Every rule below is stated as a ratio or a procedure. Before applying them, write down the medium's terms:

| Lever    | Ask                                                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Space    | The base unit: px, pt, dp, or one cell and one row. Spacing steps are multiples of it.                                                                                  |
| Emphasis | What can vary: size, weight, face, case, colour, dim, reverse, underline, position. A terminal has one size, so its levels come from weight, colour, dim, and position. |
| Colour   | Full colour, 256, the user's 16-colour theme, or none. Light and dark grounds, and whether the user owns the palette.                                                   |
| Input    | Pointer, touch, keyboard, or several, and the smallest comfortable target. Detect what the input can do, never what the device claims to be.                            |
| Sizes    | The smallest, typical, and largest space the UI is given, including the user's own text size or zoom.                                                                   |
| Content  | The shortest, typical, and longest values and counts the data allows.                                                                                                   |
| Render   | How to see the real output: a browser screenshot, a simulator capture, a terminal capture at a fixed size.                                                              |

Then state the purpose in one sentence: who uses this, how often, and the one task each screen serves. Give each screen a mode. **Operate** (do a task) earns density, familiar controls, and speed; **read** (understand something) earns comfortable measure and wayfinding; **persuade** (decide and act) earns space and one strong statement. A product's landing screen may persuade while its main screen operates. Note what must stay untouched and what would make a polished result feel wrong.

## Hierarchy

- Give each screen one dominant element: the thing the user came to see or do. In a one-second glance there should be exactly one answer.
- Use few levels, far apart. Two or three carry most screens; five is the ceiling. Levels that are almost the same read as noise, so merge them.
- Emphasis is scarce. If every line is bold, coloured, or boxed, none is.
- Secondary information is the same face in a softer ink, not a smaller or thinner one that stops being readable.
- At each decision, show about four equal options at most: one primary action, one or two secondary ones, the rest grouped. Put the common path first and advanced options one level deeper.
- Everything a decision needs is on the same screen; do not make the user remember it from an earlier step.
- Put a control next to what it changes, arranged like the thing it changes. A control that needs a label to explain its mapping is mapped weakly.

## Spacing and alignment

- Derive every gap from one scale of a few clearly different steps. Arbitrary in-between values show.
- Related things sit close; unrelated things sit far. The gap between groups is clearly larger than any gap inside a group, about twice as large.
- A heading belongs to what follows it: at least twice as much space above it as below.
- Text hangs from two or three shared edges reused across the whole UI. Six distinct left edges means things were placed one at a time.
- Align numbers in columns by their right edge, with fixed-width figures where the medium offers them.
- Empty space is placed, not left over. When a region looks empty, enlarge the main element or remove the region; do not fill it with ornament.
- Separate with space first, then a tone step, and only then a line. Do not box everything, and do not put a panel inside a panel.
- Align optically, not only numerically: an icon beside text, a glyph in a circle, or a round letter at an edge often needs a small nudge to look right.
- Layout follows the space the UI is given, not the device: a split window is a small screen, a resized terminal is a new size.
- The smallest and the largest sizes are compositions of their own. At the smallest, re-break lines, fold secondary parts, and keep the dominant element in view; at the largest, use the room (list beside detail) and cap the measure instead of stretching.
- Fixed-size parts and trailing actions claim their space first; text gives way. Content cut at an edge shows that more follows.
- When something must shorten, shorten by whole parts, keep the part that tells items apart (the file name, not the shared path prefix), and make the full text reachable somewhere. Never shorten numbers, amounts, or dates the user compares.

## Type and text

- Keep running text to about 45 to 75 characters per line. Do not centre more than three lines; do not justify.
- Sentence case for headings, labels, and buttons. Capitals only for a few words, and never as tiny decorative labels.
- Use one family, or two with fixed jobs. Do not add a face for labels or numbers.
- Author line breaks in titles: no single orphan word, no break that splits a phrase.
- Use real characters where the medium renders them (curly quotes, an ellipsis, an en dash for ranges), and check their width where alignment depends on it.

## Colour and surfaces

- Name roles before choosing values: ground, surface, ink, muted ink, one accent, the ink on the accent, and status colours if needed. Use only those roles; a raw value in a component starts a second palette.
- Ground holds most of the screen. The accent marks the primary action, the selection, or the current place, and covers under about five percent of a screen. Headings are ink, not accent. A tinted surface, such as a coloured sidebar, is a surface, not the accent.
- A surface differs from the ground by one tone step. Depth comes from a lighter or darker surface, never from glows.
- Body text meets 4.5:1 contrast and large text or controls 3:1. Muted text on dark grounds fails first, so check it.
- Colour never carries meaning alone: pair it with a word, a symbol, or position, so the UI survives colour blindness, monochrome output, and a user's own theme.
- Where the user owns the palette (terminal themes, system accent colours, dark mode), build from their colours and check both light and dark grounds.

## Copy

- Name the outcome or the thing: "Save draft", "Delete 3 files", never the gesture ("Click here"). One action keeps one name everywhere.
- Prefer the specific noun and the real number. If another product could print the sentence unchanged, sharpen it or cut it.
- Say it once. If the heading explains the state, the text below adds something new or goes. Helper text answers the question the user would ask, not the control's name again.
- A placeholder is an example, not a label; the label stays visible while the user types.
- Errors say what happened, why if known, and what to do next, with no "Oops" and no exclamation marks.
- Loading text names the real operation.
- Write messages as whole sentences, not pasted-together fragments, and leave room for text to grow by about a third.
- No invented proof, customers, or metrics. Sample data is plausible, varied, and at the real density, and you name it as sample data in your report.

## States and interaction

- Every control has visible resting, focused, pressed, disabled, and selected or current states. Keyboard focus is always visible.
- Every view of data has designed loading, error, partial, and overflow states, and five distinct empty states: first use, no results, everything filtered out, no permission, and failed to load. Each says what belongs here and gives its own next step.
- Loading keeps the layout's shape so nothing jumps when content arrives. Progress is never invented.
- The visible response lands on press, in the same frame as the input; only slow work comes after it. Anything slower than about a second shows progress.
- New input changes course from wherever the screen is now. Never lock input while something moves, redraws, or loads.
- A key that might start a sequence delays every press of it, so keep frequent keys out of sequences.
- A cancelled gesture, lost focus, or a resize mid-action leaves no stuck state. A user who leaves mid-task returns to where they were.
- An error keeps what the user entered, and a failure in one region degrades only that region. Check a field as it is filled in, not only at submit.
- Use a modal only when the task must interrupt or hold focus; try inline first. Passing feedback never blocks. A blocking task dims what is behind it; a panel used alongside the main view does not. A self-dismissing message pauses its timer while the screen is hidden or unfocused.
- The user can always tell where they are and how to go back. The platform's own way back (system back, edge swipe, Esc or q) is never disabled or overridden.
- Destructive actions are undoable or confirmed in proportion to their cost.
- Every action is reachable from every input the medium supports, with targets large enough for the coarsest one. Nothing works only on hover.
- Never block the user's own scaling (zoom, text size, terminal font), and keep content out of areas the system owns (notches, system bars, the on-screen keyboard).
- Error text, identifiers, paths, and addresses stay selectable and copyable.

## Motion

Motion comes last and never rescues a weak layout. Animate only to show where something came from, confirm an action, or soften a change. The more often a user sees it, the shorter it is: actions repeated hundreds of times get none, and a pressed state is required but animating it is not. Things leave the way they came, toward the control that opened them; only something anchored to nothing comes from the centre. Entrances ease out, leaving is faster than arriving, and nothing bounces unless the user's gesture threw it. Never move what the user is reading for decoration, and let ongoing motion be stopped. Reduced-motion settings keep fades and colour changes and drop movement. Never hide content until an animation finishes. Judge motion on the slowest real target, slowed down, not on the development machine. In a terminal, redraw only what changed, without flicker, and show a spinner only for waits a user would notice.

## Generated-default tells

These appear because they are defaults, not because the content asks for them. Fixing one means rewriting the element, not toning it down, and filling the gap with structure from the content: a UI with every tell removed and nothing added reads as generated too.

- Violet or indigo gradients, gradient text, glows, neon accents on near-black, cream grounds with terracotta accents.
- Soft shadow and medium rounding on every box, or glass panels; every section a row of identical cards with an icon in a rounded square.
- Tiny letter-spaced capital labels above headings, "New" or "Beta" pills, index numbering such as 01 / 02 / 03 or "Step 02", a second face brought in to make labels or numbers look "technical".
- Hairline rules and outlined boxes everywhere; decorative chrome (crosshairs, status dots, version or time stamps, middle-dot strings).
- Everything centred; nine nearly equal sizes; one word of a title styled differently.
- Emoji as icons or bullets; icons that repeat the word beside them.
- Genre words (seamless, effortless, elevate, unlock, supercharge, powerful, all-in-one), "not just X, it's Y", three-part slogans, "Get started" and "Learn more" as labels, an em dash habit.
- Three of everything: three features, three stats, three steps. Use the number the content has.
- Identical fade-and-rise on every block, hover lift on every card, bounce easing.

## Look at the render, then fix

Judge the rendered output at the smallest, typical, and largest sizes, in light and dark, never the code: you wrote the code and will read your intentions into it. Form your own judgement before reading any linter or checker, whose findings anchor you. Let motion settle before capturing, then open each capture and confirm it shows what its name claims. A screenshot checks layout, not interaction: drive each interaction and say what drove it (simulated keys, a simulator, a real device). Load the UI with stress data from [references/stress.md](references/stress.md) through the same path real data takes.

Make each pass separately:

1. One second: what is the focal point, and is it the screen's task?
2. Squint: does it reduce to two or three masses of clearly different weight?
3. Edges: count the distinct left edges.
4. Space: related close, unrelated far, no accidental holes.
5. Emphasis: count the levels; check measure and line breaks.
6. Colour: name the proportions, the accent's job, and any contrast failure; check without colour.
7. Copy: read every label and message aloud.
8. States: walk every empty state, loading, error, and interruption.
9. Sizes and data: overflow, truncation, collisions, anything covering content, and the stress data.
10. Decisions: count the equal options at each decision point.
11. The task: walk it end to end as an expert (keyboard only, nothing forced or unskippable) and as a first-timer who reads every label literally.
12. Substance: does it show what the user came for, completely and at a readable size? Cover the product's name: could the screen belong to anything else?

Fix anything broken, misleading, blocking, or losing data first. Then fix in this order, since later items cannot rescue earlier ones: purpose and hierarchy, composition and spacing, type, colour, copy, states, detail, motion. Fix the top three problems, render again, and critique again, for at most three rounds. Stop early when a round finds nothing a stranger would notice.

Report each round in this shape, ranking problems by harm, then visibility, and naming them as a designer would to a colleague ("the status column starts one cell left of the title column"), never "could be more polished":

```
ROUND n
Focal point:
Purpose and mode:
Evidence (sizes, themes, what drove the interactions):
Top three problems, each with where it shows and the fix:
1.
2.
3.
Remaining after this round:
```

If problems remain after the last round, list them plainly; do not round up.
