import { describe, expect, it } from "@effect/vitest";

import {
  mapCatalogToPiModels,
  preferredModelId,
  renderModelsJson,
  ZROUTE_PI_PROVIDER_ID,
} from "./catalog.ts";

const catalog = {
  models: [
    {
      id: "claude-sonnet-4-6",
      display_name: "Z Claude Sonnet 4.6",
      context_window: 250000,
      max_completion_tokens: 64000,
      input_modalities: ["text", "image"],
      supports_reasoning: false,
      cost: { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
    },
    {
      id: "gemini-3.8-flash",
      display_name: "Z Gemini 3.8 Flash",
      context_window: 1048576,
      max_completion_tokens: 65536,
      input_modalities: ["text", "image"],
      supports_reasoning: true,
      default_reasoning_effort: "high",
      reasoning_efforts: ["low", "medium", "high"],
      cost: { input: 0.3, output: 2.5, cache_read: 0.03, cache_write: 0.083 },
    },
    { id: "gemini-3.8-flash", display_name: "duplicate" },
    { id: "bad id with spaces" },
    { id: "zroute/grok-4.7", supports_reasoning: true, reasoning_efforts: ["xhigh", "none"] },
  ],
};

describe("mapCatalogToPiModels", () => {
  it("maps reasoning, level map, modalities, limits and cost", () => {
    const models = mapCatalogToPiModels(catalog);
    expect(models.map((model) => model.id)).toEqual([
      "claude-sonnet-4-6",
      "gemini-3.8-flash",
      "grok-4.7",
    ]);
    expect(models[0]).toEqual({
      id: "claude-sonnet-4-6",
      name: "Z Claude Sonnet 4.6",
      input: ["text", "image"],
      contextWindow: 250000,
      maxTokens: 64000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });
    expect(models[1]).toEqual({
      id: "gemini-3.8-flash",
      name: "Z Gemini 3.8 Flash",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
      contextWindow: 1048576,
      maxTokens: 65536,
      cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.083 },
    });
    // "none" turns thinking off; an id carrying the provider prefix is normalized.
    expect(models[2]?.thinkingLevelMap).toMatchObject({ off: "none", xhigh: "xhigh", low: null });
    expect(models[2]?.name).toBe("grok-4.7");
  });

  it("returns nothing for payloads without a model list", () => {
    expect(mapCatalogToPiModels({})).toEqual([]);
    expect(mapCatalogToPiModels(null)).toEqual([]);
  });

  it("prefers the first gemini model, else the first model", () => {
    const models = mapCatalogToPiModels(catalog);
    expect(preferredModelId(models)).toBe("gemini-3.8-flash");
    expect(preferredModelId(models.filter((model) => !model.id.startsWith("gemini")))).toBe(
      "claude-sonnet-4-6",
    );
    expect(preferredModelId([])).toBeUndefined();
  });
});

describe("renderModelsJson", () => {
  it("writes the Pi provider entry zroute's installer writes", () => {
    const parsed = JSON.parse(
      renderModelsJson({
        apiBase: "https://api-dev.zroute.ai///",
        apiKey: "zr_live_test",
        models: mapCatalogToPiModels(catalog),
      }),
    );
    expect(parsed.providers[ZROUTE_PI_PROVIDER_ID]).toMatchObject({
      baseUrl: "https://api-dev.zroute.ai/openai",
      api: "openai-responses",
      apiKey: "zr_live_test",
      authHeader: true,
    });
    expect(parsed.providers.zroute.models).toHaveLength(3);
  });
});
