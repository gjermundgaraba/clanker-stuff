// Standalone synthesis of the Pi extension animation research pass.
// It is an explicit terminal takeover; terminal-specific graphics stay as labeled
// cell fallbacks. Optional OSC and completion attention require explicit flags.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ESC = "\x1b";
const CSI = `${ESC}[`;
const RESET = `${CSI}0m`;
const DEFAULT_SECONDS = 60;
const DEFAULT_FPS = 20;
const MIN_COLUMNS = 54;
const MIN_ROWS = 24;
const USE_COLOR =
  !("NO_COLOR" in process.env) &&
  Boolean(process.stdout.isTTY) &&
  process.env.TERM !== "dumb";
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;
const EIGHTH_SCANNER = [
  "▏",
  ...Array.from({ length: 6 }, (_, index) =>
    String.fromCodePoint(0x1_fb70 + index)
  ),
  "▕",
] as const;
const OCTANTS = [
  ..." 𜺨𜺫🮂𜴀▘𜴁𜴂𜴃𜴄▝𜴅𜴆𜴇𜴈▀𜴉𜴊𜴋𜴌🯦𜴍𜴎𜴏𜴐𜴑𜴒𜴓𜴔𜴕𜴖𜴗𜴘𜴙𜴚𜴛𜴜𜴝𜴞𜴟🯧𜴠𜴡𜴢𜴣𜴤𜴥𜴦𜴧𜴨𜴩𜴪𜴫𜴬𜴭𜴮𜴯𜴰𜴱𜴲𜴳𜴴𜴵🮅𜺣𜴶𜴷𜴸𜴹𜴺𜴻𜴼𜴽𜴾𜴿𜵀𜵁𜵂𜵃𜵄▖𜵅𜵆𜵇𜵈▌𜵉𜵊𜵋𜵌▞𜵍𜵎𜵏𜵐▛𜵑𜵒𜵓𜵔𜵕𜵖𜵗𜵘𜵙𜵚𜵛𜵜𜵝𜵞𜵟𜵠𜵡𜵢𜵣𜵤𜵥𜵦𜵧𜵨𜵩𜵪𜵫𜵬𜵭𜵮𜵯𜵰𜺠𜵱𜵲𜵳𜵴𜵵𜵶𜵷𜵸𜵹𜵺𜵻𜵼𜵽𜵾𜵿𜶀𜶁𜶂𜶃𜶄𜶅𜶆𜶇𜶈𜶉𜶊𜶋𜶌𜶍𜶎𜶏▗𜶐𜶑𜶒𜶓▚𜶔𜶕𜶖𜶗▐𜶘𜶙𜶚𜶛▜𜶜𜶝𜶞𜶟𜶠𜶡𜶢𜶣𜶤𜶥𜶦𜶧𜶨𜶩𜶪𜶫▂𜶬𜶭𜶮𜶯𜶰𜶱𜶲𜶳𜶴𜶵𜶶𜶷𜶸𜶹𜶺𜶻𜶼𜶽𜶾𜶿𜷀𜷁𜷂𜷃𜷄𜷅𜷆𜷇𜷈𜷉𜷊𜷋𜷌𜷍𜷎𜷏𜷐𜷑𜷒𜷓𜷔𜷕𜷖𜷗𜷘𜷙𜷚▄𜷛𜷜𜷝𜷞▙𜷟𜷠𜷡𜷢▟𜷣▆𜷤𜷥█",
] as const;

type Motion = "full" | "reduced" | "off";
type Color = readonly [number, number, number];
type Act = {
  name: string;
  includes: string;
  render: (
    time: number,
    width: number,
    height: number,
    motion: Motion
  ) => string[];
};

const rgb = ([r, g, b]: Color, text: string) =>
  USE_COLOR ? `${CSI}38;2;${r};${g};${b}m${text}${RESET}` : text;
const bg = ([r, g, b]: Color, text: string) =>
  USE_COLOR ? `${CSI}48;2;${r};${g};${b}m${text}${RESET}` : text;
const dim = (text: string) => (USE_COLOR ? `${CSI}2m${text}${RESET}` : text);
const bold = (text: string) => (USE_COLOR ? `${CSI}1m${text}${RESET}` : text);
const cyan = (text: string) => rgb([94, 218, 255], text);
const green = (text: string) => rgb([118, 226, 166], text);
const gold = (text: string) => rgb([247, 194, 95], text);
const violet = (text: string) => rgb([192, 139, 255], text);
const clamp = (value: number, low = 0, high = 1) =>
  Math.max(low, Math.min(high, value));
const mix = (a: number, b: number, amount: number) => a + (b - a) * amount;
const ease = (value: number) => 1 - (1 - clamp(value)) ** 3;
const strip = (text: string) => text.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const fit = (text: string, width: number) => {
  const truncated = truncateToWidth(text, Math.max(1, width), "");
  const clipped = USE_COLOR ? truncated : strip(truncated);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};
const center = (text: string, width: number) =>
  fit(
    " ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2))) +
      text,
    width
  );
const progress = (value: number, width: number, textureOffset = 0) => {
  const count = Math.round(clamp(value) * width);
  const fill = Array.from({ length: count }, (_, index) =>
    (index + textureOffset) % 4 < 2 ? "━" : "╸"
  ).join("");
  return green(fill) + dim("─".repeat(width - count));
};
const solidSextant = (mask: number) => {
  if (mask === 0) return " ";
  if (mask === 21) return "▌";
  if (mask === 42) return "▐";
  if (mask === 63) return "█";
  return String.fromCodePoint(
    0x1_fb00 + mask - 1 - Number(mask > 21) - Number(mask > 42)
  );
};
const separatedSextant = (mask: number) =>
  mask === 0 ? " " : String.fromCodePoint(0x1_ce50 + mask);
const braille = (mask: number) => String.fromCodePoint(0x2800 + mask);

const lifecycleAct = (
  time: number,
  width: number,
  _height: number,
  motion: Motion
) => {
  const animated = motion === "full";
  const t = animated ? Math.min(time, 5.2) : 4.8;
  const rows = ["read files", "apply diff", "run tests"];
  const state = (index: number) => {
    const local = t - 0.45 - index * 0.02;
    if (local < 0) return dim("○");
    if (local < 1.2) return cyan("◐");
    return green("✓");
  };
  const estimateKnown = t >= 1.3;
  const value = estimateKnown ? clamp((t - 1.3) / 3) : 0;
  const railWidth = Math.min(30, width - 24);
  const [from, target, transitionAt] =
    t < 2.6 ? [0, 1, 0.4] : t < 4 ? [1, 12, 2.6] : [12, 22, 4];
  const leading = animated
    ? Math.round(mix(from, target, ease((t - transitionAt) / 0.55)))
    : 22;
  const trailing = animated
    ? Math.round(mix(from, target, ease((t - transitionAt - 0.16) / 0.55)))
    : 22;
  const left = Math.min(leading, trailing);
  const right = Math.max(leading, trailing) + 5;
  const rail = Array.from({ length: railWidth }, (_, index) =>
    index >= left && index <= Math.min(railWidth - 1, right) ? "━" : "─"
  ).join("");
  const wash = animated ? Math.floor(t * 14) % Math.max(1, width - 18) : width;
  const material = [..."src/panel.ts   +12 −3   saved"]
    .map((character, index) =>
      Math.abs(index - wash) <= 2 ? bg([41, 83, 102], character) : character
    )
    .join("");
  const oldEcho = t < 0.06 ? " timeout=30" : t < 0.18 ? dim(" timeout=30") : "";
  return [
    `${bold("OUTCOME-FIRST AFTERGLOW")}  timeout=${green("12")}${oldEcho}`,
    dim(
      "semantic correction is immediate; the previous token trails for 180 ms"
    ),
    "",
    `${bold("SHARED ANCHOR")}          ${rows.map((row, index) => `${state(index)} ${row}`).join("   ")}`,
    dim(
      "the same marker cell carries submit → working → result; rows stagger 20 ms"
    ),
    "",
    `${bold("TRUTHFUL PROGRESS")}      [${progress(value, Math.min(28, width - 30), -Math.floor(t * 4))}] ${
      estimateKnown
        ? `${Math.round(value * 100)
            .toString()
            .padStart(3)}%`
        : "estimating · 1.2s"
    }`,
    dim(
      "the exact boundary stays fixed while only the interior texture counterflows"
    ),
    "",
    `${bold("ELASTIC FOCUS")}          ${dim("commands  ")} ${cyan(rail)}`,
    `${dim("                         open       edit       test       ship")}`,
    "",
    `${bold("MATERIAL CELLS")}         ${material}`,
    dim("one wash crosses component-owned cells; no unrelated particles"),
  ];
};

const sampleColor = (x: number, y: number, time: number): Color => {
  const wave = Math.sin(x * 0.31 + time) + Math.cos(y * 0.53 - time * 0.7);
  return [
    Math.round(125 + 105 * Math.sin(wave + time * 0.3)),
    Math.round(125 + 105 * Math.sin(wave + 2.1)),
    Math.round(125 + 105 * Math.sin(wave + 4.2)),
  ];
};
const mean = (
  samples: readonly Color[],
  mask: number,
  selected: boolean
): Color => {
  let count = 0;
  const sum = [0, 0, 0];
  for (let index = 0; index < 8; index++) {
    if (Boolean(mask & (1 << index)) !== selected) continue;
    const color = samples[index]!;
    sum[0] += color[0];
    sum[1] += color[1];
    sum[2] += color[2];
    count += 1;
  }
  if (count === 0) return mean(samples, mask, !selected);
  return sum.map((value) => Math.round(value / count)) as [
    number,
    number,
    number,
  ];
};
const distance = (a: Color, b: Color) =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const octantHistory = new Map<number, number>();
const fitOctant = (samples: readonly Color[], key: number) => {
  let bestMask = 0;
  let bestError = Number.POSITIVE_INFINITY;
  let foreground: Color = samples[0]!;
  let background: Color = samples[0]!;
  const previous = octantHistory.get(key);
  for (let mask = 0; mask < 128; mask++) {
    const fg = mean(samples, mask, true);
    const bgColor = mean(samples, mask, false);
    let error = 0;
    for (let index = 0; index < 8; index++)
      error += distance(samples[index]!, mask & (1 << index) ? fg : bgColor);
    if (
      error < bestError - 0.001 ||
      (Math.abs(error - bestError) <= 0.001 && mask === previous)
    ) {
      bestMask = mask;
      bestError = error;
      foreground = fg;
      background = bgColor;
    }
  }
  octantHistory.set(key, bestMask);
  const glyph = OCTANTS[bestMask] ?? " ";
  return USE_COLOR
    ? `${CSI}38;2;${foreground.join(";")};48;2;${background.join(";")}m${glyph}${RESET}`
    : glyph;
};
const octantPanel = (width: number, time: number) => {
  const columns = Math.min(32, width);
  return Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: columns }, (_, column) => {
      const samples: Color[] = [];
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 2; sx++)
          samples.push(sampleColor(column * 2 + sx, row * 4 + sy, time));
      return fitOctant(samples, row * columns + column);
    }).join("")
  );
};
const sdfPanel = (width: number, time: number) => {
  const columns = Math.min(32, width);
  return Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: columns }, (_, column) => {
      let mask = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const x = (column * 2 + sx) / (columns * 2) - 0.5;
          const y = (row * 4 + sy) / 12 - 0.5;
          const radius = 0.25 + 0.04 * Math.sin(time * 2);
          if (Math.abs(Math.hypot(x * 1.6, y) - radius) < 0.045)
            mask |= 1 << (sy * 2 + sx);
        }
      }
      return cyan(OCTANTS[mask] ?? " ");
    }).join("")
  );
};
const glyphAct = (
  time: number,
  width: number,
  _height: number,
  motion: Motion
) => {
  const t = motion === "full" ? time : 1.75;
  const orbit = [0, 1, 2, 3, 7, 11, 15, 14, 13, 12, 8, 4];
  const cell = String.fromCodePoint(
    0x1_ce90 + orbit[Math.floor(t * 9) % orbit.length]!
  );
  const fallbackMasks = [1, 8, 16, 128, 64, 4, 2, 1];
  const fallback = braille(
    fallbackMasks[Math.floor(t * 8) % fallbackMasks.length]!
  );
  const masks = [1, 3, 11, 27, 59, 63, 54, 36, 4];
  const rackMask = masks[Math.floor(t * 5) % masks.length]!;
  const separated = Math.floor(t * 3) % 2 === 1;
  const rackGlyph = separated
    ? separatedSextant(rackMask)
    : solidSextant(rackMask);
  const scanner = EIGHTH_SCANNER[Math.floor(t * 8) % EIGHTH_SCANNER.length];
  const dither = Array.from({ length: Math.min(34, width) }, (_, x) =>
    (BAYER[1]![x % 4] ?? 0) < 8 + 6 * Math.sin((x - t * 4) * 0.18) ? "▓" : "░"
  ).join("");
  const octants = octantPanel(width, t);
  const sdf = sdfPanel(width, t);
  return [
    `${bold("ONE CELL · 4×4")}   Ghostty sprite ${cyan(cell)}   Braille fallback ${cyan(fallback)}`,
    dim("U+1CE90…1CE9F is row-major; both representations keep one cell fixed"),
    "",
    `${bold("FOCUS RACK")}       mask ${String(rackMask).padStart(2)}   ${separated ? violet(rackGlyph) : cyan(rackGlyph)}   ${separated ? "separated" : "solid"}`,
    dim(
      "one position morphs material while its binary sextant mask stays fixed"
    ),
    "",
    `${bold("EXACT 2-COLOR OCTANT FIT")}  128 mask/complement partitions + history tie-break`,
    ...octants.map((line) => `  ${line}`),
    "",
    `${bold("ANALYTIC SDF → OCTANTS")}    sampled directly on each 2×4 lattice`,
    ...sdf.map((line) => `  ${line}`),
    "",
    `${bold("SCREEN-STABLE DITHER")} ${gold(dither)}  head ${cyan(scanner ?? "█")}`,
    dim(
      "Bayer phase is anchored to cell coordinates; the scan head advances by eighths"
    ),
  ];
};

const card = (
  title: string,
  boundary: string,
  visual: string,
  width: number
) => {
  const label = ` ${title} `;
  const line = `┌${label}${"─".repeat(Math.max(0, width - label.length - 2))}┐`;
  return [
    dim(line),
    `│${fit(` ${visual}`, width - 2)}│`,
    `│${fit(` ${dim(boundary)}`, width - 2)}│`,
    dim(`└${"─".repeat(width - 2)}┘`),
  ];
};
let pointerX = 0.52;
let pointerY = 0.48;
const wowAct = (
  time: number,
  width: number,
  height: number,
  motion: Motion
) => {
  const t = motion === "full" ? time : 2.2;
  const gap = 2;
  const cardWidth = Math.max(24, Math.floor((width - gap) / 2));
  const atlas = ["▖", "▘", "▝", "▗"][Math.floor(t * 4) % 4];
  const cursors = Array.from({ length: 18 }, (_, index) =>
    index % 6 === Math.floor(t * 3) % 6 ? "█" : "·"
  ).join("");
  const darkTheme = Math.floor(t / 1.5) % 2 === 0;
  const px = Math.round(pointerX * 12);
  const py = Math.round(pointerY * 2);
  const pointerGrid = Array.from({ length: 3 }, (_, y) =>
    Array.from({ length: 13 }, (_, x) =>
      x === px && y === py ? "◎" : "·"
    ).join("")
  ).join("/");
  const conveyor = "alpha beta gamma delta"
    .slice(Math.floor(t * 3) % 10)
    .padEnd(22);
  const cards = [
    card(
      "KITTY PLACEHOLDER ATLAS",
      "cell fallback · no Kitty graphics APC emitted",
      `${cyan(atlas ?? "◆")}  upload-once atlas movement`,
      cardWidth
    ),
    card(
      "HARDWARE CURSORS",
      "cell fallback · multiple-cursor protocol not queried",
      cyan(cursors),
      cardWidth
    ),
    card(
      "THEME REACTIVE",
      "simulated theme event · no DEC 2031 / OSC 5",
      darkTheme
        ? bg([25, 30, 45], " DARK  cyan → violet ")
        : bg([224, 228, 237], " LIGHT blue → plum "),
      cardWidth
    ),
    card(
      "PIXEL INTERACTION",
      "arrow-key fallback · mouse mode 1016 stays disabled",
      cyan(pointerGrid),
      cardWidth
    ),
    card(
      "RECTANGULAR EFFECTS",
      "owned cell buffer · no DECCARA / DECSLRM emitted",
      gold(conveyor),
      cardWidth
    ),
    card(
      "SECONDARY PATHS",
      "capability-only: iTerm GIF/fireworks and SIXEL P2=1",
      `${violet("✦")} visible cell fallback always remains`,
      cardWidth
    ),
  ];
  const lines: string[] = [];
  for (let index = 0; index < cards.length; index += 2) {
    const left = cards[index]!;
    const right = cards[index + 1]!;
    for (let row = 0; row < 4; row++)
      lines.push(`${left[row]}${" ".repeat(gap)}${right[row]}`);
    if (index < cards.length - 2) lines.push("");
  }
  if (height > 22)
    lines.push(
      "",
      dim(
        "Every path is visually demonstrated without claiming negotiated terminal support."
      )
    );
  return lines;
};

const oscString = (value: string) => {
  const bytes = Buffer.from(`${value}\0`);
  const padding = Buffer.alloc((4 - (bytes.length % 4)) % 4);
  return Buffer.concat([bytes, padding]);
};
const oscPacket = (address: string, values: readonly number[]) =>
  Buffer.concat([
    oscString(address),
    oscString("," + "i".repeat(values.length)),
    ...values.map((value) => {
      const buffer = Buffer.alloc(4);
      buffer.writeInt32BE(value);
      return buffer;
    }),
  ]);
const retainedAct = (
  time: number,
  width: number,
  _height: number,
  motion: Motion
) => {
  const t = motion === "full" ? time : 4.6;
  const step = Math.min(3, Math.floor(t / 1.3));
  const files = [
    ["M", "panel.ts", "+12 −3"],
    ["A", "motion.ts", "+48"],
    ["M", "timer.ts", "+4 −1"],
  ] as const;
  const silkWidth = Math.min(42, width - 18);
  const silk = Array.from({ length: 2 }, (_, row) =>
    Array.from({ length: silkWidth }, (_, x) => {
      const rowWave =
        Math.sin(x * 0.38 + t * 2.2 + row * 0.9) +
        Math.sin(t * 0.7 - row * 1.2) * 0.45;
      return rowWave > 0.45 ? "▓" : rowWave > -0.2 ? "▒" : "░";
    }).join("")
  );
  const event =
    step < 2
      ? "/pi/agent/start"
      : step === 2
        ? "/pi/tool/end 1"
        : "/pi/agent/settled 4200";
  const packet = oscPacket(
    event.split(" ")[0]!,
    event.includes(" ") ? [Number(event.split(" ")[1])] : []
  );
  const attention =
    step === 3 ? green("✓ complete  visible result") : cyan("◐ working  4.2s");
  const picker = ["text/plain", "image/png", "text/uri-list"]
    .map((type, index) =>
      index === step % 3 ? cyan(`▶ ${type}`) : dim(`  ${type}`)
    )
    .join("   ");
  return [
    `${bold("SEMANTIC GIT CODA")}   ${dim("demo session data · opt-in completion command")}`,
    ...files.map(([mark, file, delta], index) =>
      index <= step
        ? `  ${green(mark)} ${file.padEnd(16)} ${gold(delta)}`
        : dim(`  · ${file.padEnd(16)} queued`)
    ),
    "",
    `${bold("ORIGINAL SCANLINE SILK")}`,
    ...silk.map((line) => `  ${violet(line)}`),
    dim(
      "cell-color fallback: per-row phase is independent; indexed palette is untouched"
    ),
    "",
    `${bold("CONTENT-FREE PI → OSC")}   ${cyan(event.padEnd(28))} ${packet.length} bytes`,
    dim("OSC 1.0 over fire-and-forget UDP · --osc-port N targets 127.0.0.1"),
    "",
    `${bold("COMPLETION ATTENTION")}    ${attention}`,
    dim(
      "BEL stays off unless --attention; the visible settled state is authoritative"
    ),
    "",
    `${bold("GUI-GRADE DRAG + DROP")}   ${picker}`,
    dim("owned picker fallback · OSC 72 is not enabled or advertised"),
  ];
};

const nyanAct = (
  time: number,
  width: number,
  _height: number,
  motion: Motion
) => {
  const t = motion === "full" ? time : 1.4;
  const phase = Math.floor(t * 8);
  const trailWidth = Math.max(12, Math.min(34, width - 30));
  const rainbow: Color[] = [
    [255, 84, 94],
    [255, 159, 67],
    [255, 220, 92],
    [80, 220, 130],
    [72, 166, 255],
    [179, 111, 255],
  ];
  const cat = [
    [" ", "╭──────────╮", ""],
    [" ", "│ ·  ·  ·  │", "/\\_/\\ "],
    [phase % 2 ? "~" : "≈", "│  ·  ·  · │", "( ^ .^)"],
    [" ", "│ ·  ·  ·  │", '  "   "'],
    [" ", "╰──────────╯", ""],
    [" ", "", phase % 2 ? " ╱╲  ╱╲" : "╱╲    ╱╲"],
  ] as const;
  const stars = (seed: number) =>
    Array.from({ length: Math.min(width, 72) }, (_, index) => {
      const point = (index * 17 + seed * 11 - phase) % 47;
      return point === 0 ? "✦" : point === 19 ? "·" : " ";
    }).join("");
  const art = cat.map(([tail, pastry, head], row) => {
    const wave = (row + phase) % 3 === 0 ? 1 : 0;
    const trail = " ".repeat(wave) + "━".repeat(trailWidth - wave);
    const pastryArt = USE_COLOR
      ? `${CSI}38;2;242;202;151;48;2;244;175;213m${pastry}${RESET}`
      : pastry;
    return `${rgb(rainbow[row]!, trail)}${rgb([194, 202, 218], tail)}${pastryArt}${rgb([194, 202, 218], head)}`;
  });
  return [
    `${bold("NYAN CAT · TERMINAL ORBIT")}  ${dim("Pop-Tart torso · attached gray cat")}`,
    dim("rainbow and stars scroll; tail and four paws alternate in two poses"),
    "",
    cyan(stars(0)),
    ...(phase % 2 ? [""] : []),
    ...art,
    ...(phase % 2 ? [] : [""]),
    cyan(stars(1)),
    "",
    center(gold("♪ nyan · nyan · nyan · nyan ♪"), width),
  ];
};

const finaleAct = (
  time: number,
  width: number,
  height: number,
  motion: Motion
) => {
  const t = motion === "full" ? Math.min(time, 8.6) : 8.6;
  const value = clamp(t / 5.5);
  const title = "Pi applies meaning first";
  const waveWidth = Math.min(46, width - 8);
  const wave = Array.from({ length: waveWidth }, (_, index) => {
    const level = Math.sin(index * 0.4 - t * 2) * 0.5 + 0.5;
    return level > 0.72 ? "█" : level > 0.44 ? "▓" : level > 0.2 ? "▒" : "░";
  }).join("");
  const checklist = [
    "real state never waits for motion",
    "fixed anchors and component-owned cells",
    "full · reduced · off",
    "cell fallback before terminal protocols",
    "one absolute clock; obsolete frames skipped",
  ];
  return [
    "",
    center(violet("╭──────────────────────────────────────────────╮"), width),
    center(violet(`│  ${title.padEnd(42)}│`), width),
    center(violet("╰──────────────────────────────────────────────╯"), width),
    "",
    center(
      `[${progress(value, Math.min(38, width - 12), -Math.floor(t * 3))}] ${Math.round(value * 100)}%`,
      width
    ),
    "",
    center(cyan(wave), width),
    "",
    ...checklist.map((item, index) =>
      center(
        `${index < Math.round(value * checklist.length) ? green("✓") : dim("○")} ${item}`,
        width
      )
    ),
    "",
    center(dim(t >= 8.6 ? "settled · returning to the prompt" : " "), width),
    ...(height > 24
      ? [
          "",
          center(
            dim("A standalone lab, not a second renderer inside Pi."),
            width
          ),
        ]
      : []),
  ];
};

const ACTS: Act[] = [
  {
    name: "Lifecycle motion",
    includes:
      "afterglow · shared anchor · truthful progress · elastic focus · material cells",
    render: lifecycleAct,
  },
  {
    name: "Unicode + subcell alphabets",
    includes:
      "4×4 cell · focus rack · exact octants · SDF vectors · stable dither/eighth scan",
    render: glyphAct,
  },
  {
    name: "Protocol spectacle, safely",
    includes:
      "placeholder atlas · cursor constellation · theme · pixel input · rectangles (+ secondary paths)",
    render: wowAct,
  },
  {
    name: "Semantic coda",
    includes:
      "Git coda · scanline silk · OSC bridge · completion attention · drag and drop",
    render: retainedAct,
  },
  {
    name: "Nyan Cat terminal orbit",
    includes: "six-color rainbow · star parallax · bobbing fixed-cell cat",
    render: nyanAct,
  },
  {
    name: "Product-motion finale",
    includes: "truth-first synthesis and motion contract",
    render: finaleAct,
  },
];

const stageSections = (lines: string[], time: number, motion: Motion) => {
  if (motion !== "full") return lines;
  let section = 0;
  return lines.map((line) => {
    const visible = time >= section * 0.65;
    if (strip(line).trim() === "") section += 1;
    return visible ? line : "";
  });
};

const compose = (
  act: Act,
  index: number,
  time: number,
  motion: Motion,
  columns: number,
  rows: number
) => {
  const width = Math.min(100, Math.max(MIN_COLUMNS, columns));
  const height = Math.min(32, Math.max(MIN_ROWS, rows));
  const inner = width - 4;
  const bodyHeight = height - 6;
  const rendered = act.render(time, inner, bodyHeight, motion);
  const body = (
    index >= ACTS.length - 2 ? rendered : stageSections(rendered, time, motion)
  ).slice(0, bodyHeight);
  while (body.length < bodyHeight) body.push("");
  const mode =
    motion === "full"
      ? cyan("FULL")
      : motion === "reduced"
        ? gold("REDUCED")
        : dim("OFF");
  const header = ` PI ANIMATION LAB  ${String(index + 1).padStart(2, "0")}/${ACTS.length} `;
  const top = `╭${header}${"─".repeat(Math.max(0, width - header.length - 2))}╮`;
  const lines = [
    top,
    `│ ${fit(`${bold(act.name)}  ${dim(act.includes)}`, inner)} │`,
    `├${"─".repeat(width - 2)}┤`,
    ...body.map((line) => `│ ${fit(line, inner)} │`),
    `├${"─".repeat(width - 2)}┤`,
    `│ ${fit(`${mode}  ${dim(`[/] pin acts · 1–${ACTS.length} jump · arrows move pixel card · q/Esc exits`)}`, inner)} │`,
    `╰${"─".repeat(width - 2)}╯`,
  ];
  return lines.join("\n");
};

const valueAfter = (flag: string, fallback: number) => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${flag} must be a positive number`);
  return value;
};
const portAfter = () => {
  const index = process.argv.indexOf("--osc-port");
  if (index < 0) return undefined;
  const port = Number(process.argv[index + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("--osc-port must be an integer from 1 to 65535");
  return port;
};
const osPrefersReducedMotion = () => {
  try {
    if (process.platform === "darwin")
      return (
        execFileSync(
          "defaults",
          ["read", "com.apple.universalaccess", "reduceMotion"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        ).trim() === "1"
      );
    if (process.platform === "linux")
      return (
        execFileSync(
          "gsettings",
          ["get", "org.gnome.desktop.interface", "enable-animations"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        ).trim() === "false"
      );
  } catch {
    // A desktop preference API is best effort; the explicit flag remains exact.
  }
  return false;
};
const motionAfter = (): Motion => {
  const index = process.argv.indexOf("--motion");
  if (index >= 0) {
    const value = process.argv[index + 1];
    if (value !== "full" && value !== "reduced" && value !== "off")
      throw new Error("--motion must be full, reduced, or off");
    return value;
  }
  if (process.env.TERM === "dumb") return "off";
  return osPrefersReducedMotion() ? "reduced" : "full";
};
const list = () => {
  for (const [index, act] of ACTS.entries()) {
    console.log(`${index + 1}. ${act.name}`);
    console.log(`   ${act.includes}`);
  }
};

const check = () => {
  assert.equal(ACTS.length, 6);
  assert.equal(new Set(ACTS.map(({ name }) => name)).size, ACTS.length);
  assert.equal(OCTANTS.length, 256);
  assert.equal(solidSextant(63), "█");
  assert.equal(separatedSextant(1).codePointAt(0), 0x1_ce51);
  assert.equal(String.fromCodePoint(0x1_ce90).codePointAt(0), 0x1_ce90);
  const samples = Array.from(
    { length: 8 },
    (_, index) => (index < 4 ? [255, 0, 0] : [0, 0, 255]) as Color
  );
  const fitted = fitOctant(samples, 999);
  if (USE_COLOR) assert.match(fitted, /\x1b\[38;2;/);
  else assert.equal(visibleWidth(fitted), 1);
  const uniform = fitOctant(Array<Color>(8).fill([42, 42, 42]), 1000);
  assert.equal(visibleWidth(uniform), 1);
  if (USE_COLOR) assert.match(uniform, /48;2;42;42;42m/);
  assert.ok(oscPacket("/pi/tool/end", [1]).length % 4 === 0);
  const settled = oscPacket("/pi/agent/settled", [4200]);
  assert.equal(settled.readInt32BE(settled.length - 4), 4200);
  for (const motion of ["full", "reduced", "off"] as const) {
    for (const [index, act] of ACTS.entries()) {
      const first = compose(act, index, 0.23, motion, 80, 24);
      const second = compose(act, index, 2.71, motion, 80, 24);
      assert.equal(first.split("\n").length, 24);
      assert.ok(first.split("\n").every((line) => visibleWidth(line) <= 80));
      assert.ok(strip(first).includes(act.name));
      if (motion !== "full") assert.equal(first, second);
    }
  }
  assert.equal(
    compose(ACTS[0]!, 0, 5.2, "full", 80, 24),
    compose(ACTS[0]!, 0, 99, "full", 80, 24)
  );
  const finaleIndex = ACTS.length - 1;
  assert.equal(
    compose(ACTS[finaleIndex]!, finaleIndex, 8.6, "full", 80, 24),
    compose(ACTS[finaleIndex]!, finaleIndex, 99, "full", 80, 24)
  );
  assert.ok(strip(nyanAct(1, 80, 24, "full").join("\n")).includes("/\\_/\\"));
  for (const forbidden of [
    `${ESC}_G`,
    `${ESC}[?1016`,
    `${ESC}]5;`,
    `${ESC}]72;`,
  ])
    assert.ok(
      !ACTS.map((act) => act.render(1, 80, 24, "full").join(""))
        .join("")
        .includes(forbidden)
    );
  console.log(
    "Checked 6 acts: lifecycle, subcells, safe fallbacks, semantic coda, Nyan Cat, and finale."
  );
};

const knownFlags = new Set([
  "--list",
  "--check",
  "--seconds",
  "--fps",
  "--motion",
  "--osc-port",
  "--attention",
]);
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index]!;
  if (!argument.startsWith("--"))
    throw new Error(`unexpected argument ${argument}`);
  if (!knownFlags.has(argument)) throw new Error(`unknown option ${argument}`);
  if (["--seconds", "--fps", "--motion", "--osc-port"].includes(argument)) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${argument} requires a value`);
    index += 1;
  }
}

if (process.argv.includes("--check")) check();
else if (process.argv.includes("--list")) list();
else {
  const seconds = valueAfter("--seconds", DEFAULT_SECONDS);
  const fps = valueAfter("--fps", DEFAULT_FPS);
  const motion = motionAfter();
  const oscPort = portAfter();
  const attention = process.argv.includes("--attention");
  if (fps > 60) throw new Error("--fps must be 60 or less");
  const interactive =
    process.stdout.isTTY && process.stdin.isTTY && process.env.TERM !== "dumb";
  const explicitOff = process.argv.includes("--motion") && motion === "off";
  if (!interactive && !explicitOff) {
    list();
    console.log("\nRun in an interactive terminal for the live lab.");
  } else if (motion === "off") {
    console.log("Motion off — no frames scheduled.\n");
    const columns = Math.max(
      MIN_COLUMNS,
      Math.min(100, process.stdout.columns ?? 80)
    );
    const snapshots = ACTS.map((act, index) =>
      compose(act, index, 99, "off", columns, 24)
    ).join("\n\n");
    console.log(USE_COLOR ? snapshots : strip(snapshots));
  } else if (
    (process.stdout.columns ?? 0) < MIN_COLUMNS ||
    (process.stdout.rows ?? 0) < MIN_ROWS
  ) {
    throw new Error(
      `terminal must be at least ${MIN_COLUMNS}×${MIN_ROWS} cells`
    );
  } else {
    const input = process.stdin;
    const output = process.stdout;
    const started = performance.now();
    const actSeconds = seconds / ACTS.length;
    let selectedAt = started;
    let selected: number | undefined;
    let stopped = false;
    let lastFrame = "";
    let lastActivityAt = 0;
    let lastActivityAct = -1;
    let toolEnded = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let oscSocket: Socket | undefined = oscPort
      ? createSocket("udp4")
      : undefined;
    let oscError: Error | undefined;

    const rememberOscError = (error: Error) => {
      oscError ??= error;
    };
    oscSocket?.on("error", rememberOscError);
    const sendOsc = (address: string, values: readonly number[] = []) => {
      if (!oscSocket || !oscPort) return;
      oscSocket.send(
        oscPacket(address, values),
        oscPort,
        "127.0.0.1",
        (error) => {
          if (error) rememberOscError(error);
        }
      );
    };
    const closeOsc = (natural: boolean) => {
      const socket = oscSocket;
      oscSocket = undefined;
      if (!socket || !oscPort) return;
      const close = (error: Error | null = null) => {
        if (error) {
          rememberOscError(error);
          process.stderr.write(`OSC send failed: ${error.message}\n`);
        }
        try {
          socket.close();
        } catch {
          // The socket may already have closed after an asynchronous error.
        }
      };
      if (natural)
        socket.send(
          oscPacket("/pi/agent/settled", [
            Math.round(performance.now() - started),
          ]),
          oscPort,
          "127.0.0.1",
          close
        );
      else close();
    };

    const cleanup = (code = 0, natural = false) => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      input.off("data", onInput);
      process.off("SIGHUP", onSighup);
      process.off("SIGINT", onSigint);
      process.off("SIGQUIT", onSigquit);
      process.off("SIGTERM", onSigterm);
      process.off("SIGWINCH", onResize);
      process.off("uncaughtException", onUncaught);
      if (input.isRaw) input.setRawMode(false);
      input.pause();
      output.write(
        `${CSI}?2026l${RESET}${CSI}?7h${CSI}?25h${CSI}?1049l${natural && attention ? "\x07" : ""}`
      );
      closeOsc(natural);
      if (oscError) process.stderr.write(`OSC disabled: ${oscError.message}\n`);
      process.exitCode = code;
    };
    const draw = () => {
      if (stopped) return;
      const columns = output.columns ?? 0;
      const rows = output.rows ?? 0;
      if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
        cleanup(1);
        process.stderr.write(
          `terminal must remain at least ${MIN_COLUMNS}×${MIN_ROWS} cells\n`
        );
        return;
      }
      const now = performance.now();
      const elapsed = (now - started) / 1000;
      if (selected === undefined && elapsed >= seconds) return cleanup(0, true);
      const index =
        selected ?? Math.min(ACTS.length - 1, Math.floor(elapsed / actSeconds));
      const localTime =
        selected === undefined
          ? elapsed % actSeconds
          : (now - selectedAt) / 1000;
      if (index === 0 && localTime >= 2 && !toolEnded) {
        sendOsc("/pi/tool/end", [1]);
        toolEnded = true;
      }
      if (
        index !== lastActivityAct ||
        (motion === "full" && now - lastActivityAt >= 200)
      ) {
        sendOsc("/pi/stream/activity", [index + 1]);
        lastActivityAt = now;
        lastActivityAct = index;
      }
      const frame = compose(
        ACTS[index]!,
        index,
        localTime,
        motion,
        columns,
        rows
      );
      if (frame === lastFrame) return;
      lastFrame = frame;
      output.write(`${CSI}?2026h${CSI}H${frame}${CSI}J${CSI}?2026l`);
    };
    const currentIndex = () => {
      const elapsed = (performance.now() - started) / 1000;
      return (
        selected ?? Math.min(ACTS.length - 1, Math.floor(elapsed / actSeconds))
      );
    };
    const selectAct = (index: number) => {
      selected = (index + ACTS.length) % ACTS.length;
      selectedAt = performance.now();
      toolEnded = selected !== 0;
      lastFrame = "";
    };
    const moveAct = (offset: number) => selectAct(currentIndex() + offset);
    const onInput = (chunk: Buffer) => {
      const key = chunk.toString();
      if (key === "[") moveAct(-1);
      else if (key === "]") moveAct(1);
      else if (/^[1-9]$/.test(key) && Number(key) <= ACTS.length)
        selectAct(Number(key) - 1);
      else if (currentIndex() === 2 && key === "\x1b[C")
        pointerX = clamp(pointerX + 0.07);
      else if (currentIndex() === 2 && key === "\x1b[D")
        pointerX = clamp(pointerX - 0.07);
      else if (currentIndex() === 2 && key === "\x1b[A")
        pointerY = clamp(pointerY - 0.2);
      else if (currentIndex() === 2 && key === "\x1b[B")
        pointerY = clamp(pointerY + 0.2);
      else if (key === "q" || key === "Q" || key === "\x1b" || key === "\x03")
        return cleanup();
      draw();
    };
    const onSighup = () => cleanup(129);
    const onSigint = () => cleanup(130);
    const onSigquit = () => cleanup(131);
    const onSigterm = () => cleanup(143);
    const onResize = () => {
      lastFrame = "";
      draw();
    };
    const onUncaught = (error: unknown) => {
      cleanup(1);
      console.error(error);
    };

    process.once("SIGHUP", onSighup);
    process.once("SIGINT", onSigint);
    process.once("SIGQUIT", onSigquit);
    process.once("SIGTERM", onSigterm);
    process.on("SIGWINCH", onResize);
    process.once("uncaughtException", onUncaught);
    input.setRawMode(true);
    input.resume();
    input.on("data", onInput);
    output.write(`${CSI}?1049h${CSI}?25l${CSI}?7l${CSI}2J${CSI}H`);
    sendOsc("/pi/agent/start");
    timer = setInterval(
      draw,
      1000 / (motion === "reduced" ? Math.min(4, fps) : fps)
    );
    draw();
  }
}
