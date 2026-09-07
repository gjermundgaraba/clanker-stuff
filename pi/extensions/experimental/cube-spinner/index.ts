import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSpinner } from "./spinner.js";

export default function cubeSpinner(pi: ExtensionAPI): void {
  const spinner = createSpinner();

  pi.on("session_start", (_event, ctx) => spinner.apply(ctx));
  pi.registerCommand("cube-spinner", {
    description: "Control the cube spinner: on, static, off, or preview",
    handler: async (args, ctx) => spinner.command(args, ctx),
  });
}
