import { parseExplicitEffort } from "../../../src/lib/math/canonicalize.ts";
import type { DomainId, HarnessRegime, RawObservation } from "../../../src/lib/schema.ts";
import {
  extractRscText,
  fetchText,
  parseBalancedJson,
  parseIsoDate,
  parseNumeric,
  parsePositive,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const SEAL_SWE_PRO_URL = "https://scale.com/leaderboard/swe_bench_pro_public_v2";

interface SealEntry {
  model?: string;
  version?: string;
  score?: number;
  confidenceInterval_upper?: number;
  company?: string;
  createdAt?: string;
  deprecated?: boolean;
}

interface SealVariant {
  key?: string;
  entries?: SealEntry[];
}

interface SealFeedSpec {
  pageKey: "swePro";
  url: string;
  variantKey: string;
  label: string;
  benchmarkId: string;
  version: string;
  domainId: DomainId;
  harnessRegime: HarnessRegime;
  defaultHarness: string;
  requireStandardizedSweHarness?: boolean;
}

const SEAL_FEEDS: readonly SealFeedSpec[] = [
  {
    pageKey: "swePro",
    url: SEAL_SWE_PRO_URL,
    variantKey: "full",
    label: "SWE-bench Pro v2",
    benchmarkId: "swe_bench_pro_v2",
    version: "2.0",
    domainId: "coding",
    harnessRegime: "standardized",
    defaultHarness: "mini-SWE-agent",
    requireStandardizedSweHarness: true,
  },
];

function extractVariantEntries(rsc: string, variantKey: string, label: string): SealEntry[] {
  const marker = '"variants":[';
  let pos = 0;
  while (pos < rsc.length) {
    const idx = rsc.indexOf(marker, pos);
    if (idx === -1) break;
    const arr = parseBalancedJson(rsc, idx + marker.length - 1);
    if (Array.isArray(arr)) {
      const target = (arr as SealVariant[]).find(
        (v) => v && typeof v === "object" && v.key === variantKey && Array.isArray(v.entries),
      );
      if (target?.entries && target.entries.length > 0) {
        return target.entries;
      }
    }
    pos = idx + marker.length;
  }
  throw new Error(`Scale SEAL ${label} '${variantKey}' variant array not found`);
}

function safeSealProvider(rawCompany: string | null, modelTrimmed: string): string | null {
  const inferredFamilyProvider = /^(?:claude|opus|sonnet|haiku|fable)\b/i.test(modelTrimmed)
    ? "anthropic"
    : /^(?:gpt-|o[134]\b)/i.test(modelTrimmed)
      ? "openai"
      : /^gemini\b/i.test(modelTrimmed)
        ? "google"
        : /^grok\b/i.test(modelTrimmed)
          ? "spacexai"
          : /^(?:muse|llama)\b/i.test(modelTrimmed)
            ? "meta"
            : /^deepseek\b/i.test(modelTrimmed)
              ? "deepseek"
              : /^kimi\b/i.test(modelTrimmed)
                ? "moonshot"
                : /^qwen\b/i.test(modelTrimmed)
                  ? "alibaba"
                  : /^glm\b/i.test(modelTrimmed)
                    ? "zhipu"
                    : null;
  // Upstream Scale SEAL tags OpenAI-compatible wire-format runs of non-OpenAI models with company="openai";
  // clear only that known wire-format artifact so genuine cross-lab mismatches still fail closed in canonicalize.ts
  if (
    rawCompany?.toLowerCase() === "openai" &&
    inferredFamilyProvider !== null &&
    inferredFamilyProvider !== "openai"
  ) {
    return null;
  }
  return rawCompany;
}

export const scaleSealAdapter: SourceAdapter = {
  id: "scale-seal",
  label: "Scale SEAL (SWE-bench Pro v2)",
  license: "Public Research Leaderboard",
  sourceUrl: SEAL_SWE_PRO_URL,
  expectedBenchmarks: SEAL_FEEDS.map((f) => f.benchmarkId),
  expectsPricing: false,
  async fetchLive(nowIso) {
    const [sweProRes] = await Promise.allSettled([fetchText(SEAL_SWE_PRO_URL)]);

    const resByPage: Record<SealFeedSpec["pageKey"], PromiseSettledResult<string>> = {
      swePro: sweProRes,
    };
    const rscByPage = new Map<SealFeedSpec["pageKey"], string>();
    const errByPage = new Map<SealFeedSpec["pageKey"], string>();
    for (const [key, res] of Object.entries(resByPage) as [
      SealFeedSpec["pageKey"],
      PromiseSettledResult<string>,
    ][]) {
      if (res.status === "fulfilled") {
        try {
          rscByPage.set(key, extractRscText(res.value));
        } catch (err) {
          errByPage.set(key, err instanceof Error ? err.message : String(err));
        }
      } else {
        errByPage.set(key, res.reason instanceof Error ? res.reason.message : String(res.reason));
      }
    }

    const observations: RawObservation[] = [];
    const partitionStats: Record<string, PartitionStats> = {};

    for (const spec of SEAL_FEEDS) {
      const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
      partitionStats[spec.benchmarkId] = st;

      const pageErr = errByPage.get(spec.pageKey);
      const rsc = rscByPage.get(spec.pageKey);
      if (pageErr || !rsc) {
        st.error = pageErr ?? `Missing Scale SEAL page '${spec.pageKey}'`;
        continue;
      }

      let entries: SealEntry[];
      try {
        entries = extractVariantEntries(rsc, spec.variantKey, spec.label);
      } catch (err) {
        st.error = err instanceof Error ? err.message : String(err);
        continue;
      }

      const seenRowIds = new Set<string>();
      for (const entry of entries) {
        st.attempted++;
        if (!entry || typeof entry !== "object") {
          st.rejected++;
          continue;
        }
        if (typeof entry.model !== "string" || !entry.model.trim()) {
          st.rejected++;
          continue;
        }
        if (entry.deprecated) {
          st.excluded++;
          continue;
        }
        const score = parseNumeric(entry.score);
        if (score === null || score < 0 || score > 100) {
          st.rejected++;
          continue;
        }

        const modelTrimmed = entry.model.trim();
        let observedHarness = spec.defaultHarness;
        if (spec.requireStandardizedSweHarness) {
          const parenTokens = [...modelTrimmed.matchAll(/\(([^)]+)\)/g)]
            .flatMap((m) => (m[1] ?? "").split(/[,/]+/))
            .map((t) => t.trim())
            .filter(
              (t) =>
                t.length > 0 &&
                parseExplicitEffort(t, false) === null &&
                !/^(?:202\d-\d{2}-\d{2}|202\d\d{4}|\d{4})$/.test(t),
            );
          if (
            parenTokens.length > 0 &&
            !parenTokens.every((t) => /^mini[\s_-]?swe[\s_-]?agent$/i.test(t))
          ) {
            st.excluded++;
            continue;
          }
          if (parenTokens.length > 0) observedHarness = parenTokens.join(", ");
        }

        const rawCompany = typeof entry.company === "string" ? entry.company.trim() || null : null;
        const ciHalf = parsePositive(entry.confidenceInterval_upper);
        const sourceRowId = `seal:${spec.benchmarkId}:${spec.variantKey}:${modelTrimmed}`;
        if (seenRowIds.has(sourceRowId)) continue;
        seenRowIds.add(sourceRowId);

        observations.push({
          sourceId: "scale-seal",
          sourceRowId,
          benchmarkId: spec.benchmarkId,
          benchmarkVersion: spec.version,
          domainId: spec.domainId,
          rawModelName: modelTrimmed,
          rawProvider: safeSealProvider(rawCompany, modelTrimmed),
          rawEffort: null,
          rawHarness: null,
          observedHarness,
          harnessRegime: spec.harnessRegime,
          rawScore: Number(score.toFixed(2)),
          seRaw: ciHalf !== null ? Number((ciHalf / 1.96).toFixed(6)) : null,
          ciHalfWidth: ciHalf !== null ? Number(ciHalf.toFixed(4)) : null,
          ciLower: null,
          ciUpper: null,
          battleCount: null,
          measuredCostUsd: null,
          suiteCostUsd: null,
          measuredInputTokens: null,
          measuredOutputTokens: null,
          evalDate: parseIsoDate(entry.createdAt, nowIso),
          publishedDate: null,
          sourceUrl: spec.url,
        });
      }
    }

    return { observations, pricing: [], partitionStats };
  },
};
