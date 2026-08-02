import type { Api, Model } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { ToolOperations } from "../operations.js";

export interface HarnessProfile {
  readonly id: string;
  readonly createTools: (
    operations: ToolOperations
  ) => readonly ToolDefinition[];
  readonly matches: (model: Model<Api>) => boolean;
}
