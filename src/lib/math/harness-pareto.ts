import { compareIsoInstants } from "../format.ts";
import type {
  HarnessBenchmarkMetric,
  HarnessEntry,
  HarnessLeaderboardSnapshot,
  HarnessModelSlice,
} from "../schema.ts";
import { compareAscii, solveTwoWayLinearRasch } from "./aggregate.ts";

export const MIN_CONTROLLED_HARNESSES = 8;

const CANONICAL_HARNESS_PROVIDER_BY_KEY: Readonly<Record<string, string>> = {
  "z.ai": "Zhipu",
  "z ai": "Zhipu",
  zai: "Zhipu",
  "z-ai": "Zhipu",
  "zai-org": "Zhipu",
  zhipu: "Zhipu",
  zhipuai: "Zhipu",
  "zhipu ai": "Zhipu",
  moonshot: "Moonshot",
  "moonshot ai": "Moonshot",
  moonshotai: "Moonshot",
  kimi: "Moonshot",
  alibaba: "Alibaba",
  "alibaba cloud": "Alibaba",
  dashscope: "Alibaba",
  qwen: "Alibaba",
  xai: "SpaceXAI",
  "x.ai": "SpaceXAI",
  spacexai: "SpaceXAI",
  deepseek: "DeepSeek",
  "deepseek-ai": "DeepSeek",
  recursive: "Recursive",
  recursivesi: "Recursive",
  "recursive si": "Recursive",
  ricursive: "Ricursive",
  ricursiveai: "Ricursive",
  "ricursive ai": "Ricursive",
  meta: "Meta",
  "meta-llama": "Meta",
  "meta-models": "Meta",
  facebook: "Meta",
};

export function canonicalizeHarnessProviderName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  return Object.hasOwn(CANONICAL_HARNESS_PROVIDER_BY_KEY, key)
    ? CANONICAL_HARNESS_PROVIDER_BY_KEY[key]!
    : trimmed;
}

export function normalizeHarnessVersion(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^v/i, "");
  return cleaned.length > 0 ? cleaned : null;
}

export function mergeHarnessVersions(
  first: string | null | undefined,
  second: string | null | undefined,
): string | null {
  const a = normalizeHarnessVersion(first ?? null);
  const b = normalizeHarnessVersion(second ?? null);
  if (a && b) return a === b ? a : `${a} / ${b}`;
  return a ?? b ?? null;
}

export type RawHarnessEntryInput = Omit<
  HarnessEntry,
  "onFrontier" | "dominatedById" | "scoreDeficit" | "costRatio"
>;

// Compute exact single-envelope Pareto frontier across harnesses (higher pass rate, lower cost per trial)
export function annotateHarnessPareto(rawEntries: readonly RawHarnessEntryInput[]): HarnessEntry[] {
  const byCost = rawEntries.toSorted(
    (a, b) =>
      a.costPerTrialUsd - b.costPerTrialUsd ||
      b.passRate - a.passRate ||
      compareAscii(a.harnessId, b.harnessId),
  );

  const frontier: RawHarnessEntryInput[] = [];
  const metaById = new Map<
    string,
    {
      onFrontier: boolean;
      dominatedById: string | null;
      scoreDeficit: number | null;
      costRatio: number | null;
    }
  >();

  for (const item of byCost) {
    const prev = frontier.at(-1);
    if (!prev || item.passRate > prev.passRate + 1e-6) {
      frontier.push(item);
      metaById.set(item.harnessId, {
        onFrontier: true,
        dominatedById: null,
        scoreDeficit: null,
        costRatio: null,
      });
    } else {
      const dominator =
        frontier.find(
          (f) =>
            f.costPerTrialUsd <= item.costPerTrialUsd + 1e-9 && f.passRate >= item.passRate - 1e-6,
        ) ?? prev;
      metaById.set(item.harnessId, {
        onFrontier: false,
        dominatedById: dominator.harnessId,
        scoreDeficit: Number(Math.max(0, dominator.passRate - item.passRate).toFixed(2)),
        costRatio: Number((item.costPerTrialUsd / dominator.costPerTrialUsd).toFixed(2)),
      });
    }
  }

  return rawEntries
    .map((entry) => {
      const meta = metaById.get(entry.harnessId) ?? {
        onFrontier: false,
        dominatedById: null,
        scoreDeficit: null,
        costRatio: null,
      };
      return {
        harnessId: entry.harnessId,
        name: entry.name,
        vendor: canonicalizeHarnessProviderName(entry.vendor) ?? "Community",
        color: entry.color,
        version: normalizeHarnessVersion(entry.version),
        passRate: entry.passRate,
        ciLower: entry.ciLower,
        ciUpper: entry.ciUpper,
        costPerTrialUsd: entry.costPerTrialUsd,
        costPerPassUsd: entry.costPerPassUsd,
        passAll3Rate: entry.passAll3Rate,
        tokensPerTrial: entry.tokensPerTrial,
        agentSecondsPerTrial: entry.agentSecondsPerTrial,
        nScored: entry.nScored,
        onFrontier: meta.onFrontier,
        dominatedById: meta.dominatedById,
        scoreDeficit: meta.scoreDeficit,
        costRatio: meta.costRatio,
        benchmarks: [...entry.benchmarks].toSorted((a, b) =>
          compareAscii(a.benchmarkId, b.benchmarkId),
        ),
      };
    })
    .toSorted(
      (a, b) =>
        b.passRate - a.passRate ||
        a.costPerTrialUsd - b.costPerTrialUsd ||
        compareAscii(a.harnessId, b.harnessId),
    );
}

export interface ControlledHarnessPick {
  tag: "Budget" | "Best value" | "Top score" | "Top pick";
  entry: HarnessEntry;
  accent: boolean;
}

// Single source of truth for Controlled Harness picks across HomeView and HarnessesView
export function selectControlledHarnessPicks(
  entries: readonly HarnessEntry[],
): ControlledHarnessPick[] {
  const frontier = entries
    .filter((e) => e.onFrontier)
    .toSorted((a, b) => a.costPerTrialUsd - b.costPerTrialUsd);
  if (frontier.length === 0) return [];
  const budget = frontier[0]!;
  const top = frontier[frontier.length - 1]!;
  if (frontier.length === 1) return [{ tag: "Top pick", entry: top, accent: true }];
  if (frontier.length === 2) {
    return [
      { tag: "Budget", entry: budget, accent: true },
      { tag: "Top score", entry: top, accent: false },
    ];
  }

  const interior = frontier.slice(1, -1);
  const pricedInterior = interior.filter(
    (e): e is HarnessEntry & { costPerPassUsd: number } =>
      e.costPerPassUsd !== null && Number.isFinite(e.costPerPassUsd),
  );
  let mid = interior[0]!;
  if (pricedInterior.length > 0) {
    mid = pricedInterior.toSorted(
      (a, b) => a.costPerPassUsd - b.costPerPassUsd || b.passRate - a.passRate,
    )[0]!;
  } else {
    const logMin = Math.log10(Math.max(1e-6, budget.costPerTrialUsd));
    const logMax = Math.log10(Math.max(1e-6, top.costPerTrialUsd));
    const logSpan = Math.max(1e-6, logMax - logMin);
    const rateSpan = Math.max(1e-6, top.passRate - budget.passRate);
    let bestLift = -Infinity;
    for (const cand of interior) {
      const lift =
        (cand.passRate - budget.passRate) / rateSpan -
        (Math.log10(Math.max(1e-6, cand.costPerTrialUsd)) - logMin) / logSpan;
      if (lift > bestLift) {
        bestLift = lift;
        mid = cand;
      }
    }
  }

  return [
    { tag: "Budget", entry: budget, accent: false },
    { tag: "Best value", entry: mid, accent: true },
    { tag: "Top score", entry: top, accent: false },
  ];
}

// Align equivalent harness IDs across FrontierHarness v1.1 and Harness Leaderboard while keeping OpenCode 1.19.4 distinct
function canonicalizeFrontierHarnessId(rawId: string): string {
  if (rawId === "opencode-2.2.7") return "opencode";
  if (rawId === "opencode") return "opencode-1.19";
  if (rawId === "deepseek-standard") return "deepseek-harness";
  return rawId;
}

function canonicalizeDisplayName(
  hid: string,
  fhEntry?: HarnessEntry,
  hlbEntry?: HarnessEntry,
): string {
  if (hid === "opencode") return "OpenCode";
  if (hid === "kimi-code") return "Kimi Code";
  if (hid === "deepseek-harness") return "DeepSeek Harness";
  return fhEntry?.name ?? hlbEntry?.name ?? hid;
}

export const FRONTIER_HARNESS_BENCHMARK_IDS = ["terminal-bench-2.1", "terminal-bench-4.0"] as const;
export const HARNESS_LB_BENCHMARK_IDS = ["deep-swe", "terminal-bench-2.1"] as const;

export function validateHarnessSourceBenchmarks(
  board: HarnessLeaderboardSnapshot,
  expectedBenchmarkIds: readonly string[],
  sourceLabel: string,
): void {
  const expectedSorted = [...expectedBenchmarkIds].toSorted(compareAscii);
  const isMultiModelHlb = sourceLabel === "Harness Leaderboard" && board.slices.length > 2;
  for (const slice of board.slices) {
    for (const entry of slice.entries) {
      const actualSorted = entry.benchmarks.map((b) => b.benchmarkId).toSorted(compareAscii);
      if (
        actualSorted.length !== expectedSorted.length ||
        actualSorted.some((id, idx) => id !== expectedSorted[idx])
      ) {
        throw new Error(
          `${sourceLabel} slice '${slice.sliceId}' harness '${entry.harnessId}' has benchmark roster [${actualSorted.join(",")}] !== expected [${expectedSorted.join(",")}]`,
        );
      }
      if (isMultiModelHlb && slice.sliceId === "_all") {
        for (const b of entry.benchmarks) {
          if (b.ciLower !== null && b.ciUpper !== null && !b.ciIsUpperBound) {
            throw new Error(
              `${sourceLabel} pooled '_all' slice harness '${entry.harnessId}' benchmark '${b.benchmarkId}' must mark multi-model CI as ciIsUpperBound=true`,
            );
          }
        }
      }
    }
  }
}

interface EquatingCell {
  hid: string;
  cid: string;
  family: string;
  val: number;
  p3Val: number | null;
  se: number;
  hasMeasuredCi: boolean;
  isUpperBound: boolean;
}

function estimateBenchmarkSe(b: HarnessBenchmarkMetric): {
  se: number;
  hasMeasuredCi: boolean;
  isUpperBound: boolean;
} {
  if (b.ciLower !== null && b.ciUpper !== null && b.ciUpper > b.ciLower) {
    return {
      se: (b.ciUpper - b.ciLower) / (2 * 1.96),
      hasMeasuredCi: true,
      isUpperBound: Boolean(b.ciIsUpperBound),
    };
  }
  return {
    se: b.nTasks > 0 ? 50 / Math.sqrt(b.nTasks) : 3.0,
    hasMeasuredCi: false,
    isUpperBound: true,
  };
}

/**
 * Merges two controlled-harness slices via CTT reliability-weighted, TB-2.1-deduplicated two-way
 * additive pass-rate equating and multiplicative log-cost fixed effects across bridge harnesses.
 */
function mergeControlledSliceEntries(
  fhEntries: readonly HarnessEntry[],
  hlbEntries: readonly HarnessEntry[],
  fhUrl: string,
  hlbUrl: string,
): HarnessEntry[] {
  const fhById = new Map<string, HarnessEntry>();
  for (const e of fhEntries) {
    const cid = canonicalizeFrontierHarnessId(e.harnessId);
    if (fhById.has(cid)) {
      throw new Error(
        `FrontierHarness slice contains duplicate or colliding post-alias harness ID '${cid}'`,
      );
    }
    fhById.set(cid, e);
  }
  const hlbById = new Map<string, HarnessEntry>();
  for (const e of hlbEntries) {
    if (hlbById.has(e.harnessId)) {
      throw new Error(`Harness Leaderboard slice contains duplicate harness ID '${e.harnessId}'`);
    }
    hlbById.set(e.harnessId, e);
  }

  const allHids = [...new Set([...fhById.keys(), ...hlbById.keys()])].toSorted(compareAscii);
  const sharedHids = allHids.filter((id) => fhById.has(id) && hlbById.has(id));
  if (sharedHids.length < 3) {
    throw new Error(
      `Insufficient bridge harnesses (${sharedHids.length} < 3) to equate controlled harness suites`,
    );
  }

  const cells: EquatingCell[] = [];
  for (const [hid, e] of fhById) {
    const bmIds = e.benchmarks.map((b) => b.benchmarkId).toSorted(compareAscii);
    if (
      bmIds.length !== FRONTIER_HARNESS_BENCHMARK_IDS.length ||
      bmIds.some((id, idx) => id !== FRONTIER_HARNESS_BENCHMARK_IDS[idx])
    ) {
      throw new Error(
        `FrontierHarness entry '${hid}' has incomplete or unexpected benchmarks [${bmIds.join(",")}]`,
      );
    }
    for (const b of e.benchmarks) {
      const isTb21 = b.benchmarkId === "terminal-bench-2.1";
      const seInfo = estimateBenchmarkSe(b);
      cells.push({
        hid,
        cid: isTb21 ? "fh:tb21" : "fh:tb40",
        family: isTb21 ? "tb21" : "tb40",
        val: b.passRate,
        p3Val: b.passAll3Rate ?? null,
        se: seInfo.se,
        hasMeasuredCi: seInfo.hasMeasuredCi,
        isUpperBound: seInfo.isUpperBound,
      });
    }
  }
  for (const [hid, e] of hlbById) {
    const bmIds = e.benchmarks.map((b) => b.benchmarkId).toSorted(compareAscii);
    if (
      bmIds.length !== HARNESS_LB_BENCHMARK_IDS.length ||
      bmIds.some((id, idx) => id !== HARNESS_LB_BENCHMARK_IDS[idx])
    ) {
      throw new Error(
        `Harness Leaderboard entry '${hid}' has incomplete or unexpected benchmarks [${bmIds.join(",")}]`,
      );
    }
    for (const b of e.benchmarks) {
      const isTb21 = b.benchmarkId === "terminal-bench-2.1";
      const seInfo = estimateBenchmarkSe(b);
      cells.push({
        hid,
        cid: isTb21 ? "hlb:tb21" : "hlb:deepswe",
        family: isTb21 ? "tb21" : "deepswe",
        val: b.passRate,
        p3Val: b.passAll3Rate ?? null,
        se: seInfo.se,
        hasMeasuredCi: seInfo.hasMeasuredCi,
        isUpperBound: seInfo.isUpperBound,
      });
    }
  }

  // Weight each cell by empirical CTT reliability rho_c / familyDuplication so TB 2.1 is never double-counted
  const cellIds = [...new Set(cells.map((c) => c.cid))].toSorted(compareAscii);
  const familyCellCounts = new Map<string, number>();
  for (const cid of cellIds) {
    const fam = cells.find((c) => c.cid === cid)!.family;
    familyCellCounts.set(fam, (familyCellCounts.get(fam) ?? 0) + 1);
  }

  const cellWeight = new Map<string, number>();
  for (const cid of cellIds) {
    const rows = cells.filter((c) => c.cid === cid);
    const mean = rows.reduce((s, r) => s + r.val, 0) / rows.length;
    const variance = rows.reduce((s, r) => s + (r.val - mean) ** 2, 0) / rows.length;
    const allExactMeasured = rows.every((r) => r.hasMeasuredCi && !r.isUpperBound);
    // Subtract meanSeSq strictly when intervals reflect exact joint task variance, never conservative upper bounds
    let rho = 0.5;
    if (allExactMeasured) {
      const meanSeSq = rows.reduce((s, r) => s + r.se * r.se, 0) / rows.length;
      rho = variance > 1e-9 ? Math.max(0.1, Math.min(1, (variance - meanSeSq) / variance)) : 0.1;
    }
    const famCount = familyCellCounts.get(rows[0]!.family) ?? 1;
    cellWeight.set(cid, rho / famCount);
  }

  const totalCellW = [...cellWeight.values()].reduce((s, w) => s + w, 0);
  const raschFit = solveTwoWayLinearRasch(
    cells.map((c) => ({
      configId: c.hid,
      benchmarkId: c.cid,
      zScore: c.val,
      measVarZ: c.se * c.se,
      // Keep conservative upper bounds for reporting SE, but debias tauResidSq strictly from exact measured variance
      debiasVarZ: c.hasMeasuredCi && !c.isUpperBound ? c.se * c.se : 0,
    })),
    undefined,
    cellWeight,
  );
  const alpha = raschFit.thetaByConfig;
  const tauResidSq = raschFit.tauResidSq;

  // Symmetric multiplicative log-cost and headline-weight-consistent pass^3 gap fixed effects across bridge harnesses
  const logCostDiffs = sharedHids.map(
    (h) => Math.log(fhById.get(h)!.costPerTrialUsd) - Math.log(hlbById.get(h)!.costPerTrialUsd),
  );
  const gammaDiff = logCostDiffs.reduce((s, d) => s + d, 0) / logCostDiffs.length;
  const gFh = gammaDiff / 2;
  const gHlb = -gammaDiff / 2;

  const computeSuiteWeightedGap = (hid: string, prefix: "fh:" | "hlb:"): number | null => {
    const suiteCells = cells.filter((c) => c.hid === hid && c.cid.startsWith(prefix));
    if (suiteCells.length === 0) return null;
    let wSum = 0;
    let wGapSum = 0;
    for (const c of suiteCells) {
      if (c.p3Val === null || !Number.isFinite(c.p3Val)) return null;
      const w = cellWeight.get(c.cid) ?? 0;
      if (!(w > 0)) continue;
      wSum += w;
      wGapSum += w * Math.max(0, c.val - c.p3Val);
    }
    return wSum > 0 ? wGapSum / wSum : null;
  };

  const gapDiffs: number[] = [];
  for (const h of sharedHids) {
    const fRow = fhById.get(h)!;
    const lRow = hlbById.get(h)!;
    const fWeightedGap =
      fRow.passAll3Rate !== null && Number.isFinite(fRow.passAll3Rate)
        ? computeSuiteWeightedGap(h, "fh:")
        : null;
    const lWeightedGap =
      lRow.passAll3Rate !== null && Number.isFinite(lRow.passAll3Rate)
        ? computeSuiteWeightedGap(h, "hlb:")
        : null;
    if (fWeightedGap !== null && lWeightedGap !== null) {
      gapDiffs.push(fWeightedGap - lWeightedGap);
    }
  }
  const hasP3Bridge = gapDiffs.length > 0;
  const bridgeGapDiff = hasP3Bridge ? gapDiffs.reduce((s, d) => s + d, 0) / gapDiffs.length : null;
  let fullFhWeight = 0;
  let fullHlbWeight = 0;
  for (const [cid, w] of cellWeight.entries()) {
    if (cid.startsWith("fh:")) fullFhWeight += w;
    else if (cid.startsWith("hlb:")) fullHlbWeight += w;
  }
  const fullTotalW = Math.max(1e-9, fullFhWeight + fullHlbWeight);
  const fullFhShare = fullFhWeight / fullTotalW;
  const fullHlbShare = fullHlbWeight / fullTotalW;

  const rawMerged: RawHarnessEntryInput[] = allHids.map((hid) => {
    const f = fhById.get(hid);
    const l = hlbById.get(hid);
    const hCells = cells.filter((c) => c.hid === hid);
    const obsSet = new Set(hCells.map((c) => c.cid));

    let wObs = 0;
    let wFhObs = 0;
    let wHlbObs = 0;
    for (const c of hCells) {
      const w = cellWeight.get(c.cid) ?? 1;
      wObs += w;
      if (c.cid.startsWith("fh:")) wFhObs += w;
      else if (c.cid.startsWith("hlb:")) wHlbObs += w;
    }
    let fpcSq = 0;
    for (const cid of cellIds) {
      const w = cellWeight.get(cid) ?? 0;
      const coeff = (obsSet.has(cid) ? w / wObs : 0) - w / totalCellW;
      fpcSq += coeff * coeff;
    }
    // Include exact Gauss-Markov uncertainty from both own cells and estimated suite offsets
    const samplingVar = raschFit.thetaVarByConfig.get(hid) ?? 0;
    const seTotal = Math.sqrt(Math.max(0, samplingVar + fpcSq * tauResidSq));
    const passRate = Number(Math.max(0, Math.min(100, alpha.get(hid) ?? 0)).toFixed(2));
    const ciLower = Number(Math.max(0, passRate - 1.96 * seTotal).toFixed(2));
    const ciUpper = Number(Math.min(100, passRate + 1.96 * seTotal).toFixed(2));

    const eqLogCosts: number[] = [];
    if (f) eqLogCosts.push(Math.log(f.costPerTrialUsd) - gFh);
    if (l) eqLogCosts.push(Math.log(l.costPerTrialUsd) - gHlb);
    const costPerTrialUsd = Number(
      Math.exp(eqLogCosts.reduce((s, v) => s + v, 0) / eqLogCosts.length).toFixed(6),
    );
    const costPerPassUsd =
      passRate > 0 ? Number((costPerTrialUsd / (passRate / 100)).toFixed(6)) : null;

    // Weight per-benchmark 1-pass-to-3-pass drops strictly by headline benchmark weights (requiring row & constituent eligibility)
    const fWeightedGap =
      f !== undefined && f.passAll3Rate !== null && Number.isFinite(f.passAll3Rate)
        ? computeSuiteWeightedGap(hid, "fh:")
        : null;
    const lWeightedGap =
      l !== undefined && l.passAll3Rate !== null && Number.isFinite(l.passAll3Rate)
        ? computeSuiteWeightedGap(hid, "hlb:")
        : null;
    let passAll3Rate: number | null = null;
    if (f && l) {
      if (fWeightedGap !== null && lWeightedGap !== null && wObs > 0) {
        const mergedGap = (wFhObs * fWeightedGap + wHlbObs * lWeightedGap) / wObs;
        passAll3Rate = Number(Math.max(0, Math.min(passRate, passRate - mergedGap)).toFixed(2));
      }
    } else if (f && fWeightedGap !== null && bridgeGapDiff !== null) {
      const mergedGap = Math.max(
        fullFhShare * fWeightedGap,
        fWeightedGap - fullHlbShare * bridgeGapDiff,
      );
      passAll3Rate = Number(Math.max(0, Math.min(passRate, passRate - mergedGap)).toFixed(2));
    } else if (l && lWeightedGap !== null && bridgeGapDiff !== null) {
      const mergedGap = Math.max(
        fullHlbShare * lWeightedGap,
        lWeightedGap + fullFhShare * bridgeGapDiff,
      );
      passAll3Rate = Number(Math.max(0, Math.min(passRate, passRate - mergedGap)).toFixed(2));
    }

    const tokVals = [f?.tokensPerTrial, l?.tokensPerTrial].filter(
      (v): v is number => v !== undefined && v !== null && Number.isFinite(v),
    );
    const tokensPerTrial =
      tokVals.length > 0 ? Math.round(tokVals.reduce((s, v) => s + v, 0) / tokVals.length) : null;

    const secVals = [f?.agentSecondsPerTrial, l?.agentSecondsPerTrial].filter(
      (v): v is number => v !== undefined && v !== null && Number.isFinite(v),
    );
    const agentSecondsPerTrial =
      secVals.length > 0
        ? Number((secVals.reduce((s, v) => s + v, 0) / secVals.length).toFixed(1))
        : null;

    const benchmarks: HarnessBenchmarkMetric[] = [];
    if (f) {
      for (const b of f.benchmarks) {
        const isTb21 = b.benchmarkId === "terminal-bench-2.1";
        benchmarks.push({
          ...b,
          benchmarkId: isTb21 ? "tb21-frontierharness" : "terminal-bench-4.0",
          name: isTb21 ? "Terminal-Bench 2.1 (FrontierHarness)" : "Terminal-Bench 4.0",
          sourceUrl: b.sourceUrl ?? fhUrl,
        });
      }
    }
    if (l) {
      for (const b of l.benchmarks) {
        const isTb21 = b.benchmarkId === "terminal-bench-2.1";
        benchmarks.push({
          ...b,
          benchmarkId: isTb21 ? "tb21-harness-lb" : "deep-swe",
          name: isTb21 ? "Terminal-Bench 2.1 (Harness LB)" : "DeepSWE v1.1",
          sourceUrl: b.sourceUrl ?? hlbUrl,
        });
      }
    }

    return {
      harnessId: hid,
      name: canonicalizeDisplayName(hid, f, l),
      vendor: f?.vendor ?? l?.vendor ?? "Community",
      color: f?.color ?? l?.color ?? "#52525b",
      version: mergeHarnessVersions(f?.version, l?.version),
      passRate,
      ciLower,
      ciUpper,
      costPerTrialUsd,
      costPerPassUsd,
      passAll3Rate,
      tokensPerTrial,
      agentSecondsPerTrial,
      nScored: (f?.nScored ?? 0) + (l?.nScored ?? 0),
      benchmarks,
    };
  });

  return annotateHarnessPareto(rawMerged);
}

function canonicalModelTail(sliceId: string): string {
  const trimmed = sliceId.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function canonicalSliceOrg(slice: HarnessModelSlice): string | null {
  const explicit = canonicalizeHarnessProviderName(slice.org)?.toLowerCase() ?? null;
  const trimmed = slice.sliceId.trim();
  const slash = trimmed.indexOf("/");
  const nsOrg =
    slash > 0
      ? (canonicalizeHarnessProviderName(trimmed.slice(0, slash))?.toLowerCase() ?? null)
      : null;
  if (explicit && nsOrg && explicit !== nsOrg) {
    throw new Error(
      `Conflicting provider provenance for slice '${slice.sliceId}': namespace '${nsOrg}' !== org '${explicit}'`,
    );
  }
  return explicit ?? nsOrg;
}

function assertUniqueCanonicalModelSlices(
  slices: readonly HarnessModelSlice[],
  sourceLabel: string,
): Map<string, HarnessModelSlice> {
  const byCanon = new Map<string, HarnessModelSlice>();
  for (const s of slices) {
    const tail = canonicalModelTail(s.sliceId);
    const org = canonicalSliceOrg(s);
    const key = `${org ?? ""}::${tail}`;
    const existing = byCanon.get(key);
    if (existing) {
      throw new Error(
        `${sourceLabel} contains duplicate canonical control model '${key}' ('${existing.sliceId}' vs '${s.sliceId}')`,
      );
    }
    byCanon.set(key, s);
  }
  return byCanon;
}

export function mergeControlledHarnessSuites(
  frontierHarness: HarnessLeaderboardSnapshot,
  harnessLb: HarnessLeaderboardSnapshot,
): HarnessLeaderboardSnapshot {
  validateHarnessSourceBenchmarks(
    frontierHarness,
    FRONTIER_HARNESS_BENCHMARK_IDS,
    "FrontierHarness",
  );
  validateHarnessSourceBenchmarks(harnessLb, HARNESS_LB_BENCHMARK_IDS, "Harness Leaderboard");

  const fhAll = frontierHarness.slices.find((s) => s.sliceId === "_all");
  const hlbAll = harnessLb.slices.find((s) => s.sliceId === "_all");
  if (!fhAll || !hlbAll) {
    throw new Error("Both controlled harness suites must include pooled '_all' slice");
  }

  const pooledEntries = mergeControlledSliceEntries(
    fhAll.entries,
    hlbAll.entries,
    frontierHarness.sourceUrl,
    harnessLb.sourceUrl,
  );

  // Validate canonical uniqueness on both suites before 1:1 matching so merges never depend on input order
  const fhModels = frontierHarness.slices
    .filter((s) => s.sliceId !== "_all")
    .toSorted((a, b) => compareAscii(a.sliceId, b.sliceId));
  const hlbModels = harnessLb.slices
    .filter((s) => s.sliceId !== "_all")
    .toSorted((a, b) => compareAscii(a.sliceId, b.sliceId));
  assertUniqueCanonicalModelSlices(fhModels, "FrontierHarness");
  assertUniqueCanonicalModelSlices(hlbModels, "Harness Leaderboard");
  const modelSlices: HarnessModelSlice[] = [];

  const matchedHlbIds = new Set<string>();
  for (const fm of fhModels) {
    const fmTail = canonicalModelTail(fm.sliceId);
    const fmOrg = canonicalSliceOrg(fm);
    const matches = hlbModels.filter((hm) => {
      if (matchedHlbIds.has(hm.sliceId)) return false;
      const hmTail = canonicalModelTail(hm.sliceId);
      const hmOrg = canonicalSliceOrg(hm);
      return hmTail === fmTail && fmOrg !== null && hmOrg !== null && fmOrg === hmOrg;
    });
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous controlled-model join for FrontierHarness slice '${fm.sliceId}': matched [${matches.map((m) => m.sliceId).join(", ")}]`,
      );
    }
    const hlbMatch = matches[0];
    if (hlbMatch) {
      matchedHlbIds.add(hlbMatch.sliceId);
      modelSlices.push({
        sliceId: fm.sliceId,
        label: fm.label,
        org: canonicalizeHarnessProviderName(fm.org ?? hlbMatch.org),
        entries: mergeControlledSliceEntries(
          fm.entries,
          hlbMatch.entries,
          frontierHarness.sourceUrl,
          harnessLb.sourceUrl,
        ),
      });
    } else {
      modelSlices.push({
        sliceId: fm.sliceId,
        label: fm.label,
        org: canonicalizeHarnessProviderName(fm.org),
        entries: annotateHarnessPareto(
          fm.entries.map((e) => ({
            ...e,
            harnessId: canonicalizeFrontierHarnessId(e.harnessId),
            name: canonicalizeDisplayName(canonicalizeFrontierHarnessId(e.harnessId), e),
            benchmarks: e.benchmarks.map((b) => ({
              ...b,
              benchmarkId:
                b.benchmarkId === "terminal-bench-2.1" ? "tb21-frontierharness" : b.benchmarkId,
              sourceUrl: b.sourceUrl ?? frontierHarness.sourceUrl,
            })),
          })),
        ),
      });
    }
  }

  for (const hm of hlbModels) {
    if (matchedHlbIds.has(hm.sliceId)) continue;
    modelSlices.push({
      sliceId: hm.sliceId,
      label: hm.label,
      org: canonicalizeHarnessProviderName(hm.org),
      entries: annotateHarnessPareto(
        hm.entries.map((e) => ({
          ...e,
          benchmarks: e.benchmarks.map((b) => ({
            ...b,
            benchmarkId: b.benchmarkId === "terminal-bench-2.1" ? "tb21-harness-lb" : b.benchmarkId,
            sourceUrl: b.sourceUrl ?? harnessLb.sourceUrl,
          })),
        })),
      ),
    });
  }

  modelSlices.sort((a, b) => compareAscii(a.sliceId, b.sliceId));
  const cmpTs = compareIsoInstants(
    frontierHarness.upstreamGeneratedAt,
    harnessLb.upstreamGeneratedAt,
  );
  const latestTimestamp =
    cmpTs !== null && cmpTs < 0
      ? harnessLb.upstreamGeneratedAt
      : frontierHarness.upstreamGeneratedAt;

  return {
    sourceVersion: `${frontierHarness.sourceVersion}+${harnessLb.sourceVersion}`,
    upstreamGeneratedAt: latestTimestamp,
    sourceUrl: frontierHarness.sourceUrl,
    slices: [
      {
        sliceId: "_all",
        label: `All ${modelSlices.length} models`,
        org: null,
        entries: pooledEntries,
      },
      ...modelSlices,
    ],
  };
}

// Recompute dominance, versions, and deterministic ordering from scratch so cached frontier claims are never trusted
export function recomputeHarnessLeaderboard(
  raw: HarnessLeaderboardSnapshot,
): HarnessLeaderboardSnapshot {
  const pooled = raw.slices.filter((s) => s.sliceId === "_all");
  const models = raw.slices
    .filter((s) => s.sliceId !== "_all")
    .toSorted((a, b) => compareAscii(a.sliceId, b.sliceId));
  const ordered = [...pooled, ...models];

  return {
    sourceVersion: raw.sourceVersion,
    upstreamGeneratedAt: raw.upstreamGeneratedAt,
    sourceUrl: raw.sourceUrl,
    slices: ordered.map((slice) => ({
      sliceId: slice.sliceId,
      label: slice.sliceId === "_all" ? `All ${models.length} models` : slice.label,
      org: canonicalizeHarnessProviderName(slice.org),
      entries: annotateHarnessPareto(
        slice.entries.map(
          ({
            onFrontier: _onFrontier,
            dominatedById: _dominatedById,
            scoreDeficit: _scoreDeficit,
            costRatio: _costRatio,
            ...base
          }) => base,
        ),
      ),
    })),
  };
}
