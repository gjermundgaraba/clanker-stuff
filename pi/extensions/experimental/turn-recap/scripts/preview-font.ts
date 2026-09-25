/** Standalone preview of the real widget; synthetic metrics, no session or persistence. */
import { parseArgs } from "node:util";

import { Key, matchesKey, ProcessTerminal, Text, TuiAltScreen } from "@earendil-works/pi-tui";

import type { LiveState } from "../card.js";
import { getRollingFontPath, loadRollingFont } from "../font.js";
import { collectMetrics } from "../metrics.js";
import { createLiveWidget } from "../widget.js";

const { values } = parseArgs({
  options: { seconds: { type: "string", default: "30" }, help: { type: "boolean" } },
});

const main = async (): Promise<void> => {
  if (values.help) {
    console.log("Preview the installed rolling font: [--seconds 30]. q, Escape or Ctrl-C exits.");

    return;
  }

  const seconds = Number(values.seconds);

  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error("--seconds must be positive and finite");

  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Run directly in an interactive terminal");
  const font = await loadRollingFont();

  if (!font) throw new Error(`No rolling-font manifest at ${getRollingFontPath()}`);
  const tui = new TuiAltScreen(new ProcessTerminal());
  const started = performance.now();
  const initialElapsedMs = 118_000;

  const metrics = collectMetrics([]);

  const widget = createLiveWidget(
    tui,
    { fg: (_tone, text) => text },
    (): LiveState => {
      const elapsed = performance.now() - started;
      const tick = Math.floor(elapsed / 1000);
      metrics.toolCalls = 96 + tick;
      metrics.usage.input = 1096 + tick * 10;
      metrics.context = {
        tokens: 990 - (tick % 90),
        contextWindow: 10000,
        percent: 9.9 - (tick % 90) / 100,
        startTokens: 900,
      };

      return { activeMs: initialElapsedMs + elapsed, paused: false, metrics };
    },
    font,
  );

  const stationary = Array.from({ length: 10 }, (_, digit) => font.stationary(String(digit)));

  tui.addChild(
    new Text(
      "Rolling numbers · q / Esc exits\nNative:    |0|1|2|3|4|5|6|7|8|9|\nCompanion: |" +
        stationary.join("|") +
        "|",
      0,
      1,
    ),
  );
  tui.addChild(widget);
  const finished = Promise.withResolvers<void>();
  const stop = () => finished.resolve();
  tui.addInputListener((input) => {
    if (input === "q" || matchesKey(input, Key.escape) || matchesKey(input, Key.ctrl("c"))) stop();

    return { consume: true };
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const timeout = setTimeout(stop, seconds * 1000);

  try {
    tui.start();
    await finished.promise;
  } finally {
    clearTimeout(timeout);
    widget.dispose();
    tui.stop();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
};

await main();
