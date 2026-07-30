import type { Api, Model } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { ToolCore } from "../core.js";

export interface HarnessProfile {
  readonly id: string;
  readonly createTools: (core: ToolCore) => readonly ToolDefinition[];
  readonly matches: (model: Model<Api>) => boolean;
}
