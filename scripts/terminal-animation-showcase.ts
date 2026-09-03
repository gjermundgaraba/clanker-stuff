import assert from "node:assert/strict";

const CSI = "\x1b[";
const RESET = `${CSI}0m`;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;
const FPS = 15;
const MIN_WIDTH = 36;
const MIN_HEIGHT = 12;
const SUPPORTS_OSC_PROGRESS = Boolean(
  process.env.WT_SESSION ||
  process.env.KITTY_WINDOW_ID ||
  ["WezTerm", "ghostty"].includes(process.env.TERM_PROGRAM ?? "")
);
const oscProgress = (state: 0 | 1 | 2 | 4, value = 0) =>
  `\x1b]9;4;${state};${value}\x1b\\`;

const style = (code: string, text: string) => `${CSI}${code}m${text}${RESET}`;
const fg = (r: number, g: number, b: number, text: string) =>
  style(`38;2;${r};${g};${b}`, text);
const dim = (text: string) => style("2", text);
const bold = (text: string) => style("1", text);
const accent = (text: string) => fg(121, 192, 255, text);
const success = (text: string) => fg(123, 211, 137, text);
const warning = (text: string) => fg(238, 190, 101, text);
const muted = (text: string) => fg(142, 148, 166, text);
const plain = (text: string) => text.replaceAll(ANSI_PATTERN, "");
const widthOf = (text: string) => [...plain(text)].length;
const fit = (text: string, width: number) => {
  const visible = widthOf(text);
  if (visible > width) return [...plain(text)].slice(0, width).join("");
  return text + " ".repeat(width - visible);
};
const center = (text: string, width: number) => {
  const padding = Math.max(0, Math.floor((width - widthOf(text)) / 2));
  return fit(" ".repeat(padding) + text, width);
};
const hash = (value: number) => {
  const result = Math.sin(value * 12.9898) * 43_758.5453;
  return result - Math.floor(result);
};
const LORENZ_POINTS = (() => {
  const points: [number, number, number][] = [];
  let [x, y, z] = [0.1, 0, 0];
  for (let step = 0; step < 1_800; step++) {
    [x, y, z] = [
      x + 0.006 * 10 * (y - x),
      y + 0.006 * (x * (28 - z) - y),
      z + 0.006 * (x * y - (8 / 3) * z),
    ];
    if (step > 300 && step % 2 === 0) points.push([x, y, z]);
  }
  return points;
})();
const frameAt = (frames: readonly string[], time: number, intervalMs = 100) =>
  frames[Math.floor((time * 1000) / intervalMs) % frames.length] ?? "";
const body = (lines: string[], width: number, height: number) => {
  const visible = lines.slice(0, height).map((line) => fit(line, width));
  const top = Math.max(0, Math.floor((height - visible.length) / 2));
  return [
    ...Array.from({ length: top }, () => " ".repeat(width)),
    ...visible,
    ...Array.from({ length: Math.max(0, height - top - visible.length) }, () =>
      " ".repeat(width)
    ),
  ];
};
const progressBar = (value: number, width: number) => {
  const size = Math.max(4, width);
  const filled = Math.round(Math.max(0, Math.min(1, value)) * size);
  return success("█".repeat(filled)) + dim("░".repeat(size - filled));
};

const CATALOG = [
  [
    "Animation engines",
    [
      [
        "TerminalTextEffects",
        "https://github.com/ChrisBuilds/terminaltexteffects",
      ],
      ["TachyonFX", "https://github.com/ratatui/tachyonfx"],
      ["tui-vfx", "https://github.com/5ocworkshop/tui-vfx"],
      ["Textual", "https://github.com/Textualize/textual"],
      ["OpenTUI", "https://github.com/anomalyco/opentui"],
      ["Ink", "https://github.com/vadimdemedes/ink"],
      ["Bubble Tea", "https://github.com/charmbracelet/bubbletea"],
      ["Ratatui", "https://github.com/ratatui/ratatui"],
      ["FTXUI", "https://github.com/ArthurSonzogni/FTXUI"],
      ["asciimatics", "https://github.com/peterbrittain/asciimatics"],
      ["Ansimax", "https://github.com/Brashkie/ansimax"],
      ["sysc-Go", "https://github.com/Nomadcxx/sysc-Go"],
      ["terminal-kit", "https://github.com/cronvel/terminal-kit"],
      [
        "unicode-animations",
        "https://github.com/gunnargray-dev/unicode-animations",
      ],
      ["agents-are-thinking", "https://github.com/czl9707/agents-are-thinking"],
      ["pi-animations", "https://github.com/arpagon/pi-animations"],
    ],
  ],
  [
    "TUI foundations",
    [
      ["Bubbles", "https://github.com/charmbracelet/bubbles"],
      ["Lip Gloss", "https://github.com/charmbracelet/lipgloss"],
      ["Harmonica", "https://github.com/charmbracelet/harmonica"],
      ["Crossterm", "https://github.com/crossterm-rs/crossterm"],
      ["tui-realm", "https://github.com/veeso/tui-realm"],
      [
        "prompt_toolkit",
        "https://github.com/prompt-toolkit/python-prompt-toolkit",
      ],
      ["Blessed", "https://github.com/jquast/blessed"],
      ["Lanterna", "https://github.com/mabe02/lanterna"],
      ["Pi TUI", "https://github.com/earendil-works/pi"],
      ["blessed (Node)", "https://github.com/chjj/blessed"],
      ["termui", "https://github.com/gizak/termui"],
    ],
  ],
  [
    "Inline and task UI",
    [
      ["cli-spinners", "https://github.com/sindresorhus/cli-spinners"],
      ["Ora", "https://github.com/sindresorhus/ora"],
      ["Listr2", "https://github.com/listr2/listr2"],
      ["Rich", "https://github.com/Textualize/rich"],
      ["alive-progress", "https://github.com/rsalmei/alive-progress"],
      ["indicatif", "https://github.com/console-rs/indicatif"],
      ["PTerm", "https://github.com/pterm/pterm"],
      ["Gum", "https://github.com/charmbracelet/gum"],
      ["Spectre.Console", "https://github.com/spectreconsole/spectre.console"],
      ["@topcli/spinner", "https://github.com/TopCli/Spinner"],
      [
        "bash_loading_animations",
        "https://github.com/Silejonu/bash_loading_animations",
      ],
      ["log-update", "https://github.com/sindresorhus/log-update"],
      ["Chalk", "https://github.com/chalk/chalk"],
      ["nanospinner", "https://github.com/usmanyunusov/nanospinner"],
      ["Go progressbar", "https://github.com/schollz/progressbar"],
      ["Consola", "https://github.com/unjs/consola"],
      ["console-rs", "https://github.com/console-rs/console"],
      ["Glamour", "https://github.com/charmbracelet/glamour"],
      ["Mordant", "https://github.com/ajalt/mordant"],
      ["indicators", "https://github.com/p-ranav/indicators"],
      [
        "throbber-widgets-tui",
        "https://github.com/arkbig/throbber-widgets-tui",
      ],
      ["cli-spinner", "https://github.com/helloIAmPau/node-spinner"],
      ["yocto-spinner", "https://github.com/sindresorhus/yocto-spinner"],
      ["unicode-animatio", "https://github.com/openminion/unicode-animatio"],
      ["unicode-spinner", "https://github.com/tsvillain/unicode-spinner"],
      ["Rattles", "https://github.com/vyfor/rattles"],
    ],
  ],
  [
    "Procedural and classic",
    [
      ["termflix", "https://github.com/paulrobello/termflix"],
      ["ascii-splash", "https://github.com/reowens/ascii-splash"],
      ["tarts", "https://github.com/oiwn/tarts"],
      ["cmatrix", "https://github.com/abishekvashok/cmatrix"],
      ["asciiquarium", "https://github.com/cmatsuoka/asciiquarium"],
      ["pipes.sh", "https://github.com/pipeseroni/pipes.sh"],
      ["cbonsai", "https://gitlab.com/jallbrit/cbonsai"],
      ["nyancat", "https://github.com/klange/nyancat"],
      ["sl", "https://github.com/mtoyoda/sl"],
      ["libcaca demos", "https://github.com/cacalabs/libcaca"],
      [
        "asciiquarium-python",
        "https://github.com/MKAbuMattar/asciiquarium-python",
      ],
      ["pipes-rs", "https://github.com/dnorhoj/pipes-rs"],
      ["parrot.live", "https://github.com/hugomd/parrot.live"],
      ["genact", "https://github.com/svenstaro/genact"],
      ["terminal-parrot", "https://github.com/jmhobbs/terminal-parrot"],
      ["anims", "https://github.com/jbanana/anims"],
      ["CurlParrot_perrito", "https://github.com/Aaron3312/CurlParrot_perrito"],
      ["life-simulator", "https://github.com/changkun/life-simulator"],
      ["AsciiCreativeCoding", "https://github.com/prtamil/AsciiCreativeCoding"],
      ["TermiSand", "https://github.com/BobdaProgrammer/TermiSand"],
    ],
  ],
  [
    "Application references",
    [
      ["lazygit", "https://github.com/jesseduffield/lazygit"],
      ["Posting", "https://github.com/darrenburns/posting"],
      ["Harlequin", "https://github.com/tconbeer/harlequin"],
      ["Glow", "https://github.com/charmbracelet/glow"],
      ["Hollywood", "https://github.com/dustinkirkland/hollywood"],
      ["tty-clock", "https://github.com/xorg62/tty-clock"],
      ["Gemini CLI", "https://github.com/google-gemini/gemini-cli"],
      ["fzf", "https://github.com/junegunn/fzf"],
      ["Windows Terminal", "https://github.com/microsoft/terminal"],
      ["Kitty", "https://github.com/kovidgoyal/kitty"],
    ],
  ],
  [
    "Playback, demos, and references",
    [
      ["theattyr", "https://github.com/orhun/theattyr"],
      ["VHS", "https://github.com/charmbracelet/vhs"],
      ["btop", "https://github.com/aristocratos/btop"],
      ["CAVA", "https://github.com/karlstav/cava"],
      ["Yazi", "https://github.com/sxyazi/yazi"],
      ["MapSCII", "https://github.com/rastapasta/mapscii"],
      ["Termynal.js", "https://github.com/ines/termynal"],
      ["Buddy", "https://github.com/JVSCHANDRADITHYA/buddy"],
      [
        "terminal-animations",
        "https://github.com/jorexdeveloper/terminal-animations",
      ],
      ["ascii-3d-cube", "https://github.com/msadeqsirjani/ascii-3d-cube"],
      ["Curlix (archived)", "https://github.com/AlexGustafsson/curlix"],
      ["tplay", "https://github.com/maxcurzi/tplay"],
      ["video-to-ascii", "https://github.com/joelibaceta/video-to-ascii"],
    ],
  ],
  [
    "Pixel, subcell, and shader rendering",
    [
      ["notcurses", "https://github.com/dankamongmen/notcurses"],
      ["chafa", "https://github.com/hpjansson/chafa"],
      ["timg", "https://github.com/hzeller/timg"],
      ["Ghostty", "https://github.com/ghostty-org/ghostty"],
      ["ghostty-shaders", "https://github.com/0xhckr/ghostty-shaders"],
      ["MinecraftTTY", "https://github.com/raphamorim/minecraftty"],
      ["TerminalRenderer", "https://github.com/DarkOnGithub/TerminalRenderer"],
      [
        "OpenTUI Three",
        "https://github.com/anomalyco/opentui/tree/main/packages/three",
      ],
    ],
  ],
  [
    "Demoscene and motion techniques",
    [
      ["TMDC rules", "https://tmdc.scene.org/index.php?nav=rules"],
      [
        "Textmode demoscene essay",
        "https://viznut.fi/texts-en/demoscene_msdos-textmode.html",
      ],
      ["text-mode.org", "https://text-mode.org/"],
      [
        "Damped springs (Ryan Juckett)",
        "https://www.ryanjuckett.com/damped-springs/",
      ],
      ["awesome-tuis", "https://github.com/rothgar/awesome-tuis"],
    ],
  ],
  [
    "Small and historical references",
    [
      ["chalk-animation", "https://github.com/bokub/chalk-animation"],
      ["gradient-string", "https://github.com/bokub/gradient-string"],
      ["txtanim", "https://pypi.org/project/txtanim/"],
      ["Terani", "https://github.com/Renairisu/terani"],
      ["termination (Go)", "https://github.com/ansoni/termination"],
      ["cli-spinner-lite", "https://www.npmjs.com/package/cli-spinner-lite"],
      ["@basd/spinner", "https://github.com/basedwon/spinner"],
      ["lolcat", "https://github.com/busyloop/lolcat"],
      ["FIGlet", "https://github.com/cmatsuoka/figlet"],
      ["Are We Legacy Computing Yet?", "https://arewelegacycomputingyet.com/"],
      [
        "Unicode Legacy Computing",
        "https://unicode.org/charts/nameslist/n_1FB00.html",
      ],
      [
        "Unicode Legacy Supplement",
        "https://unicode.org/charts/nameslist/n_1CC00.html",
      ],
    ],
  ],
  [
    "Standards and terminal protocols",
    [
      [
        "ECMA-48 control functions",
        "https://ecma-international.org/publications-and-standards/standards/ecma-48/",
      ],
      [
        "ncurses terminfo API",
        "https://invisible-island.net/ncurses/man/curs_terminfo.3x.html",
      ],
      [
        "terminfo capabilities",
        "https://invisible-island.net/ncurses/man/terminfo.5.html",
      ],
      [
        "xterm control sequences",
        "https://invisible-island.net/xterm/ctlseqs/ctlseqs.pdf",
      ],
      ["Unicode grapheme boundaries", "https://www.unicode.org/reports/tr29/"],
      ["Unicode East Asian Width", "https://www.unicode.org/reports/tr11/"],
      ["NO_COLOR", "https://no-color.org/"],
      [
        "Synchronized output",
        "https://github.com/contour-terminal/vt-extensions/blob/master/synchronized-output.md",
      ],
      [
        "Kitty graphics protocol",
        "https://sw.kovidgoyal.net/kitty/graphics-protocol/",
      ],
      [
        "Kitty text sizing protocol",
        "https://sw.kovidgoyal.net/kitty/text-sizing-protocol/",
      ],
      [
        "Kitty styled underlines",
        "https://sw.kovidgoyal.net/kitty/underlines/",
      ],
      [
        "Kitty multiple cursors",
        "https://sw.kovidgoyal.net/kitty/multiple-cursors-protocol/",
      ],
      ["Ghostty pointer shapes", "https://ghostty.org/docs/vt/osc/22"],
      ["Ghostty cursor styles", "https://ghostty.org/docs/vt/csi/decscusr"],
      ["Ghostty scroll regions", "https://ghostty.org/docs/vt/csi/decstbm"],
      ["Ghostty dynamic colors", "https://ghostty.org/docs/vt/osc/1x"],
      [
        "Ghostty configuration reference",
        "https://ghostty.org/docs/config/reference",
      ],
      [
        "Ghostty 1.3 release notes",
        "https://ghostty.org/docs/install/release-notes/1-3-0",
      ],
      [
        "iTerm2 inline images",
        "https://iterm2.com/3.5/documentation-images.html",
      ],
      ["DEC SIXEL", "https://vt100.net/docs/vt3xx-gp/"],
    ],
  ],
] as const;

const EFFECT_GROUPS = [
  [
    "Micro motion",
    "Pi · cli-spinners · alive-progress · TachyonFX · Harmonica · Mordant",
    [
      "Spinner wheel",
      "Breathing pulse",
      "Bouncing indicator",
      "Meter spinner",
      "Ellipsis",
      "Blink",
      "Rainbow cycle",
      "Sand fill and drain",
      "Perimeter orbit",
      "Comet chase",
      "Phase-delayed ripple",
      "Cropped marquee",
      "Coalesce and dissolve",
      "Patterned color sweep",
      "Spring-settled marker",
      "Spinner-to-result morph",
      "Native terminal progress",
    ],
  ],
  [
    "Task feedback",
    "Ora · Listr2 · Rich · indicatif · PTerm",
    [
      "Concurrent task list",
      "Determinate progress",
      "Indeterminate progress",
      "Elapsed-time status",
    ],
  ],
  [
    "Glyph micro-motion",
    "unicode-animations · agents-are-thinking · pi-animations · Unicode Legacy Computing",
    [
      "Braille DNA twist",
      "Braille dual helix",
      "Braille diagonal fill",
      "Braille radial ripple",
      "Braille scanner field",
      "Shade mechanics",
      "Box-weight morph",
      "Block choreography",
      "Nerd Font semantic morph",
      "Nerd Font pipeline pulse",
      "Legacy texture lab",
      "Legacy sprite lab",
    ],
  ],
  [
    "Text effects",
    "TerminalTextEffects · Ansimax · Terani · chalk-animation",
    [
      "Decrypt",
      "Beam reveal",
      "Swarm",
      "Bubble text",
      "Pour",
      "Wipe",
      "VHS glitch",
      "Ring text",
      "Fade",
      "Slide",
      "Wave",
      "Glitch",
      "Scatter",
      "Typewriter",
      "Shimmer",
      "Binary path",
      "Error correction",
      "Laser etch",
      "Slice assembly",
      "Spotlights",
    ],
  ],
  [
    "Weather and fields",
    "cmatrix · termflix · ascii-splash · tarts · sysc-Go · libcaca",
    [
      "Digital rain",
      "Rain art",
      "Matrix text",
      "DOOM fire",
      "Burning text",
      "Plasma",
      "Ocean waves",
      "Aurora",
      "Lightning",
      "Snow",
      "Lava lamp",
    ],
  ],
  [
    "Simulations",
    "termflix · tarts · ascii-splash · sysc-Go",
    [
      "Game of Life",
      "Boids",
      "DNA helix",
      "Maze generation",
      "Mandelbrot",
      "N-body",
      "Reaction-diffusion",
      "Metaballs",
      "Constellation",
      "Pendulum wave",
      "Curl flow field",
      "Voronoi drift",
      "Lorenz attractor",
      "Galton board",
      "Radar sweep",
    ],
  ],
  [
    "Paths and games",
    "pipes.sh · tarts · termflix",
    ["Growing pipes", "Snake", "Pong", "Tetris", "Crabs"],
  ],
  [
    "Sprites and scenes",
    "asciiquarium · nyancat · terminal-parrot · sl · sysc-Go",
    [
      "Aquarium",
      "Nyan Cat",
      "Dancing parrot",
      "Pet dog",
      "Locomotive",
      "Amiga ball",
    ],
  ],
  [
    "Growth and playback",
    "cbonsai · theattyr · Termynal.js · ascii-splash",
    ["Bonsai growth", "Pixel-art morph", "VT100 theater", "Startup reveal"],
  ],
  [
    "Space and geometry",
    "termflix · tarts · ascii-3d-cube · libcaca",
    [
      "Starfield",
      "Fireworks",
      "3D cube",
      "Rotating donut",
      "Black hole",
      "3D heart",
    ],
  ],
  [
    "Dashboards",
    "CAVA · btop · Hollywood · tty-clock",
    ["Audio equalizer", "Live charts", "Hacker panes", "Terminal clock"],
  ],
  [
    "Rendering layers",
    "notcurses · chafa · OpenTUI · ghostty-shaders · Harmonica",
    [
      "Blitter ladder",
      "Quadrant mosaic",
      "Compact quadrant mosaic",
      "CRT afterglow",
      "RGB split glow",
      "Cell damage map",
      "Damped spring race",
      "Bloom glow",
      "Cursor smear",
    ],
  ],
  [
    "Textmode demoscene",
    "TMDC · viznut · text-mode.org",
    [
      "Rotozoomer",
      "Tunnel flight",
      "Kefrens bars",
      "Copper bars",
      "Sine scroller",
      "Vector balls",
      "Shadebobs",
      "Moiré rings",
      "Voxel landscape",
      "Dot flag",
      "Bump lighting",
      "Twister bar",
    ],
  ],
  [
    "Transitions and masks",
    "tui-vfx · TachyonFX · TerminalTextEffects",
    [
      "Iris reveal",
      "Blinds",
      "Checker tiles",
      "Diamond wipe",
      "Cellular pop",
      "Radial sweep",
      "Snake reveal",
      "Dither reveal",
      "Fault line",
      "Shredder",
      "Ripple warp",
      "Filter rack",
    ],
  ],
] as const;

const scenes = [
  {
    category: "micro",
    name: "One-cell motion lab",
    source: "Pi · cli-spinners · Gum",
    render(width: number, height: number, time: number) {
      const breathe = ["·", "•", "●", "●", "•", "·", "·", "·"];
      const samples = [
        ["breathing", frameAt(breathe, time, 110)],
        [
          "braille",
          frameAt(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], time, 80),
        ],
        ["quadrants", frameAt(["◐", "◓", "◑", "◒"], time, 120)],
        ["bounce", frameAt(["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"], time, 90)],
        [
          "meter",
          frameAt(
            [
              "▁",
              "▂",
              "▃",
              "▄",
              "▅",
              "▆",
              "▇",
              "█",
              "▇",
              "▆",
              "▅",
              "▄",
              "▃",
              "▂",
            ],
            time,
            75
          ),
        ],
      ];
      return body(
        [
          center(accent(frameAt(breathe, time, 110)), width),
          "",
          ...samples.map(([label, value]) =>
            center(`${muted(label.padEnd(12))} ${accent(value)}`, width)
          ),
          "",
          center(
            dim("Repeated frames fake fast attack and slow decay."),
            width
          ),
        ],
        width,
        height
      );
    },
  },
  {
    category: "micro",
    name: "Tasks and progress",
    source: "Ora · Listr2 · Rich · indicatif · PTerm",
    render(width: number, height: number, time: number) {
      const tasks = [
        "Resolve dependencies",
        "Compile packages",
        "Run tests",
        "Package artifacts",
      ];
      const phase = Math.floor(time / 1.4) % (tasks.length + 1);
      const spinner = frameAt(
        ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
        time,
        80
      );
      const value = (time % 6) / 6;
      const barWidth = Math.max(8, Math.min(42, width - 20));
      const lines = tasks.map((task, index) => {
        const marker =
          index < phase
            ? success("✓")
            : index === phase
              ? accent(spinner)
              : dim("○");
        return center(`${marker} ${task}`, width);
      });
      return body(
        [
          ...lines,
          "",
          center(
            `${progressBar(value, barWidth)} ${String(Math.round(value * 100)).padStart(3)}%`,
            width
          ),
          center(
            dim("Use real progress only when a denominator exists."),
            width
          ),
        ],
        width,
        height
      );
    },
  },
  {
    category: "text",
    name: "Text transformations",
    source: "TerminalTextEffects · Ansimax · Textual",
    render(width: number, height: number, time: number) {
      const message = "TERMINAL MOTION SHOULD SERVE THE STATE";
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&";
      const cycle = time % 6;
      const reveal = Math.min(message.length, Math.floor(cycle * 10));
      const tick = Math.floor(time * 18);
      const decrypt = [...message]
        .map((character, index) => {
          if (character === " ") return " ";
          if (index < reveal) return success(character);
          return dim(
            alphabet[Math.floor(hash(index * 97 + tick) * alphabet.length)] ??
              "?"
          );
        })
        .join("");
      const typed = message.slice(
        0,
        Math.min(message.length, Math.floor(cycle * 9))
      );
      const shine = (Math.floor(time * 12) % (message.length + 16)) - 8;
      const shimmer = [...message]
        .map((character, index) =>
          Math.abs(index - shine) <= 2 ? accent(character) : muted(character)
        )
        .join("");
      return body(
        [
          muted("TYPEWRITER"),
          center(
            `${typed}${Math.floor(time * 2) % 2 === 0 ? accent("_") : " "}`,
            width
          ),
          "",
          muted("DECRYPT"),
          center(decrypt, width),
          "",
          muted("SHIMMER"),
          center(shimmer, width),
        ],
        width,
        height
      );
    },
  },
  {
    category: "procedural",
    name: "Digital rain",
    source: "cmatrix · Curlix · termflix · tarts",
    render(width: number, height: number, time: number) {
      const symbols = "01ABCDEF#$%&*+";
      const lines: string[] = [];
      for (let y = 0; y < height; y++) {
        let line = "";
        for (let x = 0; x < width; x++) {
          if (x % 2 === 1) {
            line += " ";
            continue;
          }
          const head = Math.floor(
            (time * (7 + hash(x) * 8) + hash(x * 17) * height * 2) %
              (height + 14)
          );
          const distance = head - y;
          const character =
            symbols[
              Math.floor(
                hash(x * 131 + y * 17 + Math.floor(time * 8)) * symbols.length
              )
            ] ?? "0";
          if (distance === 0) line += fg(210, 255, 220, character);
          else if (distance > 0 && distance < 4)
            line += fg(65, 225, 105, character);
          else if (distance >= 4 && distance < 11)
            line += fg(20, 100, 55, character);
          else line += " ";
        }
        lines.push(fit(line, width));
      }
      return lines;
    },
  },
  {
    category: "data",
    name: "Smoothed live data",
    source: "CAVA · btop · Bubble Tea",
    render(width: number, height: number, time: number) {
      const chartHeight = Math.max(4, height - 6);
      const columns = Math.max(8, Math.min(48, Math.floor(width / 2)));
      const values = Array.from({ length: columns }, (_, index) => {
        const wave = Math.sin(index * 0.55 + time * 2.4) * 0.35;
        const swell = Math.sin(index * 0.16 - time * 0.9) * 0.25;
        return Math.max(0.05, Math.min(1, 0.45 + wave + swell));
      });
      const lines: string[] = [];
      for (let row = chartHeight; row > 0; row--) {
        const threshold = row / chartHeight;
        const bars = values
          .map((value) => (value >= threshold ? fg(95, 205, 190, "█ ") : "  "))
          .join("");
        lines.push(center(bars, width));
      }
      const cpu = (Math.sin(time * 0.7) + 1) / 2;
      lines.push("");
      lines.push(
        center(
          `CPU ${progressBar(cpu, Math.max(8, Math.min(32, width - 16)))} ${Math.round(cpu * 100)}%`,
          width
        )
      );
      lines.push(
        center(dim("Attack/decay and stable chrome beat raw jitter."), width)
      );
      return body(lines, width, height);
    },
  },
  {
    category: "procedural",
    name: "Growing pipes",
    source: "pipes.sh · ascii-splash · tarts",
    render(width: number, height: number, time: number) {
      const grid = Array.from({ length: height }, () =>
        Array.from({ length: width }, () => " ")
      );
      const colors = [
        [255, 112, 132],
        [111, 214, 255],
        [244, 198, 96],
        [153, 224, 136],
      ] as const;
      const steps = Math.floor((time % 12) * 9);
      for (let walker = 0; walker < colors.length; walker++) {
        const [red, green, blue] = colors[walker]!;
        let x = Math.floor(hash(walker * 41 + 1) * width);
        let y = Math.floor(hash(walker * 41 + 2) * height);
        let direction = Math.floor(hash(walker * 41 + 3) * 4);
        for (let step = 0; step < steps; step++) {
          const turn = Math.floor(hash(walker * 1000 + step) * 3) - 1;
          const next = (direction + turn + 4) % 4;
          const glyph =
            direction % 2 === next % 2 ? (next % 2 === 0 ? "│" : "─") : "┼";
          grid[y]![x] = fg(red, green, blue, glyph);
          direction = next;
          x = (x + [0, 1, 0, -1][direction]! + width) % width;
          y = (y + [-1, 0, 1, 0][direction]! + height) % height;
        }
        grid[y]![x] = warning("◆");
      }
      return grid.map((row) => row.join(""));
    },
  },
  {
    category: "sprites",
    name: "ASCII aquarium",
    source: "asciiquarium · sysc-Go · termflix",
    render(width: number, height: number, time: number) {
      const grid = Array.from({ length: height }, () =>
        Array.from({ length: width }, () => " ")
      );
      const put = (
        x: number,
        y: number,
        text: string,
        paint = (character: string) => character
      ) => {
        for (const [offset, character] of [...text].entries()) {
          const column = x + offset;
          if (column >= 0 && column < width && y >= 0 && y < height)
            grid[y]![column] = paint(character);
        }
      };
      for (let index = 0; index < 7; index++) {
        const sprite = index % 2 === 0 ? "><>" : "<><";
        const speed = 2 + hash(index) * 4;
        const raw = Math.floor(time * speed + hash(index * 19) * width);
        const x =
          index % 2 === 0
            ? (raw % (width + 5)) - 3
            : width - (raw % (width + 5));
        const y = 1 + Math.floor(hash(index * 31) * Math.max(1, height - 5));
        put(x, y, sprite, (character) =>
          fg(90 + index * 20, 190, 230 - index * 12, character)
        );
      }
      for (let index = 0; index < Math.floor(width / 10); index++) {
        const x = Math.floor(hash(index * 43) * width);
        const y =
          height -
          2 -
          (Math.floor(time * (1 + hash(index)) + hash(index * 7) * height) %
            Math.max(1, height - 2));
        put(x, y, index % 3 === 0 ? "O" : "o", dim);
      }
      const floor = Array.from({ length: width }, (_, index) =>
        index % 7 === 0 ? "Y" : index % 3 === 0 ? "v" : "_"
      ).join("");
      put(0, height - 1, floor, (character) => fg(69, 147, 91, character));
      return grid.map((row) => row.join(""));
    },
  },
  {
    category: "generative",
    name: "Bonsai growth",
    source: "cbonsai",
    render(width: number, height: number, time: number) {
      const tree = [
        "             .      .",
        "          .  :  .  :  .",
        "        . : \\ | / : .",
        "         \\ `-.-' /",
        "      .---`  /|\\  `---.",
        "     /      / | \\      \\",
        "    :      /  |  \\      :",
        "     `-.  /   |   \\  .-'",
        "        `-.___|_.-'",
        "             /|\\",
        "            / | \\",
        "           /  |  \\",
        "        __/___|___\\__",
        "       /_____________\\",
      ];
      const total = tree.reduce((sum, line) => sum + line.length, 0);
      let remaining = Math.floor((time * 45) % (total + 100));
      const lines = tree.map((line, row) => {
        const visible = line.slice(
          0,
          Math.max(0, Math.min(line.length, remaining))
        );
        remaining -= line.length;
        const colored =
          row < 9 ? fg(106, 189, 113, visible) : fg(157, 112, 72, visible);
        return center(colored, width);
      });
      return body(lines, width, height);
    },
  },
  {
    category: "procedural",
    name: "Starfield and fireworks",
    source: "termflix · tarts · sysc-Go · libcaca",
    render(width: number, height: number, time: number) {
      const grid = Array.from({ length: height }, () =>
        Array.from({ length: width }, () => " ")
      );
      for (let index = 0; index < Math.min(180, width * 2); index++) {
        const z = ((((hash(index * 5) - time * 0.12) % 1) + 1) % 1) + 0.08;
        const x = Math.round(
          width / 2 + ((hash(index * 5 + 1) * 2 - 1) / z) * width * 0.18
        );
        const y = Math.round(
          height / 2 + ((hash(index * 5 + 2) * 2 - 1) / z) * height * 0.18
        );
        if (x >= 0 && x < width && y >= 0 && y < height)
          grid[y]![x] =
            z < 0.32 ? accent("*") : z < 0.65 ? muted("+") : dim(".");
      }
      const burstAge = time % 3;
      const burst = Math.floor(time / 3);
      const centerX = Math.floor(width * (0.25 + hash(burst) * 0.5));
      const centerY = Math.floor(height * (0.2 + hash(burst + 9) * 0.3));
      if (burstAge < 2.3) {
        for (let particle = 0; particle < 36; particle++) {
          const angle = (particle / 36) * Math.PI * 2;
          const speed = 4 + hash(burst * 100 + particle) * 9;
          const x = Math.round(centerX + Math.cos(angle) * speed * burstAge);
          const y = Math.round(
            centerY +
              Math.sin(angle) * speed * burstAge * 0.45 +
              burstAge * burstAge
          );
          if (x >= 0 && x < width && y >= 0 && y < height)
            grid[y]![x] = fg(
              255,
              120 + (particle % 3) * 50,
              90 + (particle % 5) * 25,
              burstAge < 1.3 ? "*" : "."
            );
        }
      }
      return grid.map((row) => row.join(""));
    },
  },
  {
    category: "catalog",
    name: "Verified project field guide",
    source: "Use --list for canonical URLs",
    render(width: number, height: number, time: number) {
      const page = Math.floor(time / 7) % CATALOG.length;
      const [heading, entries] = CATALOG[page]!;
      const columns = width >= 72 ? 2 : 1;
      const rows = Math.ceil(entries.length / columns);
      const columnWidth = Math.floor(width / columns);
      const lines = [center(bold(accent(heading)), width), ""];
      for (let row = 0; row < rows; row++) {
        let line = "";
        for (let column = 0; column < columns; column++) {
          const entry = entries[row + column * rows];
          line += fit(
            entry ? `  ${success("•")} ${entry[0]}` : "",
            columnWidth
          );
        }
        lines.push(fit(line, width));
      }
      lines.push("");
      lines.push(
        center(
          dim(`Page ${page + 1}/${CATALOG.length} · changes every 7 seconds`),
          width
        )
      );
      return body(lines, width, height);
    },
  },
] as const;

const makeGrid = (width: number, height: number) =>
  Array.from({ length: height }, () =>
    Array.from({ length: width }, () => " ")
  );
const putText = (
  grid: string[][],
  x: number,
  y: number,
  text: string,
  paint = (character: string) => character
) => {
  const row = grid[y];
  if (!row) return;
  for (const [offset, character] of [...text].entries()) {
    const column = x + offset;
    if (column >= 0 && column < row.length) row[column] = paint(character);
  }
};
const finishGrid = (grid: string[][]) => grid.map((row) => row.join(""));
const seedOf = (text: string) =>
  [...text].reduce(
    (sum, character) => sum + (character.codePointAt(0) ?? 0),
    0
  );
const brailleCanvas = (
  pixelWidth: number,
  pixelHeight: number,
  isOn: (x: number, y: number) => boolean
) => {
  const dots = [
    [0, 0, 1],
    [0, 1, 2],
    [0, 2, 4],
    [1, 0, 8],
    [1, 1, 16],
    [1, 2, 32],
    [0, 3, 64],
    [1, 3, 128],
  ] as const;
  const lines: string[] = [];
  for (let cellY = 0; cellY < pixelHeight; cellY += 4) {
    let line = "";
    for (let cellX = 0; cellX < pixelWidth; cellX += 2) {
      let bits = 0;
      for (const [x, y, bit] of dots)
        if (isOn(cellX + x, cellY + y)) bits |= bit;
      line += bits === 0 ? " " : String.fromCodePoint(0x2800 + bits);
    }
    lines.push(line);
  }
  return lines;
};

const renderMicro = (
  name: string,
  width: number,
  height: number,
  time: number
) => {
  if (name === "Sand fill and drain") {
    const phase = time % 6;
    const value =
      phase < 2
        ? phase / 2
        : phase < 3
          ? 1
          : phase < 5
            ? 1 - (phase - 3) / 2
            : 0;
    const size = Math.max(8, Math.min(24, width - 18));
    const amount = Math.round(value * size);
    const fill = warning("█".repeat(amount)) + dim("░".repeat(size - amount));
    const drain = dim("░".repeat(size - amount)) + warning("█".repeat(amount));
    const grains = frameAt(["·", "∙", "•", "∙"], time, 140);
    return body(
      [
        center(`${muted("fill ")} [${fill}] ${grains}`, width),
        center(`${muted("drain")} [${drain}] ${grains}`, width),
        "",
        center(dim("attack · hold · release · rest"), width),
      ],
      width,
      height
    );
  }
  if (name === "Perimeter orbit") {
    const corners = frameAt(["◰", "◳", "◲", "◱"], time, 150);
    const quarters = frameAt(["◴", "◷", "◶", "◵"], time, 150);
    const frames = [
      "●───────────",
      "──●─────────",
      "────●───────",
      "──────●─────",
      "────────●───",
      "──────────●─",
      "───────────●",
      "─────────●──",
      "───────●────",
      "─────●──────",
      "───●────────",
      "─●──────────",
    ];
    return body(
      [
        center(`${muted("corners ")} ${accent(corners)}`, width),
        center(`${muted("quarters")} ${accent(quarters)}`, width),
        center(
          `${muted("edge    ")} ${accent(frameAt(frames, time, 90))}`,
          width
        ),
      ],
      width,
      height
    );
  }
  if (name === "Comet chase") {
    const size = Math.max(12, Math.min(34, width - 18));
    const comet = (offset: number, direction: 1 | -1, paint: typeof accent) => {
      const cells = Array.from({ length: size }, () => dim("·"));
      const head =
        (((Math.floor(time * 11 + offset) * direction) % size) + size) % size;
      for (const [tail, glyph] of ["●", "•", "∙", "·"].entries()) {
        const position = (head - tail * direction + size) % size;
        cells[position] = tail < 2 ? paint(glyph) : muted(glyph);
      }
      return cells.join("");
    };
    return body(
      [
        center(`${muted("forward")} ${comet(0, 1, accent)}`, width),
        center(`${muted("reverse")} ${comet(7, -1, warning)}`, width),
        center(`${muted("paired ")} ${comet(3, 1, success)}`, width),
      ],
      width,
      height
    );
  }
  if (name === "Phase-delayed ripple") {
    const delayed = (
      frames: readonly string[],
      count: number,
      delay: number,
      speed: number
    ) =>
      Array.from({ length: count }, (_, index) => {
        const frame =
          ((Math.floor(time * speed - index * delay) % frames.length) +
            frames.length) %
          frames.length;
        return frames[frame] ?? " ";
      }).join(" ");
    return body(
      [
        center(
          `${muted("braille")} ${accent(delayed(["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"], 9, 1.2, 11))}`,
          width
        ),
        center(
          `${muted("pulse  ")} ${success(delayed(["·", "•", "●", "•"], 9, 0.6, 7))}`,
          width
        ),
        center(
          `${muted("levels ")} ${warning(delayed(["▁", "▃", "▅", "▇", "▅", "▃"], 9, 0.8, 8))}`,
          width
        ),
      ],
      width,
      height
    );
  }
  if (name === "Cropped marquee") {
    const viewport = Math.max(12, Math.min(30, width - 18));
    const loop = "   indexing packages/clanker-stuff   ";
    const offset = Math.floor(time * 7) % loop.length;
    const wrapped = loop.repeat(3).slice(offset, offset + viewport);
    const message = "deploying terminal-animation-showcase.ts";
    const travel = Math.max(1, message.length - viewport);
    const bouncePhase = Math.floor(time * 6) % Math.max(1, travel * 2);
    const bounceOffset =
      bouncePhase <= travel ? bouncePhase : travel * 2 - bouncePhase;
    const bounced = message.slice(bounceOffset, bounceOffset + viewport);
    return body(
      [
        center(`${muted("wrap  ")}│${accent(wrapped)}│`, width),
        center(
          `${muted("bounce")}│${success(bounced.padEnd(viewport))}│`,
          width
        ),
        "",
        center(dim("The surrounding layout never moves."), width),
      ],
      width,
      height
    );
  }
  if (name === "Coalesce and dissolve") {
    const message = "LOCAL CHANGE ONLY";
    const cycle = (time % 6) / 3;
    const progress = cycle <= 1 ? cycle : 2 - cycle;
    const tick = Math.floor(time * 13);
    const coalesced = [...message]
      .map((character, index) => {
        if (character === " ") return " ";
        if (hash(index * 41) < progress) return success(character);
        return dim("·:+*"[Math.floor(hash(index * 97 + tick) * 4)] ?? "·");
      })
      .join("");
    const dissolved = [...message]
      .map((character, index) => {
        if (character === " ") return " ";
        return hash(index * 67) > progress
          ? accent(character)
          : dim(hash(index + tick) > 0.5 ? "·" : " ");
      })
      .join("");
    return body(
      [
        center(`${muted("gather ")} ${coalesced}`, width),
        center(`${muted("release")} ${dissolved}`, width),
      ],
      width,
      height
    );
  }
  if (name === "Patterned color sweep") {
    const message = "SELECTED ROW";
    const sweep = (Math.floor(time * 9) % (message.length + 8)) - 4;
    const linear = [...message]
      .map((character, index) =>
        Math.abs(index - sweep) <= 2 ? accent(character) : muted(character)
      )
      .join("");
    const checker = [...message]
      .map((character, index) =>
        (index + Math.floor(time * 5)) % 4 < 2
          ? success(character)
          : dim(character)
      )
      .join("");
    const radial = [...message]
      .map((character, index) => {
        const wave = Math.sin(time * 4 - Math.abs(index - message.length / 2));
        return wave > 0.25 ? warning(character) : muted(character);
      })
      .join("");
    return body(
      [
        center(`${muted("linear ")} ${linear}`, width),
        center(`${muted("checker")} ${checker}`, width),
        center(`${muted("radial ")} ${radial}`, width),
      ],
      width,
      height
    );
  }
  if (name === "Spring-settled marker") {
    const elapsed = time % 4;
    const tracks = Math.max(16, Math.min(34, width - 20));
    const target = Math.floor(tracks * 0.72);
    const springTrack = (value: number, paint: typeof accent) => {
      const cells = Array.from({ length: tracks }, () => dim("·"));
      cells[target] = muted("│");
      const position = Math.max(
        0,
        Math.min(tracks - 1, Math.round(value * target))
      );
      cells[position] = paint("◆");
      return cells.join("");
    };
    const under = 1 - Math.exp(-2.8 * elapsed) * Math.cos(8 * elapsed);
    const critical = 1 - (1 + 5 * elapsed) * Math.exp(-5 * elapsed);
    const over =
      1 - 0.72 * Math.exp(-1.6 * elapsed) - 0.28 * Math.exp(-7 * elapsed);
    return body(
      [
        center(`${muted("overshoot")} ${springTrack(under, accent)}`, width),
        center(
          `${muted("critical ")} ${springTrack(critical, success)}`,
          width
        ),
        center(`${muted("soft     ")} ${springTrack(over, warning)}`, width),
      ],
      width,
      height
    );
  }
  if (name === "Spinner-to-result morph") {
    const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const result = (
      label: string,
      final: string,
      offset: number,
      paint: typeof accent
    ) => {
      const phase = (time + offset) % 6;
      const glyph =
        phase < 2.4
          ? frameAt(spinner, phase, 85)
          : phase < 3.2
            ? frameAt(["◌", "○", "●", final], phase - 2.4, 200)
            : final;
      return center(
        `${muted(label.padEnd(8))} ${paint(glyph)} ${label}`,
        width
      );
    };
    return body(
      [
        result("success", "✓", 0, success),
        result("warning", "!", 1.8, warning),
        result("failure", "×", 3.6, (text) => fg(244, 106, 116, text)),
      ],
      width,
      height
    );
  }
  if (name === "Native terminal progress") {
    const phase = time % 10;
    const percentage = Math.min(100, Math.round(phase * 14));
    const state =
      phase < 6
        ? "normal"
        : phase < 7.5
          ? "warning"
          : phase < 9
            ? "error"
            : "complete";
    const paint =
      state === "warning"
        ? warning
        : state === "error"
          ? (text: string) => fg(244, 106, 116, text)
          : success;
    const size = Math.max(8, Math.min(36, width - 20));
    const filled = Math.round((percentage / 100) * size);
    const bar = paint("━".repeat(filled)) + dim("─".repeat(size - filled));
    return body(
      [
        center(`${muted("terminal chrome")}  ${bar}`, width),
        center(
          `${paint(state.padEnd(8))} ${String(percentage).padStart(3)}%`,
          width
        ),
        "",
        center(
          dim(
            SUPPORTS_OSC_PROGRESS
              ? "OSC 9;4 output is active in the terminal chrome."
              : "OSC 9;4 preview only; terminal support was not detected."
          ),
          width
        ),
      ],
      width,
      height
    );
  }
  if (name === "Rainbow cycle") {
    const message = "TERMINAL MOTION";
    const colored = [...message]
      .map((character, index) => {
        const phase = time * 2 + index * 0.35;
        return fg(
          Math.round(128 + Math.sin(phase) * 127),
          Math.round(128 + Math.sin(phase + 2.1) * 127),
          Math.round(128 + Math.sin(phase + 4.2) * 127),
          character
        );
      })
      .join("");
    return body([center(colored, width)], width, height);
  }
  if (name === "Blink")
    return body(
      [center(Math.floor(time * 2) % 2 === 0 ? success("READY") : "", width)],
      width,
      height
    );
  if (name === "Ellipsis") {
    const dots = ".".repeat(Math.floor(time * 3) % 4).padEnd(3);
    return body([center(`Thinking${accent(dots)}`, width)], width, height);
  }
  if (name === "Bouncing indicator") {
    const size = Math.max(8, Math.min(42, width - 8));
    const span = size - 1;
    const phase = (time * 12) % (span * 2);
    const position = Math.round(phase <= span ? phase : span * 2 - phase);
    return body(
      [
        center(
          dim("─".repeat(position)) +
            accent("●") +
            dim("─".repeat(size - position - 1)),
          width
        ),
      ],
      width,
      height
    );
  }
  const frames =
    name === "Breathing pulse"
      ? ["·", "•", "●", "●", "•", "·", "·", "·"]
      : name === "Meter spinner"
        ? ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▅", "▃"]
        : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  return body(
    [
      center(
        accent(frameAt(frames, time, name === "Meter spinner" ? 75 : 95)),
        width
      ),
    ],
    width,
    height
  );
};

const renderGlyphMotion = (
  name: string,
  width: number,
  height: number,
  time: number
) => {
  const pixelWidth = Math.max(16, Math.min(48, (width - 8) * 2));
  if (name === "Braille DNA twist") {
    const pixels = brailleCanvas(pixelWidth, 8, (x, y) => {
      const first = Math.round(3.5 + Math.sin(x * 0.42 - time * 4) * 2.8);
      const second = 7 - first;
      return (
        y === first ||
        y === second ||
        (x % 6 === 0 &&
          y > Math.min(first, second) &&
          y < Math.max(first, second))
      );
    });
    return body(
      [
        ...pixels.map((line, index) =>
          center(index === 0 ? accent(line) : success(line), width)
        ),
        "",
        center(dim("phase-shifted strands with intermittent rungs"), width),
      ],
      width,
      height
    );
  }
  if (name === "Braille dual helix") {
    const pixels = brailleCanvas(pixelWidth, 12, (x, y) => {
      const phase = x * 0.32 - time * 3.3;
      const first = Math.round(5.5 + Math.sin(phase) * 4.5);
      const second = Math.round(5.5 + Math.sin(phase + Math.PI) * 4.5);
      const crossing = Math.abs(Math.sin(phase)) < 0.18;
      return y === first || y === second || (crossing && y >= 4 && y <= 7);
    });
    return body(
      [
        ...pixels.map((line, index) =>
          center(index % 2 === 0 ? warning(line) : accent(line), width)
        ),
        "",
        center(dim("two sine paths exchange depth at each crossing"), width),
      ],
      width,
      height
    );
  }
  if (name === "Braille diagonal fill") {
    const pixelHeight = 12;
    const span = pixelWidth + pixelHeight;
    const phase = Math.floor(time * 13) % (span * 2);
    const edge = phase <= span ? phase : span * 2 - phase;
    const pixels = brailleCanvas(
      pixelWidth,
      pixelHeight,
      (x, y) => x + y <= edge
    );
    return body(
      [
        ...pixels.map((line) => center(accent(line), width)),
        "",
        center(dim("one diagonal threshold fills every subcell"), width),
      ],
      width,
      height
    );
  }
  if (name === "Braille radial ripple") {
    const pixelHeight = 12;
    const radius = (time * 7) % Math.max(8, pixelWidth / 2);
    const pixels = brailleCanvas(pixelWidth, pixelHeight, (x, y) => {
      const distance = Math.hypot(
        x - pixelWidth / 2,
        (y - pixelHeight / 2) * 1.7
      );
      return (
        Math.abs(distance - radius) < 1.2 ||
        Math.abs(distance - radius + 6) < 0.7
      );
    });
    return body(
      [
        ...pixels.map((line, index) =>
          center(index === 1 ? success(line) : accent(line), width)
        ),
        "",
        center(dim("concentric energy without moving the label"), width),
      ],
      width,
      height
    );
  }
  if (name === "Braille scanner field") {
    const pixelHeight = 12;
    const head = ((time * 12) % (pixelWidth + 10)) - 5;
    const tick = Math.floor(time * 8);
    const pixels = brailleCanvas(pixelWidth, pixelHeight, (x, y) => {
      const distance = head - x;
      if (Math.abs(distance) < 1) return true;
      if (distance > 0 && distance < 7)
        return hash(x * 43 + y * 71 + tick) > 0.52 + distance * 0.045;
      return hash(x * 101 + y * 59) > 0.95;
    });
    return body(
      [
        ...pixels.map((line, index) =>
          center(index === 1 ? warning(line) : muted(line), width)
        ),
        "",
        center(dim("bright scan front, decaying subcell wake"), width),
      ],
      width,
      height
    );
  }
  if (name === "Shade mechanics") {
    const size = Math.floor(Math.max(12, Math.min(30, width - 18)) / 2) * 2;
    const densities = ["░", "▒", "▓", "█"];
    const wave = (offset: number) =>
      Array.from({ length: size }, (_, index) => {
        const level = Math.floor(
          ((Math.sin(index * 0.45 + time * 3 + offset) + 1) / 2) * 3.99
        );
        return densities[level] ?? "░";
      }).join("");
    const pinch = Array.from({ length: size }, (_, index) => {
      const distance = Math.abs(index - size / 2);
      const radius = ((Math.sin(time * 2.6) + 1) / 2) * (size / 2);
      return distance < radius ? "█" : distance < radius + 2 ? "▒" : "░";
    }).join("");
    const seesaw =
      "█"
        .repeat(Math.round(((Math.sin(time * 2.2) + 1) / 2) * (size / 2)))
        .padEnd(size / 2, "░") +
      "█"
        .repeat(
          Math.round(((Math.sin(time * 2.2 + Math.PI) + 1) / 2) * (size / 2))
        )
        .padStart(size / 2, "░");
    const heartbeat = "____/‾\\____/‾‾\\_/‾\\____";
    const beatOffset = Math.floor(time * 9) % heartbeat.length;
    const beat = (heartbeat + heartbeat).slice(beatOffset, beatOffset + size);
    return body(
      [
        center(`${muted("tide     ")} ${accent(wave(0))}`, width),
        center(`${muted("pinch    ")} ${warning(pinch)}`, width),
        center(`${muted("seesaw   ")} ${success(seesaw)}`, width),
        center(`${muted("heartbeat")} ${fg(244, 106, 116, beat)}`, width),
      ],
      width,
      height
    );
  }
  if (name === "Box-weight morph") {
    const frames = [
      ["┌────────────┐", "│            │", "└────────────┘"],
      ["┏━━━━━━━━━━━━┓", "┃            ┃", "┗━━━━━━━━━━━━┛"],
      ["╔════════════╗", "║            ║", "╚════════════╝"],
      ["╭────────────╮", "│            │", "╰────────────╯"],
    ];
    const frame = frames[Math.floor(time * 3) % frames.length]!;
    const strokes = frameAt(
      ["┄ ─ ━ ═ ━ ─", "─ ━ ═ ━ ─ ┄", "━ ═ ━ ─ ┄ ─"],
      time,
      180
    );
    return body(
      [
        ...frame.map((line, index) =>
          center(index === 1 ? muted(line) : accent(line), width)
        ),
        "",
        center(warning(strokes), width),
      ],
      width,
      height
    );
  }
  if (name === "Block choreography") {
    const size = Math.max(12, Math.min(32, width - 20));
    const accordionPosition =
      ((1 - Math.cos((time % 4) * Math.PI)) / 2) * (size - 1);
    const accordion = Array.from({ length: size }, (_, index) => {
      const distance = Math.abs(index - accordionPosition);
      return distance < 0.6
        ? "█"
        : distance < 1.5
          ? "▓"
          : distance < 2.5
            ? "▒"
            : "·";
    }).join("");
    const packetPosition = Math.floor(time * 9) % Math.max(1, size - 2);
    const packet = Array.from({ length: size }, (_, index) =>
      index === 0 || index === size - 1
        ? "O"
        : index === packetPosition
          ? "═"
          : "─"
    ).join("");
    const pacPosition = Math.floor(time * 7) % Math.max(1, size - 3);
    const pacman = Array.from({ length: size }, (_, index) =>
      index === pacPosition
        ? Math.floor(time * 8) % 2 === 0
          ? "ᗧ"
          : "●"
        : index > pacPosition
          ? "·"
          : " "
    ).join("");
    const moire = frameAt(
      ["///---|||---", "---|||---///", "|||---///---"],
      time,
      170
    );
    return body(
      [
        center(`${muted("accordion")} ${accent(accordion)}`, width),
        center(`${muted("packet   ")} ${success(packet)}`, width),
        center(`${muted("chomp    ")} ${warning(pacman)}`, width),
        center(`${muted("moire    ")} ${muted(moire)}`, width),
      ],
      width,
      height
    );
  }
  if (name === "Nerd Font semantic morph") {
    const icons = [
      0xf0eb, 0xf013, 0xf0e7, 0xf135, 0xf005, 0xf06d, 0xf0ac, 0xf004,
    ];
    const labels = [
      "idea",
      "gear",
      "energy",
      "launch",
      "star",
      "fire",
      "world",
      "heart",
    ];
    const duration = 1.4;
    const position = time / duration;
    const index = Math.floor(position) % icons.length;
    const next = (index + 1) % icons.length;
    const transition = position % 1;
    const shades = ["░", "▒", "▓", "█", "▓", "▒", "░"];
    const display =
      transition < 0.3
        ? String.fromCodePoint(icons[index]!)
        : transition > 0.7
          ? String.fromCodePoint(icons[next]!)
          : (shades[Math.floor(((transition - 0.3) / 0.4) * shades.length)] ??
            "█");
    const label = labels[transition > 0.7 ? next : index] ?? "state";
    return body(
      [
        center(`${accent(display)}  ${bold(label)}`, width),
        "",
        center(
          `${muted("portable fallback")}  ${warning(`[${label}]`)}`,
          width
        ),
        center(dim("Nerd Font PUA glyph → density bridge → next glyph"), width),
      ],
      width,
      height
    );
  }
  if (name === "Nerd Font pipeline pulse") {
    const icons = [0xf0e7, 0xf013, 0xf121, 0xf0ad, 0xf00c];
    const fallback = ["PWR", "BLD", "COD", "TST", "OK"];
    const segment = 6;
    const pulse = (time * 7) % (icons.length * segment - 1);
    let iconLine = "";
    let fallbackLine = "";
    for (let index = 0; index < icons.length; index++) {
      const node = index * segment;
      iconLine +=
        Math.abs(pulse - node) < 1.5
          ? warning(String.fromCodePoint(icons[index]!))
          : muted(String.fromCodePoint(icons[index]!));
      fallbackLine +=
        Math.abs(pulse - node) < 1.5
          ? success(fallback[index]!)
          : dim(fallback[index]!);
      if (index < icons.length - 1) {
        const connector = Array.from({ length: segment - 1 }, (_, offset) =>
          Math.abs(pulse - (node + offset + 1)) < 1 ? "═" : "─"
        ).join("");
        iconLine += accent(connector);
        fallbackLine += dim("─");
      }
    }
    return body(
      [
        center(iconLine, width),
        "",
        center(fallbackLine, width),
        center(
          dim("one packet activates nodes and connectors in order"),
          width
        ),
      ],
      width,
      height
    );
  }
  if (name === "Legacy texture lab") {
    const speckle = frameAt(["𜱆", "𜱇"], time, 220);
    const circle = frameAt(
      ["𜰰", "𜰱", "𜰲", "𜰳", "𜰷", "𜰻", "𜰿", "𜰾", "𜰽", "𜰼", "𜰸", "𜰴"],
      time,
      100
    );
    const wedge = frameAt(["𜱫", "𜱬", "𜱭", "𜱮"], time, 150);
    const sextant = frameAt([" ", "🬭", "🬹", "█", "🬎", "🬂"], time, 180);
    const diagonal = frameAt(
      Array.from({ length: 20 }, (_, index) =>
        String.fromCodePoint(0x1fb3c + index)
      ),
      time,
      90
    );
    return body(
      [
        center(
          `${muted("speckle")} ${accent(speckle.repeat(8))}  ${dim(".:*:")}`,
          width
        ),
        center(`${muted("orbit  ")} ${warning(circle)}  ${dim("o···")}`, width),
        center(`${muted("wedge  ")} ${success(wedge)}  ${dim("◔◑◕◐")}`, width),
        center(`${muted("sextant")} ${accent(sextant)}  ${dim("▁▃▅█")}`, width),
        center(
          `${muted("mosaic ")} ${warning(diagonal)}  ${dim("/|\\-")}`,
          width
        ),
        center(
          dim("Unicode 16/17 glyph first · portable fallback second"),
          width
        ),
      ],
      width,
      height
    );
  }
  const direction = Math.floor(time * 4) % 4;
  const open = Math.floor(time * 7) % 2 === 0;
  const rockets = ["𜱖", "𜱗", "𜱘", "𜱙"];
  const waves = ["𜱸", "𜱹", "𜱺", "𜱻"];
  const snakes = open ? ["𜱰", "𜱱", "𜱲", "𜱳"] : ["𜱴", "𜱵", "𜱶", "𜱷"];
  return body(
    [
      center(
        `${muted("saucer ")} ${accent(frameAt(["𜱊", "𜱋"], time, 260))}  ${dim("[=] [ ]")}`,
        width
      ),
      center(
        `${muted("monster ")} ${warning(frameAt(["𜱌", "𜱍", "𜱎", "𜱏"], time, 220))}  ${dim("<O> <->")}`,
        width
      ),
      center(
        `${muted("gait    ")} ${success(frameAt(["𜱐", "𜱑", "𜱒", "𜱓", "𜱔", "𜱕"], time, 180))}  ${dim("/\\ \\/")}`,
        width
      ),
      center(
        `${muted("turn    ")} ${accent(rockets[direction] ?? "𜱖")} ${warning(waves[direction] ?? "𜱸")}  ${dim(["←", "↑", "→", "↓"][direction] ?? "→")}`,
        width
      ),
      center(
        `${muted("chomp   ")} ${success(snakes[direction] ?? "𜱰")}  ${dim(open ? ">" : "-")}`,
        width
      ),
      center(dim("tofu means the terminal/font lacks the supplement"), width),
    ],
    width,
    height
  );
};

const renderTask = (
  name: string,
  width: number,
  height: number,
  time: number
) => {
  if (name === "Concurrent task list")
    return scenes[1].render(width, height, time);
  const barWidth = Math.max(8, Math.min(48, width - 16));
  if (name === "Determinate progress") {
    const value = (time % 8) / 8;
    return body(
      [
        center(
          `${progressBar(value, barWidth)} ${String(Math.floor(value * 100)).padStart(3)}%`,
          width
        ),
        center(dim(`${Math.floor(value * 248)} / 248 files`), width),
      ],
      width,
      height
    );
  }
  if (name === "Indeterminate progress") {
    const position = Math.floor(time * 14) % Math.max(1, barWidth - 5);
    const line =
      dim("░".repeat(position)) +
      accent("█████") +
      dim("░".repeat(barWidth - position - 5));
    return body([center(line, width)], width, height);
  }
  const seconds = Math.floor(time);
  const spinner = frameAt(["◴", "◷", "◶", "◵"], time, 200);
  return body(
    [
      center(
        `${accent(spinner)} Indexing workspace  ${muted(`${seconds}.${Math.floor((time % 1) * 10)}s`)}`,
        width
      ),
    ],
    width,
    height
  );
};

const renderTextEffect = (
  name: string,
  width: number,
  height: number,
  time: number
) => {
  const message = "TERMINAL MOTION";
  const start = Math.max(0, Math.floor((width - message.length) / 2));
  const middle = Math.floor(height / 2);
  const grid = makeGrid(width, height);
  const phase = time % 5;
  const progress = Math.min(1, phase / 3.5);
  if (name === "Binary path") {
    for (const [index, character] of [...message].entries()) {
      if (character === " ") continue;
      const local = Math.max(0, Math.min(1, progress * 1.7 - index * 0.035));
      const sourceX = index % 2 === 0 ? 1 : width - 2;
      const sourceY = 2 + (index % Math.max(1, height - 4));
      const destinationX = start + index;
      const xProgress = Math.min(1, local * 2);
      const yProgress = Math.max(0, local * 2 - 1);
      const x = Math.round(sourceX + (destinationX - sourceX) * xProgress);
      const y = Math.round(sourceY + (middle - sourceY) * yProgress);
      putText(
        grid,
        x,
        y,
        local === 1 ? character : index % 2 ? "1" : "0",
        local === 1 ? success : accent
      );
      if (local > 0 && local < 1)
        putText(grid, x, sourceY, x < destinationX ? "└" : "┘", dim);
    }
    return finishGrid(grid);
  }
  if (name === "Error correction") {
    const incorrect = "TFRMINAL MXTION";
    const corrected = Math.floor((time % 4) * 5);
    for (const [index, character] of [...message].entries()) {
      const isCorrect = index < corrected || incorrect[index] === character;
      putText(
        grid,
        start + index,
        middle,
        isCorrect ? character : (incorrect[index] ?? character),
        isCorrect ? success : warning
      );
    }
    const nextError = [...message].findIndex(
      (character, index) => index >= corrected && incorrect[index] !== character
    );
    if (nextError >= 0)
      putText(
        grid,
        start + nextError,
        middle + 1,
        frameAt(["^", "▲"], time, 180),
        warning
      );
    return finishGrid(grid);
  }
  if (name === "Laser etch") {
    const head = Math.min(
      message.length - 1,
      Math.floor(progress * message.length)
    );
    for (const [index, character] of [...message].entries())
      putText(
        grid,
        start + index,
        middle,
        index < head ? character : "·",
        index < head ? success : dim
      );
    for (let y = 1; y < middle; y++) {
      const beamX = start + head + Math.round(Math.sin(y + time * 18));
      putText(grid, beamX, y, y === middle - 1 ? "▼" : "│", warning);
    }
    for (let spark = 0; spark < 7; spark++) {
      const age = (time * 8 + spark * 1.7) % 5;
      putText(
        grid,
        start + head + Math.round((hash(spark * 31) - 0.5) * age * 3),
        middle - Math.round(age),
        age < 2 ? "*" : "·",
        warning
      );
    }
    return finishGrid(grid);
  }
  if (name === "Slice assembly") {
    const split = Math.floor(message.length / 2);
    const offset = Math.round((1 - (1 - (1 - progress) ** 3)) * width * 0.45);
    putText(grid, start - offset, middle - 1, message.slice(0, split), accent);
    putText(
      grid,
      start + split + offset,
      middle + 1,
      message.slice(split),
      success
    );
    putText(
      grid,
      start + split - 1,
      middle,
      frameAt(["╱", "─", "╲", "─"], time, 140),
      warning
    );
    return finishGrid(grid);
  }
  if (name === "Spotlights") {
    const left = ((Math.sin(time * 1.8) + 1) / 2) * (message.length - 1);
    const right = ((Math.cos(time * 1.3) + 1) / 2) * (message.length - 1);
    for (const [index, character] of [...message].entries()) {
      const distance = Math.min(
        Math.abs(index - left),
        Math.abs(index - right)
      );
      const paint = distance < 1.4 ? accent : distance < 3 ? muted : dim;
      putText(grid, start + index, middle, character, paint);
    }
    putText(grid, start + Math.round(left), middle - 2, "╲", warning);
    putText(grid, start + Math.round(right), middle - 2, "╱", warning);
    return finishGrid(grid);
  }
  if (name === "Ring text") {
    for (const [index, character] of [
      ...message.replaceAll(" ", ""),
    ].entries()) {
      const angle = time + (index / 14) * Math.PI * 2;
      putText(
        grid,
        Math.round(width / 2 + Math.cos(angle) * Math.min(18, width / 3)),
        Math.round(height / 2 + Math.sin(angle) * Math.min(6, height / 3)),
        character,
        accent
      );
    }
    return finishGrid(grid);
  }
  if (name === "Wave") {
    for (const [index, character] of [...message].entries())
      putText(
        grid,
        start + index,
        middle + Math.round(Math.sin(time * 4 + index * 0.65) * 3),
        character,
        accent
      );
    return finishGrid(grid);
  }
  if (name === "Swarm" || name === "Scatter" || name === "Pour") {
    for (const [index, character] of [...message].entries()) {
      if (character === " ") continue;
      const sourceX =
        name === "Pour"
          ? start + index
          : Math.floor(hash(index * 31 + seedOf(name)) * width);
      const sourceY =
        name === "Pour"
          ? -Math.floor(hash(index * 11) * height)
          : Math.floor(hash(index * 47 + seedOf(name)) * height);
      const eased = 1 - (1 - progress) ** 3;
      putText(
        grid,
        Math.round(sourceX + (start + index - sourceX) * eased),
        Math.round(sourceY + (middle - sourceY) * eased),
        character,
        name === "Swarm" ? warning : accent
      );
    }
    return finishGrid(grid);
  }
  if (name === "Beam reveal") {
    const beam = Math.floor((time * 18) % (message.length + 8)) - 4;
    for (let y = 0; y < height; y++)
      if (beam >= 0 && beam < message.length)
        putText(grid, start + beam, y, "│", dim);
    putText(grid, start, middle, message, (character) => accent(character));
    return finishGrid(grid);
  }
  if (name === "Bubble text") {
    putText(grid, start, middle, message, accent);
    for (let index = 0; index < 18; index++) {
      const x = Math.round(
        start + hash(index) * message.length + Math.sin(time * 2 + index) * 3
      );
      const y = Math.round(middle + Math.sin(time * 1.4 + index * 1.7) * 5);
      putText(grid, x, y, index % 3 === 0 ? "O" : "o", muted);
    }
    return finishGrid(grid);
  }
  if (name === "Slide") {
    putText(
      grid,
      Math.round(-message.length + progress * (start + message.length)),
      middle,
      message,
      accent
    );
    return finishGrid(grid);
  }
  if (name === "VHS glitch") {
    const jitter = Math.floor(hash(Math.floor(time * 14)) * 9) - 4;
    const lines = [
      "PLAY  ▷",
      "",
      `${" ".repeat(Math.max(0, jitter))}${message}`,
      "",
      `TRACKING ${"=".repeat(Math.floor(time * 8) % 14)}`,
    ];
    return body(
      lines.map((line, index) =>
        center(index === 2 ? accent(line) : dim(line), width)
      ),
      width,
      height
    );
  }
  const tick = Math.floor(time * 16);
  const visible = Math.min(message.length, Math.floor((time % 4) * 5));
  const line = [...message]
    .map((character, index) => {
      if (name === "Decrypt" && index >= visible && character !== " ")
        return dim(
          "ABCDEFGHIJKLMNOPQRSTUVWXYZ#$%"[
            Math.floor(hash(index * 91 + tick) * 28)
          ] ?? "?"
        );
      if (name === "Glitch" && hash(index * 17 + tick) > 0.78)
        return warning("#%&@"[Math.floor(hash(index + tick) * 4)] ?? "#");
      if (name === "Wipe" && index >= visible) return " ";
      if (name === "Typewriter" && index >= visible)
        return index === visible ? accent("_") : " ";
      if (name === "Fade") {
        const light = Math.round(
          60 + ((Math.sin(time * 2 + index * 0.2) + 1) / 2) * 190
        );
        return fg(light, light, light, character);
      }
      if (name === "Shimmer") {
        const shine = (Math.floor(time * 12) % (message.length + 8)) - 4;
        return Math.abs(index - shine) <= 2
          ? accent(character)
          : muted(character);
      }
      return accent(character);
    })
    .join("");
  return body([center(line, width)], width, height);
};

const renderField = (
  name: string,
  width: number,
  height: number,
  time: number
) => {
  if (name === "Digital rain") return scenes[3].render(width, height, time);
  const grid = makeGrid(width, height);
  if (name === "Rain art") {
    for (let index = 0; index < Math.floor(width * height * 0.08); index++) {
      const x = Math.floor(hash(index * 17) * width);
      const y = Math.floor(
        (hash(index * 29) * height + time * (4 + hash(index) * 5)) % height
      );
      putText(grid, x, y, index % 4 === 0 ? "/" : "|", (character) =>
        fg(90, 155, 220, character)
      );
    }
    const umbrella = [
      "     .-^-.",
      "   .'     '._",
      "  /_________\\",
      "      | |",
      "      | J",
    ];
    for (const [row, line] of umbrella.entries())
      putText(
        grid,
        Math.floor(width / 2) - 7,
        Math.max(0, height - 6 + row),
        line,
        accent
      );
    return finishGrid(grid);
  }
  if (name === "Matrix text") {
    const message = "WAKE UP";
    for (let x = 0; x < width; x += 2) {
      const head = Math.floor((time * 8 + hash(x) * height) % (height + 8));
      for (let tail = 0; tail < 7; tail++) {
        const y = head - tail;
        if (y >= 0 && y < height)
          putText(
            grid,
            x,
            y,
            "01"[(x + y + Math.floor(time * 8)) % 2] ?? "0",
            tail === 0 ? success : dim
          );
      }
    }
    putText(
      grid,
      Math.floor((width - message.length) / 2),
      Math.floor(height / 2),
      message,
      (character) => fg(220, 255, 225, character)
    );
    return finishGrid(grid);
  }
  if (name === "Burning text") {
    const message = "BURN BRIGHT";
    const start = Math.floor((width - message.length) / 2);
    putText(grid, start, Math.floor(height * 0.65), message, (character) =>
      fg(255, 175, 45, character)
    );
    for (let index = 0; index < message.length * 3; index++) {
      const x = start + Math.floor(hash(index * 7) * message.length);
      const y =
        Math.floor(height * 0.65) -
        Math.floor((time * (2 + hash(index)) + hash(index * 19) * 8) % 9);
      putText(
        grid,
        x,
        y,
        hash(index + Math.floor(time * 5)) > 0.5 ? "*" : ".",
        warning
      );
    }
    return finishGrid(grid);
  }
  if (name === "Ocean waves") {
    for (let band = 0; band < 5; band++)
      for (let x = 0; x < width; x++) {
        const y = Math.round(
          height * 0.45 +
            band * 2 +
            Math.sin(x * 0.16 - time * (1.3 + band * 0.12)) * (1 + band * 0.35)
        );
        putText(grid, x, y, band === 0 ? "~" : "≈", (character) =>
          fg(55 + band * 12, 145 + band * 12, 220 + band * 5, character)
        );
      }
    return finishGrid(grid);
  }
  if (name === "Aurora") {
    for (let x = 0; x < width; x++)
      for (let band = 0; band < 5; band++) {
        const y = Math.round(
          height * 0.25 +
            band +
            Math.sin(x * 0.09 + time * 0.7 + band) * (2 + band)
        );
        putText(grid, x, y, "╷", (character) =>
          fg(80 + band * 22, 220 - band * 10, 150 + band * 18, character)
        );
      }
    return finishGrid(grid);
  }
  if (name === "Lightning") {
    const flash = hash(Math.floor(time * 2));
    let x = Math.floor(width * (0.35 + flash * 0.3));
    for (let y = 0; y < height; y++) {
      putText(grid, x, y, y % 3 === 0 ? "╲" : "│", (character) =>
        fg(245, 245, 180, character)
      );
      if (y % 3 === 0) x += hash(y + Math.floor(time * 2)) > 0.5 ? 1 : -1;
    }
    return finishGrid(grid);
  }
  if (name === "Snow") {
    for (let index = 0; index < Math.floor(width * height * 0.06); index++) {
      const x = Math.floor(
        (hash(index * 13) * width + Math.sin(time + index) * 2 + width) % width
      );
      const y = Math.floor(
        (hash(index * 23) * height + time * (1 + hash(index))) % height
      );
      putText(grid, x, y, index % 5 === 0 ? "*" : ".", (character) =>
        fg(200, 225, 255, character)
      );
    }
    return finishGrid(grid);
  }
  if (name === "Lava lamp") {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const blob =
          8 /
            (1 +
              Math.hypot(
                x - width * (0.35 + Math.sin(time) * 0.12),
                y - height * (0.3 + Math.cos(time * 0.7) * 0.18)
              )) +
          7 /
            (1 +
              Math.hypot(
                x - width * (0.65 + Math.cos(time * 0.8) * 0.1),
                y - height * (0.7 + Math.sin(time * 0.9) * 0.16)
              ));
        if (blob > 1.4)
          putText(grid, x, y, blob > 2.3 ? "█" : "▓", (character) =>
            fg(225, 75 + Math.round(blob * 22), 120, character)
          );
      }
    return finishGrid(grid);
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value =
        name === "DOOM fire"
          ? Math.max(
              0,
              1 -
                y / height +
                Math.sin(x * 0.22 + time * 7) * 0.18 +
                hash(x * 31 + y + Math.floor(time * 9)) * 0.25
            )
          : (Math.sin(x * 0.13 + time) +
              Math.sin(y * 0.31 - time * 1.4) +
              Math.sin((x + y) * 0.09 + time)) /
              6 +
            0.5;
      if (name === "DOOM fire" && value < 0.34) continue;
      const glyph = " ░▒▓█"[Math.min(4, Math.floor(value * 5))] ?? " ";
      putText(
        grid,
        x,
        name === "DOOM fire" ? height - y - 1 : y,
        glyph,
        (character) =>
          name === "DOOM fire"
            ? fg(
                255,
                Math.round(value * 190),
                Math.round(value * 45),
                character
              )
            : fg(
                Math.round(90 + value * 150),
                Math.round(50 + value * 130),
                Math.round(180 + value * 70),
                character
              )
      );
    }
  }
  return finishGrid(grid);
};

const renderSimulation = (
  name: string,
  width: number,
  height: number,
  time: number
) => {
  const grid = makeGrid(width, height);
  if (name === "DNA helix") {
    for (let y = 0; y < height; y++) {
      const left = Math.round(
        width / 2 + Math.sin(y * 0.55 + time * 2) * Math.min(14, width / 4)
      );
      const right = Math.round(
        width / 2 - Math.sin(y * 0.55 + time * 2) * Math.min(14, width / 4)
      );
      const [from, to] = left < right ? [left, right] : [right, left];
      if (y % 2 === 0)
        for (let x = from; x <= to; x++) putText(grid, x, y, "─", dim);
      putText(grid, left, y, "●", accent);
      putText(grid, right, y, "●", warning);
    }
    return finishGrid(grid);
  }
  if (name === "Pendulum wave") {
    const rows = Math.max(6, Math.min(height - 1, 18));
    const amplitude = Math.max(4, Math.min(width / 3, 28));
    for (let row = 0; row < rows; row++) {
      const y = Math.floor((row / rows) * height);
      const x = Math.round(
        width / 2 +
          Math.sin(time * (2.1 + row * 0.035) + row * 0.12) * amplitude
      );
      putText(grid, Math.floor(width / 2), y, "│", dim);
      putText(grid, x, y, "●", row % 3 === 0 ? warning : accent);
    }
    return finishGrid(grid);
  }
  if (name === "Curl flow field") {
    for (let seed = 0; seed < 18; seed++) {
      let x = hash(seed * 31) * width;
      let y = hash(seed * 47) * height;
      for (let step = 0; step < 26; step++) {
        const angle =
          Math.sin(x * 0.09 + time * 0.7) + Math.cos(y * 0.21 - time * 0.45);
        x = (x + Math.cos(angle * Math.PI) * 1.35 + width) % width;
        y = (y + Math.sin(angle * Math.PI) * 0.7 + height) % height;
        if (step > 8)
          putText(
            grid,
            Math.round(x),
            Math.round(y),
            step > 21 ? "•" : "·",
            seed % 2 === 0 ? accent : success
          );
      }
    }
    return finishGrid(grid);
  }
  if (name === "Voronoi drift") {
    const sites = Array.from({ length: 7 }, (_, index) => [
      width *
        (0.5 +
          0.42 * Math.sin(time * (0.2 + hash(index) * 0.25) + index * 2.4)),
      height *
        (0.5 +
          0.42 *
            Math.cos(time * (0.18 + hash(index + 9) * 0.22) + index * 1.7)),
    ]);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const distances = sites
          .map(([siteX, siteY], index) => [
            Math.hypot((x - siteX!) * 0.5, y - siteY!),
            index,
          ])
          .sort((left, right) => left[0]! - right[0]!);
        if (distances[1]![0]! - distances[0]![0]! < 0.38)
          putText(grid, x, y, "·", muted);
      }
    }
    for (const [index, [x, y]] of sites.entries())
      putText(
        grid,
        Math.round(x),
        Math.round(y),
        "◆",
        index % 2 === 0 ? accent : warning
      );
    return finishGrid(grid);
  }
  if (name === "Lorenz attractor") {
    const angle = time * 0.22;
    const [sin, cos] = [Math.sin(angle), Math.cos(angle)];
    const scale = Math.min(width / 62, height / 34);
    for (const [index, [x, y, z]] of LORENZ_POINTS.entries()) {
      const rotated = x * cos - y * sin;
      putText(
        grid,
        Math.round(width / 2 + rotated * scale),
        Math.round(height / 2 - (z - 25) * scale * 0.55),
        index % 7 === 0 ? "•" : "·",
        index > LORENZ_POINTS.length * 0.72 ? accent : dim
      );
    }
    return finishGrid(grid);
  }
  if (name === "Galton board") {
    const rows = Math.max(5, Math.min(10, height - 5));
    const spacing = Math.max(2, Math.min(4, Math.floor(width / (rows + 2))));
    const center = Math.floor(width / 2);
    for (let row = 0; row < rows; row++)
      for (let slot = 0; slot <= row; slot++)
        putText(
          grid,
          Math.round(center + (slot - row / 2) * spacing),
          row + 1,
          "·",
          muted
        );
    for (let ball = 0; ball < 12; ball++) {
      const age =
        (((time * 3 - ball * 0.55) % (rows + 3)) + rows + 3) % (rows + 3);
      const row = Math.floor(age);
      if (row >= rows) continue;
      let rights = 0;
      for (let step = 0; step < row; step++)
        if (hash(ball * 97 + step * 13) > 0.5) rights++;
      putText(
        grid,
        Math.round(center + (rights - row / 2) * spacing),
        row + 1,
        "●",
        ball % 2 === 0 ? warning : accent
      );
    }
    const floor = Math.min(height - 1, rows + 3);
    for (let bin = 0; bin <= rows; bin++) {
      const bell = Math.round(
        Math.max(1, (height - floor) * Math.exp(-((bin - rows / 2) ** 2) / 7))
      );
      for (let level = 0; level < bell; level++)
        putText(
          grid,
          Math.round(center + (bin - rows / 2) * spacing),
          height - 1 - level,
          "▄",
          success
        );
    }
    return finishGrid(grid);
  }
  if (name === "Radar sweep") {
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.max(3, Math.min(width / 4, height * 0.46));
    const sweep = (time * 1.7) % (Math.PI * 2);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = (x - centerX) * 0.5;
        const dy = y - centerY;
        const distance = Math.hypot(dx, dy);
        if (distance > radius) continue;
        const angle = Math.atan2(dy, dx);
        const behind = (sweep - angle + Math.PI * 2) % (Math.PI * 2);
        const onRing = [0.33, 0.66, 1].some(
          (ring) => Math.abs(distance - radius * ring) < 0.25
        );
        if (behind < 0.5)
          putText(grid, x, y, behind < 0.06 ? "│" : "·", success);
        else if (onRing) putText(grid, x, y, "·", dim);
      }
    }
    for (let blip = 0; blip < 6; blip++) {
      const angle = hash(blip * 31) * Math.PI * 2;
      const distance = radius * (0.2 + hash(blip * 47) * 0.7);
      const age = (sweep - angle + Math.PI * 2) % (Math.PI * 2);
      if (age < 2.7)
        putText(
          grid,
          Math.round(centerX + Math.cos(angle) * distance * 2),
          Math.round(centerY + Math.sin(angle) * distance),
          "◆",
          age < 0.8 ? warning : muted
        );
    }
    return finishGrid(grid);
  }
  if (name === "Boids") {
    const arrows = [">", "↗", "^", "↖", "<", "↙", "v", "↘"];
    for (let index = 0; index < 26; index++) {
      const angle = time * (0.35 + hash(index) * 0.35) + index;
      const x = Math.round(
        width / 2 +
          Math.cos(angle + hash(index * 3)) *
            width *
            (0.18 + hash(index * 5) * 0.22)
      );
      const y = Math.round(
        height / 2 +
          Math.sin(angle * 0.7) * height * (0.15 + hash(index * 7) * 0.25)
      );
      putText(
        grid,
        x,
        y,
        arrows[
          Math.floor(((angle % (Math.PI * 2)) / (Math.PI * 2)) * 8 + 8) % 8
        ] ?? ">",
        accent
      );
    }
    return finishGrid(grid);
  }
  if (name === "N-body") {
    for (let index = 0; index < 9; index++) {
      const radius = 2 + index * Math.min(3, width / 30);
      const angle = time * (1.8 / (index + 2)) + index;
      putText(
        grid,
        Math.round(width / 2 + Math.cos(angle) * radius * 2),
        Math.round(height / 2 + Math.sin(angle) * radius * 0.7),
        index === 0 ? "@" : "●",
        index % 2 ? accent : warning
      );
    }
    putText(grid, Math.floor(width / 2), Math.floor(height / 2), "*", success);
    return finishGrid(grid);
  }
  if (name === "Constellation") {
    const points = Array.from(
      { length: 12 },
      (_, index) =>
        [
          Math.floor(hash(index * 13) * width),
          Math.floor(hash(index * 29) * height),
        ] as const
    );
    for (const [index, [x, y]] of points.entries()) {
      const next = points[(index + 1) % points.length]!;
      const steps = Math.max(Math.abs(next[0] - x), Math.abs(next[1] - y));
      for (let step = 0; step < steps; step++)
        putText(
          grid,
          Math.round(x + ((next[0] - x) * step) / steps),
          Math.round(y + ((next[1] - y) * step) / steps),
          "·",
          dim
        );
      putText(
        grid,
        x,
        y,
        Math.floor(time * 2 + index) % 3 === 0 ? "✦" : "*",
        accent
      );
    }
    return finishGrid(grid);
  }
  if (name === "Maze generation") {
    const reveal = Math.floor((time * width * 5) % (width * height + width));
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (
          y * width + x < reveal &&
          (x % 4 === 0 || (y % 2 === 0 && hash(x * 17 + y * 31) > 0.42))
        )
          putText(grid, x, y, x % 4 === 0 ? "│" : "─", muted);
    putText(
      grid,
      Math.min(width - 1, reveal % width),
      Math.min(height - 1, Math.floor(reveal / width)),
      "◆",
      warning
    );
    return finishGrid(grid);
  }
  if (name === "Game of Life") {
    let cells = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => hash(x * 71 + y * 113) > 0.72)
    );
    for (
      let generation = 0;
      generation < Math.floor(time * 4) % 18;
      generation++
    )
      cells = cells.map((row, y) =>
        row.map((alive, x) => {
          let neighbors = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++)
              if (
                (dx !== 0 || dy !== 0) &&
                cells[(y + dy + height) % height]?.[(x + dx + width) % width]
              )
                neighbors++;
          return neighbors === 3 || (alive && neighbors === 2);
        })
      );
    return cells.map((row) =>
      row.map((alive) => (alive ? success("■") : " ")).join("")
    );
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = 0;
      if (name === "Mandelbrot") {
        let real = 0;
        let imaginary = 0;
        const zoom = 1 + ((Math.sin(time * 0.45) + 1) / 2) * 0.7;
        const cr = ((x / width) * 3.2 - 2.3) / zoom - 0.12;
        const ci = ((y / height) * 2.2 - 1.1) / zoom;
        let iteration = 0;
        while (real * real + imaginary * imaginary < 4 && iteration < 18) {
          [real, imaginary] = [
            real * real - imaginary * imaginary + cr,
            2 * real * imaginary + ci,
          ];
          iteration++;
        }
        value = iteration / 18;
      } else if (name === "Metaballs") {
        value =
          5 /
            (1 +
              Math.hypot(
                x - width * (0.35 + Math.sin(time) * 0.15),
                y - height * 0.4
              )) +
          5 /
            (1 +
              Math.hypot(
                x - width * (0.65 + Math.cos(time * 0.8) * 0.13),
                y - height * 0.65
              ));
        value /= 2.5;
      } else {
        value =
          (Math.sin(x * 0.28 + time) * Math.cos(y * 0.47 - time * 0.7) +
            Math.sin((x + y) * 0.12 - time)) /
            4 +
          0.5;
      }
      const glyphs = name === "Reaction-diffusion" ? " .:+#@" : " .·oO@";
      const glyph =
        glyphs[
          Math.max(
            0,
            Math.min(glyphs.length - 1, Math.floor(value * glyphs.length))
          )
        ] ?? " ";
      putText(grid, x, y, glyph, (character) =>
        fg(
          80 + Math.round(value * 100),
          120 + Math.round(value * 120),
          210,
          character
        )
      );
    }
  }
  return finishGrid(grid);
};

const renderGame = (
  name: string,
  width: number,
  height: number,
  time: number
) => {
  if (name === "Growing pipes") return scenes[5].render(width, height, time);
  const grid = makeGrid(width, height);
  if (name === "Snake") {
    const length = Math.min(18, Math.floor(width / 3));
    for (let segment = 0; segment < length; segment++) {
      const step = Math.floor(time * 9) - segment;
      const x =
        (((step % Math.max(1, width - 4)) + width) % Math.max(1, width - 4)) +
        2;
      const y = Math.round(
        height / 2 + Math.sin(step * 0.32) * Math.min(5, height / 3)
      );
      putText(
        grid,
        x,
        y,
        segment === 0 ? "@" : "o",
        segment === 0 ? warning : success
      );
    }
    return finishGrid(grid);
  }
  if (name === "Pong") {
    const leftY =
      Math.round(((Math.sin(time * 1.4) + 1) * (height - 5)) / 2) + 1;
    const rightY =
      Math.round(((Math.sin(time * 1.7 + 2) + 1) * (height - 5)) / 2) + 1;
    for (let y = 0; y < 4; y++) {
      putText(grid, 2, leftY + y, "█", accent);
      putText(grid, width - 3, rightY + y, "█", warning);
    }
    const span = Math.max(1, width - 8);
    const phase = (time * 18) % (span * 2);
    const x = Math.round(phase < span ? phase : span * 2 - phase) + 4;
    putText(
      grid,
      x,
      Math.round(height / 2 + Math.sin(time * 2.2) * height * 0.35),
      "●",
      success
    );
    return finishGrid(grid);
  }
  if (name === "Tetris") {
    for (let y = height - 1; y >= Math.max(0, height - 5); y--)
      for (
        let x = Math.floor(width / 2) - 8;
        x < Math.floor(width / 2) + 8;
        x++
      )
        if (hash(x * 17 + y * 31) > 0.35)
          putText(grid, x, y, "█", (character) =>
            fg(80 + ((x * 19) % 150), 180, 220, character)
          );
    const fallingY = Math.floor((time * 5) % Math.max(1, height - 6));
    const fallingX = Math.floor(width / 2) - 1 + Math.round(Math.sin(time) * 5);
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
    ] as const)
      putText(grid, fallingX + dx, fallingY + dy, "█", warning);
    return finishGrid(grid);
  }
  for (let index = 0; index < Math.max(2, Math.floor(width / 14)); index++) {
    const x =
      Math.floor((index * 14 + time * (2 + (index % 3))) % (width + 10)) - 5;
    const y = height - 2 - (index % 3);
    putText(
      grid,
      x,
      y,
      Math.floor(time * 4 + index) % 2 ? "(V)°,,°(V)" : "(v)°..°(v)",
      warning
    );
  }
  return finishGrid(grid);
};

const renderSprite = (
  name: string,
  width: number,
  height: number,
  time: number
) => {
  if (name === "Aquarium") return scenes[6].render(width, height, time);
  if (name === "Amiga ball") {
    const ballGrid = makeGrid(width, height);
    const radiusY = Math.max(3, Math.min(height * 0.32, width * 0.13));
    const radiusX = radiusY * 1.9;
    const ballX = width / 2 + Math.sin(time * 1.1) * (width / 2 - radiusX - 2);
    const floorY = height - 2;
    const ballY =
      floorY -
      radiusY -
      Math.abs(Math.sin(time * 2.4)) * (height - 2 * radiusY - 3);
    const spin = time * 2.6;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const nx = (x - ballX) / radiusX;
        const ny = (y - ballY) / radiusY;
        const d2 = nx * nx + ny * ny;
        if (d2 > 1) continue;
        const nz = Math.sqrt(1 - d2);
        const latitude = Math.asin(Math.max(-1, Math.min(1, ny)));
        const longitude = Math.atan2(nx, nz) + spin;
        const checker =
          parity(
            Math.floor((latitude / Math.PI) * 4 + 8) +
              Math.floor((longitude / Math.PI) * 4 + 8)
          ) === 0;
        const level = 0.5 + 0.5 * nz;
        const row = ballGrid[y];
        if (row)
          row[x] = checker
            ? fg(
                Math.round(235 * level),
                Math.round(60 * level),
                Math.round(60 * level),
                "█"
              )
            : fg(
                Math.round(245 * level),
                Math.round(240 * level),
                Math.round(235 * level),
                "█"
              );
      }
    }
    const shadowRow = ballGrid[floorY + 1];
    if (shadowRow) {
      const shadowHalf = Math.round(radiusX * 0.8);
      for (let dx = -shadowHalf; dx <= shadowHalf; dx++) {
        const x = Math.round(ballX + dx + 2);
        if (x >= 0 && x < width) shadowRow[x] = fg(50, 50, 65, "▒");
      }
    }
    return finishGrid(ballGrid);
  }
  const grid = makeGrid(width, height);
  if (name === "Nyan Cat") {
    const cat = [" /\_/\\", "( o.o )", " > ^ <"];
    const x = Math.floor((time * 8) % (width + 14)) - 10;
    const y = Math.max(2, Math.floor(height / 2) - 1);
    for (let trail = 0; trail < Math.max(0, x); trail++) {
      const colors = [
        [255, 90, 90],
        [255, 180, 70],
        [250, 235, 90],
        [90, 220, 120],
        [90, 160, 255],
        [180, 100, 240],
      ] as const;
      const color = colors[(trail + Math.floor(time * 8)) % colors.length]!;
      putText(
        grid,
        trail,
        y + ((trail + Math.floor(time * 5)) % 2),
        "=",
        (character) => fg(color[0], color[1], color[2], character)
      );
    }
    for (const [row, line] of cat.entries())
      putText(grid, x, y - 1 + row, line, row === 1 ? warning : accent);
    return finishGrid(grid);
  }
  if (name === "Dancing parrot") {
    const frames = [
      ["  __", "<(o )___", " ( ._> /", "  `---'"],
      [" __", "( o)>___", " \\ <_. )", "  `---'"],
      ["  __", "<(o )___", " / <_. )", "  `---'"],
    ];
    const frame = frames[Math.floor(time * 5) % frames.length]!;
    return body(
      frame.map((line, index) =>
        center(index === 1 ? success(line) : accent(line), width)
      ),
      width,
      height
    );
  }
  if (name === "Pet dog") {
    const tail = Math.floor(time * 6) % 2 ? "/" : "\\";
    const dog = [
      " / \__",
      `(    @\___${tail}`,
      " /         O",
      "/   (_____/",
      "/_____/   U",
    ];
    const hop = Math.floor(time * 4) % 4 === 0 ? -1 : 0;
    return body(
      [
        ...Array.from(
          { length: Math.max(0, Math.floor(height / 2) - 3 + hop) },
          () => ""
        ),
        ...dog.map((line) => center(warning(line), width)),
      ],
      width,
      height
    );
  }
  const train = [
    "      ====        ________                ___________",
    "  _D _|  |_______/        \\__I_I_____===__|_________|",
    "   |(_)---  |   H\\________/ |   |        =|___ ___|",
    "   /     |  |   H  |  |     |   |         ||_| |_||",
    "  |      |  |   H  |__--------------------| [___] |",
    "  | ________|___H__/__|_____/[][]~\\_______|       |",
    "  |/ |   |-----------I_____I [][] []  D   |=======|__",
    "__/ =| o |=-~~\\  /~~\\  /~~\\  /~~\\ ____Y___________",
    " |/-=|___|=    ||    ||    ||    |_____/~\\___/",
  ];
  const x = width - Math.floor((time * 13) % (width + 68));
  for (const [row, line] of train.entries())
    putText(
      grid,
      x,
      Math.floor((height - train.length) / 2) + row,
      line,
      row < 2 ? accent : muted
    );
  return finishGrid(grid);
};

const renderGrowth = (
  name: string,
  width: number,
  height: number,
  time: number
) => {
  if (name === "Bonsai growth") return scenes[7].render(width, height, time);
  if (name === "Startup reveal") {
    const logo = [
      "┌──────────────────┐",
      "│  TERMINAL MOTION │",
      "└──────────────────┘",
    ];
    const reveal = Math.floor((time * 18) % 70);
    let remaining = reveal;
    return body(
      logo.map((line) => {
        const shown = line.slice(
          0,
          Math.max(0, Math.min(line.length, remaining))
        );
        remaining -= line.length;
        return center(accent(shown), width);
      }),
      width,
      height
    );
  }
  if (name === "VT100 theater") {
    const actorX = Math.floor((time * 7) % Math.max(1, width - 16));
    const lines = [
      center(warning("\\\\\\  NOW PLAYING  /////"), width),
      "",
      fit(`${" ".repeat(actorX)}  o`, width),
      fit(`${" ".repeat(actorX)} /|\\`, width),
      fit(`${" ".repeat(actorX)} / \\`, width),
      "",
      center(
        dim(`FRAME ${String(Math.floor(time * 12)).padStart(5, "0")} · 12 FPS`),
        width
      ),
    ];
    return body(lines, width, height);
  }
  const grid = makeGrid(width, height);
  const scale = Math.max(
    1,
    Math.min(3, Math.floor(Math.min(width / 18, height / 9)))
  );
  const frames = [
    ["  ##  ", " #### ", "######", "##  ##", " #### "],
    [" #  # ", "######", " #### ", "######", " #  # "],
    ["######", "# ## #", " #### ", "# ## #", "######"],
  ];
  const sprite = frames[Math.floor(time * 2) % frames.length]!;
  for (const [row, line] of sprite.entries())
    for (const [column, character] of [...line].entries())
      if (character !== " ")
        for (let dy = 0; dy < scale; dy++)
          putText(
            grid,
            Math.floor(width / 2) -
              (sprite[0]!.length * scale) / 2 +
              column * scale,
            Math.floor(height / 2) -
              (sprite.length * scale) / 2 +
              row * scale +
              dy,
            "█".repeat(scale),
            (cell) => fg(100 + column * 20, 140 + row * 18, 235, cell)
          );
  return finishGrid(grid);
};

const drawLine = (
  grid: string[][],
  from: readonly [number, number],
  to: readonly [number, number],
  glyph = "·"
) => {
  const steps = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]));
  for (let step = 0; step <= steps; step++)
    putText(
      grid,
      Math.round(from[0] + ((to[0] - from[0]) * step) / Math.max(1, steps)),
      Math.round(from[1] + ((to[1] - from[1]) * step) / Math.max(1, steps)),
      glyph,
      muted
    );
};

const renderSpace = (
  name: string,
  width: number,
  height: number,
  time: number
) => {
  const grid = makeGrid(width, height);
  if (name === "Starfield") {
    for (let index = 0; index < Math.min(220, width * 3); index++) {
      const z = ((((hash(index * 5) - time * 0.13) % 1) + 1) % 1) + 0.06;
      const x = Math.round(
        width / 2 + ((hash(index * 5 + 1) * 2 - 1) / z) * width * 0.16
      );
      const y = Math.round(
        height / 2 + ((hash(index * 5 + 2) * 2 - 1) / z) * height * 0.16
      );
      putText(
        grid,
        x,
        y,
        z < 0.28 ? "*" : z < 0.6 ? "+" : ".",
        z < 0.28 ? accent : dim
      );
    }
    return finishGrid(grid);
  }
  if (name === "Fireworks") {
    for (let burst = 0; burst < 3; burst++) {
      const age = (time + burst * 1.1) % 3;
      const centerX = Math.floor(
        width * (0.25 + hash(burst * 17 + Math.floor(time / 3)) * 0.5)
      );
      const centerY = Math.floor(height * (0.25 + hash(burst * 23) * 0.25));
      for (let particle = 0; particle < 28; particle++) {
        const angle = (particle / 28) * Math.PI * 2;
        const speed = 3 + hash(particle * 7 + burst) * 8;
        putText(
          grid,
          Math.round(centerX + Math.cos(angle) * speed * age),
          Math.round(
            centerY + Math.sin(angle) * speed * age * 0.45 + age * age
          ),
          age < 1.3 ? "*" : ".",
          particle % 2 ? warning : accent
        );
      }
    }
    return finishGrid(grid);
  }
  if (name === "Black hole") {
    for (let arm = 0; arm < 7; arm++)
      for (let point = 2; point < Math.min(width, height * 3); point++) {
        const radius = point * 0.42;
        const angle = arm + point * 0.22 - time * (1 + 12 / point);
        putText(
          grid,
          Math.round(width / 2 + Math.cos(angle) * radius * 1.8),
          Math.round(height / 2 + Math.sin(angle) * radius * 0.55),
          point < 7 ? "@" : ".",
          point < 10 ? warning : dim
        );
      }
    return finishGrid(grid);
  }
  if (name === "3D heart") {
    for (let index = 0; index < 180; index++) {
      const angle = (index / 180) * Math.PI * 2;
      const x = 16 * Math.sin(angle) ** 3;
      const y =
        13 * Math.cos(angle) -
        5 * Math.cos(2 * angle) -
        2 * Math.cos(3 * angle) -
        Math.cos(4 * angle);
      const wobble = 0.75 + Math.sin(time * 2) * 0.08;
      putText(
        grid,
        Math.round(width / 2 + x * wobble),
        Math.round(height / 2 - y * 0.35),
        "♥",
        (character) => fg(235, 70 + (index % 80), 120, character)
      );
    }
    return finishGrid(grid);
  }
  if (name === "3D cube") {
    const vertices = [-1, 1].flatMap((x) =>
      [-1, 1].flatMap((y) => [-1, 1].map((z) => [x, y, z] as const))
    );
    const points = vertices.map(([x, y, z]) => {
      const rx = x * Math.cos(time) - z * Math.sin(time);
      const rz = x * Math.sin(time) + z * Math.cos(time);
      const ry = y * Math.cos(time * 0.7) - rz * Math.sin(time * 0.7);
      return [
        Math.round(width / 2 + rx * Math.min(12, width / 5)),
        Math.round(height / 2 + ry * Math.min(5, height / 3)),
      ] as const;
    });
    for (let a = 0; a < vertices.length; a++)
      for (let b = a + 1; b < vertices.length; b++) {
        const differences = vertices[a]!.filter(
          (value, axis) => value !== vertices[b]![axis]
        ).length;
        if (differences === 1) drawLine(grid, points[a]!, points[b]!);
      }
    for (const point of points) putText(grid, ...point, "◆", accent);
    return finishGrid(grid);
  }
  for (let a = 0; a < Math.PI * 2; a += 0.22)
    for (let b = 0; b < Math.PI * 2; b += 0.18) {
      const x = (2 + Math.cos(b)) * Math.cos(a);
      const y = (2 + Math.cos(b)) * Math.sin(a);
      const z = Math.sin(b);
      const rx = x * Math.cos(time) - y * Math.sin(time);
      const ry = x * Math.sin(time) + y * Math.cos(time);
      const py = z * Math.cos(time * 0.7) - ry * Math.sin(time * 0.7);
      putText(
        grid,
        Math.round(width / 2 + rx * Math.min(6, width / 14)),
        Math.round(height / 2 + py * Math.min(2.2, height / 8)),
        "·",
        (character) => fg(100 + Math.round((z + 1) * 60), 170, 235, character)
      );
    }
  return finishGrid(grid);
};

const renderDashboard = (
  name: string,
  width: number,
  height: number,
  time: number
) => {
  if (name === "Audio equalizer") {
    const columns = Math.max(8, Math.floor(width / 3));
    const chartHeight = Math.max(4, height - 2);
    const lines: string[] = [];
    for (let row = chartHeight; row > 0; row--)
      lines.push(
        center(
          Array.from({ length: columns }, (_, index) => {
            const value =
              (Math.sin(index * 0.7 + time * 5) +
                Math.sin(index * 0.17 - time * 2) +
                2) /
              4;
            return value >= row / chartHeight
              ? fg(70 + row * 8, 220 - row * 4, 180, "██")
              : "  ";
          }).join(" "),
          width
        )
      );
    return body(lines, width, height);
  }
  if (name === "Live charts") return scenes[4].render(width, height, time);
  if (name === "Terminal clock") {
    const now = new Date(Date.now() + time * 1000);
    const clock = now.toLocaleTimeString("en-GB", { hour12: false });
    const date = now.toLocaleDateString("en-CA");
    return body(
      [center(bold(accent(clock)), width), center(dim(date), width)],
      width,
      height
    );
  }
  const leftWidth = Math.floor(width / 2) - 1;
  const lines = Array.from({ length: height }, (_, row) => {
    const log = `[${String(Math.floor(time * 12) + row).padStart(5, "0")}] ${"abcdef0123456789"[(row + Math.floor(time * 5)) % 16]} process ${row % 4}`;
    const hex = Array.from(
      { length: Math.max(1, Math.floor((width - leftWidth - 3) / 3)) },
      (_, index) =>
        ((index * 17 + row * 31 + Math.floor(time * 30)) % 256)
          .toString(16)
          .padStart(2, "0")
    ).join(" ");
    return (
      fit(dim(log), leftWidth) +
      accent("│") +
      fit(row % 3 === 0 ? success(hex) : muted(hex), width - leftWidth - 1)
    );
  });
  return lines;
};

const QUADRANT_GLYPHS = [
  " ",
  "▘",
  "▝",
  "▀",
  "▖",
  "▌",
  "▞",
  "▛",
  "▗",
  "▚",
  "▐",
  "▜",
  "▄",
  "▙",
  "▟",
  "█",
] as const;
const OCTANT_GLYPHS = [
  ..." 𜺨𜺫🮂𜴀▘𜴁𜴂𜴃𜴄▝𜴅𜴆𜴇𜴈▀𜴉𜴊𜴋𜴌🯦𜴍𜴎𜴏𜴐𜴑𜴒𜴓𜴔𜴕𜴖𜴗𜴘𜴙𜴚𜴛𜴜𜴝𜴞𜴟🯧𜴠𜴡𜴢𜴣𜴤𜴥𜴦𜴧𜴨𜴩𜴪𜴫𜴬𜴭𜴮𜴯𜴰𜴱𜴲𜴳𜴴𜴵🮅𜺣𜴶𜴷𜴸𜴹𜴺𜴻𜴼𜴽𜴾𜴿𜵀𜵁𜵂𜵃𜵄▖𜵅𜵆𜵇𜵈▌𜵉𜵊𜵋𜵌▞𜵍𜵎𜵏𜵐▛𜵑𜵒𜵓𜵔𜵕𜵖𜵗𜵘𜵙𜵚𜵛𜵜𜵝𜵞𜵟𜵠𜵡𜵢𜵣𜵤𜵥𜵦𜵧𜵨𜵩𜵪𜵫𜵬𜵭𜵮𜵯𜵰𜺠𜵱𜵲𜵳𜵴𜵵𜵶𜵷𜵸𜵹𜵺𜵻𜵼𜵽𜵾𜵿𜶀𜶁𜶂𜶃𜶄𜶅𜶆𜶇𜶈𜶉𜶊𜶋𜶌𜶍𜶎𜶏▗𜶐𜶑𜶒𜶓▚𜶔𜶕𜶖𜶗▐𜶘𜶙𜶚𜶛▜𜶜𜶝𜶞𜶟𜶠𜶡𜶢𜶣𜶤𜶥𜶦𜶧𜶨𜶩𜶪𜶫▂𜶬𜶭𜶮𜶯𜶰𜶱𜶲𜶳𜶴𜶵𜶶𜶷𜶸𜶹𜶺𜶻𜶼𜶽𜶾𜶿𜷀𜷁𜷂𜷃𜷄𜷅𜷆𜷇𜷈𜷉𜷊𜷋𜷌𜷍𜷎𜷏𜷐𜷑𜷒𜷓𜷔𜷕𜷖𜷗𜷘𜷙𜷚▄𜷛𜷜𜷝𜷞▙𜷟𜷠𜷡𜷢▟𜷣▆𜷤𜷥█",
] as const;
const sextantGlyph = (bits: number) => {
  if (bits === 0) return " ";
  if (bits === 21) return "▌";
  if (bits === 42) return "▐";
  if (bits === 63) return "█";
  return String.fromCodePoint(
    0x1_fb00 + bits - 1 - Number(bits > 21) - Number(bits > 42)
  );
};
const subcellPanel = (
  cols: number,
  rows: number,
  subX: number,
  subY: number,
  weights: readonly number[],
  glyph: (bits: number) => string,
  lit: (nx: number, ny: number) => boolean
) => {
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = "";
    for (let x = 0; x < cols; x++) {
      let bits = 0;
      for (let dy = 0; dy < subY; dy++) {
        for (let dx = 0; dx < subX; dx++) {
          if (
            lit(
              (x * subX + dx) / (cols * subX),
              (y * subY + dy) / (rows * subY)
            )
          )
            bits |= weights[dy * subX + dx] ?? 0;
        }
      }
      line += glyph(bits);
    }
    lines.push(line);
  }
  return lines;
};
const parity = (value: number) => ((value % 2) + 2) % 2;

const renderLayers = (
  name: string,
  width: number,
  height: number,
  time: number
) => {
  if (name === "Blitter ladder") {
    const modes = [
      {
        label: "1×1",
        subX: 1,
        subY: 1,
        weights: [1],
        glyph: (bits: number) => (bits ? "#" : " "),
      },
      {
        label: "half",
        subX: 1,
        subY: 2,
        weights: [1, 2],
        glyph: (bits: number) => [" ", "▀", "▄", "█"][bits] ?? " ",
      },
      {
        label: "quad",
        subX: 2,
        subY: 2,
        weights: [1, 2, 4, 8],
        glyph: (bits: number) => QUADRANT_GLYPHS[bits] ?? " ",
      },
      {
        label: "sext",
        subX: 2,
        subY: 3,
        weights: [1, 2, 4, 8, 16, 32],
        glyph: sextantGlyph,
      },
      {
        label: "oct",
        subX: 2,
        subY: 4,
        weights: [1, 2, 4, 8, 16, 32, 64, 128],
        glyph: (bits: number) => OCTANT_GLYPHS[bits] ?? " ",
      },
      {
        label: "braille",
        subX: 2,
        subY: 4,
        weights: [1, 8, 2, 16, 4, 32, 64, 128],
        glyph: (bits: number) =>
          bits ? String.fromCodePoint(0x2800 + bits) : " ",
      },
    ];
    const cols = Math.max(
      4,
      Math.floor((width - modes.length + 1) / modes.length)
    );
    const rows = Math.max(3, height - 2);
    const centerX = 0.5 + 0.28 * Math.cos(time * 1.5);
    const centerY = 0.5 + 0.24 * Math.sin(time * 2.1);
    const radius = 0.24 + 0.07 * Math.sin(time * 3.2);
    const lit = (nx: number, ny: number) =>
      (nx - centerX) ** 2 + (ny - centerY) ** 2 < radius ** 2;
    const panels = modes.map((mode) =>
      subcellPanel(
        cols,
        rows,
        mode.subX,
        mode.subY,
        mode.weights,
        mode.glyph,
        lit
      )
    );
    return body(
      [
        modes.map((mode) => center(dim(mode.label), cols)).join(" "),
        ...Array.from({ length: rows }, (_, row) =>
          panels.map((panel) => fit(accent(panel[row] ?? ""), cols)).join(" ")
        ),
      ],
      width,
      height
    );
  }
  if (name === "Quadrant mosaic" || name === "Compact quadrant mosaic") {
    const compact = name === "Compact quadrant mosaic";
    const rows = compact
      ? Math.max(4, Math.min(12, height - 3))
      : Math.max(4, height - 1);
    const cols = compact
      ? Math.max(8, Math.min(48, width - 4))
      : Math.max(8, Math.min(width, 100));
    const pixel = (px: number, py: number) => {
      const nx = px / (cols * 2);
      const ny = py / (rows * 2);
      const glowA = Math.exp(
        -18 *
          ((nx - 0.5 - 0.3 * Math.cos(time * 1.3)) ** 2 +
            (ny - 0.5 - 0.3 * Math.sin(time * 1.7)) ** 2)
      );
      const glowB = Math.exp(
        -14 *
          ((nx - 0.5 + 0.32 * Math.cos(time * 0.9)) ** 2 +
            (ny - 0.5 + 0.26 * Math.sin(time * 1.1)) ** 2)
      );
      return [
        Math.min(255, Math.round(30 + 225 * glowA + 40 * glowB)),
        Math.min(255, Math.round(20 + 90 * glowA + 160 * glowB)),
        Math.min(255, Math.round(50 + 40 * glowA + 235 * glowB)),
      ];
    };
    const average = (colors: number[][], fallback: number[]) =>
      colors.length === 0
        ? fallback
        : colors
            .reduce(
              (sum, color) =>
                sum.map((value, index) => value + (color[index] ?? 0)),
              [0, 0, 0]
            )
            .map((total) => Math.round(total / colors.length));
    const lines: string[] = [];
    for (let y = 0; y < rows; y++) {
      let line = "";
      for (let x = 0; x < cols; x++) {
        const samples = [
          pixel(x * 2, y * 2),
          pixel(x * 2 + 1, y * 2),
          pixel(x * 2, y * 2 + 1),
          pixel(x * 2 + 1, y * 2 + 1),
        ];
        const luma = samples.map(
          ([r, g, b]) => 0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0)
        );
        const mean = luma.reduce((sum, value) => sum + value, 0) / luma.length;
        const weights = [1, 2, 4, 8];
        let bits = 0;
        const litColors: number[][] = [];
        const unlitColors: number[][] = [];
        for (const [index, value] of luma.entries()) {
          if (value >= mean) {
            bits |= weights[index] ?? 0;
            litColors.push(samples[index] ?? [0, 0, 0]);
          } else {
            unlitColors.push(samples[index] ?? [0, 0, 0]);
          }
        }
        const front = average(litColors, [0, 0, 0]);
        const back = average(unlitColors, front);
        line += style(
          `38;2;${front.join(";")};48;2;${back.join(";")}`,
          QUADRANT_GLYPHS[bits] ?? " "
        );
      }
      lines.push(center(compact ? dim("│") + line + dim("│") : line, width));
    }
    if (compact) {
      lines.unshift(center(dim(`╭${"─".repeat(cols)}╮`), width));
      lines.push(center(dim(`╰${"─".repeat(cols)}╯`), width));
    }
    return body(lines, width, height);
  }
  if (name === "CRT afterglow") {
    const feed = [
      "$ make release",
      "cc -O2 core.c -o core.o",
      "cc -O2 tui.c -o tui.o",
      "link core.o tui.o -o app",
      "tests: 148 passed, 0 failed",
      "$ ./app --demo",
      "booting motion gallery",
      "loading scenes",
      "ready.",
    ];
    const rows = Math.max(4, height - 1);
    const flicker = 1 - 0.18 * hash(Math.floor(time * 9));
    const band = ((time * 9) % (rows + 8)) - 4;
    const lines: string[] = [];
    for (let row = 0; row < rows; row++) {
      const text = feed[(row + Math.floor(time * 1.4)) % feed.length] ?? "";
      const wobble = 2 + Math.round(Math.sin(row * 0.7 + time * 3.1) * 1.4);
      const near = Math.abs(row - band) < 2 ? 1.45 : 1;
      const level = (row % 2 === 0 ? 1 : 0.55) * flicker * near;
      const channel = (value: number) =>
        Math.min(255, Math.round(value * level));
      lines.push(
        fit(
          " ".repeat(Math.max(0, wobble)) +
            fg(channel(90), channel(235), channel(140), text),
          width
        )
      );
    }
    return body(lines, width, height);
  }
  if (name === "RGB split glow") {
    const message = "SHADER GLOW";
    const shift = Math.round(2.4 * Math.sin(time * 2.2));
    const startX = Math.max(0, Math.floor((width - message.length) / 2));
    const layerBits = new Map<number, number>();
    for (const [offset, bit] of [
      [-shift, 1],
      [0, 2],
      [shift, 4],
    ] as const) {
      for (const [index, character] of [...message].entries()) {
        if (character === " ") continue;
        const column = startX + index + offset;
        if (column >= 0 && column < width)
          layerBits.set(column, (layerBits.get(column) ?? 0) | bit);
      }
    }
    const palette: Record<number, [number, number, number]> = {
      1: [255, 90, 90],
      2: [90, 255, 130],
      3: [245, 240, 120],
      4: [100, 150, 255],
      5: [250, 120, 250],
      6: [110, 240, 245],
      7: [255, 255, 255],
    };
    let textRow = "";
    for (let column = 0; column < width; column++) {
      const bits = layerBits.get(column) ?? 0;
      if (bits === 0) {
        textRow += " ";
        continue;
      }
      const [r, g, b] = palette[bits] ?? [255, 255, 255];
      const character = bits & 2 ? (message[column - startX] ?? "█") : "█";
      textRow += fg(r, g, b, character);
    }
    return body(
      [textRow, "", center(dim("chromatic aberration"), width)],
      width,
      height
    );
  }
  if (name === "Cell damage map") {
    const rows = Math.max(6, height - 2);
    const cols = Math.max(20, Math.min(width, 72));
    const paint = (at: number) => {
      const grid = makeGrid(cols, rows);
      putText(
        grid,
        1,
        0,
        `frame ${String(Math.max(0, Math.floor(at * FPS))).padStart(5, "0")}`
      );
      putText(grid, 1, rows - 1, "static footer");
      const x = Math.round((0.5 + 0.42 * Math.sin(at * 1.5)) * (cols - 3));
      const y = 1 + Math.round(Math.abs(Math.sin(at * 2.3)) * (rows - 4));
      putText(grid, Math.max(0, x - 2), y, "·");
      putText(grid, x, y, "●");
      return grid;
    };
    const current = paint(time);
    const previous = paint(time - 1 / FPS);
    let changed = 0;
    const lines = current.map((rowCells, y) =>
      rowCells
        .map((cell, x) => {
          if (cell === previous[y]?.[x]) return cell === " " ? " " : dim(cell);
          changed += 1;
          return style(
            "48;2;180;100;30;38;2;255;220;150",
            cell === " " ? "·" : cell
          );
        })
        .join("")
    );
    const total = cols * rows;
    lines.push(
      dim(
        `emitted ${changed} cells · elided ${total - changed} (${Math.round(((total - changed) / total) * 100)}%)`
      )
    );
    return body(
      lines.map((line) => center(line, width)),
      width,
      height
    );
  }
  if (name === "Bloom glow") {
    const message = "BLOOM";
    const textStart = Math.floor((width - message.length) / 2);
    const textRow = Math.floor(height / 2) - 1;
    const pulse = 0.55 + 0.45 * Math.sin(time * 2.5);
    const lines: string[] = [];
    for (let y = 0; y < height; y++) {
      let line = "";
      for (let x = 0; x < width; x++) {
        if (y === textRow && x >= textStart && x < textStart + message.length) {
          line += bold(fg(255, 250, 230, message[x - textStart] ?? " "));
          continue;
        }
        let nearest = Number.POSITIVE_INFINITY;
        for (let index = 0; index < message.length; index++) {
          const dx = (x - (textStart + index)) * 0.55;
          const dy = y - textRow;
          nearest = Math.min(nearest, dx * dx + dy * dy);
        }
        const halo = pulse * Math.exp(-nearest * 0.16);
        if (halo < 0.06) {
          line += " ";
          continue;
        }
        const shade = halo > 0.5 ? "▓" : halo > 0.22 ? "▒" : "░";
        line += fg(
          Math.round(255 * halo),
          Math.round(200 * halo),
          Math.round(110 * halo),
          shade
        );
      }
      lines.push(line);
    }
    lines.push(center(dim("additive halo · ghostty bloom family"), width));
    return body(lines, width, height);
  }
  if (name === "Cursor smear") {
    const grid = makeGrid(width, height);
    const backdrop = "const frame = render(scene, camera);  ";
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const character = backdrop[(x + y * 7) % backdrop.length] ?? " ";
        if (character !== " ") {
          const row = grid[y];
          if (row) row[x] = fg(70, 78, 96, character);
        }
      }
    }
    const target = (segment: number) => ({
      x: 2 + Math.floor(hash(segment * 13 + 1) * (width - 5)),
      y: Math.floor(hash(segment * 29 + 2) * height),
    });
    const positionAt = (at: number) => {
      const segment = Math.floor(at / 0.9);
      const eased = 1 - (1 - Math.min(1, ((at % 0.9) / 0.9) * 1.7)) ** 3;
      const from = target(segment - 1);
      const to = target(segment);
      return {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
      };
    };
    const trail = ["░", "▒", "▒", "▓", "▓", "▓"];
    for (const [index, shade] of trail.entries()) {
      const at = positionAt(time - (trail.length - index) * 0.035);
      const row = grid[Math.round(at.y)];
      const level = (index + 1) / (trail.length + 1);
      if (row && Math.round(at.x) >= 0 && Math.round(at.x) < width)
        row[Math.round(at.x)] = fg(
          Math.round(121 * level),
          Math.round(192 * level),
          Math.round(255 * level),
          shade
        );
    }
    const head = positionAt(time);
    const headRow = grid[Math.round(head.y)];
    if (headRow && Math.round(head.x) >= 0 && Math.round(head.x) < width)
      headRow[Math.round(head.x)] = fg(200, 230, 255, "█");
    return finishGrid(grid);
  }
  const period = 2.6;
  const segment = Math.floor(time / period);
  const localTime = time - segment * period;
  const margin = 2;
  const span = Math.max(12, width - margin * 2 - 1);
  const inset = Math.max(2, Math.floor(span * 0.12));
  const [from, to] =
    segment % 2 === 0 ? [inset, span - inset] : [span - inset, inset];
  const omega = 7;
  const zeta = 0.55;
  const dampedOmega = omega * Math.sqrt(1 - zeta * zeta);
  const eased = Math.min(1, localTime / 1.1);
  const racers = [
    ["linear", from + (to - from) * eased],
    ["ease-out", from + (to - from) * (1 - (1 - eased) ** 3)],
    [
      "spring",
      to +
        (from - to) *
          Math.exp(-zeta * omega * localTime) *
          (Math.cos(dampedOmega * localTime) +
            ((zeta * omega) / dampedOmega) * Math.sin(dampedOmega * localTime)),
    ],
  ] as const;
  const lines = racers.flatMap(([label, position]) => {
    const cells = Array.from({ length: span + 1 }, () => dim("─"));
    cells[to] = warning("┃");
    const index = Math.max(0, Math.min(span, Math.round(position)));
    cells[index] = label === "spring" ? success("●") : accent("●");
    return [
      fit(` ${label}`, width),
      fit(" ".repeat(margin) + cells.join(""), width),
      "",
    ];
  });
  lines.push(center(dim("closed-form damped spring vs fixed easing"), width));
  return body(lines, width, height);
};

const renderDemoscene = (
  name: string,
  width: number,
  height: number,
  time: number
) => {
  if (name === "Rotozoomer") {
    const angle = time * 0.8;
    const zoom = 0.16 + 0.1 * (1 + Math.sin(time * 0.9));
    const cosA = Math.cos(angle) * zoom;
    const sinA = Math.sin(angle) * zoom;
    const lines: string[] = [];
    for (let y = 0; y < height; y++) {
      let line = "";
      for (let x = 0; x < width; x++) {
        const dx = x - width / 2;
        const dy = (y - height / 2) * 2;
        const u = dx * cosA - dy * sinA + time * 1.3;
        const v = dx * sinA + dy * cosA;
        line +=
          parity(Math.floor(u / 3) + Math.floor(v / 3)) === 0
            ? fg(180, 120, 240, "▓")
            : fg(90, 200, 190, "░");
      }
      lines.push(line);
    }
    return lines;
  }
  if (name === "Tunnel flight") {
    const lines: string[] = [];
    for (let y = 0; y < height; y++) {
      let line = "";
      for (let x = 0; x < width; x++) {
        const dx = (x - width / 2) * 0.55;
        const dy = y - height / 2 + 0.5;
        const dist = Math.hypot(dx, dy) + 0.35;
        const depth = 10 / dist + time * 5;
        const swirl = (Math.atan2(dy, dx) / Math.PI) * 6 + time * 0.8;
        const ring = parity(Math.floor(depth) + Math.floor(swirl));
        const brightness = Math.min(1, dist / (height * 0.7));
        const channel = (value: number) => Math.round(value * brightness);
        line += ring
          ? fg(channel(255), channel(170), channel(70), "▓")
          : fg(channel(150), channel(80), channel(40), "▒");
      }
      lines.push(line);
    }
    return lines;
  }
  if (name === "Kefrens bars") {
    const lines: string[] = [];
    for (let y = 0; y < height; y++) {
      const row = Array.from({ length: width }, () => " ");
      for (let past = 0; past <= y; past++) {
        const barX = Math.round(
          width / 2 +
            Math.sin(time * 2.1 + past * 0.35) * width * 0.32 +
            Math.sin(time * 1.4 + past * 0.13) * width * 0.12
        );
        const r = 150 + 100 * Math.sin(past * 0.4 + time);
        const g = 120 + 100 * Math.sin(past * 0.4 + time + 2.1);
        const b = 160 + 90 * Math.sin(past * 0.4 + time + 4.2);
        for (let dx = -1; dx <= 1; dx++) {
          const x = barX + dx;
          const level = dx === 0 ? 1 : 0.55;
          if (x >= 0 && x < width)
            row[x] = fg(
              Math.round(r * level),
              Math.round(g * level),
              Math.round(b * level),
              dx === 0 ? "█" : "▓"
            );
        }
      }
      lines.push(row.join(""));
    }
    return lines;
  }
  if (name === "Copper bars") {
    const palette = [
      [235, 80, 80],
      [235, 170, 70],
      [90, 210, 100],
      [90, 150, 240],
      [210, 100, 230],
    ];
    const lines: string[] = [];
    for (let y = 0; y < height; y++) {
      let best: { color: number[]; strength: number } | undefined;
      for (const [index, color] of palette.entries()) {
        const barY =
          height / 2 + Math.sin(time * 1.6 + index * 1.15) * height * 0.42;
        const strength = 1 - Math.abs(y - barY) / 2.6;
        if (strength > 0 && strength > (best?.strength ?? 0))
          best = { color, strength };
      }
      if (best) {
        const scale = 0.35 + 0.65 * best.strength;
        lines.push(
          fg(
            Math.round((best.color[0] ?? 0) * scale),
            Math.round((best.color[1] ?? 0) * scale),
            Math.round((best.color[2] ?? 0) * scale),
            "█".repeat(width)
          )
        );
      } else {
        lines.push(" ".repeat(width));
      }
    }
    return lines;
  }
  if (name === "Sine scroller") {
    const message =
      "GREETINGS FROM THE TERMINAL DEMOSCENE * 80 COLUMNS ARE ENOUGH FOR EVERYONE *  ";
    const grid = makeGrid(width, height);
    const step = Math.floor(time * 14);
    for (let x = 0; x < width; x++) {
      const phase = x + step;
      if (phase % 2 !== 0) continue;
      const character = message[Math.floor(phase / 2) % message.length] ?? " ";
      if (character === " ") continue;
      const y = Math.round(
        height / 2 + Math.sin(phase * 0.16) * (height / 2 - 1.5)
      );
      const hue = (Math.floor(phase / 2) % message.length) / message.length;
      const row = grid[y];
      if (row)
        row[x] = fg(
          Math.round(150 + 100 * Math.sin(hue * Math.PI * 2)),
          Math.round(150 + 100 * Math.sin(hue * Math.PI * 2 + 2.1)),
          Math.round(150 + 100 * Math.sin(hue * Math.PI * 2 + 4.2)),
          bold(character)
        );
    }
    return finishGrid(grid);
  }
  if (name === "Vector balls") {
    const grid = makeGrid(width, height);
    const pitch = time * 1.1;
    const yaw = time * 0.7;
    const balls: { x: number; y: number; z: number }[] = [];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      balls.push({ x: Math.cos(a) * 10, y: 0, z: Math.sin(a) * 10 });
      balls.push({ x: Math.cos(a) * 5, y: Math.sin(a) * 5, z: 0 });
    }
    const projected = balls.map(({ x, y, z }) => {
      const x1 = x * Math.cos(yaw) + z * Math.sin(yaw);
      const z1 = -x * Math.sin(yaw) + z * Math.cos(yaw);
      const y1 = y * Math.cos(pitch) - z1 * Math.sin(pitch);
      const z2 = y * Math.sin(pitch) + z1 * Math.cos(pitch);
      const perspective = 18 / (18 + z2);
      return {
        depth: z2,
        perspective,
        screenX: Math.round(width / 2 + x1 * perspective * 2.1),
        screenY: Math.round(height / 2 + y1 * perspective * 0.95),
      };
    });
    projected.sort((a, b) => b.depth - a.depth);
    for (const ball of projected) {
      const row = grid[ball.screenY];
      if (!row || ball.screenX < 0 || ball.screenX >= width) continue;
      const glow = Math.round(120 + 135 * Math.min(1, ball.perspective));
      row[ball.screenX] = fg(
        glow,
        glow,
        Math.min(255, glow + 30),
        ball.perspective > 1.05 ? "●" : ball.perspective > 0.88 ? "o" : "·"
      );
    }
    return finishGrid(grid);
  }
  if (name === "Shadebobs") {
    const field = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => 0)
    );
    for (let bob = 0; bob < 3; bob++) {
      for (let k = 0; k < 16; k++) {
        const at = time - k * 0.085;
        const centerX =
          width / 2 + Math.sin(at * 1.6 + bob * 2.1) * width * 0.34;
        const centerY =
          height / 2 + Math.sin(at * 2.35 + bob * 1.3) * height * 0.36;
        const strength = 1 - k / 16;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            const x = Math.round(centerX + dx);
            const y = Math.round(centerY + dy);
            const row = field[y];
            if (row && x >= 0 && x < width)
              row[x] =
                (row[x] ?? 0) +
                strength * Math.exp(-((dx * 0.55) ** 2 + dy ** 2) * 0.35);
          }
        }
      }
    }
    const shades = [" ", "░", "▒", "▓", "█"];
    return field.map((row) =>
      row
        .map((value) => {
          const index = Math.min(4, Math.floor(value * 2.2));
          if (index === 0) return " ";
          const level = Math.min(1, value / 2);
          return fg(
            Math.round(90 + 150 * level),
            Math.round(200 * level + 40),
            Math.round(90 * (1 - level) + 40),
            shades[index] ?? "█"
          );
        })
        .join("")
    );
  }
  if (name === "Moiré rings") {
    const firstX = width / 2 + Math.sin(time * 1.2) * width * 0.2;
    const firstY = height / 2 + Math.cos(time * 1.6) * height * 0.22;
    const secondX = width / 2 - Math.sin(time * 1.4) * width * 0.2;
    const secondY = height / 2 - Math.cos(time * 1.1) * height * 0.22;
    const lines: string[] = [];
    for (let y = 0; y < height; y++) {
      let line = "";
      for (let x = 0; x < width; x++) {
        const d1 = Math.hypot((x - firstX) * 0.55, y - firstY);
        const d2 = Math.hypot((x - secondX) * 0.55, y - secondY);
        line +=
          parity(Math.floor(d1 / 1.6)) === parity(Math.floor(d2 / 1.6))
            ? fg(120, 220, 235, "▒")
            : fg(35, 60, 80, "░");
      }
      lines.push(line);
    }
    return lines;
  }
  if (name === "Voxel landscape") {
    const grid = makeGrid(width, height);
    const depthBuffer = Array.from({ length: width }, () => height);
    for (let z = 3; z < 30; z++) {
      for (let x = 0; x < width; x++) {
        const worldX = (x - width / 2) * z * 0.045;
        const worldZ = z + time * 7;
        const elevation = Math.max(
          0,
          2.6 +
            1.9 * Math.sin(worldX * 0.35 + worldZ * 0.23) +
            1.3 * Math.sin(worldX * 0.21 - worldZ * 0.35)
        );
        const screenY = Math.round(2 + ((9 - elevation) * 16) / z);
        if (screenY >= (depthBuffer[x] ?? height)) continue;
        const fade = Math.max(0.2, 1 - z / 34);
        const base = elevation / 6;
        const glyph = elevation > 4.4 ? "█" : elevation > 2.5 ? "▓" : "▒";
        for (
          let y = Math.max(0, screenY);
          y < (depthBuffer[x] ?? height);
          y++
        ) {
          const row = grid[y];
          if (row)
            row[x] = fg(
              Math.round((40 + 130 * base) * fade),
              Math.round((90 + 140 * base) * fade),
              Math.round((60 + 70 * base) * fade),
              glyph
            );
        }
        depthBuffer[x] = Math.max(0, screenY);
      }
    }
    return finishGrid(grid);
  }
  if (name === "Dot flag") {
    const grid = makeGrid(width, height);
    const flagWidth = Math.min(width - 8, 44);
    const flagHeight = Math.max(6, height - 6);
    const poleX = Math.floor((width - flagWidth) / 2);
    const topY = 2;
    for (let v = 0; v <= flagHeight; v++) {
      for (let u = 0; u <= flagWidth; u += 2) {
        const across = u / flagWidth;
        const lift = Math.sin(across * 4.5 - time * 3.1) * 2 * across;
        const depth = Math.cos(across * 4.5 - time * 3.1);
        const x = poleX + u;
        const y = Math.round(topY + v + lift);
        const row = grid[y];
        if (!row || x < 0 || x >= width) continue;
        const hue = v / flagHeight;
        const level = 0.45 + 0.55 * Math.max(0, depth);
        row[x] = fg(
          Math.round((150 + 100 * Math.sin(hue * 4)) * level),
          Math.round((150 + 100 * Math.sin(hue * 4 + 2.1)) * level),
          Math.round((150 + 100 * Math.sin(hue * 4 + 4.2)) * level),
          depth > 0.25 ? "●" : depth > -0.4 ? "•" : "·"
        );
      }
    }
    for (let y = 1; y < height - 1; y++) {
      const row = grid[y];
      if (row && poleX - 2 >= 0) row[poleX - 2] = dim("│");
    }
    return finishGrid(grid);
  }
  if (name === "Bump lighting") {
    const surface = (x: number, y: number) =>
      Math.sin(x * 0.35) * Math.sin(y * 0.7) +
      0.5 * Math.sin(x * 0.26 + y * 0.51);
    const lightX = width / 2 + Math.cos(time * 1.7) * width * 0.3;
    const lightY = height / 2 + Math.sin(time * 1.3) * height * 0.3;
    const lines: string[] = [];
    for (let y = 0; y < height; y++) {
      let line = "";
      for (let x = 0; x < width; x++) {
        const gradX = surface(x + 1, y) - surface(x - 1, y);
        const gradY = surface(x, y + 1) - surface(x, y - 1);
        const towardX = lightX - x;
        const towardY = (lightY - y) * 2;
        const dist = Math.hypot(towardX, towardY) + 1;
        const intensity = Math.max(
          0,
          Math.min(
            1,
            ((-gradX * towardX - gradY * towardY) / dist) * 1.6 + 0.25
          ) /
            (1 + dist * 0.055)
        );
        if (intensity < 0.035) {
          line += " ";
          continue;
        }
        const shade =
          intensity > 0.4
            ? "█"
            : intensity > 0.24
              ? "▓"
              : intensity > 0.12
                ? "▒"
                : "░";
        line += fg(
          Math.round(120 + 135 * intensity),
          Math.round(90 + 120 * intensity),
          Math.round(60 + 80 * intensity),
          shade
        );
      }
      lines.push(line);
    }
    return lines;
  }
  const lines: string[] = [];
  const radius = Math.min(20, Math.floor(width / 3.2));
  const centerX = Math.floor(width / 2);
  const shadeByFace = ["░", "▒", "▓", "█"];
  for (let y = 0; y < height; y++) {
    const theta =
      time * 1.8 + y * 0.16 + Math.sin(time * 1.1 + y * 0.045) * 1.2;
    const row = Array.from({ length: width }, () => " ");
    for (let face = 0; face < 4; face++) {
      const faceAngle = theta + (face * Math.PI) / 2;
      const x1 = Math.round(centerX + Math.sin(faceAngle) * radius);
      const x2 = Math.round(
        centerX + Math.sin(faceAngle + Math.PI / 2) * radius
      );
      if (x2 <= x1) continue;
      const light = 0.35 + 0.65 * Math.abs(Math.cos(faceAngle + Math.PI / 4));
      for (let x = Math.max(0, x1); x <= Math.min(width - 1, x2); x++) {
        row[x] = fg(
          Math.round(230 * light),
          Math.round(140 * light),
          Math.round(220 * light),
          shadeByFace[face] ?? "█"
        );
      }
    }
    lines.push(row.join(""));
  }
  return lines;
};

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;
const renderTransition = (
  name: string,
  width: number,
  height: number,
  time: number
) => {
  const cycle = (time % 6) / 6;
  const progress = cycle < 0.5 ? cycle * 2 : (1 - cycle) * 2;
  const message = "MOTION GALLERY";
  const textStart = Math.max(0, Math.floor((width - message.length) / 2));
  const textRow = Math.floor(height / 2);
  const contentAt = (x: number, y: number) => {
    if (y === textRow && x >= textStart && x < textStart + message.length) {
      const character = message[x - textStart] ?? " ";
      if (character !== " ") return bold(character);
    }
    const hue = x / (width * 1.4) + y / (height * 2.2) + time * 0.06;
    return fg(
      Math.round(120 + 90 * Math.sin(hue * Math.PI * 2)),
      Math.round(110 + 90 * Math.sin(hue * Math.PI * 2 + 2.1)),
      Math.round(150 + 90 * Math.sin(hue * Math.PI * 2 + 4.2)),
      ["░", "▒", "▓"][(x + y * 2) % 3] ?? "▒"
    );
  };
  if (name === "Filter rack") {
    const filters = [
      "Dim",
      "Brighten",
      "Tint",
      "Invert",
      "Vignette",
      "PatternFill",
      "Greyscale",
    ];
    const slot = Math.floor(time / 1.8) % filters.length;
    const filter = filters[slot] ?? "Dim";
    const local = (time % 1.8) / 1.8;
    const lines: string[] = [];
    for (let y = 0; y < height - 1; y++) {
      let line = "";
      for (let x = 0; x < width; x++) {
        const hue = x / (width * 1.4) + y / (height * 2.2) + time * 0.06;
        let glyph = ["░", "▒", "▓"][(x + y * 2) % 3] ?? "▒";
        let r = 120 + 90 * Math.sin(hue * Math.PI * 2);
        let g = 110 + 90 * Math.sin(hue * Math.PI * 2 + 2.1);
        let b = 150 + 90 * Math.sin(hue * Math.PI * 2 + 4.2);
        if (filter === "Dim") {
          const level = 1 - 0.75 * local;
          r *= level;
          g *= level;
          b *= level;
        } else if (filter === "Brighten") {
          const level = 1 + 0.9 * local;
          r = Math.min(255, r * level);
          g = Math.min(255, g * level);
          b = Math.min(255, b * level);
        } else if (filter === "Tint") {
          const mix = 0.7;
          r = r * (1 - mix) + (200 + 55 * Math.sin(local * Math.PI * 2)) * mix;
          g = g * (1 - mix) + 120 * mix;
          b = b * (1 - mix) + (200 - 120 * Math.sin(local * Math.PI * 2)) * mix;
        } else if (filter === "Invert") {
          if (local > 0.3) {
            r = 255 - r;
            g = 255 - g;
            b = 255 - b;
          }
        } else if (filter === "Vignette") {
          const dx = (x - width / 2) / (width / 2);
          const dy = (y - height / 2) / (height / 2);
          const level = Math.max(
            0,
            1 - Math.hypot(dx, dy) * (0.4 + local * 1.1)
          );
          r *= level;
          g *= level;
          b *= level;
        } else if (filter === "PatternFill") {
          if ((x + y) % 2 === 0) glyph = local > 0.5 ? "▚" : "╱";
        } else {
          const grey = 0.299 * r + 0.587 * g + 0.114 * b;
          const mix = Math.min(1, local * 1.6);
          r = r * (1 - mix) + grey * mix;
          g = g * (1 - mix) + grey * mix;
          b = b * (1 - mix) + grey * mix;
        }
        line += fg(
          Math.round(Math.max(0, r)),
          Math.round(Math.max(0, g)),
          Math.round(Math.max(0, b)),
          glyph
        );
      }
      lines.push(line);
    }
    lines.push(
      center(
        `${dim("filter:")} ${bold(filter)} ${dim(`(${slot + 1}/${filters.length})`)}`,
        width
      )
    );
    return lines;
  }
  if (name === "Ripple warp") {
    const lines: string[] = [];
    for (let y = 0; y < height; y++) {
      let line = "";
      for (let x = 0; x < width; x++) {
        const dx = (x - width / 2) * 0.55;
        const dy = y - height / 2;
        const radius = Math.hypot(dx, dy) + 0.001;
        const wave =
          Math.sin(radius * 1.1 - time * 5) * 1.8 * Math.exp(-radius * 0.07);
        const sourceX = Math.round(x + ((dx / radius) * wave) / 0.55);
        const sourceY = Math.round(y + (dy / radius) * wave);
        line +=
          sourceX >= 0 && sourceX < width && sourceY >= 0 && sourceY < height
            ? contentAt(sourceX, sourceY)
            : " ";
      }
      lines.push(line);
    }
    return lines;
  }
  if (name === "Fault line") {
    const offset = Math.round(progress * width * 0.22);
    const lines: string[] = [];
    for (let y = 0; y < height; y++) {
      const split = Math.round(width / 2 + Math.sin(y * 0.85) * 3);
      let line = "";
      for (let x = 0; x < width; x++) {
        const source = x < split ? x + offset : x - offset;
        line +=
          (x < split ? source < split : source >= split) &&
          source >= 0 &&
          source < width
            ? contentAt(source, y)
            : " ";
      }
      lines.push(line);
    }
    return lines;
  }
  if (name === "Shredder") {
    const lines: string[] = [];
    for (let y = 0; y < height; y++) {
      let line = "";
      for (let x = 0; x < width; x++) {
        const direction = Math.floor(x / 3) % 2 === 0 ? 1 : -1;
        const source = y + direction * Math.round(progress * height * 1.1);
        line += source >= 0 && source < height ? contentAt(x, source) : " ";
      }
      lines.push(line);
    }
    return lines;
  }
  const visibleAt = (x: number, y: number) => {
    const dx = (x - width / 2) / (width / 2);
    const dy = (y - height / 2) / (height / 2);
    if (name === "Iris reveal") return Math.hypot(dx, dy) < progress * 1.45;
    if (name === "Blinds") return y % 4 < progress * 4.6;
    if (name === "Checker tiles") {
      const parityOffset = (Math.floor(x / 6) + Math.floor(y / 3)) % 2;
      const local = Math.min(1, Math.max(0, progress * 2 - parityOffset));
      return (x % 6) / 6 < local;
    }
    if (name === "Diamond wipe")
      return Math.abs(dx) + Math.abs(dy) < progress * 2.1;
    if (name === "Cellular pop")
      return hash(Math.floor(x / 5) * 57 + Math.floor(y / 2) * 131) < progress;
    if (name === "Radial sweep")
      return Math.atan2(dy, dx) / (Math.PI * 2) + 0.5 < progress;
    if (name === "Snake reveal") {
      const column = y % 2 === 0 ? x : width - 1 - x;
      return y * width + column < progress * width * height;
    }
    return (BAYER4[y % 4]?.[x % 4] ?? 0) / 16 < progress;
  };
  const lines: string[] = [];
  for (let y = 0; y < height; y++) {
    let line = "";
    for (let x = 0; x < width; x++)
      line += visibleAt(x, y) ? contentAt(x, y) : " ";
    lines.push(line);
  }
  return lines;
};

const EFFECTS = EFFECT_GROUPS.flatMap(([category, source, names]) =>
  names.map((name) => ({ category, name, source }))
);
const GROUP_STARTS = EFFECT_GROUPS.map((_, index) =>
  EFFECT_GROUPS.slice(0, index).reduce(
    (sum, [, , names]) => sum + names.length,
    0
  )
);
const ITEM_COUNT = EFFECTS.length;
const renderEffect = (
  effect: (typeof EFFECTS)[number],
  width: number,
  height: number,
  time: number
) => {
  if (effect.category === "Micro motion")
    return renderMicro(effect.name, width, height, time);
  if (effect.category === "Task feedback")
    return renderTask(effect.name, width, height, time);
  if (effect.category === "Glyph micro-motion")
    return renderGlyphMotion(effect.name, width, height, time);
  if (effect.category === "Text effects")
    return renderTextEffect(effect.name, width, height, time);
  if (effect.category === "Weather and fields")
    return renderField(effect.name, width, height, time);
  if (effect.category === "Simulations")
    return renderSimulation(effect.name, width, height, time);
  if (effect.category === "Paths and games")
    return renderGame(effect.name, width, height, time);
  if (effect.category === "Sprites and scenes")
    return renderSprite(effect.name, width, height, time);
  if (effect.category === "Growth and playback")
    return renderGrowth(effect.name, width, height, time);
  if (effect.category === "Space and geometry")
    return renderSpace(effect.name, width, height, time);
  if (effect.category === "Dashboards")
    return renderDashboard(effect.name, width, height, time);
  if (effect.category === "Rendering layers")
    return renderLayers(effect.name, width, height, time);
  if (effect.category === "Textmode demoscene")
    return renderDemoscene(effect.name, width, height, time);
  return renderTransition(effect.name, width, height, time);
};

const composeFrame = (
  itemIndex: number,
  width: number,
  height: number,
  time: number,
  paused: boolean,
  autoplay: boolean
) => {
  const effect = EFFECTS[itemIndex]!;
  const bodyHeight = Math.max(1, height - 4);
  const header = `${bold(accent("TERMINAL MOTION GALLERY"))}  ${muted(`${String(itemIndex + 1).padStart(2, "0")}/${ITEM_COUNT} · ${effect.category}`)}`;
  const controls = `${paused ? warning("PAUSED") : autoplay ? success("AUTO") : muted("MANUAL")}  ${dim("←/→ type · ↑/↓ group · space pause · a auto · q quit")}`;
  const lines = [
    fit(header, width),
    fit(bold(effect.name), width),
    fit(dim(`inspired by ${effect.source}`), width),
    ...renderEffect(effect, width, bodyHeight, time),
    fit(controls, width),
  ];
  return lines
    .slice(0, height)
    .map((line) => fit(line, width))
    .join("\n");
};

const printCatalog = () => {
  console.log("Terminal Motion Gallery — verified sources\n");
  for (const [category, entries] of CATALOG) {
    console.log(category);
    for (const [name, url] of entries)
      console.log(`  ${name.padEnd(24)} ${url}`);
    console.log();
  }
  console.log("Animation types\n");
  for (const [category, source, names] of EFFECT_GROUPS) {
    console.log(`${category} — ${source}`);
    for (const name of names) console.log(`  ${name}`);
    console.log();
  }
};

const runCheck = () => {
  const projectNames = CATALOG.flatMap(([, entries]) =>
    entries.map(([name]) => name)
  );
  const effectNames = EFFECT_GROUPS.flatMap(([, , names]) => names);
  assert.equal(
    new Set(projectNames).size,
    projectNames.length,
    "catalog names must be unique"
  );
  assert.equal(
    new Set(effectNames).size,
    effectNames.length,
    "effect names must be unique"
  );
  assert.equal(EFFECTS.length, effectNames.length);
  assert.deepEqual(
    EFFECTS.map(({ name }) => name),
    effectNames
  );
  for (const [, entries] of CATALOG) {
    for (const [, url] of entries)
      assert.match(url, /^https:\/\//, `invalid URL: ${url}`);
  }
  for (const width of [MIN_WIDTH, 80, 120]) {
    for (let itemIndex = 0; itemIndex < ITEM_COUNT; itemIndex++) {
      const rendered = composeFrame(
        itemIndex,
        width,
        24,
        1.25,
        false,
        true
      ).split("\n");
      assert.equal(rendered.length, 24);
      for (const line of rendered)
        assert.ok(
          widthOf(line) <= width,
          `item ${itemIndex + 1}: line exceeds ${width}`
        );
    }
  }
  for (const [index, effect] of EFFECTS.entries()) {
    const rendered = plain(composeFrame(index, 120, 24, 1.25, false, true));
    assert.ok(rendered.includes(effect.name), `${effect.name} is not visible`);
  }
  const signatures = EFFECTS.map((effect) =>
    renderEffect(effect, 80, 20, 1.25).join("\n")
  );
  const firstBySignature = new Map<string, string>();
  const duplicates: string[] = [];
  for (const [index, signature] of signatures.entries()) {
    const first = firstBySignature.get(signature);
    if (first) duplicates.push(`${EFFECTS[index]!.name} repeats ${first}`);
    else firstBySignature.set(signature, EFFECTS[index]!.name);
  }
  assert.deepEqual(
    duplicates,
    [],
    "animation types must have distinct rendered previews"
  );
  for (const effect of EFFECTS) {
    const frames = [0.2, 0.9, 1.7].map((time) =>
      renderEffect(effect, 80, 20, time).join("\n")
    );
    assert.ok(
      new Set(frames).size > 1,
      `${effect.name} must animate over time`
    );
  }
  console.log(
    `Checked ${EFFECTS.length} distinct animation types and ${projectNames.length} catalog sources.`
  );
};

if (process.argv.includes("--check")) {
  runCheck();
} else if (
  process.argv.includes("--list") ||
  !process.stdin.isTTY ||
  !process.stdout.isTTY
) {
  printCatalog();
  if (!process.argv.includes("--list"))
    console.log(
      "Run this command in an interactive terminal to play the gallery."
    );
} else {
  const stdin = process.stdin;
  const stdout = process.stdout;
  let itemIndex = 0;
  let autoplay = true;
  let paused = false;
  let stopped = false;
  let sceneStarted = performance.now();
  let frozenTime = 0;
  let nativeProgressActive = false;
  let lastNativeProgress = "";

  const elapsed = () =>
    paused ? frozenTime : (performance.now() - sceneStarted) / 1000;
  const select = (offset: number) => {
    itemIndex = (itemIndex + offset + ITEM_COUNT) % ITEM_COUNT;
    sceneStarted = performance.now();
    frozenTime = 0;
  };
  const jump = (index: number) => {
    itemIndex = index;
    sceneStarted = performance.now();
    frozenTime = 0;
  };
  const jumpGroup = (offset: number) => {
    const current = GROUP_STARTS.findLastIndex((start) => start <= itemIndex);
    jump(
      GROUP_STARTS[
        (current + offset + GROUP_STARTS.length) % GROUP_STARTS.length
      ]!
    );
  };
  const updateNativeProgress = (time?: number) => {
    if (!SUPPORTS_OSC_PROGRESS) return;
    if (time === undefined) {
      if (nativeProgressActive) stdout.write(oscProgress(0));
      nativeProgressActive = false;
      lastNativeProgress = "";
      return;
    }
    const phase = time % 10;
    const percentage = Math.min(100, Math.round(phase * 14));
    const state: 1 | 2 | 4 =
      phase < 6 ? 1 : phase < 7.5 ? 4 : phase < 9 ? 2 : 1;
    const sequence = oscProgress(state, percentage);
    if (sequence !== lastNativeProgress) stdout.write(sequence);
    nativeProgressActive = true;
    lastNativeProgress = sequence;
  };
  const restore = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    stdin.off("data", onInput);
    stdin.setRawMode(false);
    stdin.pause();
    updateNativeProgress();
    stdout.write(`${CSI}?2026l${CSI}?7h${CSI}?25h${CSI}?1049l`);
  };
  const stop = (code = 0, error?: unknown) => {
    restore();
    if (error) console.error(error);
    process.exitCode = code;
  };
  const draw = () => {
    if (stopped) return;
    try {
      const width = Math.max(1, stdout.columns ?? 80);
      const height = Math.max(1, stdout.rows ?? 24);
      const time = elapsed();
      if (autoplay && !paused && time >= 8) select(1);
      updateNativeProgress(
        EFFECTS[itemIndex]!.name === "Native terminal progress"
          ? elapsed()
          : undefined
      );
      const frame =
        width < MIN_WIDTH || height < MIN_HEIGHT
          ? [
              fit("Terminal Motion Gallery", width),
              fit(`Resize to at least ${MIN_WIDTH}x${MIN_HEIGHT}.`, width),
              ...Array.from({ length: Math.max(0, height - 2) }, () =>
                " ".repeat(width)
              ),
            ].join("\n")
          : composeFrame(itemIndex, width, height, elapsed(), paused, autoplay);
      stdout.write(`${CSI}?2026h${CSI}H${frame}${CSI}J${CSI}?2026l`);
    } catch (error) {
      stop(1, error);
    }
  };
  const onInput = (chunk: Buffer) => {
    const input = chunk.toString();
    if (
      input === "\x1b" ||
      input.includes("\x03") ||
      input.toLowerCase().includes("q")
    ) {
      stop();
      return;
    } else if (input === "\x1b[C" || input === "l" || input === "n") select(1);
    else if (input === "\x1b[D" || input === "h" || input === "p") select(-1);
    else if (input === "\x1b[A" || input === "k") jumpGroup(-1);
    else if (input === "\x1b[B" || input === "j") jumpGroup(1);
    else if (input === "a") autoplay = !autoplay;
    else if (input === " ") {
      if (paused) sceneStarted = performance.now() - frozenTime * 1000;
      else frozenTime = elapsed();
      paused = !paused;
    }
    draw();
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onInput);
  process.once("SIGHUP", () => stop(129));
  process.once("SIGINT", () => stop(130));
  process.once("SIGQUIT", () => stop(131));
  process.once("SIGTERM", () => stop(143));
  process.once("uncaughtException", (error) => stop(1, error));
  stdout.write(`${CSI}?1049h${CSI}?25l${CSI}?7l`);
  const timer = setInterval(draw, 1000 / FPS);
  draw();
}
