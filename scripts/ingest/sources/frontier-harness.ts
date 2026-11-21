import { compareAscii } from "../../../src/lib/math/aggregate.ts";
import {
  annotateHarnessPareto,
  MIN_CONTROLLED_HARNESSES,
  normalizeHarnessVersion,
  type RawHarnessEntryInput,
} from "../../../src/lib/math/harness-pareto.ts";
import {
  type HarnessBenchmarkMetric,
  type HarnessEntry,
  type HarnessLeaderboardSnapshot,
  HarnessLeaderboardSnapshotSchema,
  type HarnessModelSlice,
} from "../../../src/lib/schema.ts";
import { fetchJson, parseNonNegative, parseNumeric } from "../http.ts";
import type { SourceAdapter } from "../types.ts";

const FH_LIVE_URL = "https://frontierharness.org/api/live?since=0";
const FH_SUMMARY_URL = "https://frontierharness.org/api/summary";
const FH_PUBLIC_URL = "https://frontierharness.org/leaderboard/v1.1/";

interface FhSummaryHarness {
  id?: string;
  label?: string;
  baseline?: boolean;
  ecosystem?: string | null;
  color?: string | { light?: string; dark?: string } | null;
}

interface FhSummaryPayload {
  version?: string;
  study?: {
    harnesses?: FhSummaryHarness[];
  };
}

interface FhLiveTask {
  name?: string;
  subset?: string;
  category?: string;
}

interface FhLiveHarness {
  id?: string;
  label?: string;
  version?: string;
}

interface FhLiveModel {
  id?: string;
  label?: string;
  ecosystem?: string;
}

interface FhLivePayload {
  version?: string;
  end_ms?: number;
  complete?: boolean;
  attempts?: number;
  outcomes?: string[];
  tasks?: FhLiveTask[];
  harnesses?: FhLiveHarness[];
  models?: FhLiveModel[];
  finished_fields?: string[];
  finished?: unknown[][];
}

const VENDOR_BY_HARNESS: Readonly<Record<string, string>> = {
  codex: "OpenAI",
  "claude-code": "Anthropic",
  "antigravity-cli": "Google",
  "grok-build": "SpaceXAI",
  "deepseek-minimal": "DeepSeek",
  "deepseek-standard": "DeepSeek",
  "deepseek-code": "DeepSeek",
  "deepseek-creator": "DeepSeek",
  "kimi-code": "Moonshot",
  zcode: "Zhipu",
  "copilot-cli": "GitHub",
  hermes: "Nous Research",
  "mini-swe-agent": "SWE-agent",
  opencode: "OpenCode",
  "opencode-2.2.7": "OpenCode",
  "cline-cli": "Cline",
  "minimax-code": "MiniMax",
  pi: "Pi",
  "oh-my-pi": "Oh My Pi",
  maka: "Maka",
  alma: "Alma",
  exo: "Exo",
};

const MODEL_ORG_BY_ECOSYSTEM: Readonly<Record<string, string>> = {
  zhipu: "Zhipu",
  deepseek: "DeepSeek",
  meta: "Meta",
  moonshot: "Moonshot",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "SpaceXAI",
};

const SUBSET_META: Readonly<
  Record<string, { benchmarkId: string; name: string; minTasks: number }>
> = {
  tb21: { benchmarkId: "terminal-bench-2.1", name: "Terminal-Bench 2.1", minTasks: 45 },
  tb4: { benchmarkId: "terminal-bench-4.0", name: "Terminal-Bench 4.0", minTasks: 17 },
};

interface CellTrial {
  taskIdx: number;
  cellIdx: number;
  subset: string;
  passed: boolean;
  costUsd: number | null;
  totalTokens: number | null;
  runSec: number | null;
}

function resolveColor(raw: FhSummaryHarness["color"]): string {
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (raw && typeof raw === "object" && typeof raw.light === "string" && raw.light.trim()) {
    return raw.light.trim();
  }
  return "#52525b";
}

function taskClusteredCiPct(rates: readonly number[]): {
  lower: number | null;
  upper: number | null;
} {
  const m = rates.length;
  if (m < 2) return { lower: null, upper: null };
  const mean = rates.reduce((s, r) => s + r, 0) / m;
  let sumSq = 0;
  for (const r of rates) {
    const d = r - mean;
    sumSq += d * d;
  }
  if (sumSq <= 1e-12) {
    // Non-degenerate Wilson 95% score interval over m distinct tasks when all tasks pass (100%) or fail (0%)
    const z = 1.96;
    const z2 = z * z;
    const denom = 1 + z2 / m;
    const center = (mean + z2 / (2 * m)) / denom;
    const half = (z * Math.sqrt((mean * (1 - mean) + z2 / (4 * m)) / m)) / denom;
    return {
      lower: Number((Math.max(0, center - half) * 100).toFixed(2)),
      upper: Number((Math.min(1, center + half) * 100).toFixed(2)),
    };
  }
  const se = Math.sqrt(sumSq / (m * (m - 1)));
  const lo = Math.max(0, (mean - 1.96 * se) * 100);
  const hi = Math.min(100, (mean + 1.96 * se) * 100);
  return { lower: Number(lo.toFixed(2)), upper: Number(hi.toFixed(2)) };
}

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let res = 1;
  for (let i = 1; i <= k; i++) {
    res = (res * (n - k + i)) / i;
  }
  return res;
}

const MIN_SLICE_COMPLETION_FRAC = 0.9;

function buildEntryFromTrials(
  harness: FhLiveHarness,
  summaryMeta: FhSummaryHarness | undefined,
  trials: readonly CellTrial[],
  attemptsK: number,
  expectedSubsets: readonly string[],
  expectedTasksBySubset: ReadonlyMap<string, number>,
  modelCountInSlice: number,
  hasCorruptedAttempts: boolean,
): RawHarnessEntryInput | null {
  if (trials.length === 0 || hasCorruptedAttempts) return null;

  let scored = 0;
  let tokenSum = 0;
  let tokenCount = 0;
  let secSum = 0;
  let secCount = 0;

  // Group strictly by (model, task) cell first so passRate, pass^3, cost, and task-clustered 95% CI share identical equal-task weights
  const cellMap = new Map<
    number,
    {
      taskIdx: number;
      subset: string;
      passes: number;
      scored: number;
      costSum: number;
      costCount: number;
    }
  >();

  for (const t of trials) {
    scored++;
    if (t.totalTokens !== null) {
      tokenSum += t.totalTokens;
      tokenCount++;
    }
    if (t.runSec !== null) {
      secSum += t.runSec;
      secCount++;
    }

    const curCell = cellMap.get(t.cellIdx) ?? {
      taskIdx: t.taskIdx,
      subset: t.subset,
      passes: 0,
      scored: 0,
      costSum: 0,
      costCount: 0,
    };
    curCell.scored++;
    if (t.passed) curCell.passes++;
    if (t.costUsd !== null) {
      curCell.costSum += t.costUsd;
      curCell.costCount++;
    }
    cellMap.set(t.cellIdx, curCell);
  }

  let totalExpectedTasks = 0;
  for (const subsetKey of expectedSubsets) {
    totalExpectedTasks += expectedTasksBySubset.get(subsetKey) ?? 0;
  }
  const minRequiredRuns = Math.ceil(
    totalExpectedTasks * modelCountInSlice * attemptsK * MIN_SLICE_COMPLETION_FRAC,
  );
  const expectedCellCount = totalExpectedTasks * modelCountInSlice;
  // Reject slices missing any expected (model, task) cell so omitted failing-model cells cannot inflate pooled scores
  if (scored < minRequiredRuns || cellMap.size < expectedCellCount) return null;

  const taskAgg = new Map<
    number,
    {
      subset: string;
      rateSum: number;
      p3Sum: number;
      costSum: number;
      cellCount: number;
      p3Count: number;
      costCellCount: number;
    }
  >();
  for (const st of cellMap.values()) {
    if (st.scored <= 0 || st.scored > attemptsK) return null;
    // Require priced attempts in every required (model, task) cell before publishing task-averaged cost
    if (st.costCount <= 0) return null;
    const cellRate = st.passes / st.scored;
    const cellCost = st.costSum / st.costCount;
    const has3 = st.scored >= 3;
    const cur = taskAgg.get(st.taskIdx) ?? {
      subset: st.subset,
      rateSum: 0,
      p3Sum: 0,
      costSum: 0,
      cellCount: 0,
      p3Count: 0,
      costCellCount: 0,
    };
    cur.rateSum += cellRate;
    cur.costSum += cellCost;
    cur.cellCount++;
    cur.costCellCount++;
    if (has3) {
      cur.p3Sum += comb(st.passes, 3) / comb(st.scored, 3);
      cur.p3Count++;
    }
    taskAgg.set(st.taskIdx, cur);
  }

  const benchmarks: HarnessBenchmarkMetric[] = [];
  const allTaskRates: number[] = [];
  const allTaskCosts: number[] = [];
  const allTaskP3Rates: number[] = [];
  let allSubsetsHave3 = true;
  const trialsBySubset = Map.groupBy(trials, (t) => t.subset);

  for (const subsetKey of expectedSubsets) {
    const expectedTasks = expectedTasksBySubset.get(subsetKey) ?? 0;
    const subsetTrials = trialsBySubset.get(subsetKey) ?? [];
    if (
      subsetTrials.length <
      Math.ceil(expectedTasks * modelCountInSlice * attemptsK * MIN_SLICE_COMPLETION_FRAC)
    )
      return null;
    const subRates: number[] = [];
    const subCosts: number[] = [];
    const subP3Rates: number[] = [];
    let subAllCellsHave3 = true;
    for (const st of taskAgg.values()) {
      if (
        st.subset === subsetKey &&
        st.cellCount === modelCountInSlice &&
        st.costCellCount === modelCountInSlice
      ) {
        const r = st.rateSum / st.cellCount;
        const c = st.costSum / st.costCellCount;
        subRates.push(r);
        subCosts.push(c);
        allTaskRates.push(r);
        allTaskCosts.push(c);
        if (st.p3Count === st.cellCount) {
          const p3 = st.p3Sum / st.p3Count;
          subP3Rates.push(p3);
          allTaskP3Rates.push(p3);
        } else {
          subAllCellsHave3 = false;
        }
      }
    }
    if (expectedTasks === 0 || subRates.length < expectedTasks || subCosts.length < expectedTasks) {
      return null;
    }
    if (!subAllCellsHave3 || subP3Rates.length !== subRates.length) {
      allSubsetsHave3 = false;
    }
    const subMean = subRates.reduce((s, r) => s + r, 0) / subRates.length;
    const subCostMean = subCosts.reduce((s, c) => s + c, 0) / subCosts.length;
    if (!(subCostMean > 0)) return null;
    const subPassAll3Rate =
      subAllCellsHave3 && subP3Rates.length === subRates.length
        ? Number(
            (
              Math.min(subMean, subP3Rates.reduce((s, r) => s + r, 0) / subP3Rates.length) * 100
            ).toFixed(2),
          )
        : null;
    const subInfo = SUBSET_META[subsetKey] ?? { benchmarkId: subsetKey, name: subsetKey };
    const ci = taskClusteredCiPct(subRates);
    benchmarks.push({
      benchmarkId: subInfo.benchmarkId,
      name: subInfo.name,
      passRate: Number((subMean * 100).toFixed(2)),
      ciLower: ci.lower,
      ciUpper: ci.upper,
      ciIsUpperBound: ci.lower === null || ci.upper === null,
      passAll3Rate: subPassAll3Rate,
      costPerTrialUsd: Number(subCostMean.toFixed(6)),
      nTasks: subRates.length,
      nScored: subsetTrials.length,
      tokensPerTrial: subsetTrials.every((t) => t.totalTokens !== null)
        ? Math.round(subsetTrials.reduce((n, t) => n + t.totalTokens!, 0) / subsetTrials.length)
        : null,
      agentSecondsPerTrial: subsetTrials.every((t) => t.runSec !== null)
        ? Number((subsetTrials.reduce((n, t) => n + t.runSec!, 0) / subsetTrials.length).toFixed(1))
        : null,
      sourceUrl: FH_PUBLIC_URL,
    });
  }
  benchmarks.sort((a, b) => compareAscii(a.benchmarkId, b.benchmarkId));

  if (allTaskRates.length < totalExpectedTasks || allTaskCosts.length < totalExpectedTasks) {
    return null;
  }
  const passRateFrac = allTaskRates.reduce((s, r) => s + r, 0) / allTaskRates.length;
  const passRate = Number((passRateFrac * 100).toFixed(2));
  const passAll3Rate =
    allSubsetsHave3 && allTaskP3Rates.length === allTaskRates.length
      ? Number(
          (
            Math.min(
              passRateFrac,
              allTaskP3Rates.reduce((s, r) => s + r, 0) / allTaskP3Rates.length,
            ) * 100
          ).toFixed(2),
        )
      : null;

  const costPerTrialUsd = Number(
    (allTaskCosts.reduce((s, c) => s + c, 0) / allTaskCosts.length).toFixed(6),
  );
  const costPerPassUsd =
    passRateFrac > 0 ? Number((costPerTrialUsd / passRateFrac).toFixed(6)) : null;
  const overallCi = taskClusteredCiPct(allTaskRates);

  const harnessId = harness.id!.trim();
  const displayName = (summaryMeta?.label ?? harness.label ?? harnessId).trim();
  const vendor =
    VENDOR_BY_HARNESS[harnessId] ??
    (summaryMeta?.ecosystem
      ? (MODEL_ORG_BY_ECOSYSTEM[summaryMeta.ecosystem] ?? summaryMeta.ecosystem)
      : "Community");

  return {
    harnessId,
    name: displayName,
    vendor,
    color: resolveColor(summaryMeta?.color),
    version: normalizeHarnessVersion(harness.version ?? null),
    passRate,
    ciLower: overallCi.lower,
    ciUpper: overallCi.upper,
    costPerTrialUsd,
    costPerPassUsd,
    passAll3Rate,
    tokensPerTrial: tokenCount > 0 ? Math.round(tokenSum / tokenCount) : null,
    agentSecondsPerTrial: secCount > 0 ? Number((secSum / secCount).toFixed(1)) : null,
    nScored: scored,
    benchmarks,
  };
}

export const frontierHarnessAdapter: SourceAdapter = {
  id: "frontier-harness",
  label: "FrontierHarness Eval v1.1 (TB 2.1 + TB 4.0)",
  license: "Public Research Leaderboard / Attribution Required",
  sourceUrl: FH_PUBLIC_URL,
  expectedBenchmarks: [],
  expectsPricing: false,
  expectsHarnessLeaderboard: true,
  async fetchLive() {
    const [live, summary] = await Promise.all([
      fetchJson<FhLivePayload>(FH_LIVE_URL, { timeoutMs: 30_000 }),
      fetchJson<FhSummaryPayload>(FH_SUMMARY_URL, { timeoutMs: 20_000 }),
    ]);

    if (
      live.complete !== true ||
      !Array.isArray(live.finished) ||
      !Array.isArray(live.finished_fields) ||
      !Array.isArray(live.tasks) ||
      !Array.isArray(live.harnesses) ||
      !Array.isArray(live.models) ||
      typeof live.end_ms !== "number" ||
      !Number.isFinite(live.end_ms)
    ) {
      throw new Error("FrontierHarness live API payload incomplete or missing required arrays");
    }

    const fieldIdx = new Map<string, number>();
    for (let i = 0; i < live.finished_fields.length; i++) {
      const f = live.finished_fields[i];
      if (typeof f !== "string" || !f.trim()) {
        throw new Error("FrontierHarness finished_fields contains empty or non-string column name");
      }
      if (fieldIdx.has(f)) {
        throw new Error(`FrontierHarness finished_fields contains duplicate column '${f}'`);
      }
      fieldIdx.set(f, i);
    }
    const cTask = fieldIdx.get("task");
    const cHarness = fieldIdx.get("harness");
    const cModel = fieldIdx.get("model");
    const cAttempt = fieldIdx.get("attempt");
    const cOutcome = fieldIdx.get("outcome");
    const cInput = fieldIdx.get("input_tokens");
    const cOutput = fieldIdx.get("output_tokens");
    const cCost = fieldIdx.get("cost_usd");
    const cRunSec = fieldIdx.get("run_seconds");
    const cLookup = fieldIdx.get("lookup");
    if (
      cTask === undefined ||
      cHarness === undefined ||
      cModel === undefined ||
      cAttempt === undefined ||
      cOutcome === undefined ||
      cCost === undefined ||
      cLookup === undefined
    ) {
      throw new Error(
        "FrontierHarness finished_fields missing required column indices (including lookup)",
      );
    }

    if (
      !Array.isArray(live.outcomes) ||
      live.outcomes.length === 0 ||
      !live.outcomes.every((o) => typeof o === "string" && o.trim().length > 0)
    ) {
      throw new Error("FrontierHarness payload missing valid outcomes mapping");
    }
    const outcomes = live.outcomes;
    if (new Set(outcomes).size !== outcomes.length) {
      throw new Error("FrontierHarness outcomes table contains duplicate outcome codes");
    }
    const passCode = outcomes.indexOf("pass");
    const infraCode = outcomes.indexOf("infra");
    if (passCode < 0 || infraCode < 0) {
      throw new Error("FrontierHarness outcomes table missing pass/infra codes");
    }

    if (
      typeof live.attempts !== "number" ||
      !Number.isInteger(live.attempts) ||
      live.attempts < 2
    ) {
      throw new Error("FrontierHarness payload missing valid integer attempts count (>= 2)");
    }
    const attemptsK = live.attempts;
    const expectedTasksBySubset = new Map<string, number>();
    const seenTaskKeys = new Set<string>();
    for (const task of live.tasks) {
      const s = task.subset?.trim() ?? "";
      const taskName = task.name?.trim() ?? "";
      if (!s || !taskName) {
        throw new Error("FrontierHarness task roster contains unnamed or subset-less task entry");
      }
      const uniqueKey = `${s}::${taskName}`;
      if (seenTaskKeys.has(uniqueKey)) {
        throw new Error(`FrontierHarness task roster contains duplicate task '${uniqueKey}'`);
      }
      seenTaskKeys.add(uniqueKey);
      expectedTasksBySubset.set(s, (expectedTasksBySubset.get(s) ?? 0) + 1);
    }
    const expectedSubsets = [...expectedTasksBySubset.keys()].toSorted(compareAscii);
    for (const [reqKey, meta] of Object.entries(SUBSET_META)) {
      const count = expectedTasksBySubset.get(reqKey) ?? 0;
      if (count < meta.minTasks) {
        throw new Error(
          `FrontierHarness subset '${reqKey}' task roster truncated (${count} < ${meta.minTasks})`,
        );
      }
    }

    const summaryByHarnessId = new Map<string, FhSummaryHarness>(
      (summary.study?.harnesses ?? [])
        .filter((h): h is FhSummaryHarness & { id: string } => typeof h.id === "string")
        .map((h) => [h.id, h]),
    );

    const trialsByModelHarness = new Map<string, CellTrial[]>();
    const trialsByHarnessAll = new Map<number, CellTrial[]>();
    interface ParsedAttempt {
      tIdx: number;
      hIdx: number;
      mIdx: number;
      oIdx: number;
      lookupFlag: number;
      subset: string;
      costUsd: number | null;
      totalTokens: number | null;
      runSec: number | null;
    }
    const attemptsByKey = new Map<string, ParsedAttempt[]>();
    let totalAttempted = 0;
    let totalRejected = 0;

    for (const row of live.finished) {
      totalAttempted++;
      if (!Array.isArray(row)) {
        totalRejected++;
        continue;
      }
      const tIdx = parseNumeric(row[cTask]);
      const hIdx = parseNumeric(row[cHarness]);
      const mIdx = parseNumeric(row[cModel]);
      const oIdx = parseNumeric(row[cOutcome]);
      const attemptNum = parseNumeric(row[cAttempt]);
      if (
        tIdx === null ||
        hIdx === null ||
        mIdx === null ||
        oIdx === null ||
        attemptNum === null ||
        !Number.isInteger(tIdx) ||
        !Number.isInteger(hIdx) ||
        !Number.isInteger(mIdx) ||
        !Number.isInteger(oIdx) ||
        !Number.isInteger(attemptNum) ||
        tIdx < 0 ||
        tIdx >= live.tasks.length ||
        hIdx < 0 ||
        hIdx >= live.harnesses.length ||
        mIdx < 0 ||
        mIdx >= live.models.length ||
        oIdx < 0 ||
        oIdx >= outcomes.length ||
        attemptNum < 1 ||
        attemptNum > attemptsK
      ) {
        totalRejected++;
        continue;
      }
      const subset = live.tasks[tIdx]?.subset?.trim() ?? "";
      if (!subset) {
        totalRejected++;
        continue;
      }
      const rawLookupVal = row[cLookup];
      if (typeof rawLookupVal !== "number" || (rawLookupVal !== 0 && rawLookupVal !== 1)) {
        totalRejected++;
        continue;
      }
      const lookupFlag = rawLookupVal;
      const costUsd = parseNonNegative(row[cCost]);
      const inTok = cInput !== undefined ? parseNonNegative(row[cInput]) : null;
      const outTok = cOutput !== undefined ? parseNonNegative(row[cOutput]) : null;
      const totalTokens = inTok !== null && outTok !== null ? inTok + outTok : null;
      const runSec = cRunSec !== undefined ? parseNonNegative(row[cRunSec]) : null;
      const attemptKey = `${tIdx}:${hIdx}:${mIdx}:${attemptNum}`;
      const grp = attemptsByKey.get(attemptKey) ?? [];
      grp.push({ tIdx, hIdx, mIdx, oIdx, lookupFlag, subset, costUsd, totalTokens, runSec });
      attemptsByKey.set(attemptKey, grp);
    }

    const corruptedModelHarness = new Set<string>();
    const corruptedHarnessAll = new Set<number>();
    for (const grp of attemptsByKey.values()) {
      // Deduplicate identical replay copies before counting unique variants or conflicts
      const uniqueVariants = new Map<string, ParsedAttempt>();
      for (const a of grp) {
        const sig = `${a.oIdx}|${a.lookupFlag}|${a.costUsd ?? "null"}|${a.totalTokens ?? "null"}|${a.runSec ?? "null"}`;
        if (!uniqueVariants.has(sig)) uniqueVariants.set(sig, a);
      }
      if (grp.length > uniqueVariants.size) {
        totalAttempted -= grp.length - uniqueVariants.size;
      }
      const first = grp[0]!;
      if (uniqueVariants.size > 1) {
        totalRejected += uniqueVariants.size;
        corruptedModelHarness.add(`${first.mIdx}:${first.hIdx}`);
        corruptedHarnessAll.add(first.hIdx);
        continue;
      }
      // Match FrontierHarness live.js: exclude infra failures and score reward-hacking lookup passes as fail
      if (first.oIdx === infraCode) continue;
      const passed = first.oIdx === passCode && first.lookupFlag === 0;
      const cellIdx = first.mIdx * live.tasks.length + first.tIdx;
      const trial: CellTrial = {
        taskIdx: first.tIdx,
        cellIdx,
        subset: first.subset,
        passed,
        costUsd: first.costUsd,
        totalTokens: first.totalTokens,
        runSec: first.runSec,
      };

      const cellKey = `${first.mIdx}:${first.hIdx}`;
      const cellList = trialsByModelHarness.get(cellKey) ?? [];
      cellList.push(trial);
      trialsByModelHarness.set(cellKey, cellList);

      const allList = trialsByHarnessAll.get(first.hIdx) ?? [];
      allList.push(trial);
      trialsByHarnessAll.set(first.hIdx, allList);
    }

    const liveHarnesses = live.harnesses;
    const liveModels = live.models;
    const buildSliceEntries = (
      getTrials: (hIdx: number) => readonly CellTrial[],
      isCorrupted: (hIdx: number) => boolean,
      modelCountInSlice: number,
    ): HarnessEntry[] => {
      const raws: RawHarnessEntryInput[] = [];
      for (let hIdx = 0; hIdx < liveHarnesses.length; hIdx++) {
        const harness = liveHarnesses[hIdx]!;
        if (!harness.id) continue;
        const entry = buildEntryFromTrials(
          harness,
          summaryByHarnessId.get(harness.id),
          getTrials(hIdx),
          attemptsK,
          expectedSubsets,
          expectedTasksBySubset,
          modelCountInSlice,
          isCorrupted(hIdx),
        );
        if (entry) raws.push(entry);
      }
      return annotateHarnessPareto(raws);
    };

    const pooledEntries = buildSliceEntries(
      (hIdx) => trialsByHarnessAll.get(hIdx) ?? [],
      (hIdx) => corruptedHarnessAll.has(hIdx),
      liveModels.length,
    );
    const modelSlices: HarnessModelSlice[] = [];
    for (let mIdx = 0; mIdx < liveModels.length; mIdx++) {
      const m = liveModels[mIdx]!;
      if (!m.id) continue;
      const entries = buildSliceEntries(
        (hIdx) => trialsByModelHarness.get(`${mIdx}:${hIdx}`) ?? [],
        (hIdx) => corruptedModelHarness.has(`${mIdx}:${hIdx}`),
        1,
      );
      if (entries.length < MIN_CONTROLLED_HARNESSES) continue;
      const org = m.ecosystem ? (MODEL_ORG_BY_ECOSYSTEM[m.ecosystem] ?? m.ecosystem) : null;
      modelSlices.push({
        sliceId: m.id,
        label: (m.label ?? m.id).trim(),
        org,
        entries,
      });
    }

    if (
      pooledEntries.length < MIN_CONTROLLED_HARNESSES ||
      modelSlices.length !== liveModels.length
    ) {
      return {
        observations: [],
        pricing: [],
        harnessLeaderboardStats: {
          attempted: Math.max(1, totalAttempted),
          rejected: Math.max(1, totalRejected),
          excluded: 0,
          error: `Incomplete FrontierHarness board (${modelSlices.length}/${live.models.length} models, ${pooledEntries.length} pooled harnesses)`,
        },
      };
    }

    modelSlices.sort((a, b) => compareAscii(a.sliceId, b.sliceId));
    const slices: HarnessModelSlice[] = [
      {
        sliceId: "_all",
        label: `All ${modelSlices.length} models`,
        org: null,
        entries: pooledEntries,
      },
      ...modelSlices,
    ];

    const upstreamGeneratedAt = new Date(live.end_ms).toISOString();
    const harnessLeaderboard: HarnessLeaderboardSnapshot = HarnessLeaderboardSnapshotSchema.parse({
      sourceVersion: `1.1-${(live.version ?? summary.version ?? "live").slice(0, 8)}`,
      upstreamGeneratedAt,
      sourceUrl: FH_PUBLIC_URL,
      slices,
    });

    return {
      observations: [],
      pricing: [],
      harnessLeaderboard,
      harnessLeaderboardStats: {
        attempted: totalAttempted,
        rejected: totalRejected,
        excluded: 0,
      },
    };
  },
};
