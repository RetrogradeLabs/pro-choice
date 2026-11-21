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
  parseStrictNonNegativeInt,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const AA_MODELS_URL = "https://artificialanalysis.ai/leaderboards/models";
const AA_BRIEFCASE_URL = "https://artificialanalysis.ai/evaluations/aa-briefcase";
const AA_GDPVAL_URL = "https://artificialanalysis.ai/evaluations/gdpval-aa";
const AA_CODE2VIDEO_URL = "https://artificialanalysis.ai/evaluations/code2video-aa";
const AA_CODING_AGENTS_URL = "https://artificialanalysis.ai/agents/coding-agents";

const MAX_ARENA_CI = 25;

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
  canonicalEvalTokenCounts?: {
    code2video?: {
      input?: number;
      answer?: number;
      reasoning?: number;
      cacheableInput?: number | null;
    };
  };
  price1mInputTokens?: number;
  price1mOutputTokens?: number;
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

function code2VideoCost(row: AaEvalModel): number | null {
  const usage = row.canonicalEvalTokenCounts?.code2video;
  const inputPrice = parsePositive(row.price1mInputTokens);
  const outputPrice = parsePositive(row.price1mOutputTokens);
  if (!usage || usage.cacheableInput !== null || inputPrice === null || outputPrice === null)
    return null;
  const input = parseStrictNonNegativeInt(usage.input);
  const answer = parseStrictNonNegativeInt(usage.answer);
  const reasoning = parseStrictNonNegativeInt(usage.reasoning);
  if (input === null || answer === null || reasoning === null) return null;
  return parsePositive(
    (input * inputPrice + (answer + reasoning) * outputPrice) / (114 * 1_000_000),
  );
}

interface BoundedScoreSpec {
  page?: {
    key: "itbenchSre" | "gatedAllPass";
    collection: "initialModels" | "models";
    protocol: string;
    catalogName: string;
  };
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
    sourceUrl: "https://artificialanalysis.ai/evaluations/terminalbench-4-0",
  },
  {
    aaKey: "itbench-aa",
    page: {
      key: "itbenchSre",
      collection: "initialModels",
      protocol: "59 Kubernetes incident tasks",
      catalogName: "ITBench-AA",
    },
    benchmarkId: "itbench_aa",
    version: "59-sre",
    domainId: "coding",
    harnessRegime: "standardized",
    observedHarness: "Stirrup",
    sourceUrl: "https://artificialanalysis.ai/evaluations/itbench-aa",
  },
  {
    aaKey: "mlcr-aa",
    benchmarkId: "mlcr_aa",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Direct API",
    sourceUrl: "https://artificialanalysis.ai/evaluations/mlcr-aa",
  },
  {
    aaKey: "omniscience-accuracy",
    benchmarkId: "aa_omniscience",
    version: "1.1",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Direct API",
    sourceUrl: "https://artificialanalysis.ai/evaluations/omniscience",
  },
  {
    aaKey: "gdp-pdf",
    benchmarkId: "gdp_pdf",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Direct API",
    sourceUrl: "https://artificialanalysis.ai/evaluations/gdp-pdf",
  },
  {
    aaKey: "hle-diamond",
    benchmarkId: "hle_diamond",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Direct API",
    sourceUrl: "https://artificialanalysis.ai/evaluations/hle-diamond",
  },
  {
    aaKey: "critpt-v2-hard",
    benchmarkId: "critpt_v2_hard",
    version: "2.0",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Stirrup",
    sourceUrl: "https://artificialanalysis.ai/evaluations/critpt-v2",
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
    aaKey: "harvey-lab-aa",
    page: {
      key: "gatedAllPass",
      collection: "models",
      protocol: "Harvey LAB-AA v1.1 Benchmark",
      catalogName: "Harvey LAB-AA v1.1",
    },
    benchmarkId: "harvey_lab_aa",
    version: "1.1",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Stirrup",
    sourceUrl: "https://artificialanalysis.ai/evaluations/harvey-lab-aa",
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
    "itbench_aa",
    "aa_briefcase",
    "gdpval_aa",
    "code2video_aa",
    "mlcr_aa",
    "aa_omniscience",
    "gdp_pdf",
    "hle_diamond",
    "critpt_v2_hard",
    "terminalbench_science_aa",
    "aa_analyst_agent",
    "harvey_lab_aa",
    "aa_mka",
    "aa_vials",
    "aa_agent_frontiercode",
    "aa_agent_swe_atlas",
  ],
  expectsPricing: false,
  async fetchLive(nowIso) {
    const detailSpecs = AA_BOUNDED_SPECS.filter((s) => s.page);
    const [modelsRes, briefcaseRes, gdpvalRes, codingAgentsRes, code2VideoRes, ...detailResponses] =
      await Promise.allSettled([
        fetchText(AA_MODELS_URL, { rejectRedirects: false }),
        fetchText(AA_BRIEFCASE_URL, { rejectRedirects: false }),
        fetchText(AA_GDPVAL_URL, { rejectRedirects: false }),
        fetchText(AA_CODING_AGENTS_URL, { rejectRedirects: false }),
        fetchText(AA_CODE2VIDEO_URL, { rejectRedirects: false }),
        ...detailSpecs.map((s) => fetchText(s.sourceUrl, { rejectRedirects: false })),
      ]);

    const partitionStats: Record<string, PartitionStats> = {};
    const ensureStat = (bmId: string): PartitionStats => {
      if (!partitionStats[bmId]) {
        partitionStats[bmId] = { attempted: 0, rejected: 0, excluded: 0 };
      }
      return partitionStats[bmId]!;
    };

    type EloBenchmark = "aa_briefcase" | "gdpval_aa" | "code2video_aa";
    type MergedEvalRow = AaEvalModel & {
      taskCost: number | null;
      score: number | null;
      interval: AccumulatedInterval | null;
      rowConflict: boolean;
    };
    const metrics = {
      aa_briefcase: {
        scoreKey: "briefcaseElo",
        intervalKey: "briefcaseBreakdown",
        sourceUrl: AA_BRIEFCASE_URL,
        version: "1.1",
        harness: "Stirrup",
        domain: "research",
      },
      gdpval_aa: {
        scoreKey: "gdpval",
        intervalKey: "gdpvalBreakdown",
        sourceUrl: AA_GDPVAL_URL,
        version: "2.1",
        harness: "Stirrup",
        domain: "research",
      },
      code2video_aa: {
        scoreKey: "code2videoElo",
        intervalKey: "code2videoBreakdown",
        sourceUrl: AA_CODE2VIDEO_URL,
        version: "114-briefs-argon",
        harness: "HyperFrames HTML",
        domain: "design_code",
      },
    } as const;

    const observations: RawObservation[] = [];
    const evalIdentityById = new Map<string, VerifiedEvalIdentity>();
    const disqualifiedRows = new Map<string, Set<string>>();
    const disqualify = (benchmarkId: string, rowId: string) => {
      const ids = disqualifiedRows.get(benchmarkId) ?? new Set<string>();
      ids.add(`aa:${benchmarkId}:${rowId}`);
      disqualifiedRows.set(benchmarkId, ids);
    };
    const evalIdsByPage = new Map<string, Set<string>>();
    const rowsByMetric: Record<EloBenchmark, MergedEvalRow[]> = {
      aa_briefcase: [],
      gdpval_aa: [],
      code2video_aa: [],
    };

    // Keep Elo eval rows isolated per page while detecting same-page and cross-page conflicts order-independently
    const ingestEvalPage = (res: PromiseSettledResult<string>, bmId: EloBenchmark): number => {
      const st = ensureStat(bmId);
      const pageIds = new Set<string>();
      evalIdsByPage.set(bmId, pageIds);
      if (res.status !== "fulfilled") {
        st.error = res.reason instanceof Error ? res.reason.message : String(res.reason);
        return 0;
      }
      if (
        bmId === "code2video_aa" &&
        (!res.value.includes("114 design briefs") || !res.value.includes("Gemini 4 Argon judge"))
      ) {
        st.error = "Code2Video task set or judge changed";
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
          disqualify(bmId, evId);
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
        const { scoreKey, intervalKey } = metrics[bmId];
        const reportedScore = parseNumeric(ev[scoreKey]);
        const details = ev[intervalKey];
        const intervalScore = details && "elo" in details ? parseNumeric(details.elo) : null;
        const score = reportedScore ?? intervalScore;
        const interval = mergeIntervalBounds(prevRow?.interval, details);
        const invalidReportedScore = ev[scoreKey] != null && reportedScore === null;
        const taskCost = bmId === "code2video_aa" ? code2VideoCost(ev) : null;
        const invalidInterval =
          details != null &&
          ((details.lower95ci != null && parseNumeric(details.lower95ci) === null) ||
            (details.upper95ci != null && parseNumeric(details.upper95ci) === null) ||
            ("elo" in details && details.elo != null && intervalScore === null));
        const metricConflict =
          numericDisagrees(prevRow?.taskCost ?? null, taskCost) ||
          invalidReportedScore ||
          invalidInterval ||
          Boolean(prevRow?.rowConflict) ||
          numericDisagrees(reportedScore, intervalScore) ||
          numericDisagrees(prevRow?.score ?? null, score) ||
          interval.conflict;

        const resolvedCreator = ev.creator?.name ? ev.creator : prevRow?.creator;
        pageRowById.set(evId, {
          ...prevRow,
          ...ev,
          name: cleanString(ev.name) ?? prevRow?.name ?? "",
          suffix: cleanString(ev.suffix) ?? prevRow?.suffix ?? null,
          ...(resolvedCreator ? { creator: resolvedCreator } : {}),
          effort: ev.effort?.slug ? ev.effort : (prevRow?.effort ?? null),
          score: score ?? prevRow?.score ?? null,
          interval: interval.chosen,
          taskCost: taskCost ?? prevRow?.taskCost ?? null,
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
        rowsByMetric[bmId].push(mergedRow);
      }
      const parsedCount = pageRowById.size;
      if (parsedCount === 0) {
        st.error = `AA eval page ${bmId} returned 0 model records`;
      }
      return parsedCount;
    };

    const briefcaseCount = ingestEvalPage(briefcaseRes, "aa_briefcase");
    const gdpvalCount = ingestEvalPage(gdpvalRes, "gdpval_aa");
    ingestEvalPage(code2VideoRes, "code2video_aa");

    const evalOrCyberJoinedIds = new Set<string>([
      ...(evalIdsByPage.get("aa_briefcase") ?? []),
      ...(evalIdsByPage.get("gdpval_aa") ?? []),
    ]);

    let leaderboardModels: AaLeaderboardModel[] = [];
    let modelsParseError: string | null = null;
    const verifiedCatalog = new Set<string>();
    const compatibleSummary = new Set<string>();
    if (modelsRes.status === "fulfilled") {
      try {
        const modelsRsc = extractRscText(modelsRes.value);
        const catalog = extractModelArrayByKey(modelsRsc, "generalEvaluations") as Array<{
          shortName?: unknown;
          href?: unknown;
          deprecated?: unknown;
        } | null>;
        for (const spec of detailSpecs) {
          const entries = catalog.filter(
            (entry) => entry?.href === new URL(spec.sourceUrl).pathname,
          );
          if (
            entries.length === 1 &&
            entries[0]?.deprecated === false &&
            entries[0].shortName === spec.page?.catalogName
          )
            verifiedCatalog.add(spec.benchmarkId);
        }
        leaderboardModels = extractModelArrayByKey(
          modelsRsc,
          "initialModels",
        ) as AaLeaderboardModel[];
      } catch (err) {
        modelsParseError = err instanceof Error ? err.message : String(err);
      }
      const byId = new Map(leaderboardModels.filter((row) => row?.id).map((row) => [row.id, row]));
      for (const [i, spec] of detailSpecs.entries()) {
        const page = spec.page!;
        const result = detailResponses[i];
        const st = ensureStat(spec.benchmarkId);
        if (result?.status !== "fulfilled" || !result.value.includes(page.protocol)) {
          st.error = `Missing or changed ${spec.aaKey} evaluation page`;
          continue;
        }
        try {
          const rows = extractModelArrayByKey(
            extractRscText(result.value),
            page.collection,
          ) as Array<AaEvalModel & { itbenchSre?: number; gatedAllPass?: number }>;
          if (!rows.length) throw new Error(`No ${page.collection} rows for ${spec.aaKey}`);
          let overlap = 0;
          let disagrees = false;
          const detailIds = new Set<string>();
          evalIdsByPage.set(spec.benchmarkId, detailIds);
          for (const detail of rows) {
            const id = cleanString(detail?.id);
            const name = cleanString(detail?.name);
            const score = parseNumeric(detail?.[page.key]);
            if (!id || !name || score === null || score < 0 || score > 1) {
              if (id) disqualify(spec.benchmarkId, id);
              st.attempted++;
              st.rejected++;
              continue;
            }
            const repeated = detailIds.has(id);
            detailIds.add(id);
            const creator = cleanString(detail.creator?.name);
            const malformedEffort =
              detail.effort != null &&
              (typeof detail.effort !== "object" || hasMalformedOptionalString(detail.effort.slug));
            mergeIdentityRecord(
              evalIdentityById,
              id,
              name,
              creator,
              detail.suffix,
              detail.effort?.slug,
              malformedEffort || hasMalformedOptionalString(detail.suffix),
            );
            let model = byId.get(id);
            if (!model) {
              model = { id, name, suffix: detail.suffix ?? null, effort: detail.effort ?? null };
              if (creator) model.modelCreatorName = creator;
              leaderboardModels.push(model);
              byId.set(id, model);
            }
            model.scores ??= {};
            const previous = parseNumeric(model.scores[spec.aaKey]);
            if (
              (model.scores[spec.aaKey] != null && previous === null) ||
              numericDisagrees(previous, score, 1e-9)
            ) {
              disagrees = true;
              disqualify(spec.benchmarkId, id);
              st.attempted++;
              st.rejected++;
            }
            if (!repeated && previous !== null) overlap++;
            model.scores[spec.aaKey] = score;
          }
          if (verifiedCatalog.has(spec.benchmarkId) && overlap > 0 && !disagrees)
            compatibleSummary.add(spec.benchmarkId);
        } catch (error) {
          st.error = error instanceof Error ? error.message : String(error);
        }
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
      (briefcaseCount === 0 && gdpvalCount === 0
        ? `effort metadata unavailable (briefcase: ${partitionStats.aa_briefcase?.error ?? "empty"}; gdpval: ${partitionStats.gdpval_aa?.error ?? "empty"})`
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
      if (
        lbIds.size > 0 &&
        ((briefcaseCount > 0 && briefcaseJoinCount === 0) ||
          (gdpvalCount > 0 && gdpvalJoinCount === 0))
      ) {
        evalMetadataError = `AA eval metadata IDs failed leaderboard join (briefcase=${briefcaseJoinCount}, gdpval=${gdpvalJoinCount})`;
      }

      if (!evalMetadataError) {
        const evalPartialOutage = briefcaseCount === 0 || gdpvalCount === 0;
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
              spec.page &&
              !partitionStats[spec.benchmarkId]?.error &&
              !evalIdsByPage.get(spec.benchmarkId)?.has(rowId) &&
              !compatibleSummary.has(spec.benchmarkId)
            ) {
              disqualify(spec.benchmarkId, rowId);
              st.excluded++;
              continue;
            }
            if (ident?.gatedDaybreak) {
              disqualify(spec.benchmarkId, rowId);
              st.excluded++;
              continue;
            }
            if (!hasVerifiedEffortProvenance) {
              if (!evalPartialOutage || ident?.conflict || lbEffCheck.conflict)
                disqualify(spec.benchmarkId, rowId);
              st.rejected++;
              continue;
            }
            const fraction = parseNumeric(rawVal);
            if (fraction === null || fraction < 0 || fraction > 1) {
              disqualify(spec.benchmarkId, rowId);
              st.rejected++;
              continue;
            }
            if (partitionStats[spec.benchmarkId]?.error) continue;
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
              sourceUrl:
                spec.page && !evalIdsByPage.get(spec.benchmarkId)?.has(rowId)
                  ? AA_MODELS_URL
                  : spec.sourceUrl,
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

    for (const bmId of ["aa_briefcase", "gdpval_aa", "code2video_aa"] as const) {
      const metric = metrics[bmId];
      for (const ev of rowsByMetric[bmId]) {
        const evId = cleanString(ev.id);
        const evName = cleanString(ev.name);
        if (!evId) continue;
        if (!evName) {
          disqualify(bmId, evId);
          continue;
        }
        const interval = ev.interval;
        const score = ev.score;
        if (score === null) {
          if (ev.rowConflict) disqualify(bmId, evId);
          continue;
        }

        const st = ensureStat(bmId);
        st.attempted++;
        const ident = evalIdentityById.get(evId);
        if (ident?.gatedDaybreak) {
          disqualify(bmId, evId);
          st.excluded++;
          continue;
        }
        if (ev.rowConflict || ident?.conflict) {
          disqualify(bmId, evId);
          st.rejected++;
          continue;
        }
        const low = parseNumeric(interval?.lower95ci);
        const high = parseNumeric(interval?.upper95ci);
        if (
          !interval?.hasComplete ||
          low === null ||
          high === null ||
          high <= low ||
          score < low ||
          score > high
        ) {
          disqualify(bmId, evId);
          st.rejected++;
          continue;
        }
        const rawCiHalf = (high - low) / 2;
        if (rawCiHalf > MAX_ARENA_CI) {
          disqualify(bmId, evId);
          st.excluded++;
          continue;
        }
        const fallbackRouting =
          (ident?.fallbackRouting ?? false) ||
          isAaFallbackRoutingLabel(evName, ev.suffix, ev.effort?.slug);
        observations.push({
          sourceId: "artificial-analysis",
          sourceRowId: `aa:${bmId}:${evId}`,
          benchmarkId: bmId,
          benchmarkVersion: metric.version,
          domainId: metric.domain,
          rawModelName: evName,
          rawProvider: cleanString(ev.creator?.name),
          rawEffort: emitEffortForId(evId, ev.suffix, ev.effort?.slug),
          rawHarness: null,
          observedHarness: metric.harness,
          harnessRegime: "native",
          rawScore: Number(score.toFixed(2)),
          ciHalfWidth: Number(rawCiHalf.toFixed(4)),
          ciLower: Number(low.toFixed(4)),
          ciUpper: Number(high.toFixed(4)),
          battleCount: null,
          measuredCostUsd: ev.taskCost,
          ...(ev.taskCost !== null ? { measuredCostEstimated: true } : {}),
          ...(fallbackRouting ? { fallbackRouting: true } : {}),
          suiteCostUsd: null,
          measuredInputTokens: null,
          measuredOutputTokens: null,
          evalDate: null,
          publishedDate: null,
          sourceUrl: metric.sourceUrl,
        });
      }
    }

    // Emit independent AA Coding Agent sub-evals (FrontierCode 2.0 & SWE-Atlas-QnA, excluding TB 4.1 to avoid double-counting)
    const AA_AGENT_SUB_SPECS = [
      {
        datasetIndexName: "frontiercode-2-0",
        altPrefix: "frontiercode",
        benchmarkId: "aa_agent_frontiercode",
        version: "2.0",
      },
      {
        datasetIndexName: "swe-atlas-qna",
        altPrefix: "swe-atlas",
        benchmarkId: "aa_agent_swe_atlas",
        version: "1.0",
      },
    ] as const;

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
            const effortStr = normalizeAaEffort(effortSuffix, effortSlug);
            const isGated = isAaDaybreakLabel(modelName, effortSuffix, effortSlug);

            for (const spec of AA_AGENT_SUB_SPECS) {
              const ev = (row.evals as AaCodingAgentEval[]).find((e) => {
                const dn = cleanString(e?.datasetIndexName)?.toLowerCase() ?? "";
                return dn === spec.datasetIndexName || dn.startsWith(spec.altPrefix);
              });
              const reward = parseNumeric(ev?.mean?.reward);
              if (reward === null) continue;
              const st = ensureStat(spec.benchmarkId);
              st.attempted++;
              if (isGated) {
                disqualify(spec.benchmarkId, rowId);
                st.excluded++;
                continue;
              }
              if (reward < 0 || reward > 1) {
                disqualify(spec.benchmarkId, rowId);
                st.rejected++;
                continue;
              }
              const fallbackCount = parseNumeric(ev?.safety?.fallbackAttemptCount) ?? 0;
              observations.push({
                sourceId: "artificial-analysis",
                sourceRowId: `aa:${spec.benchmarkId}:${rowId}`,
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
                ...(fallbackCount > 0 ? { fallbackRouting: true } : {}),
                suiteCostUsd: null,
                measuredInputTokens: null,
                measuredOutputTokens: null,
                evalDate: null,
                publishedDate: null,
                sourceUrl: AA_CODING_AGENTS_URL,
              });
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const spec of AA_AGENT_SUB_SPECS) ensureStat(spec.benchmarkId).error = msg;
      }
    }

    // AA model UUIDs are shared across evaluation tables, including partitions temporarily offline.
    const modelMetrics = [...AA_BOUNDED_SPECS.map((s) => s.benchmarkId), ...Object.keys(metrics)];
    for (const [id, identity] of evalIdentityById) {
      if (identity.conflict || identity.gatedDaybreak) {
        for (const metric of modelMetrics) disqualify(metric, id);
      }
    }

    const distinct = new Map<string, RawObservation>();
    for (const obs of observations) {
      const old = distinct.get(obs.sourceRowId);
      if (old && !observationsMatchExact(old, obs)) {
        disqualify(obs.benchmarkId, obs.sourceRowId.slice(`aa:${obs.benchmarkId}:`.length));
        ensureStat(obs.benchmarkId).rejected++;
      }
      distinct.set(obs.sourceRowId, obs);
    }
    return {
      observations: [...distinct.values()].filter(
        (obs) => !disqualifiedRows.get(obs.benchmarkId)?.has(obs.sourceRowId),
      ),
      pricing: [],
      partitionStats,
      disqualifiedSourceRowIdsByBenchmark: Object.fromEntries(
        [...disqualifiedRows].map(([id, rows]) => [id, [...rows].toSorted()]),
      ),
    };
  },
};
