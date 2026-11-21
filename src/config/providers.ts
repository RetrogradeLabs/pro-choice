import type { ProviderGroup, ProviderId } from "../lib/schema.ts";

export type ProviderMarker =
  | "circle"
  | "square"
  | "diamond"
  | "triangleUp"
  | "star"
  | "triangleDown"
  | "pentagon"
  | "hexagon"
  | "cross";

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  shortName: string;
  group: ProviderGroup;
  subscriptionLabel: string;
  marker: ProviderMarker;
  cssVar: string;
  inkLight: string;
  inkDark: string;
  aliases: readonly string[];
}

export const PROVIDERS: readonly ProviderMeta[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    shortName: "Anthropic",
    group: "western_subscription",
    subscriptionLabel: "Claude Pro / Max / Ultra",
    marker: "circle",
    cssVar: "var(--prov-anthropic)",
    inkLight: "oklch(0.49 0.18 25)",
    inkDark: "oklch(0.73 0.17 28)",
    aliases: ["anthropic", "claude"],
  },
  {
    id: "openai",
    name: "OpenAI",
    shortName: "OpenAI",
    group: "western_subscription",
    subscriptionLabel: "ChatGPT Plus / Pro",
    marker: "square",
    cssVar: "var(--prov-openai)",
    inkLight: "oklch(0.45 0.12 178)",
    inkDark: "oklch(0.74 0.13 176)",
    aliases: ["openai", "chatgpt", "gpt", "o3", "o4"],
  },
  {
    id: "google",
    name: "Google",
    shortName: "Google",
    group: "western_subscription",
    subscriptionLabel: "Google AI Pro / Ultra",
    marker: "triangleUp",
    cssVar: "var(--prov-google)",
    inkLight: "oklch(0.50 0.19 258)",
    inkDark: "oklch(0.72 0.17 254)",
    aliases: ["google", "deepmind", "gemini", "gemma"],
  },
  {
    id: "spacexai",
    name: "SpaceXAI",
    shortName: "SpaceXAI",
    group: "western_subscription",
    subscriptionLabel: "SuperGrok / Heavy",
    marker: "diamond",
    cssVar: "var(--prov-spacexai)",
    inkLight: "oklch(0.36 0.03 255)",
    inkDark: "oklch(0.77 0.03 255)",
    aliases: ["spacexai", "xai", "x.ai", "x-ai", "grok"],
  },
  {
    id: "meta",
    name: "Meta",
    shortName: "Meta",
    group: "western_subscription",
    subscriptionLabel: "Meta AI / Muse API",
    marker: "star",
    cssVar: "var(--prov-meta)",
    inkLight: "oklch(0.47 0.16 232)",
    inkDark: "oklch(0.75 0.14 230)",
    aliases: ["meta", "meta ai", "meta-llama", "llama", "muse"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    shortName: "DeepSeek",
    group: "chinese_frontier",
    subscriptionLabel: "DeepSeek API / Direct",
    marker: "triangleDown",
    cssVar: "var(--prov-deepseek)",
    inkLight: "oklch(0.45 0.18 282)",
    inkDark: "oklch(0.72 0.16 280)",
    aliases: ["deepseek", "deepseek-ai"],
  },
  {
    id: "moonshot",
    name: "Moonshot",
    shortName: "Moonshot",
    group: "chinese_frontier",
    subscriptionLabel: "Moonshot API / Kimi",
    marker: "pentagon",
    cssVar: "var(--prov-moonshot)",
    inkLight: "oklch(0.54 0.16 78)",
    inkDark: "oklch(0.80 0.15 82)",
    aliases: ["moonshot", "moonshotai", "moonshot ai", "kimi"],
  },
  {
    id: "alibaba",
    name: "Alibaba",
    shortName: "Alibaba",
    group: "chinese_frontier",
    subscriptionLabel: "Alibaba Model Studio",
    marker: "hexagon",
    cssVar: "var(--prov-alibaba)",
    inkLight: "oklch(0.50 0.18 320)",
    inkDark: "oklch(0.74 0.17 318)",
    aliases: ["alibaba", "alibaba cloud", "dashscope", "qwen"],
  },
  {
    id: "zhipu",
    name: "Zhipu",
    shortName: "Zhipu",
    group: "chinese_frontier",
    subscriptionLabel: "Zhipu / GLM Coding Plan",
    marker: "cross",
    cssVar: "var(--prov-zhipu)",
    inkLight: "oklch(0.46 0.14 146)",
    inkDark: "oklch(0.73 0.14 146)",
    aliases: ["zhipu", "zhipuai", "zhipu ai", "z.ai", "z ai", "zai", "z-ai", "glm"],
  },
] as const;

export const PROVIDER_BY_ID: Readonly<Record<ProviderId, ProviderMeta>> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p]),
) as Record<ProviderId, ProviderMeta>;

export const WESTERN_PROVIDER_IDS: readonly ProviderId[] = PROVIDERS.filter(
  (p) => p.group === "western_subscription",
).map((p) => p.id);

export const CHINESE_PROVIDER_IDS: readonly ProviderId[] = PROVIDERS.filter(
  (p) => p.group === "chinese_frontier",
).map((p) => p.id);

export const ALL_PROVIDER_IDS: readonly ProviderId[] = PROVIDERS.map((p) => p.id);

// Retired or redirected first-party API SKUs: preserve historical scores, withhold purchase eligibility
export const RETIRED_PURCHASE_SKUS: Readonly<
  Record<string, { retiredAt: string; reason: string; noticeUrl: string }>
> = {
  "google:gemini-3-pro": {
    retiredAt: "2026-03-09",
    reason:
      "Google shut down gemini-3-pro-preview on 2026-03-09; no active first-party GA endpoint exists",
    noticeUrl: "https://aistudio.google.com/docs/deprecations",
  },
  "google:gemini-3.1-flash-lite-preview": {
    retiredAt: "2026-05-25",
    reason:
      "Google shut down gemini-3.1-flash-lite-preview on 2026-05-25; GA replacement requires separate evaluation",
    noticeUrl: "https://aistudio.google.com/docs/changelog#05-25-2026",
  },
  "alibaba:qwen3.8-max": {
    retiredAt: "2026-09-05",
    reason:
      "Alibaba Model Studio upgraded the live qwen3.8-max endpoint to the 2026-09-02 revision on 2026-09-05; the August 3 snapshot is superseded",
    noticeUrl:
      "https://www.alibabacloud.com/en/notice/model_studio_update_notice_for_qwen38max_models_863?_p_lc=1",
  },
  "deepseek:deepseek-v4-pro": {
    retiredAt: "2026-08-13",
    reason:
      "DeepSeek live deepseek-v4-pro endpoint upgraded from the 2026-04-24 Preview checkpoint to the 2026-08-13 GA checkpoint",
    noticeUrl: "https://api-docs.deepseek.com/updates/",
  },
  "deepseek:deepseek-v4.1-flash": {
    retiredAt: "2026-10-17",
    reason:
      "DeepSeek live flash endpoint superseded the 2026-09-10 snapshot with V4.1 Flash (1017)",
    noticeUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
  },
  "deepseek:deepseek-v4-flash": {
    retiredAt: "2026-09-10",
    reason: "DeepSeek API upgraded flash endpoint to V4.1 Flash (1017); July V4 Flash is retired",
    noticeUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
  },
  "deepseek:deepseek-v3.2": {
    retiredAt: "2026-08-13",
    reason: "DeepSeek API serves V4.1 Flash and V4 Pro; V3.2 is retired from first-party pricing",
    noticeUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
  },
  "deepseek:deepseek-v3.2-exp": {
    retiredAt: "2025-12-01",
    reason: "Experimental V3.2-Exp revision retired from first-party API",
    noticeUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
  },
};

export function isRetiredPurchaseSku(provider: ProviderId, modelSlug: string): boolean {
  return Object.hasOwn(RETIRED_PURCHASE_SKUS, `${provider}:${modelSlug}`);
}
