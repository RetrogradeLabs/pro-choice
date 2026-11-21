import { isRetiredPurchaseSku } from "../../../src/config/providers.ts";
import { compareAscii } from "../../../src/lib/math/aggregate.ts";
import { resolveModelSlugFromString } from "../../../src/lib/math/canonicalize.ts";
import type { PricingRecord, ProviderId } from "../../../src/lib/schema.ts";
import { fetchJson, parseNonNegative, parseStrictPositiveInt } from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// Restrict text token pricing strictly to verified first-party LiteLLM provider SKUs
const FIRST_PARTY_LITELLM_PROVIDER: Readonly<Record<string, ProviderId>> = {
  anthropic: "anthropic",
  openai: "openai",
  xai: "spacexai",
  gemini: "google",
  meta: "meta",
  deepseek: "deepseek",
  moonshot: "moonshot",
  dashscope: "alibaba",
  zai: "zhipu",
};

interface OpenRouterResponse {
  data?: {
    id?: string;
    context_length?: number;
  }[];
}

interface LiteLlmEntry {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  max_input_tokens?: number;
  max_tokens?: number;
}

export const pricingAdapter: SourceAdapter = {
  id: "pricing",
  label: "First-Party API Pricing (LiteLLM Verified SKUs)",
  license: "MIT / Public API",
  sourceUrl: LITELLM_PRICES_URL,
  expectedBenchmarks: [],
  expectsPricing: true,
  async fetchLive() {
    const [llRes, orRes] = await Promise.allSettled([
      fetchJson<Record<string, LiteLlmEntry>>(LITELLM_PRICES_URL),
      fetchJson<OpenRouterResponse>(OPENROUTER_MODELS_URL),
    ]);

    const pricingStats: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
    if (llRes.status !== "fulfilled" || !llRes.value || typeof llRes.value !== "object") {
      pricingStats.error =
        llRes.status === "rejected"
          ? llRes.reason instanceof Error
            ? llRes.reason.message
            : String(llRes.reason)
          : "LiteLLM pricing payload malformed";
      return { observations: [], pricing: [], pricingStats };
    }

    const bySlug = new Map<string, PricingRecord | "conflict">();
    const sortedEntries = Object.entries(llRes.value).toSorted(([a], [b]) => compareAscii(a, b));

    for (const [modelKey, info] of sortedEntries) {
      if (!info || typeof info !== "object" || modelKey === "sample_spec") continue;
      const providerKey =
        typeof info.litellm_provider === "string" ? info.litellm_provider.toLowerCase() : "";
      const firstPartyProvider = FIRST_PARTY_LITELLM_PROVIDER[providerKey];
      if (!firstPartyProvider) continue;

      // Restrict moving-endpoint rollover strictly to exact undated live endpoint keys so historical dated SKUs stay retired
      const trimmedKey = modelKey.trim();
      let targetSlug: string | null = null;
      let resolvedReleaseDate: string | null = null;
      if (
        firstPartyProvider === "deepseek" &&
        /^(?:deepseek\/)?deepseek-(?:flash|v4\.1-flash)$/i.test(trimmedKey)
      ) {
        targetSlug = "deepseek-v4.1-flash-1017";
        resolvedReleaseDate = "2026-10-17";
      } else if (
        firstPartyProvider === "deepseek" &&
        /^(?:deepseek\/)?deepseek-v4-pro$/i.test(trimmedKey)
      ) {
        // DeepSeek live deepseek-v4-pro API serves the 2026-08-13 GA checkpoint
        targetSlug = "deepseek-v4-pro-0813";
        resolvedReleaseDate = "2026-08-13";
      } else if (
        firstPartyProvider === "alibaba" &&
        /^(?:dashscope\/)?qwen3\.8-max$/i.test(trimmedKey)
      ) {
        // Alibaba Model Studio upgraded live dashscope/qwen3.8-max to the 2026-09-02 revision on 2026-09-05
        targetSlug = "qwen3.8-max-0902";
        resolvedReleaseDate = "2026-09-02";
      } else {
        const resolved = resolveModelSlugFromString(trimmedKey, firstPartyProvider);
        if (!resolved || resolved.provider !== firstPartyProvider) continue;
        targetSlug = resolved.modelSlug;
        resolvedReleaseDate = resolved.releaseDate;
      }

      pricingStats.attempted++;
      if (isRetiredPurchaseSku(firstPartyProvider, targetSlug)) {
        pricingStats.excluded++;
        continue;
      }
      if (
        info.mode &&
        info.mode !== "chat" &&
        info.mode !== "completion" &&
        info.mode !== "responses"
      ) {
        pricingStats.excluded++;
        continue;
      }
      if (info.input_cost_per_token === undefined && info.output_cost_per_token === undefined) {
        pricingStats.excluded++;
        continue;
      }
      const inTok = parseNonNegative(info.input_cost_per_token);
      const outTok = parseNonNegative(info.output_cost_per_token);
      if (inTok === null || outTok === null) {
        pricingStats.rejected++;
        continue;
      }
      if (inTok === 0 && outTok === 0) {
        pricingStats.excluded++;
        continue;
      }

      const cacheTok = parseNonNegative(info.cache_read_input_token_cost);
      const candidate: PricingRecord = {
        provider: firstPartyProvider,
        servingProvider: firstPartyProvider,
        apiSku: modelKey,
        modelSlug: targetSlug,
        inputPer1mUsd: Number((inTok * 1_000_000).toFixed(4)),
        outputPer1mUsd: Number((outTok * 1_000_000).toFixed(4)),
        cachedInputPer1mUsd: cacheTok !== null ? Number((cacheTok * 1_000_000).toFixed(4)) : null,
        contextWindow: parseStrictPositiveInt(info.max_input_tokens ?? info.max_tokens),
        releaseDate: resolvedReleaseDate,
        sourceId: "litellm",
      };

      const existing = bySlug.get(targetSlug);
      if (existing === undefined) {
        bySlug.set(targetSlug, candidate);
      } else if (existing !== "conflict") {
        const pricesConflict =
          Math.abs(existing.inputPer1mUsd - candidate.inputPer1mUsd) > 1e-4 ||
          Math.abs(existing.outputPer1mUsd - candidate.outputPer1mUsd) > 1e-4;
        if (pricesConflict) {
          bySlug.set(targetSlug, "conflict");
        } else if (existing.contextWindow === null && candidate.contextWindow !== null) {
          bySlug.set(targetSlug, { ...existing, contextWindow: candidate.contextWindow });
        }
      }
    }

    // Prefer OpenRouter's published total context_length (LiteLLM max_input_tokens can report input-only caps); never import third-party prices
    if (orRes.status === "fulfilled" && Array.isArray(orRes.value?.data)) {
      const sortedOr = orRes.value.data
        .filter((item): item is { id: string; context_length?: number } =>
          Boolean(item && typeof item === "object" && typeof item.id === "string"),
        )
        .toSorted((a, b) => compareAscii(a.id, b.id));
      for (const item of sortedOr) {
        try {
          const id = item.id.trim();
          if (!id || id.includes(":")) continue;
          const resolved = resolveModelSlugFromString(id, null);
          if (!resolved) continue;
          const existing = bySlug.get(resolved.modelSlug);
          if (!existing || existing === "conflict" || existing.provider !== resolved.provider) {
            continue;
          }
          const ctx = parseStrictPositiveInt(item.context_length);
          if (ctx !== null && ctx !== existing.contextWindow) {
            bySlug.set(resolved.modelSlug, { ...existing, contextWindow: ctx });
          }
        } catch {
          // Ignore malformed optional OpenRouter metadata rows without impacting LiteLLM pricing
        }
      }
    }

    const conflictingPricingModelSlugs = [...bySlug.entries()]
      .filter(([, rec]) => rec === "conflict")
      .map(([slug]) => slug);

    return {
      observations: [],
      pricing: [...bySlug.values()].filter((rec): rec is PricingRecord => rec !== "conflict"),
      pricingStats,
      ...(conflictingPricingModelSlugs.length > 0 ? { conflictingPricingModelSlugs } : {}),
    };
  },
};
