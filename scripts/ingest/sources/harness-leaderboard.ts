import { compareAscii } from "../../../src/lib/math/aggregate.ts";
import {
  annotateHarnessPareto,
  canonicalizeHarnessProviderName,
  MIN_CONTROLLED_HARNESSES,
  normalizeHarnessVersion,
  type RawHarnessEntryInput,
} from "../../../src/lib/math/harness-pareto.ts";
import { parseStrictUtcDateMs } from "../../../src/lib/math/lifecycle.ts";
import {
  type HarnessBenchmarkMetric,
  type HarnessEntry,
  type HarnessLeaderboardSnapshot,
  HarnessLeaderboardSnapshotSchema,
  type HarnessModelSlice,
} from "../../../src/lib/schema.ts";
import {
  fetchText,
  parseNonNegative,
  parseNumeric,
  parsePositive,
  parseStrictPositiveInt,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const HLB_URL = "https://joelniklaus-harness-leaderboard.hf.space/";
const HLB_PUBLIC_URL = "https://huggingface.co/spaces/joelniklaus/harness-leaderboard";
const REQUIRED_BENCHMARK_IDS = ["deep-swe", "terminal-bench-2.1"] as const;
const MIN_UNIQUE_TASKS_BY_BM: Readonly<Record<string, number>> = {
  "deep-swe": 100,
  "terminal-bench-2.1": 80,
};

interface HlbRawBenchmark {
  rate?: number;
  pass_all3?: number;
  ci?: [number, number] | number[];
  cost_per_trial?: number;
  tokens_per_trial?: number;
  agent_s_per_trial?: number;
  n_tasks?: number;
  n_tasks_expected?: number;
  n_tasks3?: number;
  n_scored?: number;
}

interface HlbRawHarness {
  macro?: number;
  pass_all3?: number;
  ci?: [number, number] | number[];
  cost_per_trial?: number;
  cost_per_pass?: number;
  tokens_per_trial?: number;
  agent_s_per_trial?: number;
  n_scored?: number;
  n_tasks3?: number;
  complete?: boolean;
  versions?: string[];
  benchmarks?: Record<string, HlbRawBenchmark>;
}

interface HlbRawPayload {
  generated_at?: string;
  version?: string;
  config?: {
    harnesses?: Record<string, { display?: string; vendor?: string; color?: string }>;
    benchmarks?: Record<
      string,
      { display?: string; name?: string; subset_sizes?: { full?: number } }
    >;
    models?: Record<string, { display?: string; short?: string; org?: string }>;
  };
  leaderboard?: Record<
    string,
    {
      stages?: {
        full?: {
          efforts?: Record<string, { harnesses?: Record<string, HlbRawHarness> }>;
        };
      };
    }
  >;
}

const BENCHMARK_LABELS: Record<string, string> = {
  "terminal-bench-2.1": "Terminal-Bench 2.1",
  "deep-swe": "DeepSWE v1.1",
};

function toRawPct(val: unknown): number | null {
  const n = parseNumeric(val);
  if (n === null || n < 0 || n > 1) return null;
  return n * 100;
}

function roundPct(pct: number): number {
  return Number(pct.toFixed(2));
}

function parseRawCiPct(
  ci: unknown,
  ratePct?: number,
): { lower: number | null; upper: number | null } {
  if (!Array.isArray(ci) || ci.length !== 2) return { lower: null, upper: null };
  const lo = toRawPct(ci[0]);
  const hi = toRawPct(ci[1]);
  if (lo === null || hi === null || hi < lo) return { lower: null, upper: null };
  if (ratePct !== undefined && (lo > ratePct + 0.05 || hi < ratePct - 0.05)) {
    return { lower: null, upper: null };
  }
  return { lower: lo, upper: hi };
}

interface PropagatedBmInfo {
  expectedRatePct: number;
  lowerDelta: number | null;
  upperDelta: number | null;
  exactLowerPct: number | null;
  exactUpperPct: number | null;
}

function ciBoundsFromAsymmetricDeltas(
  ratePct: number,
  lowerDelta: number | null,
  upperDelta: number | null,
): { ciLower: number | null; ciUpper: number | null } {
  if (
    lowerDelta === null ||
    upperDelta === null ||
    !Number.isFinite(lowerDelta) ||
    !Number.isFinite(upperDelta) ||
    lowerDelta < 0 ||
    upperDelta < 0 ||
    lowerDelta + upperDelta <= 0
  ) {
    return { ciLower: null, ciUpper: null };
  }
  return {
    ciLower: roundPct(Math.max(0, ratePct - lowerDelta)),
    ciUpper: roundPct(Math.min(100, ratePct + upperDelta)),
  };
}

function parseSliceHarnesses(
  harnessesObj: Record<string, HlbRawHarness>,
  expectedBenchmarkIds: readonly string[],
  expectedTasksByBm: ReadonlyMap<string, number>,
  effortMultiplier: number,
  ciIsUpperBound: boolean,
  harnessConfig: Record<string, { display?: string; vendor?: string; color?: string }>,
  benchConfig: Record<string, { display?: string; name?: string }>,
  propagatedByHarness: ReadonlyMap<string, ReadonlyMap<string, PropagatedBmInfo>>,
): { entries: HarnessEntry[]; attempted: number; rejected: number } {
  const rawEntries: RawHarnessEntryInput[] = [];
  let attempted = 0;
  let rejected = 0;

  for (const [harnessId, row] of Object.entries(harnessesObj)) {
    attempted++;
    if (!row || typeof row !== "object") {
      rejected++;
      continue;
    }
    if (row.complete !== true) {
      rejected++;
      continue;
    }
    const costPerTrial = parsePositive(row.cost_per_trial);
    const rawMacroPct = toRawPct(row.macro);
    if (costPerTrial === null || rawMacroPct === null) {
      rejected++;
      continue;
    }

    const rawBms = row.benchmarks;
    const propMap = propagatedByHarness.get(harnessId);
    if (!rawBms || typeof rawBms !== "object" || !propMap) {
      rejected++;
      continue;
    }

    const benchmarks: HarnessBenchmarkMetric[] = [];
    const rawRates: number[] = [];
    let benchmarkInvalid = false;
    let allBmsHave3 = true;
    let totalRawSliceTasks = 0;
    let sumBmNScored = 0;
    const bmLowerDeltas: number[] = [];
    const bmUpperDeltas: number[] = [];
    let allBmCiPresent = true;

    for (const bmId of expectedBenchmarkIds) {
      const bm = rawBms[bmId];
      const propInfo = propMap.get(bmId);
      if (!bm || typeof bm !== "object" || !propInfo) {
        benchmarkInvalid = true;
        break;
      }
      const rawRatePct = toRawPct(bm.rate);
      const bmCost = parsePositive(bm.cost_per_trial);
      const nTasks = parseStrictPositiveInt(bm.n_tasks);
      const nExpected = parseStrictPositiveInt(bm.n_tasks_expected);
      const bmNScored = parseStrictPositiveInt(bm.n_scored);
      const authUniqueN = expectedTasksByBm.get(bmId) ?? 0;
      const requiredTasks = authUniqueN * effortMultiplier;
      if (
        rawRatePct === null ||
        bmCost === null ||
        nTasks === null ||
        nExpected === null ||
        bmNScored === null ||
        bmNScored < nTasks ||
        authUniqueN <= 0 ||
        nTasks < nExpected ||
        nTasks !== requiredTasks ||
        nExpected !== requiredTasks ||
        Math.abs(rawRatePct - propInfo.expectedRatePct) > 0.15
      ) {
        benchmarkInvalid = true;
        break;
      }
      const rate = roundPct(rawRatePct);
      rawRates.push(rawRatePct);
      totalRawSliceTasks += nTasks;
      sumBmNScored += bmNScored;

      const nTasks3 = parseStrictPositiveInt(bm.n_tasks3);
      const rawBmP3Pct = toRawPct(bm.pass_all3);
      const bmP3Feasible =
        rawBmP3Pct !== null &&
        rawBmP3Pct <= rawRatePct + 1e-6 &&
        (bmNScored !== 3 * nTasks || rawBmP3Pct >= Math.max(0, 3 * rawRatePct - 200) - 0.15);
      const bmHas3 =
        nTasks3 !== null && nTasks3 === nTasks && bmNScored >= 3 * nTasks && bmP3Feasible;
      if (!bmHas3) {
        allBmsHave3 = false;
      }

      // Preserve exact asymmetric single-effort endpoints; propagate separate lower/upper deltas on averages
      let ci: { ciLower: number | null; ciUpper: number | null };
      if (
        !ciIsUpperBound &&
        propInfo.exactLowerPct !== null &&
        propInfo.exactUpperPct !== null &&
        propInfo.lowerDelta !== null &&
        propInfo.upperDelta !== null
      ) {
        ci = {
          ciLower: roundPct(propInfo.exactLowerPct),
          ciUpper: roundPct(propInfo.exactUpperPct),
        };
        bmLowerDeltas.push(propInfo.lowerDelta);
        bmUpperDeltas.push(propInfo.upperDelta);
      } else if (propInfo.lowerDelta !== null && propInfo.upperDelta !== null) {
        ci = ciBoundsFromAsymmetricDeltas(rawRatePct, propInfo.lowerDelta, propInfo.upperDelta);
        if (ci.ciLower !== null && ci.ciUpper !== null) {
          bmLowerDeltas.push(propInfo.lowerDelta);
          bmUpperDeltas.push(propInfo.upperDelta);
        } else {
          allBmCiPresent = false;
        }
      } else {
        ci = { ciLower: null, ciUpper: null };
        allBmCiPresent = false;
      }

      const hasCi = ci.ciLower !== null && ci.ciUpper !== null;
      benchmarks.push({
        benchmarkId: bmId,
        name:
          BENCHMARK_LABELS[bmId] ?? benchConfig[bmId]?.display ?? benchConfig[bmId]?.name ?? bmId,
        passRate: rate,
        ciLower: ci.ciLower,
        ciUpper: ci.ciUpper,
        ciIsUpperBound: !hasCi || ciIsUpperBound,
        passAll3Rate: bmHas3 && rawBmP3Pct !== null ? roundPct(rawBmP3Pct) : null,
        costPerTrialUsd: Number(bmCost.toFixed(6)),
        nTasks: authUniqueN,
        nScored: bmNScored,
        tokensPerTrial: parseNonNegative(bm.tokens_per_trial),
        agentSecondsPerTrial: parseNonNegative(bm.agent_s_per_trial),
        sourceUrl: HLB_PUBLIC_URL,
      });
    }
    if (benchmarkInvalid || benchmarks.length !== expectedBenchmarkIds.length) {
      rejected++;
      continue;
    }
    // Validate macro agreement at full source precision before rounding for publication
    const rawConstituentMeanPct = rawRates.reduce((s, r) => s + r, 0) / rawRates.length;
    if (Math.abs(rawMacroPct - rawConstituentMeanPct) > 0.15) {
      rejected++;
      continue;
    }
    const passRate = roundPct(rawMacroPct);

    const nScored = parseStrictPositiveInt(row.n_scored);
    if (nScored === null || nScored < totalRawSliceTasks || nScored !== sumBmNScored) {
      rejected++;
      continue;
    }
    benchmarks.sort((a, b) => compareAscii(a.benchmarkId, b.benchmarkId));

    // Propagate macro CI strictly from validated constituent lower/upper deltas without falling back to row.ci
    const overallCi =
      allBmCiPresent &&
      bmLowerDeltas.length === benchmarks.length &&
      bmUpperDeltas.length === benchmarks.length &&
      benchmarks.length > 0
        ? ciBoundsFromAsymmetricDeltas(
            rawMacroPct,
            Math.sqrt(bmLowerDeltas.reduce((s, d) => s + d * d, 0)) / bmLowerDeltas.length,
            Math.sqrt(bmUpperDeltas.reduce((s, d) => s + d * d, 0)) / bmUpperDeltas.length,
          )
        : { ciLower: null, ciUpper: null };

    const cfgMeta = harnessConfig[harnessId];
    const versions = Array.isArray(row.versions)
      ? row.versions
          .filter((v): v is string => typeof v === "string")
          .map((v) => normalizeHarnessVersion(v))
          .filter((v): v is string => v !== null)
      : [];

    const rowNTasks3 = parseStrictPositiveInt(row.n_tasks3);
    const rowTasks3Valid = rowNTasks3 !== null && rowNTasks3 === totalRawSliceTasks;
    const rawRowP3Pct = toRawPct(row.pass_all3);
    const rowP3Feasible =
      rawRowP3Pct !== null &&
      rawRowP3Pct <= rawMacroPct + 1e-6 &&
      (nScored !== 3 * totalRawSliceTasks ||
        rawRowP3Pct >= Math.max(0, 3 * rawMacroPct - 200) - 0.15);
    const passAll3Valid =
      allBmsHave3 &&
      rowTasks3Valid &&
      totalRawSliceTasks > 0 &&
      nScored >= 3 * totalRawSliceTasks &&
      rowP3Feasible;
    const passAll3Rate = passAll3Valid && rawRowP3Pct !== null ? roundPct(rawRowP3Pct) : null;
    if (!passAll3Valid) {
      for (const bm of benchmarks) bm.passAll3Rate = null;
    }

    rawEntries.push({
      harnessId,
      name: cfgMeta?.display?.trim() || harnessId,
      vendor: canonicalizeHarnessProviderName(cfgMeta?.vendor) ?? "Community",
      color: cfgMeta?.color?.trim() || "#52525b",
      version: versions[0] ?? null,
      passRate,
      ciLower: overallCi.ciLower,
      ciUpper: overallCi.ciUpper,
      costPerTrialUsd: Number(costPerTrial.toFixed(6)),
      costPerPassUsd: (() => {
        const c = parsePositive(row.cost_per_pass);
        return c !== null ? Number(c.toFixed(6)) : null;
      })(),
      passAll3Rate,
      tokensPerTrial: (() => {
        const t = parseNonNegative(row.tokens_per_trial);
        return t !== null ? Math.round(t) : null;
      })(),
      agentSecondsPerTrial: (() => {
        const s = parseNonNegative(row.agent_s_per_trial);
        return s !== null ? Number(s.toFixed(1)) : null;
      })(),
      nScored,
      benchmarks,
    });
  }

  return { entries: annotateHarnessPareto(rawEntries), attempted, rejected };
}

export const harnessLeaderboardAdapter: SourceAdapter = {
  id: "harness-leaderboard",
  label: "Harness Leaderboard (TB 2.1 + DeepSWE)",
  license: "Apache-2.0",
  sourceUrl: HLB_PUBLIC_URL,
  expectedBenchmarks: [],
  expectsPricing: false,
  expectsHarnessLeaderboard: true,
  async fetchLive() {
    const html = await fetchText(HLB_URL, { timeoutMs: 25_000 });
    const match = html.match(/<script[^>]*id="hlb-data"[^>]*>([\s\S]*?)<\/script>/i);
    if (!match?.[1]) {
      throw new Error("Harness Leaderboard inline JSON payload missing (#hlb-data)");
    }

    const parsed = JSON.parse(match[1]) as HlbRawPayload;
    const generatedAt = parsed.generated_at?.trim();
    const sourceVersion = parsed.version?.trim();
    if (
      !generatedAt ||
      parseStrictUtcDateMs(generatedAt) === null ||
      !sourceVersion ||
      !parsed.leaderboard
    ) {
      throw new Error(
        "Harness Leaderboard payload missing valid generated_at, version, or leaderboard",
      );
    }

    const harnessConfig = parsed.config?.harnesses ?? {};
    const benchConfig = parsed.config?.benchmarks ?? {};
    const modelConfig = parsed.config?.models ?? {};

    const configBmIds = Object.keys(benchConfig).toSorted(compareAscii);
    const expectedBenchmarkIds = configBmIds.length > 0 ? configBmIds : [...REQUIRED_BENCHMARK_IDS];
    for (const reqBm of REQUIRED_BENCHMARK_IDS) {
      if (!expectedBenchmarkIds.includes(reqBm)) {
        throw new Error(`Harness Leaderboard missing required benchmark '${reqBm}'`);
      }
    }

    const modelKeys = Object.keys(parsed.leaderboard)
      .filter((k) => k !== "_all")
      .toSorted(compareAscii);
    if (modelKeys.length === 0) {
      throw new Error("Harness Leaderboard missing individual control-model slices");
    }

    const allEffortsKey = "_all";
    let totalAttempted = 0;
    let totalRejected = 0;

    // Strictly require authoritative configured unique task counts from config.benchmarks.subset_sizes.full
    const uniqueTasksByBm = new Map<string, number>();
    for (const bmId of expectedBenchmarkIds) {
      const cfgFull = parseStrictPositiveInt(benchConfig[bmId]?.subset_sizes?.full);
      const minFloor = MIN_UNIQUE_TASKS_BY_BM[bmId] ?? 1;
      if (cfgFull !== null && cfgFull >= minFloor) {
        uniqueTasksByBm.set(bmId, cfgFull);
      }
    }
    const missingUniqueBms = expectedBenchmarkIds.filter((id) => !uniqueTasksByBm.has(id));
    if (missingUniqueBms.length > 0) {
      return {
        observations: [],
        pricing: [],
        harnessLeaderboardStats: {
          attempted: 1,
          rejected: 1,
          excluded: 0,
          error: `Harness Leaderboard missing authoritative unique task counts (${missingUniqueBms.join(", ")})`,
        },
      };
    }

    // Validate contributing single-effort slices at full source precision and propagate asymmetric CI deltas
    const effortKeysByModel = new Map<string, string[]>();
    const modelPropBySliceHarness = new Map<string, Map<string, Map<string, PropagatedBmInfo>>>();
    let totalEffortSlices = 0;

    for (const sliceId of modelKeys) {
      const effortsObj = parsed.leaderboard[sliceId]?.stages?.full?.efforts ?? {};
      const singleEfforts = Object.keys(effortsObj)
        .filter((k) => k !== allEffortsKey && effortsObj[k]?.harnesses)
        .toSorted(compareAscii);
      effortKeysByModel.set(sliceId, singleEfforts);
      totalEffortSlices += singleEfforts.length;

      const byHarness = new Map<string, Map<string, PropagatedBmInfo>>();
      const allHarnessesInModel = new Set<string>();
      for (const ek of singleEfforts) {
        for (const hid of Object.keys(effortsObj[ek]?.harnesses ?? {})) {
          allHarnessesInModel.add(hid);
        }
      }
      for (const hid of allHarnessesInModel) {
        const bmMap = new Map<string, PropagatedBmInfo>();
        let harnessValid = singleEfforts.length > 0;
        for (const bmId of expectedBenchmarkIds) {
          const authN = uniqueTasksByBm.get(bmId) ?? 0;
          const rates: number[] = [];
          const loDeltas: number[] = [];
          const hiDeltas: number[] = [];
          let exactLo: number | null = null;
          let exactHi: number | null = null;
          let allEffCiValid = true;
          for (const ek of singleEfforts) {
            const hRow = effortsObj[ek]?.harnesses?.[hid];
            const bmRow = hRow?.complete === true ? hRow.benchmarks?.[bmId] : undefined;
            const bmRate = toRawPct(bmRow?.rate);
            const n = parseStrictPositiveInt(bmRow?.n_tasks);
            const nExp = parseStrictPositiveInt(bmRow?.n_tasks_expected);
            const nScoredEff = parseStrictPositiveInt(bmRow?.n_scored);
            if (
              bmRate === null ||
              n !== authN ||
              nExp !== authN ||
              nScoredEff === null ||
              nScoredEff < authN
            ) {
              harnessValid = false;
              break;
            }
            rates.push(bmRate);
            const ci = parseRawCiPct(bmRow?.ci, bmRate);
            if (ci.lower !== null && ci.upper !== null && ci.upper > ci.lower) {
              loDeltas.push(Math.max(0, bmRate - ci.lower));
              hiDeltas.push(Math.max(0, ci.upper - bmRate));
              if (singleEfforts.length === 1) {
                exactLo = ci.lower;
                exactHi = ci.upper;
              }
            } else {
              allEffCiValid = false;
            }
          }
          if (!harnessValid) break;
          const expectedRatePct = rates.reduce((s, v) => s + v, 0) / rates.length;
          bmMap.set(bmId, {
            expectedRatePct,
            lowerDelta:
              allEffCiValid && loDeltas.length === rates.length
                ? loDeltas.reduce((s, v) => s + v, 0) / loDeltas.length
                : null,
            upperDelta:
              allEffCiValid && hiDeltas.length === rates.length
                ? hiDeltas.reduce((s, v) => s + v, 0) / hiDeltas.length
                : null,
            exactLowerPct: allEffCiValid && singleEfforts.length === 1 ? exactLo : null,
            exactUpperPct: allEffCiValid && singleEfforts.length === 1 ? exactHi : null,
          });
        }
        if (harnessValid && bmMap.size === expectedBenchmarkIds.length) {
          byHarness.set(hid, bmMap);
        }
      }
      modelPropBySliceHarness.set(sliceId, byHarness);
    }

    const parsedModelSlices: HarnessModelSlice[] = [];
    for (const sliceId of modelKeys) {
      const harnessesObj =
        parsed.leaderboard[sliceId]?.stages?.full?.efforts?.[allEffortsKey]?.harnesses;
      const effCount = effortKeysByModel.get(sliceId)?.length ?? 0;
      const propMap = modelPropBySliceHarness.get(sliceId);
      if (!harnessesObj || typeof harnessesObj !== "object" || effCount === 0 || !propMap) {
        totalAttempted += MIN_CONTROLLED_HARNESSES;
        totalRejected += MIN_CONTROLLED_HARNESSES;
        continue;
      }
      const res = parseSliceHarnesses(
        harnessesObj,
        expectedBenchmarkIds,
        uniqueTasksByBm,
        effCount,
        effCount > 1,
        harnessConfig,
        benchConfig,
        propMap,
      );
      totalAttempted += res.attempted;
      totalRejected += res.rejected;
      if (res.entries.length < MIN_CONTROLLED_HARNESSES) {
        totalRejected += res.entries.length;
        continue;
      }
      const mMeta = modelConfig[sliceId];
      parsedModelSlices.push({
        sliceId,
        label: mMeta?.short?.trim() || mMeta?.display?.trim() || sliceId,
        org: canonicalizeHarnessProviderName(mMeta?.org),
        entries: res.entries,
      });
    }

    const pooledHarnessesObj =
      parsed.leaderboard[allEffortsKey]?.stages?.full?.efforts?.[allEffortsKey]?.harnesses;
    if (!pooledHarnessesObj || typeof pooledHarnessesObj !== "object") {
      throw new Error("Harness Leaderboard missing pooled '_all' macro harness slice");
    }

    // Equal-model expected rates and asymmetric CI deltas matching upstream macro average across models on shared tasks
    const pooledPropByHarness = new Map<string, Map<string, PropagatedBmInfo>>();
    for (const hid of Object.keys(pooledHarnessesObj)) {
      const bmMap = new Map<string, PropagatedBmInfo>();
      let harnessValid = modelKeys.length > 0;
      for (const bmId of expectedBenchmarkIds) {
        const modelRates: number[] = [];
        const modelLoDeltas: number[] = [];
        const modelHiDeltas: number[] = [];
        let allCiValid = true;
        for (const sliceId of modelKeys) {
          const info = modelPropBySliceHarness.get(sliceId)?.get(hid)?.get(bmId);
          if (!info) {
            harnessValid = false;
            break;
          }
          modelRates.push(info.expectedRatePct);
          if (info.lowerDelta !== null && info.upperDelta !== null) {
            modelLoDeltas.push(info.lowerDelta);
            modelHiDeltas.push(info.upperDelta);
          } else {
            allCiValid = false;
          }
        }
        if (!harnessValid) break;
        bmMap.set(bmId, {
          expectedRatePct: modelRates.reduce((s, v) => s + v, 0) / modelRates.length,
          lowerDelta:
            allCiValid && modelLoDeltas.length === modelRates.length
              ? modelLoDeltas.reduce((s, v) => s + v, 0) / modelLoDeltas.length
              : null,
          upperDelta:
            allCiValid && modelHiDeltas.length === modelRates.length
              ? modelHiDeltas.reduce((s, v) => s + v, 0) / modelHiDeltas.length
              : null,
          exactLowerPct: null,
          exactUpperPct: null,
        });
      }
      if (harnessValid && bmMap.size === expectedBenchmarkIds.length) {
        pooledPropByHarness.set(hid, bmMap);
      }
    }

    const pooledRes = parseSliceHarnesses(
      pooledHarnessesObj,
      expectedBenchmarkIds,
      uniqueTasksByBm,
      totalEffortSlices,
      modelKeys.length > 1 || totalEffortSlices > 1,
      harnessConfig,
      benchConfig,
      pooledPropByHarness,
    );
    totalAttempted += pooledRes.attempted;
    totalRejected += pooledRes.rejected;

    if (
      pooledRes.entries.length < MIN_CONTROLLED_HARNESSES ||
      parsedModelSlices.length !== modelKeys.length
    ) {
      return {
        observations: [],
        pricing: [],
        harnessLeaderboardStats: {
          attempted: Math.max(1, totalAttempted),
          rejected: Math.max(1, totalRejected),
          excluded: 0,
          error: `Incomplete harness board (${parsedModelSlices.length}/${modelKeys.length} model slices, ${pooledRes.entries.length} pooled harnesses)`,
        },
      };
    }

    const slices: HarnessModelSlice[] = [
      {
        sliceId: "_all",
        label: `All ${parsedModelSlices.length} models`,
        org: null,
        entries: pooledRes.entries,
      },
      ...parsedModelSlices,
    ];

    const harnessLeaderboard: HarnessLeaderboardSnapshot = HarnessLeaderboardSnapshotSchema.parse({
      sourceVersion,
      upstreamGeneratedAt: generatedAt,
      sourceUrl: HLB_PUBLIC_URL,
      slices,
    });

    const stats: PartitionStats = {
      attempted: totalAttempted,
      rejected: totalRejected,
      excluded: 0,
    };

    return {
      observations: [],
      pricing: [],
      harnessLeaderboard,
      harnessLeaderboardStats: stats,
    };
  },
};
