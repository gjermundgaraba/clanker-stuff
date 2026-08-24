import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createCodexModelCatalog } from "../model-catalog.js";
import { SPIKE_API_KEY } from "./fixtures.js";

type StoredModels = NonNullable<RefreshModelsContext["stored"]>;

const CAPABILITY_FIELDS = [
  "supported_in_api",
  "support_verbosity",
  "supports_parallel_tool_calls",
] as const;

const remoteModel = {
  display_name: "Boundary model",
  future_metadata: { retained: true },
  priority: 1,
  slug: "gpt-5.6-boundary",
  supported_in_api: true,
  support_verbosity: true,
  supports_parallel_tool_calls: true,
  visibility: "list",
};

const refreshContext = (
  publish: RefreshModelsContext["publish"],
  stored?: StoredModels,
): RefreshModelsContext => ({
  allowNetwork: stored === undefined,
  credential: { key: SPIKE_API_KEY, type: "api_key" },
  publish,
  signal: new AbortController().signal,
  stored,
});

const fetchStoredCatalog = async (): Promise<StoredModels> => {
  let stored: StoredModels | undefined;
  const catalog = createCodexModelCatalog();
  vi.stubGlobal("fetch", async () => Response.json({ models: [remoteModel] }));
  await catalog.refreshModels(
    refreshContext(async (publication) => {
      if (publication.persist !== undefined && publication.persist !== null) {
        stored = structuredClone(publication.persist);
      }
      publication.update?.();
      return true;
    }),
  );
  if (stored === undefined) {
    throw new Error("Remote model catalog was not persisted");
  }
  return stored;
};

describe("Codex model catalog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(CAPABILITY_FIELDS)("rejects non-boolean remote %s metadata", async (field) => {
    const catalog = createCodexModelCatalog();
    vi.stubGlobal("fetch", async () =>
      Response.json({ models: [{ ...remoteModel, [field]: "false" }] }),
    );

    await expect(
      catalog.refreshModels(
        refreshContext(async (publication) => {
          publication.update?.();
          return true;
        }),
      ),
    ).rejects.toThrow("Codex model metadata capabilities are invalid");
    expect(catalog.getModels().some((model) => model.id === remoteModel.slug)).toBeFalsy();
  });

  it.each(CAPABILITY_FIELDS)("rejects non-boolean cached %s metadata", async (field) => {
    const stored = await fetchStoredCatalog();
    const models = stored.models.map((model) => {
      if (model.id !== remoteModel.slug || !("codexProviderMetadata" in model)) {
        return model;
      }
      return {
        ...model,
        codexProviderMetadata: {
          ...remoteModel,
          [field]: "false",
        },
      };
    });
    const catalog = createCodexModelCatalog();

    await catalog.refreshModels(
      refreshContext(
        async (publication) => {
          publication.update?.();
          return true;
        },
        { ...stored, models },
      ),
    );

    expect(catalog.getModels().some((model) => model.id === remoteModel.slug)).toBeFalsy();
  });
});
