import {
  parseStrictEffortMetadata,
  parseUniqueEffortFromText,
  resolveAllowlistedProvider,
  resolveModelSlugFromString,
} from "../../../src/lib/math/canonicalize.ts";
import type {
  DomainId,
  ProviderId,
  RawObservation,
  ReasoningEffort,
} from "../../../src/lib/schema.ts";
import {
  extractRscText,
  fetchText,
  observationsMatchExact,
  parseBalancedJson,
  parseIsoDate,
  parseNumeric,
  parsePositive,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const AA_MODELS_URL = "https://artificialanalysis.ai/leaderboards/models";
const AA_BRIEFCASE_URL = "https://artificialanalysis.ai/evaluations/aa-briefcase";
const AA_GDPVAL_URL = "https://artificialanalysis.ai/evaluations/gdpval-aa";
const AA_CODE2VIDEO_URL = "https://artificialanalysis.ai/evaluations/code2video-aa";
const AA_CODING_AGENTS_URL = "https://artificialanalysis.ai/agents/coding-agents";

const MAX_ARENA_CI = 25;
const MAX_RUBRIC_ELO_CI = 30;

interface AaCodingAgentEval {
  datasetIndexName?: unknown;
  mean?: {
    reward?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
  } | null;
  safety?: {
    attemptCount?: unknown;
    fallbackAttemptCount?: unknown;
  } | null;
}

interface AaCodingAgentRow {
  id?: unknown;
  agentName?: unknown;
  agentSlug?: unknown;
  provider?: unknown;
  isRouter?: unknown;
  isUnavailable?: unknown;
  model?: {
    name?: unknown;
    suffix?: unknown;
    effort?: { slug?: unknown; label?: unknown } | null;
  } | null;
  mean?: {
    costUsd?: unknown;
  } | null;
  evals?: unknown;
}

interface AaLeaderboardModel {
  id: string;
  name: string;
  shortName?: string;
  suffix?: string | null;
  effort?: { slug?: string; label?: string } | null;
  deprecated?: boolean;
  isOpenWeights?: boolean;
  release?: { slug?: string; name?: string };
  modelCreatorName?: string;
  contextWindowTokens?: number | null;
  intelligenceIndexCostPerTask?: number | null;
  price1mInputTokens?: number | null;
  price1mOutputTokens?: number | null;
  cacheHitPrice?: number | null;
  scores?: Record<string, number | null | undefined>;
}

interface AaEvalModel {
  id?: string;
  name?: string;
  suffix?: string | null;
  releaseDate?: string | null;
  deprecated?: boolean;
  creator?: { name?: string };
  effort?: { slug?: string; label?: string } | null;
  briefcaseElo?: number | null;
  briefcaseBreakdown?: {
    elo?: number | null;
    lower95ci?: number | null;
    upper95ci?: number | null;
  } | null;
  gdpval?: number | null;
  gdpvalBreakdown?: {
    lower95ci?: number | null;
    upper95ci?: number | null;
  } | null;
  code2videoElo?: number | null;
  code2videoBreakdown?: {
    elo?: number | null;
    lower95ci?: number | null;
    upper95ci?: number | null;
  } | null;
}

interface BoundedScoreSpec {
  aaKey: string;
  benchmarkId: string;
  version: string;
  domainId: DomainId;
  harnessRegime: "native" | "standardized";
  observedHarness: string;
  sourceUrl: string;
}

// Every entry below is a verified 0..1 accuracy fraction on Artificial Analysis
const AA_BOUNDED_SPECS: readonly BoundedScoreSpec[] = [
  {
    aaKey: "frontiercode-2-0",
    benchmarkId: "frontiercode_2_0",
    version: "2.0",
    domainId: "coding",
    harnessRegime: "standardized",
    observedHarness: "Stirrup",
    sourceUrl: "https://artificialanalysis.ai/evaluations/frontiercode-2-0",
  },
  {
    aaKey: "terminalbench-4-0",
    benchmarkId: "terminalbench_4_0",
    version: "4.0",
    domainId: "coding",
    harnessRegime: "standardized",
    observedHarness: "mini-SWE-agent",
    sourceUrl: AA_MODELS_URL,
  },
  {
    aaKey: "scicode",
    benchmarkId: "scicode_aa",
    version: "1.0",
    domainId: "coding",
    harnessRegime: "standardized",
    observedHarness: "Direct API",
    sourceUrl: AA_MODELS_URL,
  },
  {
    aaKey: "mlcr-aa",
    benchmarkId: "mlcr_aa",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Direct API",
    sourceUrl: AA_MODELS_URL,
  },
  {
    aaKey: "omniscience-accuracy",
    benchmarkId: "aa_omniscience",
    version: "1.1",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Direct API",
    sourceUrl: AA_MODELS_URL,
  },
  {
    aaKey: "gdp-pdf",
    benchmarkId: "gdp_pdf",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Direct API",
    sourceUrl: AA_MODELS_URL,
  },
  {
    aaKey: "hle-diamond",
    benchmarkId: "hle_diamond",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Direct API",
    sourceUrl: AA_MODELS_URL,
  },
  {
    aaKey: "critpt-v2-hard",
    benchmarkId: "critpt_v2_hard",
    version: "2.0",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Stirrup",
    sourceUrl: AA_MODELS_URL,
  },
  {
    aaKey: "terminal-bench-science",
    benchmarkId: "terminalbench_science_aa",
    version: "0.1",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "mini-SWE-agent",
    sourceUrl: "https://artificialanalysis.ai/evaluations/terminal-bench-science",
  },
  {
    aaKey: "aa-analyst-agent",
    benchmarkId: "aa_analyst_agent",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "AA Analyst Harness",
    sourceUrl: "https://artificialanalysis.ai/evaluations/aa-analyst-agent",
  },
  {
    aaKey: "mka",
    benchmarkId: "aa_mka",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Stirrup",
    sourceUrl: "https://artificialanalysis.ai/evaluations/mka",
  },
  {
    aaKey: "vials-aa",
    benchmarkId: "aa_vials",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Stirrup",
    sourceUrl: "https://artificialanalysis.ai/evaluations/vials-aa",
  },
];

function extractModelArrayByKey(rsc: string, key: string): unknown[] {
  const needle = `"${key}":[`;
  let searchFrom = 0;
  let best: unknown[] = [];

  while (searchFrom < rsc.length) {
    const idx = rsc.indexOf(needle, searchFrom);
    if (idx === -1) break;
    const arr = parseBalancedJson(rsc, idx + needle.length - 1);
    if (Array.isArray(arr) && arr.length > best.length) {
      best = arr;
    }
    searchFrom = idx + needle.length;
  }
  return best;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasMalformedOptionalString(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== "string";
}

const AA_MANUAL_BUDGET_RX = /(?:^|[\s_(,:;/+=-])(\d+k)(?=$|[\s_),:;/+=-])/i;

function stripFallbackTag(raw: string): string {
  return raw.replace(/,?\s*(?:default\s+fallback|with\s+fallback)/gi, "").trim();
}

function normalizeAaEffort(suffix: unknown, effortSlug?: unknown): string | null {
  const rawSuffix = cleanString(suffix);
  if (rawSuffix && AA_MANUAL_BUDGET_RX.test(rawSuffix)) {
    return rawSuffix;
  }
  const slug = cleanString(effortSlug);
  if (slug) return stripFallbackTag(slug) || slug;
  if (!rawSuffix) return null;
  const cleaned = stripFallbackTag(rawSuffix);
  return cleaned || null;
}

function isConcreteEffortTier(eff: ReasoningEffort | null): boolean {
  return eff !== null && eff !== "thinking";
}

interface VerifiedEvalIdentity {
  id: string;
  provider: ProviderId | null;
  modelSlug: string | null;
  normalizedBaseName: string | null;
  suffix: string | null;
  effortSlug: string | null;
  canonicalTier: ReasoningEffort | null;
  manualBudget: string | null;
  gatedDaybreak: boolean;
  fallbackRouting: boolean;
  conflict: boolean;
}

function isAaDaybreakLabel(name: string | null, suffix: unknown, effortSlug: unknown): boolean {
  const joined = `${name ?? ""} ${cleanString(suffix) ?? ""} ${cleanString(effortSlug) ?? ""}`;
  return /\bdaybreak\b/i.test(joined.replace(/_/g, " "));
}

function isAaFallbackRoutingLabel(
  name: string | null,
  suffix: unknown,
  effortSlug: unknown,
): boolean {
  const joined = `${name ?? ""} ${cleanString(suffix) ?? ""} ${cleanString(effortSlug) ?? ""}`;
  return /\b(?:default\s+fallback|with\s+fallback|server[-_\s]+side[-_\s]+fallback)\b/i.test(
    joined.replace(/_/g, " "),
  );
}

function normalizeAaBaseModelName(name: string | null): string | null {
  if (!name) return null;
  const cleaned = name
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return cleaned || null;
}

function concreteTiersConflict(a: ReasoningEffort | null, b: ReasoningEffort | null): boolean {
  if ((a === "thinking" && b === "none") || (a === "none" && b === "thinking")) return true;
  return isConcreteEffortTier(a) && isConcreteEffortTier(b) && a !== b;
}

function resolveRowCanonicalEffort(
  name: string | null,
  suffix: unknown,
  effortSlug: unknown,
): {
  tier: ReasoningEffort | null;
  manualBudget: string | null;
  conflict: boolean;
} {
  const cleanSuf = cleanString(suffix);
  const cleanSlug = cleanString(effortSlug);
  const manualBudget =
    cleanSlug?.match(AA_MANUAL_BUDGET_RX)?.[1] ??
    cleanSuf?.match(AA_MANUAL_BUDGET_RX)?.[1] ??
    name?.match(AA_MANUAL_BUDGET_RX)?.[1] ??
    null;

  const strippedSlug = cleanSlug ? stripFallbackTag(cleanSlug) : "";
  const strictSlugTier = strippedSlug ? parseStrictEffortMetadata(strippedSlug) : null;
  const slugUnparseable = strippedSlug.length > 0 && strictSlugTier === null;

  const strippedSuf = cleanSuf
    ? stripFallbackTag(cleanSuf)
        .replace(/^\((.*)\)$/, "$1")
        .trim()
    : "";
  const strictSufTier = strippedSuf ? parseStrictEffortMetadata(strippedSuf) : null;
  const sufParsed =
    strictSufTier !== null
      ? { effort: strictSufTier, ambiguous: false }
      : parseUniqueEffortFromText(strippedSuf, true);

  const nameParsed = parseUniqueEffortFromText(name, true);

  const slugTier = strictSlugTier;
  const sufTier = sufParsed.effort;
  const nameTier = nameParsed.effort;
  const conflict =
    slugUnparseable ||
    sufParsed.ambiguous ||
    nameParsed.ambiguous ||
    concreteTiersConflict(slugTier, sufTier) ||
    concreteTiersConflict(slugTier, nameTier) ||
    concreteTiersConflict(sufTier, nameTier);
  const tier = isConcreteEffortTier(slugTier)
    ? slugTier
    : isConcreteEffortTier(sufTier)
      ? sufTier
      : isConcreteEffortTier(nameTier)
        ? nameTier
        : (slugTier ?? sufTier ?? nameTier);
  return { tier, manualBudget, conflict };
}

function mergeIdentityRecord(
  map: Map<string, VerifiedEvalIdentity>,
  id: string,
  name: string | null,
  creator: string | null,
  suffix: unknown,
  effortSlug: unknown,
  malformedMeta = false,
): VerifiedEvalIdentity {
  const nextSuffix = cleanString(suffix);
  const nextSlug = cleanString(effortSlug);
  const rowEff = resolveRowCanonicalEffort(name, nextSuffix, nextSlug);
  const rowDaybreak = isAaDaybreakLabel(name, nextSuffix, nextSlug);
  const rowFallback = isAaFallbackRoutingLabel(name, nextSuffix, nextSlug);
  const resolvedModel = name ? resolveModelSlugFromString(name, creator) : null;
  const nextProvider = resolvedModel?.provider ?? resolveAllowlistedProvider(creator);
  const nextModelSlug = resolvedModel?.modelSlug ?? null;
  const nextBaseName = normalizeAaBaseModelName(name);
  const existing = map.get(id);
  if (!existing) {
    const rec: VerifiedEvalIdentity = {
      id,
      provider: nextProvider,
      modelSlug: nextModelSlug,
      normalizedBaseName: nextBaseName,
      suffix: nextSuffix,
      effortSlug: nextSlug,
      canonicalTier: rowEff.tier,
      manualBudget: rowEff.manualBudget,
      gatedDaybreak: rowDaybreak,
      fallbackRouting: rowFallback,
      conflict: malformedMeta || rowEff.conflict,
    };
    map.set(id, rec);
    return rec;
  }
  const modelConflict =
    (existing.modelSlug !== null &&
      nextModelSlug !== null &&
      existing.modelSlug !== nextModelSlug) ||
    (existing.provider !== null && nextProvider !== null && existing.provider !== nextProvider) ||
    ((existing.modelSlug === null || nextModelSlug === null) &&
      existing.normalizedBaseName !== null &&
      nextBaseName !== null &&
      existing.normalizedBaseName !== nextBaseName);
  const crossConflict =
    modelConflict ||
    concreteTiersConflict(existing.canonicalTier, rowEff.tier) ||
    (existing.manualBudget !== null &&
      rowEff.manualBudget !== null &&
      existing.manualBudget.toLowerCase() !== rowEff.manualBudget.toLowerCase());
  const nextTier = isConcreteEffortTier(existing.canonicalTier)
    ? existing.canonicalTier
    : isConcreteEffortTier(rowEff.tier)
      ? rowEff.tier
      : (existing.canonicalTier ?? rowEff.tier);
  const merged: VerifiedEvalIdentity = {
    id,
    provider: existing.provider ?? nextProvider,
    modelSlug: existing.modelSlug ?? nextModelSlug,
    normalizedBaseName: existing.normalizedBaseName ?? nextBaseName,
    suffix: existing.suffix ?? nextSuffix,
    effortSlug: existing.effortSlug ?? nextSlug,
    canonicalTier: nextTier,
    manualBudget: existing.manualBudget ?? rowEff.manualBudget,
    gatedDaybreak: existing.gatedDaybreak || rowDaybreak,
    fallbackRouting: existing.fallbackRouting || rowFallback,
    conflict: existing.conflict || malformedMeta || rowEff.conflict || crossConflict,
  };
  map.set(id, merged);
  return merged;
}

function numericDisagrees(a: number | null, b: number | null, tol = 1e-4): boolean {
  return a !== null && b !== null && Math.abs(a - b) > tol;
}

interface AccumulatedInterval {
  elo?: number | null;
  lower95ci: number | null;
  upper95ci: number | null;
  hasComplete: boolean;
}

// Retain every seen partial or complete CI bound across duplicate rows so conflicts fire order-independently
function mergeIntervalBounds(
  prev: AccumulatedInterval | null | undefined,
  next:
    | { elo?: number | null; lower95ci?: number | null; upper95ci?: number | null }
    | null
    | undefined,
): { chosen: AccumulatedInterval | null; conflict: boolean } {
  const pLow = parseNumeric(prev?.lower95ci);
  const pHigh = parseNumeric(prev?.upper95ci);
  const nLow = parseNumeric(next?.lower95ci);
  const nHigh = parseNumeric(next?.upper95ci);
  const nextComplete = nLow !== null && nHigh !== null && nHigh > nLow;
  const nextInvalidComplete = nLow !== null && nHigh !== null && nHigh <= nLow;
  const conflict =
    numericDisagrees(pLow, nLow) || numericDisagrees(pHigh, nHigh) || nextInvalidComplete;
  const lower95ci = pLow ?? nLow;
  const upper95ci = pHigh ?? nHigh;
  const hasComplete = Boolean(prev?.hasComplete) || nextComplete;
  const elo = parseNumeric(next?.elo) ?? parseNumeric(prev?.elo);
  if (lower95ci === null && upper95ci === null && elo === null) {
    return { chosen: null, conflict };
  }
  return {
    chosen: { elo, lower95ci, upper95ci, hasComplete },
    conflict,
  };
}

export const artificialAnalysisAdapter: SourceAdapter = {
  id: "artificial-analysis",
  label: "Artificial Analysis Frontier Suite",
  license: "Public Benchmarks / Attribution Required",
  sourceUrl: AA_MODELS_URL,
  expectedBenchmarks: [
    "frontiercode_2_0",
    "terminalbench_4_0",
    "scicode_aa",
    "aa_code2video",
    "aa_briefcase",
    "gdpval_aa",
    "mlcr_aa",
    "aa_omniscience",
    "gdp_pdf",
    "hle_diamond",
    "critpt_v2_hard",
    "terminalbench_science_aa",
    "aa_analyst_agent",
    "aa_mka",
    "aa_vials",
    "aa_agent_frontiercode",
    "aa_agent_swe_atlas",
  ],
  expectsPricing: false,
  async fetchLive(nowIso) {
    const [modelsRes, briefcaseRes, gdpvalRes, code2videoRes, codingAgentsRes] =
      await Promise.allSettled([
        fetchText(AA_MODELS_URL, { rejectRedirects: false }),
        fetchText(AA_BRIEFCASE_URL, { rejectRedirects: false }),
        fetchText(AA_GDPVAL_URL, { rejectRedirects: false }),
        fetchText(AA_CODE2VIDEO_URL, { rejectRedirects: false }),
        fetchText(AA_CODING_AGENTS_URL, { rejectRedirects: false }),
      ]);

    const partitionStats: Record<string, PartitionStats> = {};
    const ensureStat = (bmId: string): PartitionStats => {
      if (!partitionStats[bmId]) {
        partitionStats[bmId] = { attempted: 0, rejected: 0, excluded: 0 };
      }
      return partitionStats[bmId]!;
    };

    type MergedEvalRow = Omit<
      AaEvalModel,
      "briefcaseBreakdown" | "gdpvalBreakdown" | "code2videoBreakdown"
    > & {
      briefcaseBreakdown?: AccumulatedInterval | null;
      gdpvalBreakdown?: AccumulatedInterval | null;
      code2videoBreakdown?: AccumulatedInterval | null;
      rowConflict?: boolean;
    };

    const observations: RawObservation[] = [];
    const evalIdentityById = new Map<string, VerifiedEvalIdentity>();
    const evalIdsByPage = new Map<string, Set<string>>();
    const briefcaseRows: MergedEvalRow[] = [];
    const gdpvalRows: MergedEvalRow[] = [];
    const code2videoRows: MergedEvalRow[] = [];

    // Keep Elo eval rows isolated per page while detecting same-page and cross-page conflicts order-independently
    const ingestEvalPage = (
      res: PromiseSettledResult<string>,
      bmId: "aa_briefcase" | "gdpval_aa" | "aa_code2video",
      targetRows: MergedEvalRow[],
    ): number => {
      const st = ensureStat(bmId);
      const pageIds = new Set<string>();
      evalIdsByPage.set(bmId, pageIds);
      if (res.status !== "fulfilled") {
        st.error = res.reason instanceof Error ? res.reason.message : String(res.reason);
        return 0;
      }
      let rsc: string;
      try {
        rsc = extractRscText(res.value);
      } catch (err) {
        st.error = err instanceof Error ? err.message : String(err);
        return 0;
      }
      const arr = [
        ...extractModelArrayByKey(rsc, "models"),
        ...extractModelArrayByKey(rsc, "initialModels"),
      ] as AaEvalModel[];
      const pageRowById = new Map<string, MergedEvalRow>();

      for (const ev of arr) {
        if (!ev || typeof ev !== "object") continue;
        const evId = cleanString(ev.id);
        if (!evId) continue;
        const evCreator = cleanString(ev.creator?.name);
        const malformedEffortObj =
          ev.effort !== undefined &&
          ev.effort !== null &&
          (typeof ev.effort !== "object" || hasMalformedOptionalString(ev.effort.slug));
        if (hasMalformedOptionalString(ev.suffix) || malformedEffortObj) {
          mergeIdentityRecord(
            evalIdentityById,
            evId,
            cleanString(ev.name),
            evCreator,
            ev.suffix,
            undefined,
            true,
          );
          st.attempted++;
          st.rejected++;
          continue;
        }
        pageIds.add(evId);

        const prevRow = pageRowById.get(evId);
        const topBcElo = parseNumeric(ev.briefcaseElo);
        const breakdownBcElo = parseNumeric(ev.briefcaseBreakdown?.elo);
        const prevBcElo = parseNumeric(prevRow?.briefcaseElo ?? prevRow?.briefcaseBreakdown?.elo);
        const nextBcElo = topBcElo ?? breakdownBcElo;
        const prevGvElo = parseNumeric(prevRow?.gdpval);
        const nextGvElo = parseNumeric(ev.gdpval);
        const topC2vElo = parseNumeric(ev.code2videoElo);
        const breakdownC2vElo = parseNumeric(ev.code2videoBreakdown?.elo);
        const prevC2vElo = parseNumeric(
          prevRow?.code2videoElo ?? prevRow?.code2videoBreakdown?.elo,
        );
        const nextC2vElo = topC2vElo ?? breakdownC2vElo;
        const bcInterval = mergeIntervalBounds(prevRow?.briefcaseBreakdown, ev.briefcaseBreakdown);
        const gvInterval = mergeIntervalBounds(prevRow?.gdpvalBreakdown, ev.gdpvalBreakdown);
        const c2vInterval = mergeIntervalBounds(
          prevRow?.code2videoBreakdown,
          ev.code2videoBreakdown,
        );
        const metricConflict =
          Boolean(prevRow?.rowConflict) ||
          numericDisagrees(topBcElo, breakdownBcElo) ||
          numericDisagrees(prevBcElo, nextBcElo) ||
          numericDisagrees(prevGvElo, nextGvElo) ||
          numericDisagrees(topC2vElo, breakdownC2vElo) ||
          numericDisagrees(prevC2vElo, nextC2vElo) ||
          bcInterval.conflict ||
          gvInterval.conflict ||
          c2vInterval.conflict;

        const resolvedCreator = ev.creator?.name ? ev.creator : prevRow?.creator;
        pageRowById.set(evId, {
          ...prevRow,
          ...ev,
          name: cleanString(ev.name) ?? prevRow?.name ?? "",
          suffix: cleanString(ev.suffix) ?? prevRow?.suffix ?? null,
          ...(resolvedCreator ? { creator: resolvedCreator } : {}),
          effort: ev.effort?.slug ? ev.effort : (prevRow?.effort ?? null),
          briefcaseElo: nextBcElo ?? prevBcElo ?? null,
          briefcaseBreakdown: bcInterval.chosen,
          gdpval: nextGvElo ?? prevGvElo ?? null,
          gdpvalBreakdown: gvInterval.chosen,
          code2videoElo: nextC2vElo ?? prevC2vElo ?? null,
          code2videoBreakdown: c2vInterval.chosen,
          rowConflict: metricConflict,
        });

        mergeIdentityRecord(
          evalIdentityById,
          evId,
          cleanString(ev.name),
          evCreator,
          ev.suffix,
          ev.effort?.slug,
        );
        if (typeof ev.releaseDate === "string") {
          parseIsoDate(ev.releaseDate, nowIso);
        }
      }
      for (const mergedRow of pageRowById.values()) {
        targetRows.push(mergedRow);
      }
      const parsedCount = pageRowById.size;
      if (parsedCount === 0) {
        st.error = `AA eval page ${bmId} returned 0 model records`;
      }
      return parsedCount;
    };

    const briefcaseCount = ingestEvalPage(briefcaseRes, "aa_briefcase", briefcaseRows);
    const gdpvalCount = ingestEvalPage(gdpvalRes, "gdpval_aa", gdpvalRows);
    const code2videoCount = ingestEvalPage(code2videoRes, "aa_code2video", code2videoRows);

    const evalOrCyberJoinedIds = new Set<string>([
      ...(evalIdsByPage.get("aa_briefcase") ?? []),
      ...(evalIdsByPage.get("gdpval_aa") ?? []),
      ...(evalIdsByPage.get("aa_code2video") ?? []),
    ]);

    let leaderboardModels: AaLeaderboardModel[] = [];
    let modelsParseError: string | null = null;
    if (modelsRes.status === "fulfilled") {
      try {
        const modelsRsc = extractRscText(modelsRes.value);
        leaderboardModels = extractModelArrayByKey(
          modelsRsc,
          "initialModels",
        ) as AaLeaderboardModel[];
      } catch (err) {
        modelsParseError = err instanceof Error ? err.message : String(err);
      }
      for (const m of leaderboardModels) {
        if (!m || typeof m !== "object") continue;
        const rowId = cleanString(m.id);
        const rowName = cleanString(m.name);
        if (!rowId || !rowName) continue;
        const malformedEffort =
          m.effort !== undefined &&
          m.effort !== null &&
          (typeof m.effort !== "object" || hasMalformedOptionalString(m.effort.slug));
        const malformedMeta = hasMalformedOptionalString(m.suffix) || malformedEffort;
        mergeIdentityRecord(
          evalIdentityById,
          rowId,
          rowName,
          cleanString(m.modelCreatorName),
          m.suffix,
          malformedEffort ? undefined : m.effort?.slug,
          malformedMeta,
        );
      }
    }

    const emitEffortForId = (id: string, suffix: unknown, effortSlug: unknown): string | null => {
      const ident = evalIdentityById.get(id);
      if (ident?.manualBudget) {
        return `${ident.canonicalTier ?? ""} ${ident.manualBudget}`.trim();
      }
      return ident?.canonicalTier ?? normalizeAaEffort(suffix, effortSlug);
    };

    // Allow bounded AA scores to proceed per row using surviving eval metadata and explicit suffixes if at least one eval page succeeded
    let evalMetadataError =
      modelsParseError ??
      (briefcaseCount === 0 && gdpvalCount === 0 && code2videoCount === 0
        ? `effort metadata unavailable (briefcase: ${partitionStats.aa_briefcase?.error ?? "empty"}; gdpval: ${partitionStats.gdpval_aa?.error ?? "empty"}; code2video: ${partitionStats.aa_code2video?.error ?? "empty"})`
        : null);

    if (modelsRes.status === "fulfilled" && !evalMetadataError) {
      const lbIds = new Set(
        leaderboardModels
          .map((m) => (m && typeof m === "object" ? cleanString(m.id) : null))
          .filter((id): id is string => id !== null),
      );
      const briefcaseJoinCount = [...(evalIdsByPage.get("aa_briefcase") ?? [])].filter((id) =>
        lbIds.has(id),
      ).length;
      const gdpvalJoinCount = [...(evalIdsByPage.get("gdpval_aa") ?? [])].filter((id) =>
        lbIds.has(id),
      ).length;
      const code2videoJoinCount = [...(evalIdsByPage.get("aa_code2video") ?? [])].filter((id) =>
        lbIds.has(id),
      ).length;
      const parsedLbEffortCount = leaderboardModels.filter((m) => {
        if (!m || typeof m !== "object") return false;
        const slug = m.effort && typeof m.effort === "object" ? cleanString(m.effort.slug) : null;
        return normalizeAaEffort(m.suffix, slug) !== null;
      }).length;
      if (
        lbIds.size > 0 &&
        ((briefcaseCount > 0 && briefcaseJoinCount === 0) ||
          (gdpvalCount > 0 && gdpvalJoinCount === 0) ||
          (code2videoCount > 0 && code2videoJoinCount === 0))
      ) {
        evalMetadataError = `AA eval metadata IDs failed leaderboard join (briefcase=${briefcaseJoinCount}, gdpval=${gdpvalJoinCount}, code2video=${code2videoJoinCount})`;
      } else if (leaderboardModels.length > 0 && parsedLbEffortCount === 0) {
        evalMetadataError =
          "AA /leaderboards/models parsed 0 rows with suffix or effort.slug metadata (possible upstream schema rename)";
      }

      if (!evalMetadataError) {
        const evalPartialOutage =
          briefcaseCount === 0 || gdpvalCount === 0 || code2videoCount === 0;
        for (const m of leaderboardModels) {
          if (!m || typeof m !== "object") continue;
          const rowId = cleanString(m.id);
          const rowName = cleanString(m.name);
          if (!rowId || !rowName) continue;
          const creator = cleanString(m.modelCreatorName);
          const suiteTaskCost = parsePositive(m.intelligenceIndexCostPerTask);
          const ident = evalIdentityById.get(rowId);
          const lbEffortSlug =
            m.effort && typeof m.effort === "object" ? cleanString(m.effort.slug) : null;
          const effortStr = emitEffortForId(rowId, m.suffix, lbEffortSlug ?? ident?.effortSlug);
          const lbEffCheck = resolveRowCanonicalEffort(rowName, m.suffix, lbEffortSlug);
          const parsedSuffixEffort = lbEffCheck.conflict
            ? null
            : parseUniqueEffortFromText(normalizeAaEffort(m.suffix, lbEffortSlug), true).effort;
          const parsedNameEffort = lbEffCheck.conflict
            ? null
            : parseUniqueEffortFromText(rowName, true).effort;
          const hasEvalJoin = evalOrCyberJoinedIds.has(rowId);
          const fallbackRouting =
            (ident?.fallbackRouting ?? false) ||
            isAaFallbackRoutingLabel(rowName, m.suffix, lbEffortSlug);
          // Require non-conflicting unified identity plus eval/cyber join or explicit suffix/name effort provenance
          const hasVerifiedEffortProvenance =
            !(ident?.conflict ?? false) &&
            !lbEffCheck.conflict &&
            (hasEvalJoin ||
              (evalPartialOutage
                ? isConcreteEffortTier(parsedSuffixEffort)
                : parsedSuffixEffort !== null || parsedNameEffort !== null));
          const scores = m.scores && typeof m.scores === "object" ? m.scores : {};

          for (const spec of AA_BOUNDED_SPECS) {
            const rawVal = scores[spec.aaKey];
            if (rawVal === undefined || rawVal === null) continue;
            const st = ensureStat(spec.benchmarkId);
            st.attempted++;
            if (
              ident?.gatedDaybreak ||
              (creator !== null && resolveAllowlistedProvider(creator) === null)
            ) {
              st.excluded++;
              continue;
            }
            if (!hasVerifiedEffortProvenance) {
              // Legacy models absent from AA's effort-tagged eval pages and without explicit effort suffixes are excluded, not malformed
              if (!(ident?.conflict ?? false) && !lbEffCheck.conflict) {
                st.excluded++;
              } else {
                st.rejected++;
              }
              continue;
            }
            const fraction = parseNumeric(rawVal);
            if (fraction === null || fraction < 0 || fraction > 1) {
              st.rejected++;
              continue;
            }
            const pct = Number((fraction * 100).toFixed(2));
            observations.push({
              sourceId: "artificial-analysis",
              sourceRowId: `aa:${spec.benchmarkId}:${rowId}`,
              benchmarkId: spec.benchmarkId,
              benchmarkVersion: spec.version,
              domainId: spec.domainId,
              rawModelName: rowName,
              rawProvider: creator,
              rawEffort: effortStr,
              rawHarness: null,
              observedHarness: spec.observedHarness,
              harnessRegime: spec.harnessRegime,
              rawScore: pct,
              ciHalfWidth: null,
              ciLower: null,
              ciUpper: null,
              battleCount: null,
              measuredCostUsd: null,
              ...(fallbackRouting ? { fallbackRouting: true } : {}),
              suiteCostUsd: suiteTaskCost !== null ? Number(suiteTaskCost.toFixed(6)) : null,
              measuredInputTokens: null,
              measuredOutputTokens: null,
              evalDate: null,
              publishedDate: null,
              sourceUrl: spec.sourceUrl,
            });
          }
        }
      }
    }
    if (modelsRes.status !== "fulfilled" || evalMetadataError) {
      const msg =
        modelsRes.status !== "fulfilled"
          ? modelsRes.reason instanceof Error
            ? modelsRes.reason.message
            : String(modelsRes.reason)
          : (evalMetadataError ?? "AA effort metadata unavailable");
      for (const spec of AA_BOUNDED_SPECS) {
        ensureStat(spec.benchmarkId).error = msg;
      }
    }

    // Emit Briefcase and GDPVal Elo scores strictly from each page's own interval and unified conflict-checked identity
    for (const ev of briefcaseRows) {
      const evId = cleanString(ev.id);
      const evName = cleanString(ev.name);
      if (!evId || !evName) continue;
      const bc = ev.briefcaseBreakdown;
      const bcElo = parseNumeric(ev.briefcaseElo ?? bc?.elo);
      if (bcElo === null) continue;

      const st = ensureStat("aa_briefcase");
      st.attempted++;
      const ident = evalIdentityById.get(evId);
      if (ident?.gatedDaybreak) {
        st.excluded++;
        continue;
      }
      if (ev.rowConflict || ident?.conflict) {
        st.rejected++;
        continue;
      }
      const bcLow = parseNumeric(bc?.lower95ci);
      const bcHigh = parseNumeric(bc?.upper95ci);
      if (
        !bc?.hasComplete ||
        bcLow === null ||
        bcHigh === null ||
        bcHigh <= bcLow ||
        bcElo < bcLow - 0.01 ||
        bcElo > bcHigh + 0.01
      ) {
        st.rejected++;
        continue;
      }
      const rawCiHalf = (bcHigh - bcLow) / 2;
      if (rawCiHalf > MAX_ARENA_CI) {
        st.excluded++;
        continue;
      }
      const roundedCiHalf = Number(rawCiHalf.toFixed(4));
      if (!(roundedCiHalf > 0)) {
        st.rejected++;
        continue;
      }
      const fallbackRouting =
        (ident?.fallbackRouting ?? false) ||
        isAaFallbackRoutingLabel(evName, ev.suffix, ev.effort?.slug);
      observations.push({
        sourceId: "artificial-analysis",
        sourceRowId: `aa:aa_briefcase:${evId}`,
        benchmarkId: "aa_briefcase",
        benchmarkVersion: "1.1",
        domainId: "research",
        rawModelName: evName,
        rawProvider: cleanString(ev.creator?.name),
        rawEffort: emitEffortForId(evId, ev.suffix, ev.effort?.slug),
        rawHarness: null,
        observedHarness: "Stirrup",
        harnessRegime: "native",
        rawScore: Number(bcElo.toFixed(2)),
        ciHalfWidth: Number(rawCiHalf.toFixed(4)),
        ciLower: Number(bcLow.toFixed(4)),
        ciUpper: Number(bcHigh.toFixed(4)),
        battleCount: null,
        measuredCostUsd: null,
        ...(fallbackRouting ? { fallbackRouting: true } : {}),
        suiteCostUsd: null,
        measuredInputTokens: null,
        measuredOutputTokens: null,
        evalDate: null,
        publishedDate: null,
        sourceUrl: AA_BRIEFCASE_URL,
      });
    }

    for (const ev of gdpvalRows) {
      const evId = cleanString(ev.id);
      const evName = cleanString(ev.name);
      if (!evId || !evName) continue;
      const gv = ev.gdpvalBreakdown;
      const gvElo = parseNumeric(ev.gdpval);
      if (gvElo === null) continue;

      const st = ensureStat("gdpval_aa");
      st.attempted++;
      const ident = evalIdentityById.get(evId);
      if (ident?.gatedDaybreak) {
        st.excluded++;
        continue;
      }
      if (ev.rowConflict || ident?.conflict) {
        st.rejected++;
        continue;
      }
      const gvLow = parseNumeric(gv?.lower95ci);
      const gvHigh = parseNumeric(gv?.upper95ci);
      if (
        !gv?.hasComplete ||
        gvLow === null ||
        gvHigh === null ||
        gvHigh <= gvLow ||
        gvElo < gvLow - 0.01 ||
        gvElo > gvHigh + 0.01
      ) {
        st.rejected++;
        continue;
      }
      const rawCiHalf = (gvHigh - gvLow) / 2;
      if (rawCiHalf > MAX_ARENA_CI) {
        st.excluded++;
        continue;
      }
      const roundedCiHalf = Number(rawCiHalf.toFixed(4));
      if (!(roundedCiHalf > 0)) {
        st.rejected++;
        continue;
      }
      const fallbackRouting =
        (ident?.fallbackRouting ?? false) ||
        isAaFallbackRoutingLabel(evName, ev.suffix, ev.effort?.slug);
      observations.push({
        sourceId: "artificial-analysis",
        sourceRowId: `aa:gdpval_aa:${evId}`,
        benchmarkId: "gdpval_aa",
        benchmarkVersion: "2.1",
        domainId: "research",
        rawModelName: evName,
        rawProvider: cleanString(ev.creator?.name),
        rawEffort: emitEffortForId(evId, ev.suffix, ev.effort?.slug),
        rawHarness: null,
        observedHarness: "Stirrup",
        harnessRegime: "native",
        rawScore: Number(gvElo.toFixed(2)),
        ciHalfWidth: Number(rawCiHalf.toFixed(4)),
        ciLower: Number(gvLow.toFixed(4)),
        ciUpper: Number(gvHigh.toFixed(4)),
        battleCount: null,
        measuredCostUsd: null,
        ...(fallbackRouting ? { fallbackRouting: true } : {}),
        suiteCostUsd: null,
        measuredInputTokens: null,
        measuredOutputTokens: null,
        evalDate: null,
        publishedDate: null,
        sourceUrl: AA_GDPVAL_URL,
      });
    }

    for (const ev of code2videoRows) {
      const evId = cleanString(ev.id);
      const evName = cleanString(ev.name);
      if (!evId || !evName) continue;
      const c2v = ev.code2videoBreakdown;
      const c2vElo = parseNumeric(ev.code2videoElo ?? c2v?.elo);
      if (c2vElo === null) continue;

      const st = ensureStat("aa_code2video");
      st.attempted++;
      const ident = evalIdentityById.get(evId);
      if (ident?.gatedDaybreak) {
        st.excluded++;
        continue;
      }
      if (ev.rowConflict || ident?.conflict) {
        st.rejected++;
        continue;
      }
      const c2vLow = parseNumeric(c2v?.lower95ci);
      const c2vHigh = parseNumeric(c2v?.upper95ci);
      if (
        !c2v?.hasComplete ||
        c2vLow === null ||
        c2vHigh === null ||
        c2vHigh <= c2vLow ||
        c2vElo < c2vLow - 0.01 ||
        c2vElo > c2vHigh + 0.01
      ) {
        st.rejected++;
        continue;
      }
      const rawCiHalf = (c2vHigh - c2vLow) / 2;
      if (rawCiHalf > MAX_RUBRIC_ELO_CI) {
        st.excluded++;
        continue;
      }
      const roundedCiHalf = Number(rawCiHalf.toFixed(4));
      if (!(roundedCiHalf > 0)) {
        st.rejected++;
        continue;
      }
      const fallbackRouting =
        (ident?.fallbackRouting ?? false) ||
        isAaFallbackRoutingLabel(evName, ev.suffix, ev.effort?.slug);
      observations.push({
        sourceId: "artificial-analysis",
        sourceRowId: `aa:aa_code2video:${evId}`,
        benchmarkId: "aa_code2video",
        benchmarkVersion: "1.0",
        domainId: "design_code",
        rawModelName: evName,
        rawProvider: cleanString(ev.creator?.name),
        rawEffort: emitEffortForId(evId, ev.suffix, ev.effort?.slug),
        rawHarness: null,
        observedHarness: "Stirrup",
        harnessRegime: "native",
        rawScore: Number(c2vElo.toFixed(2)),
        ciHalfWidth: Number(rawCiHalf.toFixed(4)),
        ciLower: Number(c2vLow.toFixed(4)),
        ciUpper: Number(c2vHigh.toFixed(4)),
        battleCount: null,
        measuredCostUsd: null,
        ...(fallbackRouting ? { fallbackRouting: true } : {}),
        suiteCostUsd: null,
        measuredInputTokens: null,
        measuredOutputTokens: null,
        evalDate: null,
        publishedDate: null,
        sourceUrl: AA_CODE2VIDEO_URL,
      });
    }

    // Emit independent AA Coding Agent sub-evals (FrontierCode 2.0 & SWE-Atlas-QnA, excluding TB 4.1 to avoid double-counting)
    const AA_AGENT_SUB_SPECS = [
      {
        datasetIndexName: "frontiercode-v2.0",
        benchmarkId: "aa_agent_frontiercode",
        version: "2.0",
      },
      {
        datasetIndexName: "swe-atlas-qna",
        benchmarkId: "aa_agent_swe_atlas",
        version: "1.0",
      },
    ] as const;
    const disqualifiedByBenchmark: Record<string, string[]> = {};

    if (codingAgentsRes.status !== "fulfilled") {
      const err =
        codingAgentsRes.reason instanceof Error
          ? codingAgentsRes.reason.message
          : String(codingAgentsRes.reason);
      for (const spec of AA_AGENT_SUB_SPECS) ensureStat(spec.benchmarkId).error = err;
    } else {
      try {
        const agRsc = extractRscText(codingAgentsRes.value);
        const agRows = extractModelArrayByKey(agRsc, "benchmarkRows") as AaCodingAgentRow[];
        if (agRows.length === 0) {
          for (const spec of AA_AGENT_SUB_SPECS) {
            ensureStat(spec.benchmarkId).error = "AA Coding Agents returned 0 benchmarkRows";
          }
        } else {
          const candidatesBySpec = new Map<string, Map<string, RawObservation[]>>();
          for (const spec of AA_AGENT_SUB_SPECS) {
            candidatesBySpec.set(spec.benchmarkId, new Map());
          }
          for (const row of agRows) {
            if (!row || typeof row !== "object") continue;
            if (row.isRouter === true || row.isUnavailable === true) continue;
            const rowId = cleanString(row.id);
            const agentName = cleanString(row.agentName);
            const modelName = cleanString(row.model?.name);
            const provider = cleanString(row.provider);
            const effortSlug = cleanString(row.model?.effort?.slug);
            const effortSuffix = cleanString(row.model?.suffix);
            if (!rowId || !agentName || !modelName || !Array.isArray(row.evals)) continue;
            const resolvedEff = resolveRowCanonicalEffort(modelName, effortSuffix, effortSlug);
            const effortStr = resolvedEff.conflict
              ? null
              : (resolvedEff.manualBudget ??
                resolvedEff.tier ??
                normalizeAaEffort(effortSuffix, effortSlug));
            const isGated = isAaDaybreakLabel(modelName, effortSuffix, effortSlug);
            const hasFallbackLabel = isAaFallbackRoutingLabel(modelName, effortSuffix, effortSlug);

            for (const spec of AA_AGENT_SUB_SPECS) {
              const ev = (row.evals as AaCodingAgentEval[]).find(
                (e) =>
                  (cleanString(e?.datasetIndexName)?.toLowerCase() ?? "") === spec.datasetIndexName,
              );
              const reward = parseNumeric(ev?.mean?.reward);
              if (reward === null) continue;
              const st = ensureStat(spec.benchmarkId);
              st.attempted++;
              if (isGated) {
                st.excluded++;
                continue;
              }
              if (resolvedEff.conflict || reward < 0 || reward > 1) {
                st.rejected++;
                continue;
              }
              const fallbackCount = parseNumeric(ev?.safety?.fallbackAttemptCount) ?? 0;
              const sourceRowId = `aa:${spec.benchmarkId}:${rowId}`;
              const obs: RawObservation = {
                sourceId: "artificial-analysis",
                sourceRowId,
                benchmarkId: spec.benchmarkId,
                benchmarkVersion: spec.version,
                domainId: "harnesses",
                rawModelName: modelName,
                rawProvider: provider,
                rawEffort: effortStr,
                rawHarness: agentName,
                observedHarness: agentName,
                harnessRegime: "native",
                rawScore: Number((reward * 100).toFixed(2)),
                ciHalfWidth: null,
                ciLower: null,
                ciUpper: null,
                battleCount: null,
                measuredCostUsd: null,
                ...(fallbackCount > 0 || hasFallbackLabel ? { fallbackRouting: true } : {}),
                suiteCostUsd: null,
                measuredInputTokens: null,
                measuredOutputTokens: null,
                evalDate: null,
                publishedDate: null,
                sourceUrl: AA_CODING_AGENTS_URL,
              };
              const byRow = candidatesBySpec.get(spec.benchmarkId)!;
              const grp = byRow.get(sourceRowId) ?? [];
              grp.push(obs);
              byRow.set(sourceRowId, grp);
            }
          }
          for (const spec of AA_AGENT_SUB_SPECS) {
            const st = ensureStat(spec.benchmarkId);
            const byRow = candidatesBySpec.get(spec.benchmarkId)!;
            const disqualified: string[] = [];
            for (const grp of byRow.values()) {
              const first = grp[0]!;
              if (grp.length > 1 && !grp.every((o) => observationsMatchExact(first, o))) {
                st.rejected += grp.length;
                disqualified.push(first.sourceRowId);
                continue;
              }
              observations.push(first);
            }
            if (disqualified.length > 0) disqualifiedByBenchmark[spec.benchmarkId] = disqualified;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const spec of AA_AGENT_SUB_SPECS) ensureStat(spec.benchmarkId).error = msg;
      }
    }

    return {
      observations,
      pricing: [],
      partitionStats,
      ...(Object.keys(disqualifiedByBenchmark).length > 0
        ? { disqualifiedSourceRowIdsByBenchmark: disqualifiedByBenchmark }
        : {}),
    };
  },
};
