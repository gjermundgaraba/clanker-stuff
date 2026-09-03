// Small terminal UI motion, composed into fixed-size frames and committed with
// synchronized output. Run in Ghostty for colored/curly underline support.
//
// Run: node scripts/terminal-micro-lab.ts [--list | --check]

import assert from "node:assert/strict";

const ESC = "\x1b";
const CSI = `${ESC}[`;
const RESET = `${CSI}0m`;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const WIDTH = 64;
const FPS = 20;

const style = (code: string, text: string) => `${CSI}${code}m${text}${RESET}`;
const fg = (r: number, g: number, b: number, text: string) =>
  style(`38;2;${r};${g};${b}`, text);
const accent = (text: string) => fg(113, 190, 255, text);
const good = (text: string) => fg(123, 211, 137, text);
const warn = (text: string) => fg(238, 190, 101, text);
const bad = (text: string) => fg(244, 106, 116, text);
const muted = (text: string) => fg(139, 146, 165, text);
const dim = (text: string) => style("2", text);
const bold = (text: string) => style("1", text);
const invert = (text: string) => style("7", text);
const underline = (kind: number, color: string, text: string) =>
  `${CSI}4:${kind};58;2;${color}m${text}${RESET}`;
const plain = (text: string) => text.replaceAll(ANSI, "");
const widthOf = (text: string) => [...plain(text)].length;
const fit = (text: string, width = WIDTH) => {
  const length = widthOf(text);
  return length <= width
    ? text + " ".repeat(width - length)
    : plain(text).slice(0, width);
};
const center = (text: string, width = WIDTH) =>
  fit(
    " ".repeat(Math.max(0, Math.floor((width - widthOf(text)) / 2))) + text,
    width
  );
const at = <T>(items: readonly T[], time: number, step = 0.12) =>
  items[Math.floor(time / step) % items.length]!;
const ping = (time: number, length: number, speed = 8) => {
  const span = Math.max(0, length - 1);
  const phase = (time * speed) % Math.max(1, span * 2);
  return Math.round(phase <= span ? phase : span * 2 - phase);
};
const ease = (value: number) => 1 - (1 - Math.max(0, Math.min(1, value))) ** 3;
const spring = (time: number) => 1 - Math.exp(-5 * time) * Math.cos(11 * time);
const track = (width: number, position: number, glyph = "●") =>
  dim("─".repeat(Math.max(0, position))) +
  accent(glyph) +
  dim("─".repeat(Math.max(0, width - position - 1)));
const meter = (value: number, width: number) => {
  const count = Math.round(Math.max(0, Math.min(1, value)) * width);
  return good("━".repeat(count)) + dim("─".repeat(width - count));
};
const dots = (count: number, active: number, paint = accent) =>
  Array.from({ length: count }, (_, index) =>
    index === active ? paint("●") : dim("·")
  ).join(" ");
const box = (label: string, active = false) =>
  active ? accent(`┏ ${label} ┓`) : dim(`┌ ${label} ┐`);
const offsetText = (text: string, offset: number, span = 3) =>
  " ".repeat(span + offset) + text + " ".repeat(span - offset);

type Demo = {
  group: string;
  name: string;
  note: string;
  render: (time: number) => string[];
};

const DEMOS: Demo[] = [
  {
    group: "Semantic state",
    name: "Save transaction",
    note: "dirty → saving → durable; label and icon agree",
    render(time) {
      const phase = Math.floor((time % 6) / 2);
      return [
        phase === 0
          ? warn("● Edited")
          : phase === 1
            ? `${accent(at(["⠋", "⠙", "⠹", "⠸"], time))} Saving`
            : good("✓ Saved"),
        dim(phase === 2 ? "All changes are durable" : "document.md"),
      ];
    },
  },
  {
    group: "Semantic state",
    name: "Optimistic rollback",
    note: "instant action, then a visible correction",
    render(time) {
      const phase = time % 5;
      const count = phase < 1 ? 12 : phase < 2.8 ? 13 : 12;
      return [
        `Stars  ${phase < 2.8 && phase >= 1 ? good(`+1  ${count}`) : phase >= 2.8 ? bad(`↶  ${count}`) : muted(String(count))}`,
        phase >= 2.8 ? bad("Could not sync · restored") : dim("Synced"),
      ];
    },
  },
  {
    group: "Semantic state",
    name: "Retry resolves",
    note: "attempt history collapses into one calm result",
    render(time) {
      const phase = Math.floor(time % 7);
      const attempt = Math.min(3, Math.floor(phase / 2) + 1);
      return [
        phase < 6
          ? `${warn(`attempt ${attempt}/3`)}  ${at(["◜", "◝", "◞", "◟"], time)}`
          : good("✓ connected"),
        phase < 6 ? dots(3, attempt - 1, warn) : dim("•••  184 ms"),
      ];
    },
  },
  {
    group: "Semantic state",
    name: "Backoff countdown",
    note: "retry timing without a layout-changing clock",
    render(time) {
      const left = 5 - (Math.floor(time) % 6);
      return [
        `Offline  ${warn(`${left}s`)}`,
        `[${meter((5 - left) / 5, 16)}]  ${dim("retry queued")}`,
      ];
    },
  },
  {
    group: "Semantic state",
    name: "Fan-out and join",
    note: "one parent creates parallel work then rejoins",
    render(time) {
      const phase = Math.floor(time % 6);
      if (phase < 2) return [`${accent("build")} ──────────────`, ""];
      if (phase < 4)
        return [
          `${accent("build")} ─┬─ ${good("lint")} ─┐`,
          `       └─ ${warn("test")} ─┴─`,
        ];
      return [`${good("build")} ───── ${good("✓ ready")}`, ""];
    },
  },
  {
    group: "Semantic state",
    name: "Promotion handoff",
    note: "a token moves between stable environment anchors",
    render(time) {
      const position = ping(time, 17, 5);
      return [
        "staging " + track(17, position, "◆") + " production",
        position > 13
          ? good("                 promoted")
          : dim("                 verifying"),
      ];
    },
  },
  {
    group: "Semantic state",
    name: "Undo window",
    note: "destructive action exposes its remaining reversal time",
    render(time) {
      const value = 1 - (time % 5) / 5;
      return [
        `Archived  ${invert(" UNDO ")}`,
        `${warn("━".repeat(Math.ceil(value * 18)))}${dim("─".repeat(18 - Math.ceil(value * 18)))}  ${Math.ceil(value * 5)}s`,
      ];
    },
  },
  {
    group: "Semantic state",
    name: "Download verify unpack",
    note: "three semantic stages share one compact lane",
    render(time) {
      const phase = Math.floor((time % 6) / 2);
      const labels = ["download", "verify", "unpack"];
      return [
        labels
          .map((label, index) =>
            index < phase
              ? good(`✓ ${label}`)
              : index === phase
                ? accent(`◆ ${label}`)
                : dim(`○ ${label}`)
          )
          .join("  "),
        meter((time % 2) / 2, 34),
      ];
    },
  },
  {
    group: "Inline data",
    name: "Rolling odometer",
    note: "only changed digits roll; the numeric anchor stays fixed",
    render(time) {
      const value = 12840 + (Math.floor(time * 7) % 160);
      const hot = Math.floor(time * 7) % 10;
      return [
        `requests  ${bold(String(Math.floor(value / 10)))}${accent(String(hot))}`,
        dim("          last digit is the motion budget"),
      ];
    },
  },
  {
    group: "Inline data",
    name: "Delta flash",
    note: "new value, direction, and transient emphasis",
    render(time) {
      const up = Math.floor(time / 1.5) % 2 === 0;
      const bright = time % 1.5 < 0.45;
      const value = up ? "43.8 ms  ↓ 2.1" : "47.2 ms  ↑ 3.4";
      return [
        `latency  ${bright ? (up ? good(value) : bad(value)) : muted(value)}`,
        dim("         p95 · last 30s"),
      ];
    },
  },
  {
    group: "Inline data",
    name: "Sparkline head",
    note: "history stays still while one newest sample arrives",
    render(time) {
      const values = "▂▃▂▄▅▄▆▅▇▆▅▄";
      const head = at(["▁", "▃", "▆", "█", "▅", "▂"], time, 0.18);
      return [
        `cpu  ${muted(values)}${accent(head)}  62%`,
        dim("     history             now"),
      ];
    },
  },
  {
    group: "Inline data",
    name: "Threshold latch",
    note: "alarm attacks quickly and releases slowly",
    render(time) {
      const phase = time % 6;
      const high = phase > 1 && phase < 3;
      const latched = phase >= 1 && phase < 4.4;
      return [
        `memory  ${high ? bad("92%") : good("68%")}  ${latched ? warn("! HIGH") : dim("normal")}`,
        `[${meter(high ? 0.92 : 0.68, 20)}]`,
      ];
    },
  },
  {
    group: "Inline data",
    name: "Rate-limit refill",
    note: "capacity returns one discrete token at a time",
    render(time) {
      const count = Math.floor(time * 2) % 9;
      return [
        `API quota  ${good("● ".repeat(count))}${dim("○ ".repeat(8 - count))}`,
        `${String(count).padStart(2)}/8  ${dim("next token")} ${accent(at(["·", "•", "●", "•"], time))}`,
      ];
    },
  },
  {
    group: "Inline data",
    name: "Freshness decay",
    note: "motion and color fade as data becomes stale",
    render(time) {
      const age = Math.floor(time) % 8;
      const pulse = at(["●", "•", "·", " "], Math.min(time % 8, 3), 1);
      return [
        `weather  ${age < 4 ? good(pulse) : warn("◌")}  18.4°C`,
        age < 4 ? dim(`${age}s ago`) : warn(`${age}s ago · stale`),
      ];
    },
  },
  {
    group: "Inline data",
    name: "Queue pressure",
    note: "arrivals advance toward a fixed service boundary",
    render(time) {
      const shift = Math.floor(time * 3) % 4;
      return [
        `in  ${" ".repeat(shift)}${warn("◆ ◆ ◆")} ${dim("────")}>│${good("◆")}│ out`,
        `    ${dim("queue depth")} ${accent(String(3 + (shift % 2)))}`,
      ];
    },
  },
  {
    group: "Inline data",
    name: "Diff counters",
    note: "independent counters flip only when their side changes",
    render(time) {
      const tick = Math.floor(time * 2);
      return [
        `files ${bold(String(2 + (tick % 3)))}   ${good(`+${12 + (tick % 7)}`)}   ${bad(`-${3 + (tick % 4)}`)}`,
        dim("      changed   added   removed"),
      ];
    },
  },
  {
    group: "Editing and focus",
    name: "Ghost completion",
    note: "suggest, reveal, accept; typed text never shifts",
    render(time) {
      const phase = Math.floor(time % 5);
      const typed = "git comm";
      const rest = 'it -m "motion"';
      const shown = phase < 3 ? rest.slice(0, Math.max(0, phase * 5)) : rest;
      return [
        `$ ${typed}${phase < 3 ? dim(shown) : good(shown)}${accent("▏")}`,
        phase < 3 ? dim("tab to accept") : good("accepted"),
      ];
    },
  },
  {
    group: "Editing and focus",
    name: "Selection sweep",
    note: "selection expands by word rather than flashing the line",
    render(time) {
      const words = ["ship", "small", "motion", "well"];
      const selected = Math.floor(time * 2) % words.length;
      return [
        words
          .map((word, index) =>
            index <= selected ? invert(` ${word} `) : ` ${word} `
          )
          .join(""),
        dim("shift+option+→"),
      ];
    },
  },
  {
    group: "Editing and focus",
    name: "Matching brackets",
    note: "paired delimiters pulse together around a stable cursor",
    render(time) {
      const on = Math.floor(time * 4) % 2 === 0;
      const bracket = (value: string) =>
        on ? accent(bold(value)) : muted(value);
      return [
        `render${bracket("(")}frame${bracket("[")}index${bracket("]")}${bracket(")")} ${accent("▏")}`,
        dim("two pairs · one pulse"),
      ];
    },
  },
  {
    group: "Editing and focus",
    name: "Diagnostic underline",
    note: "Ghostty underline style and color carry severity",
    render(time) {
      const phase = Math.floor(time / 1.2) % 3;
      const samples = [
        underline(3, "244;106;116", "unknownName"),
        underline(4, "238;190;101", "deprecated()"),
        underline(5, "113;190;255", "hint"),
      ];
      return [
        `const value = ${samples[phase]};`,
        [
          bad("error · curly"),
          warn("warning · dotted"),
          accent("hint · dashed"),
        ][phase]!,
      ];
    },
  },
  {
    group: "Editing and focus",
    name: "Focus traversal",
    note: "one border changes weight; content does not move",
    render(time) {
      const active = Math.floor(time / 1.2) % 3;
      return [
        ["Name", "Role", "Team"]
          .map((label, index) => box(label.padEnd(6), index === active))
          .join("  "),
        `        ${dots(3, active)}`,
      ];
    },
  },
  {
    group: "Editing and focus",
    name: "Chord staging",
    note: "multi-key command reveals its accepted prefix",
    render(time) {
      const phase = Math.floor(time * 1.5) % 4;
      return [
        `${phase > 0 ? invert(" g ") : dim(" g ")} ${dim("then")} ${phase > 1 ? invert(" c ") : dim(" c ")}  ${phase > 2 ? good("✓ comment") : muted("waiting…")}`,
        dim("prefix expires without moving the editor"),
      ];
    },
  },
  {
    group: "Editing and focus",
    name: "Breadcrumb cursor",
    note: "context focus moves across an otherwise stable path",
    render(time) {
      const active = Math.floor(time * 1.5) % 4;
      return [
        ["repo", "scripts", "micro", "render"]
          .map((part, index) =>
            index === active ? accent(bold(part)) : muted(part)
          )
          .join(dim(" › ")),
        `      ${"    ".repeat(active)}${accent("━━━━")}`,
      ];
    },
  },
  {
    group: "Editing and focus",
    name: "Cursor echo",
    note: "short fading trail makes a large jump legible",
    render(time) {
      const head = ping(time, 24, 7);
      const cells = Array.from({ length: 24 }, () => " ");
      for (let tail = 0; tail < 4; tail++)
        if (head - tail >= 0)
          cells[head - tail] =
            tail === 0 ? accent("▌") : dim(["▓", "▒", "░"][tail - 1]!);
      return [`│${cells.join("")}│`, dim(" cursor jump with four-cell echo")];
    },
  },
  {
    group: "Controls",
    name: "Elastic toggle",
    note: "spring settles into a semantic on/off endpoint",
    render(time) {
      const local = time % 4;
      const on = local >= 2;
      const progress = on ? spring(local - 2) : 1 - spring(local);
      const position = Math.max(0, Math.min(7, Math.round(progress * 7)));
      return [
        `notifications  [${track(8, position)}]  ${on ? good("ON ") : muted("OFF")}`,
        dim("closed-form damped spring"),
      ];
    },
  },
  {
    group: "Controls",
    name: "Tri-state checkbox",
    note: "empty, mixed, checked with a shape bridge",
    render(time) {
      const glyph = at(["□", "▣", "■", "▣", "☑", "✓", "☑", "▣"], time, 0.22);
      return [
        `${accent(glyph)} Select visible rows`,
        dim("none  →  mixed  →  all"),
      ];
    },
  },
  {
    group: "Controls",
    name: "Segmented thumb",
    note: "highlight glides while labels remain fixed",
    render(time) {
      const active = Math.floor(time / 1.7) % 3;
      return [
        `${["CODE", "PLAN", "LOGS"].map((label, index) => (index === active ? invert(` ${label} `) : dim(` ${label} `))).join("│")}`,
        `${"       ".repeat(active)}${accent("━━━━━━")}`,
      ];
    },
  },
  {
    group: "Controls",
    name: "Disclosure hinge",
    note: "chevron rotates before content height changes",
    render(time) {
      const phase = Math.floor(time * 2) % 6;
      const glyph = ["›", "⌄", "⌄", "⌄", "›", "›"][phase]!;
      return [
        `${accent(glyph)} Advanced options`,
        phase > 1 && phase < 4 ? dim("  timeout  30s") : "",
      ];
    },
  },
  {
    group: "Controls",
    name: "Button ripple",
    note: "press feedback stays inside the button bounds",
    render(time) {
      const phase = Math.floor(time * 6) % 9;
      const cells = Array.from({ length: 9 }, (_, index) =>
        Math.abs(index - 4) <= phase / 2 ? accent("━") : dim("─")
      ).join("");
      return [
        `┌${cells}┐`,
        `│  ${phase > 5 ? good("SENT ") : bold("SEND ")}  │`,
        `└${cells}┘`,
      ];
    },
  },
  {
    group: "Controls",
    name: "Badge pop",
    note: "count arrival uses scale-like glyphs, not layout growth",
    render(time) {
      const badge = at(["·", "•", "●", "◉", "●", "●", "●"], time, 0.14);
      return [
        `Inbox  ${bad(badge)} ${bold(String(4 + (Math.floor(time / 2) % 3)))}`,
        dim("       fixed two-column count"),
      ];
    },
  },
  {
    group: "Tiny physics",
    name: "Validation shake",
    note: "one short damped shake, followed by a quiet error",
    render(time) {
      const local = time % 4;
      const offset =
        local < 0.8
          ? Math.round(Math.sin(local * 35) * (1 - local / 0.8) * 2)
          : 0;
      return [
        offsetText("[ invalid@email ]", offset),
        bad("   Enter a valid address"),
      ];
    },
  },
  {
    group: "Tiny physics",
    name: "Toast trajectory",
    note: "enter, dwell, exit within a reserved notification lane",
    render(time) {
      const phase = time % 5;
      const x =
        phase < 1
          ? Math.round((1 - ease(phase)) * 16)
          : phase < 4
            ? 0
            : Math.round(ease(phase - 4) * 16);
      return [
        " ".repeat(x) + good("╭─ ✓ Build complete ─╮"),
        " ".repeat(x) + dim("╰────── 2.4s ───────╯"),
      ];
    },
  },
  {
    group: "Tiny physics",
    name: "Magnetic target",
    note: "nearby pointer bends toward the actionable cell",
    render(time) {
      const position = ping(time, 20, 6);
      const distance = 19 - position;
      const pulled = distance < 5 ? 19 - Math.round(distance * 0.55) : position;
      return [
        `${" ".repeat(pulled)}${accent("◆")}${" ".repeat(Math.max(0, 19 - pulled))}${invert(" GO ")}`,
        dim("pointer attraction inside a five-cell radius"),
      ];
    },
  },
  {
    group: "Tiny physics",
    name: "Stack insertion",
    note: "siblings make space before the new row settles",
    render(time) {
      const phase = Math.floor(time * 2) % 6;
      const rows = [
        dim("1  parse"),
        phase > 1 ? good("2  new: animate") : "",
        dim(`${phase > 1 ? 3 : 2}  render`),
      ];
      return rows;
    },
  },
  {
    group: "Tiny physics",
    name: "Collision exchange",
    note: "two values trade momentum in a single-cell lane",
    render(time) {
      const phase = (time * 6) % 30;
      const left = Math.round(phase < 15 ? phase : 30 - phase);
      const right = 30 - left;
      const cells = Array.from({ length: 31 }, () => dim("·"));
      cells[left] = accent("●");
      cells[right] = warn("●");
      return [cells.join(""), dim("equal mass · exchanged velocity")];
    },
  },
  {
    group: "Tiny physics",
    name: "Gravity settle",
    note: "items land with one restrained squash frame",
    render(time) {
      const phase = Math.floor(time * 5) % 12;
      const y = Math.min(3, Math.floor(ease(Math.min(1, phase / 8)) * 3));
      return Array.from({ length: 4 }, (_, row) =>
        row === y
          ? center(phase === 8 ? accent("◆◆") : accent("◆"), 18)
          : " ".repeat(18)
      );
    },
  },
  {
    group: "Tiny physics",
    name: "Success particles",
    note: "a result emits four local particles then goes still",
    render(time) {
      const phase = Math.floor(time * 5) % 14;
      if (phase < 4)
        return ["       ·       ", "    ·  ✓  ·    ", "       ·       "].map(
          (line) => (phase < 3 ? accent(line) : good(line))
        );
      return [
        "               ",
        `       ${good("✓")}       `,
        "               ",
      ];
    },
  },
  {
    group: "Tiny physics",
    name: "Bell wobble",
    note: "damped rotation communicates a new notification",
    render(time) {
      const local = time % 4;
      const glyph = local < 1.2 ? at(["◥", "▲", "◤", "▲"], local, 0.1) : "▲";
      return [
        `notifications  ${warn(glyph)}  ${local < 1.2 ? bad("+1") : muted("1 unread")}`,
        dim("fast attack · damped rest"),
      ];
    },
  },
  {
    group: "Combinations",
    name: "Command lifecycle",
    note: "prompt, stream, completion and duration in one stable block",
    render(time) {
      const phase = Math.floor(time % 6);
      return [
        phase < 2 ? `$ pnpm test${accent("▏")}` : "$ pnpm test",
        phase < 4
          ? `${accent(at(["⠋", "⠙", "⠹", "⠸"], time))} ${muted(`running ${20 + phase * 17}/84`)}`
          : good("✓ 84 passed"),
        phase >= 4 ? dim("  1.84s") : dim("  collecting output"),
      ];
    },
  },
  {
    group: "Combinations",
    name: "Collaborator presence",
    note: "presence, typing and saved state share one restrained pulse",
    render(time) {
      const phase = Math.floor(time % 6);
      return [
        `${good("●")} Ada   ${accent("●")} Lin   ${dim("○ Sam")}`,
        phase < 3
          ? `Ada is typing${accent(".".repeat(phase + 1).padEnd(3))}`
          : phase < 5
            ? warn("Ada edited line 42")
            : good("✓ changes synced"),
      ];
    },
  },
  {
    group: "Combinations",
    name: "Inline test repair",
    note: "diagnostic transforms in place into a passing assertion",
    render(time) {
      const phase = Math.floor(time % 6);
      return [
        phase < 2
          ? underline(3, "244;106;116", "expect(4).toBe(5)")
          : phase < 4
            ? `expect(4).toBe(${accent("4▏")})`
            : good("✓ expect(4).toBe(4)"),
        phase < 2
          ? bad("expected 5, received 4")
          : phase < 4
            ? warn("editing assertion")
            : dim("12 ms"),
      ];
    },
  },
  {
    group: "Combinations",
    name: "Deploy pulse train",
    note: "a traveling pulse carries state across fixed pipeline nodes",
    render(time) {
      const active = Math.floor(time * 2) % 7;
      const node = (index: number, label: string) =>
        active > index * 2
          ? good(`● ${label}`)
          : active === index * 2
            ? accent(`◉ ${label}`)
            : dim(`○ ${label}`);
      return [
        `${node(0, "build")} ─ ${node(1, "test")} ─ ${node(2, "ship")}`,
        active >= 6
          ? good("production healthy")
          : dim("pulse advances only on acknowledgement"),
      ];
    },
  },
];

const compose = (
  demo: Demo,
  index: number,
  time: number,
  paused: boolean,
  autoplay: boolean,
  columns: number,
  rows: number
) => {
  const width = Math.max(1, Math.min(WIDTH, columns - 4));
  if (columns < 48 || rows < 12)
    return [
      fit("Terminal Micro Lab", columns),
      fit("Resize to at least 48x12.", columns),
    ].join("\n");
  const content = demo.render(time).flatMap((line) => line.split("\n"));
  const lines = [
    fit(
      `${bold("TERMINAL MICRO LAB")}  ${muted(`${index + 1}/${DEMOS.length}`)}`,
      width
    ),
    dim("─".repeat(width)),
    fit(`${accent(demo.group)}  ${bold(demo.name)}`, width),
    fit(dim(demo.note), width),
    "",
    ...content.map((line) => center(line, width)),
  ];
  while (lines.length < rows - 3) lines.push("");
  lines.push(dim("─".repeat(width)));
  lines.push(
    fit(
      `${muted("←/→")} demo  ${muted("↑/↓")} group  ${muted("space")} pause  ${muted("a")} autoplay  ${muted("q")} quit`,
      width
    )
  );
  lines.push(
    fit(
      `${paused ? warn("PAUSED") : autoplay ? good("AUTOPLAY") : muted("MANUAL")}  ${dim("synchronized output · fixed anchors · ANSI only")}`,
      width
    )
  );
  return lines
    .slice(0, rows)
    .map((line) => "  " + fit(line, width))
    .join("\n");
};

const GROUP_STARTS = DEMOS.map((demo, index) =>
  index === 0 || demo.group !== DEMOS[index - 1]!.group ? index : -1
).filter((index) => index >= 0);

const list = () => {
  console.log(`Terminal Micro Lab — ${DEMOS.length} demos\n`);
  let group = "";
  for (const demo of DEMOS) {
    if (demo.group !== group) console.log(`${group ? "\n" : ""}${demo.group}`);
    group = demo.group;
    console.log(`  ${demo.name.padEnd(26)} ${demo.note}`);
  }
};

const check = () => {
  assert.equal(
    new Set(DEMOS.map(({ name }) => name)).size,
    DEMOS.length,
    "demo names must be unique"
  );
  for (const demo of DEMOS) {
    const frames = [0.17, 0.83, 1.61, 2.47].map((time) =>
      demo
        .render(time)
        .flatMap((line) => line.split("\n"))
        .join("\n")
    );
    assert.ok(new Set(frames).size > 1, `${demo.name} must animate`);
    for (const frame of frames)
      for (const line of frame.split("\n"))
        assert.ok(
          widthOf(line) <= WIDTH,
          `${demo.name} exceeds ${WIDTH} cells`
        );
  }
  const button = DEMOS.find(({ name }) => name === "Button ripple")!;
  assert.equal(
    new Set(button.render(0).map(widthOf)).size,
    1,
    "button ripple rows must stay aligned"
  );
  const previews = DEMOS.map((demo) => plain(demo.render(1.61).join("\n")));
  assert.equal(
    new Set(previews).size,
    previews.length,
    "demo previews must be distinct"
  );
  for (const [columns, rows] of [
    [48, 12],
    [80, 24],
    [120, 40],
  ] as const) {
    const frame = compose(DEMOS[0]!, 0, 1, false, true, columns, rows).split(
      "\n"
    );
    assert.equal(frame.length, rows);
    assert.ok(frame.every((line) => widthOf(line) <= columns));
  }
  console.log(`Checked ${DEMOS.length} distinct animated micro UI demos.`);
};

if (process.argv.includes("--check")) check();
else if (
  process.argv.includes("--list") ||
  !process.stdout.isTTY ||
  !process.stdin.isTTY
)
  list();
else {
  const input = process.stdin;
  const output = process.stdout;
  let index = 0;
  let started = performance.now();
  let frozen = 0;
  let paused = false;
  let autoplay = true;
  let stopped = false;
  const elapsed = () =>
    paused ? frozen : (performance.now() - started) / 1000;
  const select = (next: number) => {
    index = (next + DEMOS.length) % DEMOS.length;
    started = performance.now();
    frozen = 0;
  };
  const draw = () => {
    if (stopped) return;
    if (autoplay && !paused && elapsed() > 7) select(index + 1);
    const frame = compose(
      DEMOS[index]!,
      index,
      elapsed(),
      paused,
      autoplay,
      output.columns ?? 80,
      output.rows ?? 24
    );
    output.write(`${CSI}?2026h${CSI}H${frame}${CSI}J${CSI}?2026l`);
  };
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    input.off("data", onInput);
    input.setRawMode(false);
    input.pause();
    output.write(`${RESET}${CSI}?7h${CSI}?25h${CSI}?1049l`);
  };
  const jumpGroup = (offset: number) => {
    const current = GROUP_STARTS.findLastIndex((start) => start <= index);
    select(
      GROUP_STARTS[
        (current + offset + GROUP_STARTS.length) % GROUP_STARTS.length
      ]!
    );
  };
  const onInput = (chunk: Buffer) => {
    const key = chunk.toString();
    if (["q", "\x03", "\x1b"].includes(key)) cleanup();
    else if (["\x1b[C", "l", "n"].includes(key)) select(index + 1);
    else if (["\x1b[D", "h", "p"].includes(key)) select(index - 1);
    else if (["\x1b[A", "k"].includes(key)) jumpGroup(-1);
    else if (["\x1b[B", "j"].includes(key)) jumpGroup(1);
    else if (key === "a") autoplay = !autoplay;
    else if (key === " ") {
      if (paused) started = performance.now() - frozen * 1000;
      else frozen = elapsed();
      paused = !paused;
    }
    draw();
  };
  input.setRawMode(true);
  input.resume();
  input.on("data", onInput);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  output.write(`${CSI}?1049h${CSI}?25l${CSI}?7l`);
  const timer = setInterval(draw, 1000 / FPS);
  draw();
}
