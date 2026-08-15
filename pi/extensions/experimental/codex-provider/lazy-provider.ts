import { lazyApi } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai";

import type { CodexModelCatalog } from "./model-catalog.js";

type CodexProvider = Provider<"openai-codex-responses">;

export const createLazyCodexProvider = (
  catalog: CodexModelCatalog,
  load: () => Promise<CodexProvider>
): CodexProvider => {
  const fallback = catalog.base;
  let loaded: CodexProvider | undefined;
  const get = async () => (loaded ??= await load());

  return {
    ...fallback,
    getModels: catalog.getModels,
    refreshModels: catalog.refreshModels,
    ...lazyApi(get),
  };
};
