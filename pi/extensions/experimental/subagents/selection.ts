import type { Api, Model } from "@earendil-works/pi-ai";

import type { ProtocolMode } from "./config.js";

export type Protocol = Exclude<ProtocolMode, "auto">;

export const modelKey = (model: Model<Api> | undefined): string | undefined =>
  model === undefined ? undefined : `${model.provider}/${model.id}`;

export const resolveProtocol = (
  model: Model<Api> | undefined,
  overrides: Readonly<Record<string, ProtocolMode>>,
  inherited?: Protocol,
): Protocol => {
  const exact = modelKey(model);
  const exactOverride = exact === undefined ? undefined : overrides[exact];

  if (exactOverride !== undefined && exactOverride !== "auto") {
    return exactOverride;
  }

  if (exactOverride !== "auto") {
    const wildcard = overrides["*"];

    if (wildcard !== undefined && wildcard !== "auto") {
      return wildcard;
    }
  }

  return inherited ?? "v1";
};
