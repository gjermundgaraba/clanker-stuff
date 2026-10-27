import { hasApi } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const canRequestPriority = (ctx: {
  model: ExtensionContext["model"];
  modelRegistry: Pick<
    ExtensionContext["modelRegistry"],
    "isUsingOAuth" | "getProvider"
  >;
}): boolean => {
  const { model } = ctx;

  return (
    model?.provider === "openai" &&
    hasApi(model, "openai-responses") &&
    model.baseUrl === "https://api.openai.com/v1" &&
    ctx.modelRegistry.isUsingOAuth(model) &&
    ctx.modelRegistry.getProvider("openai")?.auth.oauth?.isSubscription === true
  );
};
