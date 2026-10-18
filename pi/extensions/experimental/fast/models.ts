import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const canRequestPriority = (ctx: {
  model: ExtensionContext["model"];
  modelRegistry: Pick<ExtensionContext["modelRegistry"], "find" | "isUsingOAuth" | "getProvider">;
}): boolean => {
  const selected = ctx.model;

  if (
    selected?.provider !== "openai" ||
    selected.api !== "openai-responses" ||
    selected.baseUrl !== "https://api.openai.com/v1"
  )
    return false;

  const model = ctx.modelRegistry.find(selected.provider, selected.id);

  return (
    model !== undefined &&
    model.provider === "openai" &&
    model.api === "openai-responses" &&
    model.baseUrl === "https://api.openai.com/v1" &&
    ctx.modelRegistry.isUsingOAuth(model) &&
    ctx.modelRegistry.getProvider("openai")?.auth.oauth?.isSubscription === true
  );
};
