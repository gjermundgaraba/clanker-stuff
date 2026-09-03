# Terminal animation research

Last reviewed: 2026-08-10.

This is the durable source map for the [terminal motion gallery](../scripts/terminal-animation-showcase.ts). The executable gallery contains 137 distinct named animation types and 141 catalog-source entries; later research passes in this document extend that source map. The gallery implements visual families, not one duplicate scene per library. The target environment is Ghostty on this machine; portability to other terminals is not a goal.

Run `node scripts/terminal-animation-showcase.ts` to view it, `node scripts/terminal-animation-showcase.ts --list` for the plain-text catalog, or `node scripts/terminal-animation-showcase.ts --check` for its self-check.

## Findings

- For product UI, the strongest micro-motion is local and semantic: a one-cell spinner, a changing progress state, a restrained text transition, or a stable live metric. Full-screen spectacle works best for intros, idle screens, demos, and celebrations.
- Keep layout anchors fixed. Animate only the changing cells, compose a frame off-screen, write it once, and restore cursor, attributes, and alternate-screen state on every exit path.
- Use roughly 80–120 ms per one-cell spinner frame, and skip late frames instead of queueing them. Frame rate is an aesthetic choice, not a throughput limit: measured with [`scripts/terminal-bench.ts`](../scripts/terminal-bench.ts) on this machine (Ghostty 1.3.1, 251×71 cells), the pty accepts 126 full-screen 24-bit frames per second, DECSET 2026 synchronized output costs nothing (127 fps), and diff-shaped updates run at ~15,000 accepted frames per second. The practical ceiling is display refresh; 15–30 fps remains a fine default for calm UI, not a technical cap.
- Treat text as grapheme clusters and measure terminal columns with a mature width implementation. Braille, block, sextant, box-drawing, and private-use Nerd Font glyphs need visible ASCII fallbacks where layout or font coverage matters.
- Disable animation on non-TTY output or `TERM=dumb`, provide a no-animation mode, and never use color or motion as the only state signal. `NO_COLOR` covers color, not reduced motion.

## Corrections to the supplied reports

- [Ora](https://github.com/sindresorhus/ora#can-i-display-multiple-spinners-simultaneously) is designed for one active spinner. Use [Listr2](https://github.com/listr2/listr2) or [@topcli/spinner](https://github.com/TopCli/Spinner) for concurrent rows.
- [cli-spinners](https://github.com/sindresorhus/cli-spinners) is frame-and-interval data, while [Chalk](https://github.com/chalk/chalk) and [gradient-string](https://github.com/bokub/gradient-string) are styling ingredients rather than animation engines.
- [TerminalTextEffects](https://github.com/ChrisBuilds/terminaltexteffects) and [Ansimax](https://github.com/Brashkie/ansimax) are separate projects. TTE is the richer path, scene, easing, and particle system; Ansimax is a TypeScript ANSI rendering toolkit.
- `animate.sh` is stale naming for [terminal-animations](https://github.com/jorexdeveloper/terminal-animations); [Curlix](https://github.com/AlexGustafsson/curlix) is archived; [Terani](https://github.com/Renairisu/terani) is small and old; and the report's bare `termination` name refers here to the old [Go project](https://github.com/ansoni/termination).
- `asciiquarium` has a [classic Perl implementation](https://github.com/cmatsuoka/asciiquarium) and a newer [Python port](https://github.com/MKAbuMattar/asciiquarium-python). `pipes-rs` is owner-ambiguous, so this catalog names the [dnorhoj project](https://github.com/dnorhoj/pipes-rs) explicitly.

## Rendering layers and smoothness (deep-research pass, 2026-08-08)

- The biggest catalog gaps were rendering layers, not motifs. [notcurses](https://github.com/dankamongmen/notcurses) auto-degrades a blitter ladder — pixel, octant (Unicode 16), sextant (Unicode 13), quadrant, half block, Braille — and [chafa](https://github.com/hpjansson/chafa) exposes about 24 selectable symbol classes. [timg](https://github.com/hzeller/timg) is a peer; none of the three is "the" reference implementation. The Blitter ladder scene shows the resolution ladder.
- A second pass against the installed Ghostty 1.3.1 found protocol-native paths worth real companions rather than cell approximations: `OSC 4` indexed-palette cycling, SGR styled underline motion, `DECSCUSR` cursor morphing, `OSC 12` cursor-color pulses, `DECSTBM` bounded scrolling, `OSC 22` pointer states, cursor-aware custom shaders, and Kitty image placement replacement. These can move terminal-owned state or a bounded region without repainting the screen.
- The [kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/) has an animation half: `a=f` frame transmission, `a=a` terminal-driven playback with per-frame gaps, and `a=c` rectangular frame composition — protocol-level damage tracking. [`scripts/kitty-graphics-demo.ts`](../scripts/kitty-graphics-demo.ts) now emits all three with `--native-compose`; Ghostty implements the still-image path, so the native animation path remains kitty-only.
- Whole-terminal GPU post-processing ([Ghostty custom shaders](https://ghostty.org/docs/config/reference#custom-shader), [ghostty-shaders](https://github.com/0xhckr/ghostty-shaders)) is user-side terminal configuration a program cannot emit. It is Shadertoy-style but not Shadertoy-compatible: no iMouse or iDate and one input texture per pass. Ghostty can chain multiple passes through `iChannel0`, and 1.3 exposes current/previous cursor geometry and color, cursor-change time, focus state/time, and the terminal palette. The real cursor trail shader uses those uniforms.
- GPU-to-cell conversion ([OpenTUI](https://github.com/anomalyco/opentui) `@opentui/three`) renders with WebGPU and maps each 2×2 pixel block to a 16-glyph quadrant table with separate foreground and background colors. The Quadrant mosaic scene is a CPU port of that mapping.
- Verified smoothness engineering: per-cell double-buffered diffs with dirty-rect image placements (sixel regions are clear-and-repaint), batching one tick's writes inside a single synchronized-output envelope, skipping late frames without advancing the frame clock so deltas accumulate, and instrumented cell and color elision counters (notcurses `ncstats`). The Cell damage map scene visualizes the diff. Outside kitty, the portable ceiling is cell diffing plus synchronized output.
- Physics-based motion is a technique, not a library detail: [Harmonica](https://github.com/charmbracelet/harmonica) ports [Ryan Juckett's closed-form damped spring](https://www.ryanjuckett.com/damped-springs/), frame-rate independent by construction. The Damped spring race scene implements the same solution against fixed easing curves.
- The [TMDC ruleset](https://tmdc.scene.org/index.php?nav=rules) — 80×50 text mode, CP437, no font or palette changes — is the purest statement of the character-cell constraint; TMDC20 (2017) appears to be the final edition. The textmode demoscene group implements its classic effects.
- [tui-vfx](https://github.com/5ocworkshop/tui-vfx) was initially refuted because it was cited only via lib.rs; a direct source read confirms the five-stage compositor (samplers, masks, style shaders, filters, content transformers) and its ten mask types, which the transitions-and-masks group reimplements. ascii-splash's claimed dither and edge-detection pipeline remains refuted.
- [Termflix](https://github.com/paulrobello/termflix) catalogs 60 procedural animations, while [life-simulator](https://github.com/changkun/life-simulator) catalogs more than 130 terminal simulation modes. The gallery adds six stateless families; [`scripts/stateful-terminal-simulations.ts`](../scripts/stateful-terminal-simulations.ts) adds real Physarum agents, diffusion-limited aggregation, and semi-Lagrangian ink advection rather than time-indexed imitations.
- A micro-motion pass favored semantics over skins. [`scripts/terminal-micro-lab.ts`](../scripts/terminal-micro-lab.ts) has 42 fixed-layout demos covering state transitions, rolling data, edit/focus feedback, controls, tiny physics, and composed task flows. Five current [TerminalTextEffects](https://github.com/ChrisBuilds/terminaltexteffects) mechanics — binary paths, error correction, laser etching, slice assembly, and spotlights — also filled distinct gallery gaps.
- The machine-targeted companion set has grown beyond its original eight paths. It now also includes First Light, five frontier scenes, Ghostty OSC/background demos, two mainline-fidelity probes, and the terminal benchmark. Together they cover hardware cursor/pointer state, bounded scrolling, palette and shader effects, 42 micro interactions, persistent simulation, paced video, WebGPU torus/voxel scenes, still placements, kitty-native composition, audio response, interactive physics, a cell scene graph, and authored VFX sequences.
- Ghostty capability mining (verified against the installed 1.3.1 binary): custom shaders receive full cursor state — `iCurrentCursor`/`iPreviousCursor` (position and size), both cursor colors, both cursor styles, and `iTimeCursorChange` — which [`cursor-trail.glsl`](../shaders/ghostty/cursor-trail.glsl) and [`cursor-glow.glsl`](../shaders/ghostty/cursor-glow.glsl) use for real GPU cursor animation. [`scripts/ghostty-background-demo.ts`](../scripts/ghostty-background-demo.ts) exercises kitty-graphics negative z-index (animated image below the text layer), [`scripts/ghostty-osc-demo.ts`](../scripts/ghostty-osc-demo.ts) animates the terminal itself via OSC 11/12 with OSC 111/112 restore, and [`scripts/terminal-bench.ts`](../scripts/terminal-bench.ts) measures the pty throughput ceiling (full-screen vs synchronized vs diff-shaped writes) so the frame-rate guidance above can be recalibrated for this terminal instead of a portable worst case.
- Still deliberately skipped: Kitty multiple cursors and Unicode-placeholder/relative-placement animation because Ghostty 1.3.1 support is unverified, Kitty text sizing because Ghostty parses OSC 66 but does not implement it in the GUI, lower-ranked simulation families that repeat the same grid/particle engines, and TTE variants that repeat existing reveal/dissolve/morph families.

## Frontier research pass (ClankerSearch, 2026-08-09)

This pass searched general web results, GitHub, Reddit, X, Bluesky, Threads, Hacker News, Stack Exchange, and YouTube. Reddit and GitHub were the strongest sources; YouTube was useful for visual references; broad X, Bluesky, and Threads searches were mostly ambiguous or empty. The main correction to the current direction is that the next leap is not another set of plasma, rain, or spinner variants. It is a better rendering alphabet, richer input signals, and terminal/application protocols that move beyond ANSI byte streams.

[`scripts/first-light.ts`](../scripts/first-light.ts) is the resulting 34-second synthesis: native cursor and OSC color, keypress ripples, damped-spring typography, semi-Lagrangian ink, a new WebGPU raymarch, shape-aware ASCII with temporal hysteresis, quadrant and half-block ladders, OSC 4 palette motion, synchronized diff output, bounded scrolling, and a designed return to the prompt.

Five follow-up demos cover the largest remaining frontier gaps through one shared diff renderer:

- [`scripts/glyph-forge.ts`](../scripts/glyph-forge.ts) builds a live, frequency-ranked Braille codebook and performs two-color shape fitting as the atlas expands from 8 to 256 glyphs.
- [`scripts/kinetic-matter.ts`](../scripts/kinetic-matter.ts) combines fixed-step Verlet cloth, SPH-style fluid, N-body gravity, pointer grabbing, and persistent trails.
- [`scripts/sound-reactor.ts`](../scripts/sound-reactor.ts) renders an FFT spectrum tunnel, waveform ribbon, equalizer, and beat response from generative input, `--audio FILE`, or `--mic`.
- [`scripts/terminal-scene-graph.ts`](../scripts/terminal-scene-graph.ts) renders hierarchical 3D transforms, a warped floor, orbit controls, and an animated kitty-graphics texture below the cell layer.
- [`scripts/vfx-anthology.ts`](../scripts/vfx-anthology.ts) stages nine researched motifs, including split-flap text, neon chase, shutter blades, kintsugi repair, bioluminescence, elevation, paint, Stargate, and DECCRA/DECFRA rectangle motion.

Each script accepts `--seconds N`, `--fps N`, `--cells-only`, and `--check`; `q` exits. [`scripts/frontier-demos.ts`](../scripts/frontier-demos.ts) can also run any scene by name.

### Biggest visual leaps to try

1. **A learned, runtime glyph blitter.** [TUI-Image](https://github.com/volotat/tuimg) selects 4,096 shape-diverse binary tiles from a VQ-VAE codebook, then fits two colors per cell. [Glyph Protocol](https://rapha.land/introducing-glyph-protocol-for-terminals/) can register vector and COLRv0/COLRv1 glyphs at runtime, while [petiglyph](https://github.com/petipoua/petiglyph) turns images or video frames into single-cell or multi-cell font animations. The novel synthesis is a per-clip 1,024-glyph working set registered at runtime, foreground/background color fitting, and PUA frame playback: learned image fidelity without preinstalling a 4,096-glyph font.
2. **Shape-aware ASCII instead of treating characters as pixels.** [Alex Harri's renderer](https://alexharri.com/blog/ascii-rendering) fingerprints each character with a six-region shape vector, matches image samples in that space, and adds directional contrast enhancement. [`first-light.ts`](../scripts/first-light.ts) now applies that idea to a 5×7 glyph atlas and adds a temporal penalty for changing glyphs so animated edges stay sharp without sparkling. The next reuse is to port the same lookup into [`video-terminal.ts`](../scripts/video-terminal.ts) and [`shader-terminal.ts`](../scripts/shader-terminal.ts).
3. **Make the terminal a scene graph.** [Ratty](https://github.com/orhun/ratty) anchors animated 3D models to terminal cells, supports a 3D cursor, and can warp the terminal surface. [tmnl](https://tmnl.sh/) bypasses ANSI with typed cell frames, changed-cell runs, and updateable inline-image textures. A companion experiment should target these richer hosts directly rather than reducing everything to characters before it reaches the terminal.
4. **Audio-reactive shader scenes.** [Chroma](https://github.com/yuri-xyz/chroma) combines WGSL compute shaders, live shader reload, and FFT-derived bass/mid/treble inputs. Feed those three bands plus beat/onset envelopes into [`shader-terminal.ts`](../scripts/shader-terminal.ts), then render a spectrum tunnel, fluid equalizer, oscilloscope ribbons, and beat-triggered palette or camera cuts.
5. **Real interactive physics.** [Inertia](https://github.com/aclfe/inertia) combines rigid bodies, Barnes-Hut gravity, Verlet cloth, and SPH fluid in a Braille 3D projection with fixed-step simulation. The frontier suite now has grabbable cloth, SPH-style fluid, and N-body modes. The remaining leap is genuine cross-system collision and coupling, stronger physical accuracy, and a designed choreography rather than another isolated solver.

### Fast, high-value experiments

1. **Mine recipes, not library names.** [tui-vfx-recipes](https://github.com/5ocworkshop/tui-vfx-recipes) is a dense recipe bank. The VFX anthology now implements split-flap content, elevation, neon chase, shutter, kintsugi, bioluminescence, and Stargate motifs. Contact darkening and jazz-improv motion remain distinct gaps from that original list.
2. **Use typing as an animation signal.** [lex-ghostty-shaders](https://github.com/lexrus/lex-ghostty-shaders) derives a damped water-drop wave from `iTimeCursorChange`; [ghostty-shader-adventures](https://github.com/fielding/ghostty-shader-adventures) adds cursor paint splatter and typing-reactive electric arcs; [Par-term's 52-shader collection](https://github.com/paulrobello/par-term/blob/main/docs/SHADERS.md) includes keypress pulses, cursor shockwaves, orbiting particles, Pac-Man, and a sloshing cursor water tank. These are more interesting than another passive CRT pass because user actions drive them.
3. **Harden terminal-owned rectangle motion.** [`DECCRA`](https://vt100.net/docs/vt510-rm/DECCRA.html) copies a rectangular cell region and [`DECFRA`](https://vt100.net/docs/vt510-rm/DECFRA.html) fills one. The VFX anthology now demonstrates both, but it sends them without a real capability probe. The remaining work is negotiation, cleanup, and comparison against Pi-owned row diffing.
4. **Author one polished sequence.** [ASCII Motion](https://github.com/cameronfoxly/Ascii-Motion), [Durdraw](https://github.com/durdraw/durdraw), and [Playscii](https://jplebreton.com/playscii/) provide timelines, onion skinning, variable frame timing, palettes, and video conversion. Use them for a designed 10–20 second intro with anticipation, holds, overshoot, and a clean ending rather than another procedural loop.
5. **Revisit the original material.** [Sixteen Colors](https://16colo.rs/), [Demozoo](https://demozoo.org), [HardCode](https://github.com/sceners/hardcode.untergrund.net), the [256-byte archive](http://256bytes.untergrund.net/), and the [DEC animation archive](https://vt100.net/dec/animation/) are deeper motif libraries than modern “awesome” lists. Extract timing, composition, ANSI reveal order, and size-coding tricks rather than merely replaying their files.

### Newly useful collections

- [awesome-ascii-animation](https://github.com/mu-ct/awesome-ascii-animation) covers editors, converters, classic works, and communities.
- [awesome-terminal-art](https://github.com/mcthomas/awesome-terminal-art) is unusually focused: original static or animated terminal-native art, excluding games, filters, recordings, and audio visualizers.
- [awesome-cli-apps-in-a-csv](https://github.com/toolleeo/awesome-cli-apps-in-a-csv) has a dedicated animation category assembled after a Reddit request for exactly this kind of catalog.
- [awesome-ratatui](https://github.com/ratatui/awesome-ratatui) exposes renderers and widgets that generic TUI lists miss, including Bevy cameras, wireframes, globes, skeleton shimmers, rain, and particle systems.
- [tui-vfx-recipes](https://github.com/5ocworkshop/tui-vfx-recipes) is the densest immediately executable motif bank found in this pass.

## Pi extension gap pass (deep research, 2026-08-10)

### Verdict

The local work is visually broad enough. Another pass over spinner packs, rain, plasma, fire, glitch text, classic games, shader collections, or particle systems would mostly produce aliases of effects already present. The important gap is that every substantial local demo is a standalone terminal takeover. None is a reusable Pi component driven by real agent, tool, approval, retry, compaction, diff, or task-tree events.

The next work should therefore split into two lanes:

1. **Product motion:** small, truthful transitions attached to Pi lifecycle events. This is the highest-value lane.
2. **Opt-in spectacle:** a command-opened overlay or terminal-specific demo that can use richer input and graphics without destabilizing normal Pi rendering.

The first lane needs a motion contract before it needs a motion framework. Pi v0.84.0 already supplies timers, components, invalidation, overlays, differential row rendering, synchronized output, width-safe utilities, and a host-owned working indicator. Reuse those primitives and add no dependency yet.

### Highest-value Pi-native motion

| Priority | Addition | Pi-scale behavior | Why it is additive |
| --- | --- | --- | --- |
| 1 | **Outcome-first afterglow** | Show a corrected token, changed metric, moved selection, or final tool state immediately; leave the old value or path dimly visible for 100–200 ms. | [Phosphor](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/uist2006-phosphor.pdf) explains a change retrospectively without making the user wait for the animation. This is a real previous-state buffer, unlike the gallery's current “CRT afterglow.” |
| 2 | **Shared-anchor lifecycle morph** | Keep one cell fixed while `submit → working → ✓/×`; let parallel tools unfold in reading order with a short batch stagger. | It preserves causality without moving the layout. Use roughly 20 ms between already-available rows and finish the sequence within 500 ms, following [Carbon's choreography guidance](https://carbondesignsystem.com/elements/motion/choreography/). |
| 3 | **Truthful counterflow progress** | Keep the true fill boundary and numeric value; optionally drift a low-contrast interior texture backwards. Morph the same track from indeterminate to determinate when a real estimate appears. | A controlled study found backwards-decelerating ribbing made equal work feel about 11% faster. It is useful only when the percentage remains exact. [Primary paper](https://www.chrisharrison.net/projects/progressbars2/ProgressBarsHarrison.pdf). |
| 4 | **Elastic selection geometry** | Move the leading and trailing ends of a one-row underline or focus rail with an 80–180 ms follower delay. | Two scalar endpoints create a tiny stretch/compress motion that communicates direction. [FTXUI's official example](https://github.com/ArthurSonzogni/FTXUI/blob/main/examples/component/menu_underline_animated_gallery.cpp) proves the pattern without a scene engine. |
| 5 | **Treat existing cells as material** | Briefly stain, wash, peel, or fracture only the component-owned cells, then settle to the semantic result. | [Notcurses fission](https://github.com/dankamongmen/notcurses/blob/master/src/demo/fission.c), [Cellophane](https://github.com/km-clay/cellophane), and [TerminalTextEffects 0.15](https://github.com/ChrisBuilds/terminaltexteffects/releases/tag/release-0.15.0) show that styled terminal content can seed the effect instead of being replaced by unrelated particles. |

Good mappings are a tool row afterglow on completion, a single traveling wash across a newly applied diff, a focus rail in a command picker, and an old token echo when streaming content is corrected. Streaming text is already motion; do not add typewriter, bounce, or shimmer to every appended token.

### New one-cell and subcell alphabets

| Technique | What it enables | Target notes |
| --- | --- | --- |
| **One-cell 4×4 motion** | `U+1CE90–U+1CE9F` are sixteen individual one-sixteenth blocks: a true particle orbit, Hilbert spark, bouncing thought dot, or target lock inside one terminal cell. `U+1CEA0–U+1CEAF` add longer edge strokes for a tail. | Ghostty 1.3.1 renders these with built-in sprites, independent of the configured font. Use an eight-position Braille fallback. [Ghostty renderer](https://github.com/ghostty-org/ghostty/blob/v1.3.1/src/font/sprite/draw/symbols_for_legacy_computing_supplement.zig), [Unicode chart](https://www.unicode.org/charts/PDF/U1CC00.pdf). |
| **Solid/separated focus rack** | Preserve one binary image mask while morphing solid quadrants or sextants into their separated mosaic equivalents. The image appears to crystallize, breathe apart, or become a tiny LED matrix without changing layout. | Ghostty supplies the relevant legacy-computing sprites. This is distinct from changing blitter resolution. [Unicode legacy chart](https://www.unicode.org/charts/nameslist/n_1FB00.html). |
| **Exact two-color octant fitting** | For each 2×4 sample, test 128 unique mask/complement partitions, fit two mean colors, and retain the minimum reconstruction error with temporal stability as a tie-breaker. | This improves colorful video and shader fidelity over the current luminance pivot. Reuse the existing 256-entry octant table because the code points are not mask-contiguous. [Notcurses solver](https://github.com/dankamongmen/notcurses/blob/master/src/lib/blit.c), [Chafa renderer](https://github.com/hpjansson/chafa/blob/master/chafa/internal/chafa-symbol-renderer.c). |
| **SDF-to-octant vectors** | Sample an analytic signed-distance function directly on a 2×4 lattice for crisp droplets, shockwave contours, knots, logo morphs, topographic rings, outlines, dilation, and erosion without a pixel framebuffer. | Plain analytic SDFs are enough for a first pass; imported MSDF text can wait. [Valve SDF paper](https://steamcdn-a.akamaihd.net/apps/valve/2007/SIGGRAPH2007_AlphaTestedMagnification.pdf), [msdfgen](https://github.com/Chlumsky/msdfgen). |
| **Screen-stable dither and eighth-cell scanner** | Anchor Bayer/noise phase to terminal coordinates for stable soft edges and glow falloff. Separately, move an eighth-block stripe through one cell for a fractional progress head or scan beam. | Never randomize the dither phase per frame. [Chafa's dither core](https://github.com/hpjansson/chafa/blob/master/chafa/internal/chafa-dither.c) is the useful reference. |

Unicode 17 adds no new general-purpose raster alphabet worth chasing. Reject temporal color dithering, combining-mark/ZWJ animation, ligature animation, and LCD subpixel tricks: they flicker, depend on font configuration, or do not have stable cell geometry.

### Terminal-specific “wow” paths

These are excellent showcase material, but capability-gated and separate from the default Pi component path.

| Path | New effect | Compatibility boundary |
| --- | --- | --- |
| **Kitty Unicode-placeholder sprite atlas** | Upload one virtual atlas, then animate fragments by moving small `U+10EEEE` placeholder blocks with complete row/column diacritics. Movement remains ordinary text while pixel data is uploaded once. | [Kitty protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders); implemented in current Ghostty mainline, not assumed for the installed stable build. |
| **Hardware-cursor constellations** | Kitty's multiple-cursor protocol can render several smooth, contrast-aware terminal cursors as agent positions, edit locations, or attention points. | Kitty-only practical tier; query support and clear all cursors on exit. [Protocol](https://sw.kovidgoyal.net/kitty/multiple-cursors-protocol/). |
| **Live theme-reactive motion** | DEC mode 2031 can report dark/light and palette changes; Ghostty's OSC 5 special-color channels can recolor cells with semantic styles globally without rewriting their text. | Prefer Pi theme invalidation for normal components. Use raw terminal color channels only in an owned takeover and restore prior values. [Theme notifications](https://github.com/contour-terminal/contour/blob/master/docs/vt-extensions/color-palette-update-notifications.md), [Ghostty colors](https://ghostty.org/docs/vt/concepts/colors). |
| **Pixel-coordinate interaction** | Xterm mode 1016 plus focus and mouse-leave events can drive subcell ripples, springs, cloth grabs, and fluid painting rather than snapping input to cells. | Probe support, pause when unfocused, and avoid unrestricted any-motion reporting outside an owned overlay. [Xterm controls](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html), [Kitty extension](https://sw.kovidgoyal.net/kitty/misc-protocol/). |
| **Terminal-owned rectangular effects** | Extended DECCARA can recolor/style an existing rectangle; DECSLRM plus vertical margins and insert/delete line can shift a true bounded viewport for a conveyor or slot panel. | Kitty owns extended DECCARA; Ghostty documents [DECSLRM](https://ghostty.org/docs/vt/csi/decslrm). Direct sequences must not compete with Pi's cached screen renderer. |

Secondary native spectacle includes one-upload animated GIFs and cursor-positioned fireworks in [iTerm2](https://iterm2.com/documentation-escape-codes.html#Attention), and additive growth/trails with SIXEL `P2=1`. The earlier blanket statement that SIXEL always needs clear-and-repaint is too broad: adding pixels can accumulate, while removing pixels still requires erasing and redrawing.

### Other Pi-world ideas worth retaining

| Idea | Useful form | Default decision |
| --- | --- | --- |
| **Semantic Git session coda** | An opt-in 5–10 second replay of files and hunks Pi actually changed, borrowing typing, deletion, tree, and change-step ideas from [Gitlogue](https://github.com/unhappychoice/gitlogue). | Showcase or explicit completion command only; never slow normal completion. |
| **Original scanline silk** | Combine indexed palette cycling with independent per-row sinusoidal/interlace distortion, inspired by [Whoa's Saturn implementation](https://github.com/km-clay/whoa/blob/main/src/anim/saturn/mod.rs), using original assets. | Intro, idle, or overlay background only. |
| **Content-free Pi-to-OSC bridge** | Emit opt-in loopback events such as `/pi/agent/start`, `/pi/tool/end 0 | 1`, and `/pi/agent/settled duration` for SuperCollider, Max, TouchDesigner, lights, or specialist haptics. | No synthesizer dependency. Rate-limit activity to 5–10 Hz and never transmit prompts, paths, arguments, output, session IDs, or key timing. [OSC 1.0](https://opensoundcontrol.stanford.edu/spec-1_0.html). |
| **Terminal-owned completion attention** | One generic BEL or silent/unfocused notification after an explicitly configured long-task threshold. | Off by default, one event per settled task, visible result remains authoritative. [Ghostty BEL](https://ghostty.org/docs/vt/control/bel), [Kitty OSC 99](https://sw.kovidgoyal.net/kitty/desktop-notifications/). |
| **GUI-grade terminal drag and drop** | Kitty OSC 72 can expose MIME types, pixel/cell coordinates, thumbnails, and remote file transfer to an owned file/tool picker. | Interesting but not an animation priority; only implement after support probing and a concrete Pi workflow exist. [Protocol](https://sw.kovidgoyal.net/kitty/dnd-protocol/). |

Do not build microphone capture, per-keystroke sound/haptics, TTS results, remote-device side effects, or a cross-platform haptic abstraction. The local sound reactor already covers the demo value, while those additions create privacy, fatigue, and accessibility costs.

### Pi v0.84.0 integration map

The upstream checkout was verified at tag `v0.84.0`. Pi's `requestRender()` coalesces calls and enforces a 16 ms minimum interval; the renderer diffs changed rows, wraps repainting in synchronized output, and performs one terminal write. Normal animation therefore needs neither a second renderer nor direct stdout control. [Scheduler](https://github.com/earendil-works/pi/blob/v0.84.0/packages/tui/src/tui.ts), [main renderer](https://github.com/earendil-works/pi/blob/v0.84.0/packages/tui/src/tui-main-screen.ts).

| Surface | Best use | Constraint |
| --- | --- | --- |
| `ctx.ui.setWorkingIndicator()` | The safest beautiful global working glyph. Pi owns frames, cadence, replacement, and cleanup. | Limited to the standard streaming indicator. [Example](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/examples/extensions/working-indicator.ts). |
| [`pi/extensions/timer`](../pi/extensions/timer/timer.ts) | Lowest-risk first product animation: reuse its existing 100 ms `agent_start → agent_settled` tick for a constant-ink glyph morph or afterglow. | Add no second timer. |
| [`pi/extensions/side`](../pi/extensions/side/panel.ts) | Best richer surface: it already owns an overlay, subscribes to semantic updates, invalidates, constrains width, and disposes. Animate only while work is active. | Keep stable dimensions and stop the clock at equilibrium. |
| [`pi/extensions/tools/code-mode`](../pi/extensions/tools/code-mode/tools.ts) | Update-driven `running → yielded → result` morphs from real tool state. | Tool renderer components have no disposal path; do not attach a persistent private timer. |
| One explicit custom overlay | The appropriate place for 20–30 fps particles, pixel input, or an interactive showcase. | Use `ctx.mode === "tui"`, elapsed-time phase, width-safe Pi utilities, keyboard fallback, component disposal, and `session_shutdown` cleanup. |

Avoid beginning in a custom editor or a second footer. Editor replacement lacks a reliable timer-disposal path in v0.84.0, and the repository's cooperative footer already owns the single footer slot. Raw `terminal.write()` animation can corrupt Pi's cached screen model.

### Motion and pacing contract

| Concern | Contract |
| --- | --- |
| **Semantics** | The real state changes immediately. Animation explains or follows it and never gates tool completion, input, cancellation, or `Esc`. Unknown work gets a phase verb and elapsed time, never a fabricated percentage. |
| **Modes** | Preference order: explicit `full | reduced | off`, then best-effort OS preference, then off for non-TTY or `TERM=dumb`. Reduced removes spin, shake, spring travel, stagger, particles, marquee, and repeated pulse; off schedules no frames. [Textual uses the same three-level idea](https://textual.textualize.io/api/types/#textual.types.AnimationLevel). |
| **Timing** | Direct feedback and spinner frames: 80–120 ms. Small morph: about 150 ms. Overlay/toast: 200–240 ms. Rare top-level celebration: no more than 400 ms. Looping status: 8–12 fps; short transitions and interactive overlays: 20–30 fps; elapsed time: 1 Hz. |
| **Frame clock** | Derive phase from monotonic absolute time, skip obsolete frames after a stall, invalidate only while changing, and stop at completion. Faster than Pi's roughly 62.5 fps scheduling ceiling only wastes callbacks. |
| **Safety** | Keep motion and color supplementary, cap flashing at three per second, never loop an error shake, and leave moving/blinking content that persists over five seconds pausable or globally suppressible. [WCAG motion guidance](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html). |

### Protocol guardrails

| Risk | Required behavior |
| --- | --- |
| **Pi screen ownership** | Keep ordinary extension animation inside Pi components. Direct stdout writes can invalidate Pi's cached screen; a full terminal takeover must be an explicit, isolated mode. |
| **Queries and input** | Centralize terminal-response parsing. Probe modes with DECRQM where available, and use the protocol's query-plus-Primary-DA ordering when specified so unsupported replies do not leak into the editor as keystrokes. |
| **Cleanup and suspension** | End synchronized output explicitly with `CSI ?2026l`, disable mouse/focus modes, restore colors and pointer/title state, and make cleanup idempotent. Pi exposes no pre-suspend extension hook, so an extension should not own persistent terminal state that must be restored before `Ctrl-Z`. |
| **Palette restoration** | Query and restore the user's actual colors or use a supported color stack; `OSC 104/111/112` resets defaults and can erase user overrides. Kitty OSC 21 queries require 0.47.3 or newer because earlier releases had [CVE-2026-54057](https://github.com/kovidgoyal/kitty/security/advisories/GHSA-5gmr-9gwg-hhq6). Allowlist keys and never interpolate model/tool text into OSC or APC payloads. |
| **Terminal boundary** | Treat tmux as the terminal and prefer capabilities it models. Passthrough is conditional, can lose cleanup state, and image limits differ. Respect stdout backpressure and keep a cell/static fallback. [tmux passthrough notes](https://github.com/tmux/tmux/wiki/FAQ#what-is-the-passthrough-escape-sequence-and-how-do-i-use-it). |

### Local coverage corrections exposed by this pass

| Area | What the name currently overstates | Actual remaining work |
| --- | --- | --- |
| **Micro motion** | Rolling odometer, segmented thumb, stack insertion, success particles, gravity, and deploy pulse are abrupt substitutions or static arrangements. | Real rolling, interpolation, sibling reflow, emitted particles, acceleration, and a traveling connector pulse. |
| **Named simulations** | Gallery boids have no flocking rules, reaction-diffusion has no PDE/state grid, and maze generation has no connected-maze algorithm. | Implement the real algorithms before adding more simulation names. |
| **Rendering claims** | “CRT afterglow” has no previous-frame persistence, “cell damage” still triggers whole-frame output in the standalone runtime, and beam reveal does not hide unrevealed text. | History buffers, real dirty output, and correct masking. Pi already supplies changed-row rendering for components. |
| **Frontier claims** | Glyph Forge remaps standard Braille by Hamming distance rather than learning/registering glyphs; the scene graph is ANSI wireframe without filled/depth-sorted faces; audio FFT values do not drive WGSL. | Runtime glyph registration, renderer depth/clipping, and real FFT uniforms/compute/live reload. |
| **Runtime readiness** | Standalone demos count code points, do not negotiate most protocols, lack reduced motion, fix geometry at startup, and benchmark pty acceptance rather than displayed fps. | Grapheme/column-safe Pi utilities, probes, resize-safe state, cleanup, and display-level measurement. |

The gallery's `--check` verifies source uniqueness and an `https://` prefix. It does not establish reachability, provenance, current support, licensing, or that an effect name implements its underlying algorithm.

### Ranked next experiments

1. **Pi lifecycle motion lab:** one real extension surface showing `idle → working → success/error/cancelled` with outcome-first afterglow, shared anchors, truthful progress, and `full | reduced | off` side by side.
2. **One-cell glyph lab:** 4×4 sixteenth-block orbit, eighth-cell scan head, and solid/separated focus rack with Braille fallbacks.
3. **Owned-region material demo:** capture only a component's styled cells and apply a 150–250 ms stain/wash/peel transition.
4. **Input-reactive overlay:** pixel-mouse ripple or cloth grab, focus-aware and opt-in, rendered through Pi rather than a raw stdout takeover.
5. **Protocol spectacle card:** capability-gated Kitty placeholder atlas, cursor constellation, or iTerm fireworks/GIF with an explicit static fallback.

Do not introduce a shared animation package before two Pi-native consumers prove the same need. For the first experiment, a frame function, `performance.now()`, one demand-driven timer, and Pi's existing invalidation are enough.

## Animation types

### Micro motion

Inspired by: Pi · cli-spinners · alive-progress · TachyonFX · Harmonica · Mordant.

- Spinner wheel
- Breathing pulse
- Bouncing indicator
- Meter spinner
- Ellipsis
- Blink
- Rainbow cycle
- Sand fill and drain
- Perimeter orbit
- Comet chase
- Phase-delayed ripple
- Cropped marquee
- Coalesce and dissolve
- Patterned color sweep
- Spring-settled marker
- Spinner-to-result morph
- Native terminal progress

### Task feedback

Inspired by: Ora · Listr2 · Rich · indicatif · PTerm.

- Concurrent task list
- Determinate progress
- Indeterminate progress
- Elapsed-time status

### Glyph micro-motion

Inspired by: unicode-animations · agents-are-thinking · pi-animations · Unicode Legacy Computing.

- Braille DNA twist
- Braille dual helix
- Braille diagonal fill
- Braille radial ripple
- Braille scanner field
- Shade mechanics
- Box-weight morph
- Block choreography
- Nerd Font semantic morph
- Nerd Font pipeline pulse
- Legacy texture lab
- Legacy sprite lab

### Text effects

Inspired by: TerminalTextEffects · Ansimax · Terani · chalk-animation.

- Decrypt
- Beam reveal
- Swarm
- Bubble text
- Pour
- Wipe
- VHS glitch
- Ring text
- Fade
- Slide
- Wave
- Glitch
- Scatter
- Typewriter
- Shimmer
- Binary path
- Error correction
- Laser etch
- Slice assembly
- Spotlights

### Weather and fields

Inspired by: cmatrix · termflix · ascii-splash · tarts · sysc-Go · libcaca.

- Digital rain
- Rain art
- Matrix text
- DOOM fire
- Burning text
- Plasma
- Ocean waves
- Aurora
- Lightning
- Snow
- Lava lamp

### Simulations

Inspired by: termflix · tarts · ascii-splash · sysc-Go.

- Game of Life
- Boids
- DNA helix
- Maze generation
- Mandelbrot
- N-body
- Reaction-diffusion
- Metaballs
- Constellation
- Pendulum wave
- Curl flow field
- Voronoi drift
- Lorenz attractor
- Galton board
- Radar sweep

### Paths and games

Inspired by: pipes.sh · tarts · termflix.

- Growing pipes
- Snake
- Pong
- Tetris
- Crabs

### Sprites and scenes

Inspired by: asciiquarium · nyancat · terminal-parrot · sl · sysc-Go.

- Aquarium
- Nyan Cat
- Dancing parrot
- Pet dog
- Locomotive
- Amiga ball

### Growth and playback

Inspired by: cbonsai · theattyr · Termynal.js · ascii-splash.

- Bonsai growth
- Pixel-art morph
- VT100 theater
- Startup reveal

### Space and geometry

Inspired by: termflix · tarts · ascii-3d-cube · libcaca.

- Starfield
- Fireworks
- 3D cube
- Rotating donut
- Black hole
- 3D heart

### Dashboards

Inspired by: CAVA · btop · Hollywood · tty-clock.

- Audio equalizer
- Live charts
- Hacker panes
- Terminal clock

### Rendering layers

Inspired by: notcurses · chafa · OpenTUI · ghostty-shaders · Harmonica.

- Blitter ladder
- Quadrant mosaic
- Compact quadrant mosaic
- CRT afterglow
- RGB split glow
- Cell damage map
- Damped spring race
- Bloom glow
- Cursor smear

### Textmode demoscene

Inspired by: TMDC · viznut · text-mode.org.

- Rotozoomer
- Tunnel flight
- Kefrens bars
- Copper bars
- Sine scroller
- Vector balls
- Shadebobs
- Moiré rings
- Voxel landscape
- Dot flag
- Bump lighting
- Twister bar

### Transitions and masks

Inspired by: tui-vfx · TachyonFX · TerminalTextEffects.

- Iris reveal
- Blinds
- Checker tiles
- Diamond wipe
- Cellular pop
- Radial sweep
- Snake reveal
- Dither reveal
- Fault line
- Shredder
- Ripple warp
- Filter rack

## Linked source catalog

### Animation engines

- [TerminalTextEffects](https://github.com/ChrisBuilds/terminaltexteffects)
- [TachyonFX](https://github.com/ratatui/tachyonfx)
- [tui-vfx](https://github.com/5ocworkshop/tui-vfx)
- [Textual](https://github.com/Textualize/textual)
- [OpenTUI](https://github.com/anomalyco/opentui)
- [Ink](https://github.com/vadimdemedes/ink)
- [Bubble Tea](https://github.com/charmbracelet/bubbletea)
- [Ratatui](https://github.com/ratatui/ratatui)
- [FTXUI](https://github.com/ArthurSonzogni/FTXUI)
- [asciimatics](https://github.com/peterbrittain/asciimatics)
- [Ansimax](https://github.com/Brashkie/ansimax)
- [sysc-Go](https://github.com/Nomadcxx/sysc-Go)
- [terminal-kit](https://github.com/cronvel/terminal-kit)
- [unicode-animations](https://github.com/gunnargray-dev/unicode-animations)
- [agents-are-thinking](https://github.com/czl9707/agents-are-thinking)
- [pi-animations](https://github.com/arpagon/pi-animations)

### TUI foundations

- [Bubbles](https://github.com/charmbracelet/bubbles)
- [Lip Gloss](https://github.com/charmbracelet/lipgloss)
- [Harmonica](https://github.com/charmbracelet/harmonica)
- [Crossterm](https://github.com/crossterm-rs/crossterm)
- [tui-realm](https://github.com/veeso/tui-realm)
- [prompt_toolkit](https://github.com/prompt-toolkit/python-prompt-toolkit)
- [Blessed](https://github.com/jquast/blessed)
- [Lanterna](https://github.com/mabe02/lanterna)
- [Pi TUI](https://github.com/earendil-works/pi)
- [blessed (Node)](https://github.com/chjj/blessed)
- [termui](https://github.com/gizak/termui)

### Inline and task UI

- [cli-spinners](https://github.com/sindresorhus/cli-spinners)
- [Ora](https://github.com/sindresorhus/ora)
- [Listr2](https://github.com/listr2/listr2)
- [Rich](https://github.com/Textualize/rich)
- [alive-progress](https://github.com/rsalmei/alive-progress)
- [indicatif](https://github.com/console-rs/indicatif)
- [PTerm](https://github.com/pterm/pterm)
- [Gum](https://github.com/charmbracelet/gum)
- [Spectre.Console](https://github.com/spectreconsole/spectre.console)
- [@topcli/spinner](https://github.com/TopCli/Spinner)
- [bash_loading_animations](https://github.com/Silejonu/bash_loading_animations)
- [log-update](https://github.com/sindresorhus/log-update)
- [Chalk](https://github.com/chalk/chalk)
- [nanospinner](https://github.com/usmanyunusov/nanospinner)
- [Go progressbar](https://github.com/schollz/progressbar)
- [Consola](https://github.com/unjs/consola)
- [console-rs](https://github.com/console-rs/console)
- [Glamour](https://github.com/charmbracelet/glamour)
- [Mordant](https://github.com/ajalt/mordant)
- [indicators](https://github.com/p-ranav/indicators)
- [throbber-widgets-tui](https://github.com/arkbig/throbber-widgets-tui)
- [cli-spinner](https://github.com/helloIAmPau/node-spinner)
- [yocto-spinner](https://github.com/sindresorhus/yocto-spinner)
- [unicode-animatio](https://github.com/openminion/unicode-animatio)
- [unicode-spinner](https://github.com/tsvillain/unicode-spinner)
- [Rattles](https://github.com/vyfor/rattles)

### Procedural and classic

- [termflix](https://github.com/paulrobello/termflix)
- [ascii-splash](https://github.com/reowens/ascii-splash)
- [tarts](https://github.com/oiwn/tarts)
- [cmatrix](https://github.com/abishekvashok/cmatrix)
- [asciiquarium](https://github.com/cmatsuoka/asciiquarium)
- [pipes.sh](https://github.com/pipeseroni/pipes.sh)
- [cbonsai](https://gitlab.com/jallbrit/cbonsai)
- [nyancat](https://github.com/klange/nyancat)
- [sl](https://github.com/mtoyoda/sl)
- [libcaca demos](https://github.com/cacalabs/libcaca)
- [asciiquarium-python](https://github.com/MKAbuMattar/asciiquarium-python)
- [pipes-rs](https://github.com/dnorhoj/pipes-rs)
- [parrot.live](https://github.com/hugomd/parrot.live)
- [genact](https://github.com/svenstaro/genact)
- [terminal-parrot](https://github.com/jmhobbs/terminal-parrot)
- [anims](https://github.com/jbanana/anims)
- [CurlParrot_perrito](https://github.com/Aaron3312/CurlParrot_perrito)
- [life-simulator](https://github.com/changkun/life-simulator)
- [AsciiCreativeCoding](https://github.com/prtamil/AsciiCreativeCoding)
- [TermiSand](https://github.com/BobdaProgrammer/TermiSand)

### Application references

- [lazygit](https://github.com/jesseduffield/lazygit)
- [Posting](https://github.com/darrenburns/posting)
- [Harlequin](https://github.com/tconbeer/harlequin)
- [Glow](https://github.com/charmbracelet/glow)
- [Hollywood](https://github.com/dustinkirkland/hollywood)
- [tty-clock](https://github.com/xorg62/tty-clock)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [fzf](https://github.com/junegunn/fzf)
- [Windows Terminal](https://github.com/microsoft/terminal)
- [Kitty](https://github.com/kovidgoyal/kitty)

### Playback, demos, and references

- [theattyr](https://github.com/orhun/theattyr)
- [VHS](https://github.com/charmbracelet/vhs)
- [btop](https://github.com/aristocratos/btop)
- [CAVA](https://github.com/karlstav/cava)
- [Yazi](https://github.com/sxyazi/yazi)
- [MapSCII](https://github.com/rastapasta/mapscii)
- [Termynal.js](https://github.com/ines/termynal)
- [Buddy](https://github.com/JVSCHANDRADITHYA/buddy)
- [terminal-animations](https://github.com/jorexdeveloper/terminal-animations)
- [ascii-3d-cube](https://github.com/msadeqsirjani/ascii-3d-cube)
- [Curlix (archived)](https://github.com/AlexGustafsson/curlix)
- [tplay](https://github.com/maxcurzi/tplay)
- [video-to-ascii](https://github.com/joelibaceta/video-to-ascii)

### Pixel, subcell, and shader rendering

- [notcurses](https://github.com/dankamongmen/notcurses)
- [chafa](https://github.com/hpjansson/chafa)
- [timg](https://github.com/hzeller/timg)
- [Ghostty](https://github.com/ghostty-org/ghostty)
- [ghostty-shaders](https://github.com/0xhckr/ghostty-shaders)
- [MinecraftTTY](https://github.com/raphamorim/minecraftty)
- [TerminalRenderer](https://github.com/DarkOnGithub/TerminalRenderer)
- [OpenTUI Three](https://github.com/anomalyco/opentui/tree/main/packages/three)

### Demoscene and motion techniques

- [TMDC rules](https://tmdc.scene.org/index.php?nav=rules)
- [Textmode demoscene essay](https://viznut.fi/texts-en/demoscene_msdos-textmode.html)
- [text-mode.org](https://text-mode.org/)
- [Damped springs (Ryan Juckett)](https://www.ryanjuckett.com/damped-springs/)
- [awesome-tuis](https://github.com/rothgar/awesome-tuis)

### Frontier collections, renderers, and protocols

- [tui-vfx-recipes](https://github.com/5ocworkshop/tui-vfx-recipes)
- [awesome-ascii-animation](https://github.com/mu-ct/awesome-ascii-animation)
- [awesome-terminal-art](https://github.com/mcthomas/awesome-terminal-art)
- [awesome-cli-apps-in-a-csv](https://github.com/toolleeo/awesome-cli-apps-in-a-csv)
- [awesome-ratatui](https://github.com/ratatui/awesome-ratatui)
- [Sixteen Colors](https://16colo.rs/)
- [Demozoo](https://demozoo.org)
- [HardCode demoscene archive](https://github.com/sceners/hardcode.untergrund.net)
- [256-byte demos archive](http://256bytes.untergrund.net/)
- [DEC Video Terminal Animations](https://vt100.net/dec/animation/)
- [Shape-aware ASCII rendering](https://alexharri.com/blog/ascii-rendering)
- [TUI-Image](https://github.com/volotat/tuimg)
- [petiglyph](https://github.com/petipoua/petiglyph)
- [Glyph Protocol](https://rapha.land/introducing-glyph-protocol-for-terminals/)
- [Glyph Protocol examples](https://github.com/raphamorim/glyph-protocol-examples)
- [Ratty](https://github.com/orhun/ratty)
- [tmnl native mode](https://tmnl.sh/)
- [bevy_ratatui_camera](https://github.com/cxreiff/bevy_ratatui_camera)
- [Inertia](https://github.com/aclfe/inertia)
- [Chroma](https://github.com/yuri-xyz/chroma)
- [confetty_rs](https://github.com/Handfish/confetty_rs)
- [Zoa](https://github.com/icryo/zoa)
- [Carbonyl rendering notes](https://fathy.fr/carbonyl)
- [ASCII Motion](https://github.com/cameronfoxly/Ascii-Motion)
- [Durdraw](https://github.com/durdraw/durdraw)
- [Playscii](https://jplebreton.com/playscii/)
- [Par-term shader collection](https://github.com/paulrobello/par-term/blob/main/docs/SHADERS.md)
- [lex-ghostty-shaders](https://github.com/lexrus/lex-ghostty-shaders)
- [ghostty-shader-adventures](https://github.com/fielding/ghostty-shader-adventures)
- [DECCRA rectangular copy](https://vt100.net/docs/vt510-rm/DECCRA.html)
- [DECFRA rectangular fill](https://vt100.net/docs/vt510-rm/DECFRA.html)

### Small and historical references

- [chalk-animation](https://github.com/bokub/chalk-animation)
- [gradient-string](https://github.com/bokub/gradient-string)
- [txtanim](https://pypi.org/project/txtanim/)
- [Terani](https://github.com/Renairisu/terani)
- [termination (Go)](https://github.com/ansoni/termination)
- [cli-spinner-lite](https://www.npmjs.com/package/cli-spinner-lite)
- [@basd/spinner](https://github.com/basedwon/spinner)
- [lolcat](https://github.com/busyloop/lolcat)
- [FIGlet](https://github.com/cmatsuoka/figlet)
- [Are We Legacy Computing Yet?](https://arewelegacycomputingyet.com/)
- [Unicode Legacy Computing](https://unicode.org/charts/nameslist/n_1FB00.html)
- [Unicode Legacy Supplement](https://unicode.org/charts/nameslist/n_1CC00.html)

### Standards and terminal protocols

- [ECMA-48 control functions](https://ecma-international.org/publications-and-standards/standards/ecma-48/)
- [ncurses terminfo API](https://invisible-island.net/ncurses/man/curs_terminfo.3x.html)
- [terminfo capabilities](https://invisible-island.net/ncurses/man/terminfo.5.html)
- [xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.pdf)
- [Unicode grapheme boundaries](https://www.unicode.org/reports/tr29/)
- [Unicode East Asian Width](https://www.unicode.org/reports/tr11/)
- [NO_COLOR](https://no-color.org/)
- [Synchronized output](https://github.com/contour-terminal/vt-extensions/blob/master/synchronized-output.md)
- [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
- [Kitty text sizing protocol](https://sw.kovidgoyal.net/kitty/text-sizing-protocol/)
- [Kitty styled underlines](https://sw.kovidgoyal.net/kitty/underlines/)
- [Kitty multiple cursors](https://sw.kovidgoyal.net/kitty/multiple-cursors-protocol/)
- [Ghostty pointer shapes](https://ghostty.org/docs/vt/osc/22)
- [Ghostty cursor styles](https://ghostty.org/docs/vt/csi/decscusr)
- [Ghostty scroll regions](https://ghostty.org/docs/vt/csi/decstbm)
- [Ghostty dynamic colors](https://ghostty.org/docs/vt/osc/1x)
- [Ghostty configuration reference](https://ghostty.org/docs/config/reference)
- [Ghostty 1.3 release notes](https://ghostty.org/docs/install/release-notes/1-3-0)
- [iTerm2 inline images](https://iterm2.com/3.5/documentation-images.html)
- [DEC SIXEL](https://vt100.net/docs/vt3xx-gp/)
