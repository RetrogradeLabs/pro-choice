import { BENCHMARK_BY_ID, type BenchmarkMeta } from "../../config/benchmarks.ts";
import {
  assertDisjointRoster,
  datasetPoolsFor,
  measurementFamilyFor,
} from "../../config/measurement-families.ts";
import { compareIsoInstants } from "../format.ts";
import type {
  AnchorStats,
  BenchmarkScoreDetail,
  HarnessId,
  HarnessRegime,
  LinkJointCov,
  ProviderId,
  ReasoningEffort,
  SeModel,
} from "../schema.ts";
import type { AggregateWeightPolicy } from "./measurement-families.ts";
import { allocateFamilyWeights, MIN_BENCHMARK_WEIGHT } from "./measurement-families.ts";

export const DISPLAY_BASE = 50;
export const DISPLAY_SPREAD = 15;
export const Z_SCORE_MIN = -3.0;
export const Z_SCORE_MAX = 3.5;
export const TAU_MODEL_SQ_MIN = 0.1;
export const TAU_MODEL_SQ_MAX = 2.5;
export const MIN_FRONTIER_SHRINKAGE = 0.5;

function normalCdfAgg(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
    t *
    Math.exp(-ax * ax);
  return 0.5 * (1 + sign * (1 - poly));
}

const GL8_NODES_AGG = [
  -0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498,
  0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363,
] as const;
const GL8_WEIGHTS_AGG = [
  0.10122853629037626, 0.22238103445337448, 0.3137066458778873, 0.362683783378362,
  0.362683783378362, 0.3137066458778873, 0.22238103445337448, 0.10122853629037626,
] as const;

// Exact bounded variance of clip(N(mu, sigma^2), lo, hi) using non-negative centered quadrature when sigma is wide
export function clippedNormalVariance(mu: number, sigma: number, lo: number, hi: number): number {
  if (!(sigma > 0) || hi <= lo) return 0;
  const maxPopoviciu = 0.25 * (hi - lo) * (hi - lo);
  const invSqrt2Pi = 0.3989422804014327;
  const alpha = (lo - mu) / sigma;
  const beta = (hi - mu) / sigma;
  const pLo = normalCdfAgg(alpha);
  const pHi = normalCdfAgg(-beta);

  // Avoid catastrophic O(sigma^2) cancellation when the interval spans < 0.5 standard deviations
  if (beta - alpha < 0.5) {
    const mid = 0.5 * (lo + hi);
    const half = 0.5 * (hi - lo);
    const xs: number[] = [];
    const ws: number[] = [];
    let meanC = (lo - mid) * pLo + (hi - mid) * pHi;
    for (let i = 0; i < 8; i++) {
      const xc = half * GL8_NODES_AGG[i]!;
      const t = (mid + xc - mu) / sigma;
      const w =
        Math.abs(t) < 40
          ? (half * GL8_WEIGHTS_AGG[i]! * invSqrt2Pi * Math.exp(-0.5 * t * t)) / sigma
          : 0;
      xs.push(xc);
      ws.push(w);
      meanC += w * xc;
    }
    let variance =
      (lo - mid - meanC) * (lo - mid - meanC) * pLo + (hi - mid - meanC) * (hi - mid - meanC) * pHi;
    for (let i = 0; i < 8; i++) {
      const d = xs[i]! - meanC;
      variance += ws[i]! * d * d;
    }
    return Math.max(0, Math.min(sigma * sigma, maxPopoviciu, variance));
  }

  const shift = Math.min(hi, Math.max(lo, mu));
  const m = mu - shift;
  const a = lo - shift;
  const b = hi - shift;
  const pMid =
    alpha > 0 ? Math.max(0, normalCdfAgg(-alpha) - pHi) : Math.max(0, normalCdfAgg(beta) - pLo);
  const phiA = Math.abs(alpha) < 40 ? invSqrt2Pi * Math.exp(-0.5 * alpha * alpha) : 0;
  const phiB = Math.abs(beta) < 40 ? invSqrt2Pi * Math.exp(-0.5 * beta * beta) : 0;
  const ez = a * pLo + b * pHi + m * pMid - sigma * (phiB - phiA);
  const ez2 =
    a * a * pLo +
    b * b * pHi +
    (m * m + sigma * sigma) * pMid +
    sigma * ((m + a) * phiA - (m + b) * phiB);
  return Math.max(0, Math.min(sigma * sigma, maxPopoviciu, ez2 - ez * ez));
}

export function clampZScore(z: number): number {
  return Math.min(Z_SCORE_MAX, Math.max(Z_SCORE_MIN, z));
}

export function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface ObservedCell {
  configId: string;
  rawModelName: string;
  provider: ProviderId;
  modelSlug: string;
  displayName: string;
  releaseDate: string | null;
  effort: ReasoningEffort;
  harness: HarnessId;
  observedHarness: string | null;
  harnessRegime: HarnessRegime;
  benchmarkId: string;
  benchmarkVersion: string;
  sourceId: string;
  sourceRowId: string;
  rawScore: number;
  seRaw: number | null;
  ciHalfWidth: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  battleCount?: number | null;
  measuredCostUsd: number | null;
  measuredCostEstimated?: boolean;
  fallbackRouting?: boolean;
  refusalRate?: number | null;
  subFeedHealthyAt?: string | null;
  suiteCostUsd: number | null;
  evalDate: string | null;
  publishedDate: string | null;
  sourceUrl: string;
}

export type AggregatedBenchmarkDetail = BenchmarkScoreDetail;

export interface AggregatedConfigResult {
  configId: string;
  provider: ProviderId;
  modelSlug: string;
  displayName: string;
  releaseDate: string | null;
  effort: ReasoningEffort;
  harness: HarnessId;
  harnessRegime: HarnessRegime;
  theta: number;
  shrinkageFactor: number;
  score: number;
  se: number;
  samplingSe: number;
  residualSe: number;
  suiteCostUsd: number | null;
  usesFallbackRouting: boolean;
  coverageCount: number;
  activeBenchmarkCount: number;
  eligibleForFrontier: boolean;
  sumObservedResidual: number;
  missingOlderCount: number;
  benchmarks: AggregatedBenchmarkDetail[];
}

export interface DomainAggregationResult {
  anchorStats: Record<string, AnchorStats>;
  linkJointCov?: LinkJointCov;
  tauResid: number;
  calibrationTauResidSq: number;
  priorMean: number;
  tauModelSq: number;
  coverageFloor: number;
  anchorLabs: number;
  withheldBenchmarkIds: string[];
  eligible: AggregatedConfigResult[];
  provisional: AggregatedConfigResult[];
}

// Upstream CI/SE when published; else distribution-free Popoviciu upper bound over independent parent problems
export function computeMeasurementSe(
  _rawScore: number,
  ciHalfWidth: number | null,
  meta: Pick<BenchmarkMeta, "boundedMax" | "sampleSize" | "outcomeModel" | "isArena">,
  ciLower?: number | null,
  ciUpper?: number | null,
  seRaw?: number | null,
): number | null {
  if (
    ciLower !== undefined &&
    ciLower !== null &&
    ciUpper !== undefined &&
    ciUpper !== null &&
    Number.isFinite(ciLower) &&
    Number.isFinite(ciUpper) &&
    ciUpper > ciLower
  ) {
    return (ciUpper - ciLower) / (2 * 1.96);
  }
  if (seRaw !== undefined && seRaw !== null && Number.isFinite(seRaw) && seRaw > 0) {
    return seRaw;
  }
  if (ciHalfWidth !== null && Number.isFinite(ciHalfWidth) && ciHalfWidth > 0) {
    return ciHalfWidth / 1.96;
  }
  if (
    meta.boundedMax !== null &&
    meta.boundedMax > 0 &&
    meta.sampleSize !== null &&
    meta.sampleSize > 0
  ) {
    return meta.boundedMax / (2 * Math.sqrt(meta.sampleSize));
  }
  return null;
}

export function resolveSeModel(
  ciHalfWidth: number | null,
  ciLower: number | null,
  ciUpper: number | null,
  seRaw?: number | null,
  meta?: Pick<BenchmarkMeta, "boundedMax" | "sampleSize" | "isArena">,
): SeModel {
  if (ciLower !== null && ciUpper !== null && ciUpper > ciLower) {
    return "upstream_ci";
  }
  if (seRaw !== undefined && seRaw !== null && seRaw > 0) {
    return "upstream_se";
  }
  if (ciHalfWidth !== null && ciHalfWidth > 0) {
    return "upstream_ci";
  }
  if (
    !meta ||
    (meta.boundedMax !== null &&
      meta.boundedMax > 0 &&
      meta.sampleSize !== null &&
      meta.sampleSize > 0)
  ) {
    return "popoviciu_upper_bound";
  }
  return "unreported";
}

function orientScore(benchmarkId: string, rawScore: number): number {
  const meta = BENCHMARK_BY_ID[benchmarkId];
  return meta?.invertScore ? -rawScore : rawScore;
}

function weightedMeanAndSd(items: readonly { value: number; weight: number }[]): {
  mean: number;
  sd: number;
} {
  let wSum = 0;
  let wxSum = 0;
  for (const it of items) {
    wSum += it.weight;
    wxSum += it.weight * it.value;
  }
  if (wSum <= 0) return { mean: 0, sd: 0 };
  const mean = wxSum / wSum;
  let wVar = 0;
  for (const it of items) {
    const d = it.value - mean;
    wVar += it.weight * d * d;
  }
  return { mean, sd: Math.sqrt(wVar / wSum) };
}

function computeLabBalancedStats(rows: readonly { provider: ProviderId; value: number }[]): {
  mean: number;
  sd: number;
  labCount: number;
} {
  const countByLab = new Map<ProviderId, number>();
  for (const r of rows) {
    countByLab.set(r.provider, (countByLab.get(r.provider) ?? 0) + 1);
  }
  const weighted = rows.map((r) => ({
    value: r.value,
    weight: 1 / (countByLab.get(r.provider) ?? 1),
  }));
  const { mean, sd } = weightedMeanAndSd(weighted);
  return { mean, sd, labCount: countByLab.size };
}

function computeMeanSigmaParams(
  rows: readonly { provider: ProviderId; benchmarkRaw: number; refTheta: number }[],
): { mean: number; sd: number } | null {
  const bmStats = computeLabBalancedStats(
    rows.map((o) => ({ provider: o.provider, value: o.benchmarkRaw })),
  );
  const refStats = computeLabBalancedStats(
    rows.map((o) => ({ provider: o.provider, value: o.refTheta })),
  );
  if (bmStats.sd <= 1e-6 || refStats.sd <= 1e-6) return null;
  const sd = bmStats.sd / refStats.sd;
  const mean = bmStats.mean - sd * refStats.mean;
  if (!Number.isFinite(mean) || !Number.isFinite(sd) || sd <= 1e-6) return null;
  return { mean, sd };
}

/**
 * Lab-balanced Kolen & Brennan Mean-Sigma linking onto the anchor theta scale,
 * with exact leave-one-out jackknife variance coefficients and per-config influence vectors for z(x) = a + b*x.
 */
export function linkBenchmarkMeanSigma(
  overlap: readonly {
    configId?: string;
    provider: ProviderId;
    benchmarkRaw: number;
    refTheta: number;
  }[],
  minLabs: number,
  requirePositiveAssociation = false,
): {
  mean: number;
  sd: number;
  linked: boolean;
  minProviderCorrelation?: number;
  linkVarIntercept?: number;
  linkVarSlope?: number;
  linkCovIS?: number;
  jackknifeInfluence?: ReadonlyMap<string, readonly [number, number]>;
} {
  const distinctLabs = new Set(overlap.map((o) => o.provider));
  if (overlap.length < 6 || distinctLabs.size < minLabs) {
    return { mean: 0, sd: 0, linked: false };
  }

  const full = computeMeanSigmaParams(overlap);
  if (!full) return { mean: 0, sd: 0, linked: false };

  let minProviderCorrelation = 1;
  if (requirePositiveAssociation) {
    for (const leftOut of [undefined, ...distinctLabs]) {
      const rows = overlap.filter((o) => o.provider !== leftOut);
      const x = computeLabBalancedStats(
        rows.map((o) => ({ provider: o.provider, value: o.benchmarkRaw })),
      );
      const y = computeLabBalancedStats(
        rows.map((o) => ({ provider: o.provider, value: o.refTheta })),
      );
      if (x.sd <= 1e-6 || y.sd <= 1e-6) return { mean: 0, sd: 0, linked: false };
      let sum = 0;
      for (const lab of Map.groupBy(rows, (o) => o.provider).values()) {
        sum +=
          lab.reduce((s, o) => s + (o.benchmarkRaw - x.mean) * (o.refTheta - y.mean), 0) /
          lab.length;
      }
      minProviderCorrelation = Math.min(minProviderCorrelation, sum / (x.labCount * x.sd * y.sd));
    }
    if (!(minProviderCorrelation > 0)) return { mean: 0, sd: 0, linked: false };
  }

  // Leave-one-out jackknife covariance of (a_i = -mean_i / sd_i, b_i = 1 / sd_i) so Var(z(x)) = Va + 2*Cab*x + Vb*x^2
  const jackA: number[] = [];
  const jackB: number[] = [];
  for (let i = 0; i < overlap.length; i++) {
    const sub = overlap.filter((_, idx) => idx !== i);
    const subParams = computeMeanSigmaParams(sub);
    if (!subParams) return { mean: 0, sd: 0, linked: false };
    jackA.push(-subParams.mean / subParams.sd);
    jackB.push(1 / subParams.sd);
  }

  const n = jackA.length;
  const meanA = jackA.reduce((s, v) => s + v, 0) / n;
  const meanB = jackB.reduce((s, v) => s + v, 0) / n;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;
  const factor = (n - 1) / n;
  const sqrtFactor = Math.sqrt(factor);
  const jackknifeInfluence = new Map<string, readonly [number, number]>();
  for (let i = 0; i < n; i++) {
    const da = jackA[i]! - meanA;
    const db = jackB[i]! - meanB;
    sumAA += da * da;
    sumBB += db * db;
    sumAB += da * db;
    const cfgId = overlap[i]?.configId;
    if (cfgId) {
      jackknifeInfluence.set(cfgId, [sqrtFactor * da, sqrtFactor * db]);
    }
  }

  return {
    mean: full.mean,
    sd: full.sd,
    linked: true,
    ...(requirePositiveAssociation ? { minProviderCorrelation } : {}),
    // Keep full IEEE-754 precision so (varI, varS, covIS) always stays strictly positive semi-definite
    linkVarIntercept: factor * sumAA,
    linkVarSlope: factor * sumBB,
    linkCovIS: factor * sumAB,
    ...(jackknifeInfluence.size > 0 ? { jackknifeInfluence } : {}),
  };
}

export interface RaschCell {
  configId: string;
  benchmarkId: string;
  zScore: number;
  measVarZ?: number;
  debiasVarZ?: number;
}

/**
 * Finds connected components of the (config, benchmark) bipartite observation graph.
 */
function findBipartiteComponents(
  cells: readonly RaschCell[],
): { configIds: Set<string>; benchmarkIds: Set<string> }[] {
  const adjConfig = new Map<string, Set<string>>();
  const adjBm = new Map<string, Set<string>>();

  for (const c of cells) {
    const bSet = adjConfig.get(c.configId) ?? new Set<string>();
    bSet.add(c.benchmarkId);
    adjConfig.set(c.configId, bSet);

    const cSet = adjBm.get(c.benchmarkId) ?? new Set<string>();
    cSet.add(c.configId);
    adjBm.set(c.benchmarkId, cSet);
  }

  const visitedConfig = new Set<string>();
  const visitedBm = new Set<string>();
  const components: { configIds: Set<string>; benchmarkIds: Set<string> }[] = [];

  for (const startCfg of adjConfig.keys()) {
    if (visitedConfig.has(startCfg)) continue;
    const compConfigs = new Set<string>();
    const compBms = new Set<string>();
    const q: { type: "c" | "b"; id: string }[] = [{ type: "c", id: startCfg }];
    visitedConfig.add(startCfg);

    while (q.length > 0) {
      const cur = q.shift()!;
      if (cur.type === "c") {
        compConfigs.add(cur.id);
        for (const bmId of adjConfig.get(cur.id) ?? []) {
          if (!visitedBm.has(bmId)) {
            visitedBm.add(bmId);
            q.push({ type: "b", id: bmId });
          }
        }
      } else {
        compBms.add(cur.id);
        for (const cfgId of adjBm.get(cur.id) ?? []) {
          if (!visitedConfig.has(cfgId)) {
            visitedConfig.add(cfgId);
            q.push({ type: "c", id: cfgId });
          }
        }
      }
    }

    components.push({ configIds: compConfigs, benchmarkIds: compBms });
  }

  return components;
}

export function solveLinearSystem(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const aug = matrix.map((row, i) => [...row, rhs[i]!]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotVal = Math.abs(aug[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const cand = Math.abs(aug[r]![col]!);
      if (cand > pivotVal) {
        pivotVal = cand;
        pivotRow = r;
      }
    }
    if (pivotVal < 1e-12) continue;
    if (pivotRow !== col) {
      const tmp = aug[col]!;
      aug[col] = aug[pivotRow]!;
      aug[pivotRow] = tmp;
    }

    const diag = aug[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const factor = aug[r]![col]! / diag;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) {
        aug[r]![c] = aug[r]![c]! - factor * aug[col]![c]!;
      }
    }
  }

  const sol = Array.from({ length: n }, () => 0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = aug[r]![n]!;
    for (let c = r + 1; c < n; c++) {
      sum -= aug[r]![c]! * sol[c]!;
    }
    const diag = aug[r]![r]!;
    sol[r] = Math.abs(diag) > 1e-12 ? sum / diag : 0;
  }
  return sol;
}

function invertSquareMatrix(matrix: readonly (readonly number[])[]): number[][] | null {
  const n = matrix.length;
  if (n === 0) return [];
  const a = matrix.map((row) => [...row]);
  const inv: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (__, j) => (i === j ? 1 : 0)),
  );
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotVal = Math.abs(a[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const cand = Math.abs(a[r]![col]!);
      if (cand > pivotVal) {
        pivotVal = cand;
        pivotRow = r;
      }
    }
    if (pivotVal < 1e-12) return null;
    if (pivotRow !== col) {
      const tmpA = a[col]!;
      a[col] = a[pivotRow]!;
      a[pivotRow] = tmpA;
      const tmpI = inv[col]!;
      inv[col] = inv[pivotRow]!;
      inv[pivotRow] = tmpI;
    }
    const diag = a[col]![col]!;
    for (let c = 0; c < n; c++) {
      a[col]![c] = a[col]![c]! / diag;
      inv[col]![c] = inv[col]![c]! / diag;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      for (let c = 0; c < n; c++) {
        a[r]![c] = a[r]![c]! - factor * a[col]![c]!;
        inv[r]![c] = inv[r]![c]! - factor * inv[col]![c]!;
      }
    }
  }
  return inv;
}

export const UNREPORTED_SE_Z = 1.0;

export function buildWeightMapFromAnchors(
  anchorStats: Readonly<Record<string, AnchorStats>>,
  regime: HarnessRegime,
): Map<string, number> {
  const weights = new Map<string, number>();
  const suffix = regime === "standardized" ? "::standardized" : "";
  for (const [key, st] of Object.entries(anchorStats)) {
    if (regime === "standardized") {
      if (!key.endsWith(suffix)) continue;
      weights.set(key.slice(0, -suffix.length), st.effectiveWeight);
    } else if (!key.includes("::")) {
      weights.set(key, st.effectiveWeight);
    }
  }
  return weights;
}

function effectiveSeAkhtarCalibration(
  rawScore: number,
  ciHalfWidth: number | null,
  meta: BenchmarkMeta,
  ciLower?: number | null,
  ciUpper?: number | null,
  seRaw?: number | null,
): number | null {
  const baseSe = computeMeasurementSe(rawScore, ciHalfWidth, meta, ciLower, ciUpper, seRaw);
  if (baseSe === null || baseSe <= 0) return null;
  const hasUpstreamUncertainty =
    (ciLower !== undefined &&
      ciLower !== null &&
      ciUpper !== undefined &&
      ciUpper !== null &&
      ciUpper > ciLower) ||
    (seRaw !== undefined && seRaw !== null && seRaw > 0) ||
    (ciHalfWidth !== null && ciHalfWidth > 0);
  if (!meta.isArena && !hasUpstreamUncertainty && meta.sampleSize !== null && meta.sampleSize > 1) {
    return baseSe * meta.sampleSize ** 0.25;
  }
  return baseSe;
}

function facingSeBoundsCalibration(
  meta: BenchmarkMeta,
  obs: {
    rawScore: number;
    oriented: number;
    seRaw: number | null;
    ciHalfWidth: number | null;
    ciLower: number | null;
    ciUpper: number | null;
  },
): { seLow: number; seHigh: number } | null {
  if (
    obs.ciLower !== null &&
    obs.ciUpper !== null &&
    Number.isFinite(obs.ciLower) &&
    Number.isFinite(obs.ciUpper) &&
    obs.ciUpper > obs.ciLower
  ) {
    const low = meta.invertScore ? -obs.ciUpper : obs.ciLower;
    const high = meta.invertScore ? -obs.ciLower : obs.ciUpper;
    return {
      seLow: Math.max(0, obs.oriented - low) / 1.96,
      seHigh: Math.max(0, high - obs.oriented) / 1.96,
    };
  }
  const se = computeMeasurementSe(
    obs.rawScore,
    obs.ciHalfWidth,
    meta,
    obs.ciLower,
    obs.ciUpper,
    obs.seRaw,
  );
  if (se === null) return null;
  return { seLow: se, seHigh: se };
}

// Compute data-derived CTT reliability and frontier discrimination weights frozen per MAJOR epoch
export function computeBenchmarkQualityWeight(
  bmId: string,
  bmCells: readonly ObservedCell[],
  minLabs: number,
  useParentSamplingBound = false,
): { reliability: number; discrimination: number; effectiveWeight: number } {
  const meta = BENCHMARK_BY_ID[bmId];
  if (!meta || bmCells.length === 0) {
    return { reliability: 0.5, discrimination: 0.25, effectiveWeight: 0.125 };
  }

  const orientedStats = computeLabBalancedStats(
    bmCells.map((c) => ({ provider: c.provider, value: orientScore(bmId, c.rawScore) })),
  );
  const varObs = orientedStats.sd * orientedStats.sd;

  let wSeSum = 0;
  let wSeSqSum = 0;
  for (const cells of Map.groupBy(bmCells, (c) => c.provider).values()) {
    let known = 0;
    let seSqSum = 0;
    for (const c of cells) {
      const se = computeMeasurementSe(
        c.rawScore,
        c.ciHalfWidth,
        meta,
        c.ciLower,
        c.ciUpper,
        c.seRaw,
      );
      if (se !== null && se > 0) {
        known++;
        seSqSum += se * se;
      }
    }
    wSeSum += known / cells.length;
    wSeSqSum += seSqSum / cells.length;
  }

  // Exact CTT reliability: Var(true) / Var(obs) = max(0.1, (varObs - E[se^2]) / varObs)
  let reliability = 0.5;
  if (wSeSum >= orientedStats.labCount * 0.5 && varObs > 1e-12) {
    const meanSeSq = wSeSqSum / wSeSum;
    reliability = Math.min(1, Math.max(0.1, (varObs - meanSeSq) / varObs));
  }

  const perLabPeak = new Map<
    ProviderId,
    {
      provider: ProviderId;
      configId: string;
      rawScore: number;
      oriented: number;
      seRaw: number | null;
      ciHalfWidth: number | null;
      ciLower: number | null;
      ciUpper: number | null;
      akhtarSe: number | null;
    }
  >();
  const saturationSe = useParentSamplingBound ? computeMeasurementSe : effectiveSeAkhtarCalibration;
  for (const c of bmCells) {
    const oriented = orientScore(bmId, c.rawScore);
    const akhtarSe = saturationSe(c.rawScore, c.ciHalfWidth, meta, c.ciLower, c.ciUpper, c.seRaw);
    const cur = perLabPeak.get(c.provider);
    const beatsTie =
      cur !== undefined &&
      oriented === cur.oriented &&
      ((akhtarSe ?? Number.POSITIVE_INFINITY) < (cur.akhtarSe ?? Number.POSITIVE_INFINITY) ||
        ((akhtarSe ?? Number.POSITIVE_INFINITY) === (cur.akhtarSe ?? Number.POSITIVE_INFINITY) &&
          compareAscii(c.configId, cur.configId) < 0));
    if (!cur || oriented > cur.oriented || beatsTie) {
      perLabPeak.set(c.provider, {
        provider: c.provider,
        configId: c.configId,
        rawScore: c.rawScore,
        oriented,
        seRaw: c.seRaw,
        ciHalfWidth: c.ciHalfWidth,
        ciLower: c.ciLower,
        ciUpper: c.ciUpper,
        akhtarSe,
      });
    }
  }

  const labLeaders = [...perLabPeak.values()].toSorted(
    (a, b) =>
      b.oriented - a.oriented ||
      (a.akhtarSe ?? Number.POSITIVE_INFINITY) - (b.akhtarSe ?? Number.POSITIVE_INFINITY) ||
      compareAscii(a.provider, b.provider),
  );
  let discrimination = 0.25;
  if (labLeaders.length >= minLabs) {
    const top1 = labLeaders[0]!;
    const topLast = labLeaders[minLabs - 1]!;
    const se1 = saturationSe(
      top1.rawScore,
      top1.ciHalfWidth,
      meta,
      top1.ciLower,
      top1.ciUpper,
      top1.seRaw,
    );
    const seLast = saturationSe(
      topLast.rawScore,
      topLast.ciHalfWidth,
      meta,
      topLast.ciLower,
      topLast.ciUpper,
      topLast.seRaw,
    );
    const bounds = labLeaders.map((leader) => facingSeBoundsCalibration(meta, leader));
    if (se1 !== null && seLast !== null && bounds.every((b) => b !== null)) {
      const seDelta = Math.hypot(se1, seLast);
      const spread = Math.max(0, top1.oriented - topLast.oriented);
      const rNorm = seDelta > 1e-9 ? spread / seDelta : 0;
      const satIndex = Math.exp(-(rNorm * rNorm));

      let sepPairs = 0;
      const totalPairs = (labLeaders.length * (labLeaders.length - 1)) / 2;
      for (let i = 0; i < labLeaders.length; i++) {
        for (let j = i + 1; j < labLeaders.length; j++) {
          const hi = labLeaders[i]!;
          const lo = labLeaders[j]!;
          const seHi = bounds[i]!;
          const seLo = bounds[j]!;
          if (hi.oriented - lo.oriented > 1.96 * Math.hypot(seHi.seLow, seLo.seHigh)) {
            sepPairs++;
          }
        }
      }
      const sep = totalPairs > 0 ? sepPairs / totalPairs : 0;
      discrimination = Math.min(1, Math.max(0, (1 - satIndex) * (0.25 + 0.75 * sep)));
    }
  }

  const effectiveWeight = Math.min(1, Math.max(MIN_BENCHMARK_WEIGHT, reliability * discrimination));
  return {
    reliability: Number(reliability.toFixed(4)),
    discrimination: Number(discrimination.toFixed(4)),
    effectiveWeight: Number(effectiveWeight.toFixed(4)),
  };
}

export function solveTwoWayLinearRasch(
  cells: readonly RaschCell[],
  frozenDeltas?: ReadonlyMap<string, number>,
  weightByBenchmark?: ReadonlyMap<string, number>,
): {
  thetaByConfig: Map<string, number>;
  thetaVarByConfig: Map<string, number>;
  deltaByBenchmark: Map<string, number>;
  deltaCovByBenchmark: {
    freeBenchmarks: readonly string[];
    covMatrix: readonly (readonly number[])[];
  } | null;
  tauResidSq: number;
  weightedDf: number;
  tauResidIdentified: boolean;
  droppedConfigIds: Set<string>;
} {
  const weightOf = (bmId: string): number => {
    const w = weightByBenchmark?.get(bmId);
    return w !== undefined && Number.isFinite(w) && w > 0 ? w : 1;
  };
  const components = findBipartiteComponents(cells);
  const droppedConfigIds = new Set<string>();

  // Keep only components bridged by frozen anchors, or the single largest connected component during calibration
  let keptCells = cells;
  if (components.length > 1) {
    const anchoredComponents = components.filter((comp) =>
      [...comp.benchmarkIds].some((bmId) => frozenDeltas?.has(bmId)),
    );
    const minId = (set: Set<string>): string => [...set].toSorted(compareAscii)[0] ?? "";
    const chosen =
      anchoredComponents.length > 0
        ? anchoredComponents
        : [
            components.toSorted(
              (a, b) =>
                b.benchmarkIds.size - a.benchmarkIds.size ||
                b.configIds.size - a.configIds.size ||
                compareAscii(minId(a.benchmarkIds), minId(b.benchmarkIds)) ||
                compareAscii(minId(a.configIds), minId(b.configIds)),
            )[0]!,
          ];
    const keptConfigs = new Set<string>();
    for (const comp of chosen) {
      for (const id of comp.configIds) keptConfigs.add(id);
    }
    for (const c of cells) {
      if (!keptConfigs.has(c.configId)) droppedConfigIds.add(c.configId);
    }
    keptCells = cells.filter((c) => keptConfigs.has(c.configId));
  }

  const byConfig = new Map<string, RaschCell[]>();
  const byBenchmark = new Map<string, RaschCell[]>();

  for (const cell of keptCells) {
    const cList = byConfig.get(cell.configId) ?? [];
    cList.push(cell);
    byConfig.set(cell.configId, cList);

    const bList = byBenchmark.get(cell.benchmarkId) ?? [];
    bList.push(cell);
    byBenchmark.set(cell.benchmarkId, bList);
  }

  const thetaByConfig = new Map<string, number>();
  const deltaByBenchmark = new Map<string, number>();

  for (const bmId of byBenchmark.keys()) {
    deltaByBenchmark.set(bmId, frozenDeltas?.get(bmId) ?? 0);
  }

  const freeBenchmarks = [...byBenchmark.keys()].filter((bmId) => !frozenDeltas?.has(bmId));
  const keptComponents = findBipartiteComponents(keptCells);
  const unanchoredComponents = keptComponents.filter(
    (comp) => ![...comp.benchmarkIds].some((bmId) => frozenDeltas?.has(bmId)),
  );

  // Exact weighted Schur-complement normal equations eliminate theta analytically and solve free deltas directly
  let freeIndex = new Map<string, number>();
  let schurInv: number[][] | null = null;
  if (freeBenchmarks.length > 0) {
    const fCount = freeBenchmarks.length;
    freeIndex = new Map<string, number>(freeBenchmarks.map((id, idx) => [id, idx]));
    const mat: number[][] = Array.from({ length: fCount }, () =>
      Array.from({ length: fCount }, () => 0),
    );
    const rhs = Array.from({ length: fCount }, () => 0);

    for (const list of byConfig.values()) {
      let totalW = 0;
      let sumWZ = 0;
      let sumWFixedDelta = 0;
      for (const c of list) {
        const w = weightOf(c.benchmarkId);
        totalW += w;
        sumWZ += w * c.zScore;
        if (!freeIndex.has(c.benchmarkId)) {
          sumWFixedDelta += w * (deltaByBenchmark.get(c.benchmarkId) ?? 0);
        }
      }
      if (totalW <= 0) continue;
      const meanZ = sumWZ / totalW;
      const fixedShift = sumWFixedDelta / totalW;

      for (const ci of list) {
        const u = freeIndex.get(ci.benchmarkId);
        if (u === undefined) continue;
        const wu = weightOf(ci.benchmarkId);
        mat[u]![u] = mat[u]![u]! + wu;
        rhs[u] = rhs[u]! + wu * (ci.zScore - meanZ + fixedShift);
        for (const cj of list) {
          const v = freeIndex.get(cj.benchmarkId);
          if (v === undefined) continue;
          const wv = weightOf(cj.benchmarkId);
          mat[u]![v] = mat[u]![v]! - (wu * wv) / totalW;
        }
      }
    }

    // Weighted rank-1 gauge projection forces sum(w_b * delta_b) = 0 on every unanchored component
    for (const comp of unanchoredComponents) {
      const idxs = [...comp.benchmarkIds]
        .map((id) => ({ idx: freeIndex.get(id), w: weightOf(id) }))
        .filter((entry): entry is { idx: number; w: number } => entry.idx !== undefined);
      for (const a of idxs) {
        for (const b of idxs) {
          mat[a.idx]![b.idx] = mat[a.idx]![b.idx]! + a.w * b.w;
        }
      }
    }

    const solvedDeltas = solveLinearSystem(mat, rhs);
    for (let i = 0; i < fCount; i++) {
      deltaByBenchmark.set(freeBenchmarks[i]!, solvedDeltas[i]!);
    }
    schurInv = invertSquareMatrix(mat);
  }

  for (const [cfgId, list] of byConfig.entries()) {
    let sumW = 0;
    let sumWAdj = 0;
    for (const c of list) {
      const w = weightOf(c.benchmarkId);
      sumW += w;
      sumWAdj += w * (c.zScore - (deltaByBenchmark.get(c.benchmarkId) ?? 0));
    }
    thetaByConfig.set(cfgId, sumW > 0 ? sumWAdj / sumW : 0);
  }

  // Exact unbiased weighted-projection interaction variance subtracting diagonal sampling-error trace
  let weightedSse = 0;
  let weightedDf = 0;
  let weightedMeasTrace = 0;
  const fCount = freeBenchmarks.length;
  for (const [cfgId, list] of byConfig.entries()) {
    let totalW = 0;
    for (const c of list) totalW += weightOf(c.benchmarkId);
    if (totalW <= 0) continue;
    const cfgTheta = thetaByConfig.get(cfgId) ?? 0;

    for (const cell of list) {
      const wb = weightOf(cell.benchmarkId);
      const pred = cfgTheta + (deltaByBenchmark.get(cell.benchmarkId) ?? 0);
      const resid = cell.zScore - pred;
      weightedSse += wb * resid * resid;

      let leverage = wb / totalW;
      if (schurInv !== null && fCount > 0) {
        const q = Array.from({ length: fCount }, () => 0);
        for (const cj of list) {
          const u = freeIndex.get(cj.benchmarkId);
          if (u !== undefined) q[u] = q[u]! - weightOf(cj.benchmarkId) / totalW;
        }
        const bIdx = freeIndex.get(cell.benchmarkId);
        if (bIdx !== undefined) q[bIdx] = q[bIdx]! + 1;
        let quad = 0;
        for (let u = 0; u < fCount; u++) {
          const qu = q[u]!;
          if (qu === 0) continue;
          const row = schurInv[u]!;
          for (let v = 0; v < fCount; v++) {
            const qv = q[v]!;
            if (qv !== 0) quad += qu * row[v]! * qv;
          }
        }
        leverage += wb * quad;
      }
      const diagProj = wb * Math.max(0, 1 - leverage);
      weightedDf += diagProj;
      const debiasVar = cell.debiasVarZ !== undefined ? cell.debiasVarZ : cell.measVarZ;
      if (debiasVar !== undefined && Number.isFinite(debiasVar) && debiasVar > 0) {
        weightedMeasTrace += diagProj * debiasVar;
      }
    }
  }

  const tauResidIdentified = weightedDf > 1e-6;
  const tauResidSq = tauResidIdentified
    ? Math.max(0, (weightedSse - weightedMeasTrace) / weightedDf)
    : 0;

  // Exact analytical Gauss-Markov sampling variance of theta_h including estimated free benchmark offset uncertainty
  const thetaVarByConfig = new Map<string, number>();
  const configWeightSums = new Map<string, number>();
  for (const [cfgId, list] of byConfig.entries()) {
    let wSum = 0;
    for (const c of list) wSum += weightOf(c.benchmarkId);
    configWeightSums.set(cfgId, wSum);
  }
  const hasAnyMeasVar = keptCells.some(
    (c) => c.measVarZ !== undefined && Number.isFinite(c.measVarZ) && c.measVarZ > 0,
  );
  if (hasAnyMeasVar) {
    for (const [targetId, targetList] of byConfig.entries()) {
      const wTarget = configWeightSums.get(targetId) ?? 0;
      if (wTarget <= 0) {
        thetaVarByConfig.set(targetId, 0);
        continue;
      }
      const aVec = Array.from({ length: fCount }, () => 0);
      if (schurInv !== null && fCount > 0) {
        const uVec = Array.from({ length: fCount }, () => 0);
        for (const c of targetList) {
          const u = freeIndex.get(c.benchmarkId);
          if (u !== undefined) uVec[u] = uVec[u]! + weightOf(c.benchmarkId) / wTarget;
        }
        for (let r = 0; r < fCount; r++) {
          let sum = 0;
          const row = schurInv[r]!;
          for (let col = 0; col < fCount; col++) sum += row[col]! * uVec[col]!;
          aVec[r] = sum;
        }
      }
      let varSum = 0;
      for (const [srcId, srcList] of byConfig.entries()) {
        const wSrc = configWeightSums.get(srcId) ?? 0;
        if (wSrc <= 0) continue;
        let barA = 0;
        if (schurInv !== null && fCount > 0) {
          for (const c of srcList) {
            const u = freeIndex.get(c.benchmarkId);
            if (u !== undefined) barA += weightOf(c.benchmarkId) * aVec[u]!;
          }
          barA /= wSrc;
        }
        for (const c of srcList) {
          if (c.measVarZ === undefined || !Number.isFinite(c.measVarZ) || c.measVarZ <= 0) continue;
          const wb = weightOf(c.benchmarkId);
          const u = freeIndex.get(c.benchmarkId);
          const aB = u !== undefined ? aVec[u]! : 0;
          const direct = srcId === targetId ? wb / wTarget : 0;
          const offsetTerm = schurInv !== null && fCount > 0 ? wb * (aB - barA) : 0;
          const sens = direct - offsetTerm;
          varSum += sens * sens * c.measVarZ;
        }
      }
      thetaVarByConfig.set(targetId, Math.max(0, varSum));
    }
  }

  // Exact scale-invariant constrained-subspace Gauss-Markov sandwich: Cov(delta_hat) = tauResidSq * M^-1 * (A * A^T) * M^-1
  let deltaCovByBenchmark: {
    freeBenchmarks: readonly string[];
    covMatrix: readonly (readonly number[])[];
  } | null = null;
  if (schurInv !== null && fCount > 0) {
    const aat: number[][] = Array.from({ length: fCount }, () =>
      Array.from({ length: fCount }, () => 0),
    );
    for (const list of byConfig.values()) {
      let totalW = 0;
      let sumW2 = 0;
      for (const c of list) {
        const w = weightOf(c.benchmarkId);
        totalW += w;
        sumW2 += w * w;
      }
      if (totalW <= 0) continue;
      const meanW2Ratio = sumW2 / (totalW * totalW);
      for (const ci of list) {
        const u = freeIndex.get(ci.benchmarkId);
        if (u === undefined) continue;
        const wu = weightOf(ci.benchmarkId);
        for (const cj of list) {
          const v = freeIndex.get(cj.benchmarkId);
          if (v === undefined) continue;
          const wv = weightOf(cj.benchmarkId);
          const coeff = (u === v ? 1 : 0) - (wu + wv) / totalW + meanW2Ratio;
          aat[u]![v] = aat[u]![v]! + wu * wv * coeff;
        }
      }
    }
    const tmp: number[][] = Array.from({ length: fCount }, () =>
      Array.from({ length: fCount }, () => 0),
    );
    for (let i = 0; i < fCount; i++) {
      const invRow = schurInv[i]!;
      for (let k = 0; k < fCount; k++) {
        const a = invRow[k]!;
        if (a === 0) continue;
        const aatRow = aat[k]!;
        for (let j = 0; j < fCount; j++) {
          tmp[i]![j] = tmp[i]![j]! + a * aatRow[j]!;
        }
      }
    }
    const covMat: number[][] = Array.from({ length: fCount }, () =>
      Array.from({ length: fCount }, () => 0),
    );
    for (let i = 0; i < fCount; i++) {
      for (let j = i; j < fCount; j++) {
        let sum = 0;
        for (let k = 0; k < fCount; k++) {
          sum += tmp[i]![k]! * schurInv[k]![j]!;
        }
        const scaled = sum * tauResidSq;
        covMat[i]![j] = scaled;
        covMat[j]![i] = scaled;
      }
    }
    deltaCovByBenchmark = {
      freeBenchmarks: [...freeBenchmarks],
      covMatrix: covMat,
    };
  }

  return {
    thetaByConfig,
    thetaVarByConfig,
    deltaByBenchmark,
    deltaCovByBenchmark,
    tauResidSq,
    weightedDf,
    tauResidIdentified,
    droppedConfigIds,
  };
}

export interface RemlLinkTerm {
  benchmarkId: string;
  interceptCoeff: number;
  slopeCoeff: number;
  linkVarIntercept: number;
  linkVarSlope: number;
  linkCovIS: number;
}

export interface RemlPriorPoint {
  thetaMle: number;
  totalVar: number;
  provider?: ProviderId;
  modelSlug?: string;
  residCoeffs?: readonly number[];
  linkTerms?: readonly RemlLinkTerm[];
}

export function buildRemlLinkTerms(
  benchmarks: readonly Pick<BenchmarkScoreDetail, "benchmarkId" | "rawScore">[],
  anchorStats: Readonly<Record<string, AnchorStats>>,
  regime: HarnessRegime,
  orientOverrides?: ReadonlyMap<string, 1 | -1>,
): RemlLinkTerm[] {
  const keyFor = (bmId: string) => (regime === "standardized" ? `${bmId}::standardized` : bmId);
  let sumW = 0;
  for (const bm of benchmarks) {
    const w = anchorStats[keyFor(bm.benchmarkId)]?.effectiveWeight ?? 0;
    if (w > 0) sumW += w;
  }
  if (!(sumW > 0)) return [];

  const terms: RemlLinkTerm[] = [];
  for (const bm of benchmarks) {
    const st = anchorStats[keyFor(bm.benchmarkId)];
    if (
      !st?.linkedViaMeanSigma ||
      !(st.effectiveWeight > 0) ||
      st.linkVarIntercept === undefined ||
      st.linkVarSlope === undefined ||
      st.linkCovIS === undefined
    ) {
      continue;
    }
    const sign = orientOverrides?.get(bm.benchmarkId) ?? (st.invertScore ? -1 : 1);
    const oriented = sign * bm.rawScore;
    const share = st.effectiveWeight / sumW;
    terms.push({
      benchmarkId: bm.benchmarkId,
      interceptCoeff: share,
      slopeCoeff: share * oriented,
      linkVarIntercept: st.linkVarIntercept,
      linkVarSlope: st.linkVarSlope,
      linkCovIS: st.linkCovIS,
    });
  }
  return terms;
}

// Build exact finite-roster residual basis vector scaled by sqrt(tauResidSq) matching stepSignificance & bootstrap Pareto covariance
export function buildResidCoeffs(
  observedIds: ReadonlySet<string>,
  calibratedIds: readonly string[],
  anchorStats: Readonly<Record<string, AnchorStats>>,
  regime: HarnessRegime,
  calibrationTauResidSq: number,
): number[] {
  const keyFor = (bmId: string) => (regime === "standardized" ? `${bmId}::standardized` : bmId);
  let totalW = 0;
  let obsW = 0;
  for (const bmId of calibratedIds) {
    const w = anchorStats[keyFor(bmId)]?.effectiveWeight ?? 0;
    if (!(w > 0)) continue;
    totalW += w;
    if (observedIds.has(bmId)) obsW += w;
  }
  const scale = Math.sqrt(Math.max(0, calibrationTauResidSq));
  if (totalW <= 0 || obsW <= 0 || scale <= 0) return calibratedIds.map(() => 0);
  return calibratedIds.map((bmId) => {
    const w = anchorStats[keyFor(bmId)]?.effectiveWeight ?? 0;
    if (!(w > 0)) return 0;
    return scale * ((observedIds.has(bmId) ? w / obsW : 0) - w / totalW);
  });
}

function choleskyBlockFactor(
  mat: readonly (readonly number[])[],
): { L: number[][]; logDet: number } | null {
  const n = mat.length;
  const L: number[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
  let logDet = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = mat[i]![j]!;
      for (let k = 0; k < j; k++) sum -= L[i]![k]! * L[j]![k]!;
      if (i === j) {
        if (!(sum > 1e-12)) return null;
        const diag = Math.sqrt(sum);
        L[i]![i] = diag;
        logDet += 2 * Math.log(diag);
      } else {
        L[i]![j] = sum / L[j]![j]!;
      }
    }
  }
  return { L, logDet };
}

function solveLowerTriangular(L: readonly (readonly number[])[], rhs: readonly number[]): number[] {
  const n = rhs.length;
  const out = Array.from({ length: n }, () => 0);
  for (let i = 0; i < n; i++) {
    let s = rhs[i]!;
    for (let k = 0; k < i; k++) s -= L[i]![k]! * out[k]!;
    out[i] = s / L[i]![i]!;
  }
  return out;
}

// Positive-semidefinite Cholesky factor L (L * L^T = mat) keeping only non-zero factor columns
export function factorJointLinkCovariance(
  linkJointCov?: LinkJointCov | null,
): { bmIndex: Map<string, number>; factor: number[][]; rank: number } | null {
  if (!linkJointCov || linkJointCov.benchmarkIds.length === 0) return null;
  const dim = linkJointCov.benchmarkIds.length * 2;
  if (linkJointCov.covMatrix.length !== dim) return null;
  const fullL: number[][] = Array.from({ length: dim }, () => Array.from({ length: dim }, () => 0));
  for (let i = 0; i < dim; i++) {
    const rowI = linkJointCov.covMatrix[i];
    if (!rowI || rowI.length !== dim) return null;
    for (let j = 0; j <= i; j++) {
      let sum = rowI[j]!;
      for (let k = 0; k < j; k++) sum -= fullL[i]![k]! * fullL[j]![k]!;
      if (i === j) {
        fullL[i]![i] = sum > 1e-14 ? Math.sqrt(sum) : 0;
      } else {
        fullL[i]![j] = fullL[j]![j]! > 1e-14 ? sum / fullL[j]![j]! : 0;
      }
    }
  }
  const activeCols: number[] = [];
  for (let col = 0; col < dim; col++) {
    let normSq = 0;
    for (let r = col; r < dim; r++) normSq += fullL[r]![col]! * fullL[r]![col]!;
    if (normSq > 1e-14) activeCols.push(col);
  }
  if (activeCols.length === 0) return null;
  const bmIndex = new Map<string, number>(linkJointCov.benchmarkIds.map((id, idx) => [id, idx]));
  const factor = fullL.map((row) => activeCols.map((c) => row[c]!));
  return { bmIndex, factor, rank: activeCols.length };
}

// Compute exact quadratic link variance/covariance between two sets of weighted benchmark link terms
export function computeJointLinkCovariance(
  termsA: readonly Pick<
    RemlLinkTerm,
    | "benchmarkId"
    | "interceptCoeff"
    | "slopeCoeff"
    | "linkVarIntercept"
    | "linkVarSlope"
    | "linkCovIS"
  >[],
  termsB: readonly Pick<
    RemlLinkTerm,
    | "benchmarkId"
    | "interceptCoeff"
    | "slopeCoeff"
    | "linkVarIntercept"
    | "linkVarSlope"
    | "linkCovIS"
  >[],
  linkJointCov?: LinkJointCov | null,
): number {
  if (termsA.length === 0 || termsB.length === 0) return 0;
  if (linkJointCov && linkJointCov.benchmarkIds.length > 0) {
    const dim = linkJointCov.benchmarkIds.length * 2;
    if (linkJointCov.covMatrix.length === dim) {
      const idxByBm = new Map<string, number>(
        linkJointCov.benchmarkIds.map((id, idx) => [id, idx]),
      );
      const vecA = new Float64Array(dim);
      const vecB = new Float64Array(dim);
      let anyCovered = false;
      for (const t of termsA) {
        const bi = idxByBm.get(t.benchmarkId);
        if (bi !== undefined) {
          vecA[2 * bi] = vecA[2 * bi]! + t.interceptCoeff;
          vecA[2 * bi + 1] = vecA[2 * bi + 1]! + t.slopeCoeff;
          anyCovered = true;
        }
      }
      for (const t of termsB) {
        const bi = idxByBm.get(t.benchmarkId);
        if (bi !== undefined) {
          vecB[2 * bi] = vecB[2 * bi]! + t.interceptCoeff;
          vecB[2 * bi + 1] = vecB[2 * bi + 1]! + t.slopeCoeff;
        }
      }
      let quad = 0;
      if (anyCovered) {
        for (let r = 0; r < dim; r++) {
          const ar = vecA[r]!;
          if (ar === 0) continue;
          const covRow = linkJointCov.covMatrix[r]!;
          for (let c = 0; c < dim; c++) {
            const bc = vecB[c]!;
            if (bc !== 0) quad += ar * covRow[c]! * bc;
          }
        }
      }
      // Fallback block-diagonal for any linked benchmark omitted from linkJointCov
      const byBmB = new Map<string, (typeof termsB)[number]>();
      for (const t of termsB) {
        if (!idxByBm.has(t.benchmarkId)) byBmB.set(t.benchmarkId, t);
      }
      for (const tA of termsA) {
        if (idxByBm.has(tA.benchmarkId)) continue;
        const tB = byBmB.get(tA.benchmarkId);
        if (!tB) continue;
        quad +=
          tA.interceptCoeff * tB.interceptCoeff * tA.linkVarIntercept +
          (tA.interceptCoeff * tB.slopeCoeff + tA.slopeCoeff * tB.interceptCoeff) * tA.linkCovIS +
          tA.slopeCoeff * tB.slopeCoeff * tA.linkVarSlope;
      }
      return quad;
    }
  }

  const byBmB = new Map<string, (typeof termsB)[number]>();
  for (const t of termsB) byBmB.set(t.benchmarkId, t);
  let cov = 0;
  for (const tA of termsA) {
    const tB = byBmB.get(tA.benchmarkId);
    if (!tB) continue;
    cov +=
      tA.interceptCoeff * tB.interceptCoeff * tA.linkVarIntercept +
      (tA.interceptCoeff * tB.slopeCoeff + tA.slopeCoeff * tB.interceptCoeff) * tA.linkCovIS +
      tA.slopeCoeff * tB.slopeCoeff * tA.linkVarSlope;
  }
  return cov;
}

// Global-maximum heteroscedastic REML estimator propagating both provider residual blocks and cross-provider shared Mean-Sigma link covariance via Woodbury
export function fitHeteroscedasticRemlPrior(
  points: readonly RemlPriorPoint[],
  linkJointCov?: LinkJointCov | null,
): {
  priorMean: number;
  tauModelSq: number;
} {
  if (points.length < 6) {
    return { priorMean: 0, tauModelSq: 1.0 };
  }

  const nPts = points.length;
  // Build low-rank cross-provider link factor U (N x r) using joint jackknife covariance across overlapping linked benchmarks
  const jointFactor = factorJointLinkCovariance(linkJointCov);
  const coveredByJoint = new Set<string>(jointFactor ? jointFactor.bmIndex.keys() : []);
  const fallbackSpecByBm = new Map<string, { l00: number; l10: number; l11: number }>();
  for (const p of points) {
    if (!p.linkTerms) continue;
    for (const t of p.linkTerms) {
      if (coveredByJoint.has(t.benchmarkId) || fallbackSpecByBm.has(t.benchmarkId)) continue;
      const l00 = Math.sqrt(Math.max(0, t.linkVarIntercept));
      const l10 = l00 > 1e-12 ? t.linkCovIS / l00 : 0;
      const l11 = Math.sqrt(Math.max(0, t.linkVarSlope - l10 * l10));
      if (l00 > 1e-12 || l11 > 1e-12) {
        fallbackSpecByBm.set(t.benchmarkId, { l00, l10, l11 });
      }
    }
  }
  const fallbackBmIds = [...fallbackSpecByBm.keys()].toSorted(compareAscii);
  const fallbackColOffset = new Map<string, { c0: number; c1: number }>();
  let linkRank = jointFactor?.rank ?? 0;
  for (const bmId of fallbackBmIds) {
    const sp = fallbackSpecByBm.get(bmId)!;
    const c0 = sp.l00 > 1e-12 || Math.abs(sp.l10) > 1e-12 ? linkRank++ : -1;
    const c1 = sp.l11 > 1e-12 ? linkRank++ : -1;
    fallbackColOffset.set(bmId, { c0, c1 });
  }

  const uRows: number[][] = Array.from({ length: nPts }, () =>
    Array.from({ length: linkRank }, () => 0),
  );
  const ownLinkVar = new Float64Array(nPts);
  if (linkRank > 0) {
    for (let i = 0; i < nPts; i++) {
      const terms = points[i]!.linkTerms;
      if (!terms) continue;
      const u = uRows[i]!;
      for (const t of terms) {
        const jIdx = jointFactor?.bmIndex.get(t.benchmarkId);
        if (jointFactor && jIdx !== undefined) {
          const rowA = jointFactor.factor[2 * jIdx]!;
          const rowS = jointFactor.factor[2 * jIdx + 1]!;
          for (let c = 0; c < jointFactor.rank; c++) {
            u[c] = u[c]! + t.interceptCoeff * rowA[c]! + t.slopeCoeff * rowS[c]!;
          }
          continue;
        }
        const sp = fallbackSpecByBm.get(t.benchmarkId);
        const cols = fallbackColOffset.get(t.benchmarkId);
        if (!sp || !cols) continue;
        if (cols.c0 >= 0) {
          u[cols.c0] = u[cols.c0]! + t.interceptCoeff * sp.l00 + t.slopeCoeff * sp.l10;
        }
        if (cols.c1 >= 0) {
          u[cols.c1] = u[cols.c1]! + t.slopeCoeff * sp.l11;
        }
      }
      let lv = 0;
      for (let c = 0; c < linkRank; c++) lv += u[c]! * u[c]!;
      ownLinkVar[i] = lv;
    }
  }

  const hasBlockCov = points.every(
    (p) => p.provider !== undefined && p.modelSlug !== undefined && p.residCoeffs !== undefined,
  );

  const blocks: { y: number[]; baseCov: number[][]; uCols: number[][] }[] = [];
  if (hasBlockCov) {
    const byProv = new Map<ProviderId, number[]>();
    for (let i = 0; i < nPts; i++) {
      const prov = points[i]!.provider!;
      const list = byProv.get(prov) ?? [];
      list.push(i);
      byProv.set(prov, list);
    }
    for (const idxs of byProv.values()) {
      const m = idxs.length;
      const baseCov: number[][] = Array.from({ length: m }, () =>
        Array.from({ length: m }, () => 0),
      );
      for (let i = 0; i < m; i++) {
        const idxI = idxs[i]!;
        const pi = points[idxI]!;
        baseCov[i]![i] = Math.max(0, pi.totalVar - ownLinkVar[idxI]!);
        const ci = pi.residCoeffs!;
        for (let j = i + 1; j < m; j++) {
          const idxJ = idxs[j]!;
          const pj = points[idxJ]!;
          const cj = pj.residCoeffs!;
          const rho = pi.modelSlug === pj.modelSlug ? 0.5 : 0.1;
          let dot = 0;
          const len = Math.min(ci.length, cj.length);
          for (let k = 0; k < len; k++) dot += ci[k]! * cj[k]!;
          const cov = rho * dot;
          baseCov[i]![j] = cov;
          baseCov[j]![i] = cov;
        }
      }
      const uCols: number[][] = Array.from({ length: linkRank }, (_, c) =>
        idxs.map((idx) => uRows[idx]![c]!),
      );
      blocks.push({ y: idxs.map((idx) => points[idx]!.thetaMle), baseCov, uCols });
    }
  }

  const evalReml = (tau2: number): { logLik: number; mu: number } => {
    let logDetD = 0;
    let oneD1 = 0;
    let oneDy = 0;
    let yDy = 0;
    const uD1 = Array.from({ length: linkRank }, () => 0);
    const uDy = Array.from({ length: linkRank }, () => 0);
    const uDu: number[][] = Array.from({ length: linkRank }, () =>
      Array.from({ length: linkRank }, () => 0),
    );

    if (!hasBlockCov) {
      for (let i = 0; i < nPts; i++) {
        const v = tau2 + Math.max(0, points[i]!.totalVar - ownLinkVar[i]!);
        if (!(v > 1e-12)) return { logLik: Number.NEGATIVE_INFINITY, mu: 0 };
        logDetD += Math.log(v);
        const w = 1 / v;
        const yi = points[i]!.thetaMle;
        oneD1 += w;
        oneDy += w * yi;
        yDy += w * yi * yi;
        if (linkRank > 0) {
          const ui = uRows[i]!;
          for (let a = 0; a < linkRank; a++) {
            const ua = ui[a]!;
            if (ua === 0) continue;
            uD1[a] = uD1[a]! + w * ua;
            uDy[a] = uDy[a]! + w * ua * yi;
            for (let b = a; b < linkRank; b++) {
              const ub = ui[b]!;
              if (ub !== 0) uDu[a]![b] = uDu[a]![b]! + w * ua * ub;
            }
          }
        }
      }
    } else {
      for (const blk of blocks) {
        const m = blk.y.length;
        const vMat: number[][] = Array.from({ length: m }, (_, i) =>
          Array.from({ length: m }, (__, j) => blk.baseCov[i]![j]! + (i === j ? tau2 : 0)),
        );
        const fac = choleskyBlockFactor(vMat);
        if (!fac) return { logLik: Number.NEGATIVE_INFINITY, mu: 0 };
        logDetD += fac.logDet;
        const zOne = solveLowerTriangular(
          fac.L,
          Array.from({ length: m }, () => 1),
        );
        const zY = solveLowerTriangular(fac.L, blk.y);
        for (let i = 0; i < m; i++) {
          oneD1 += zOne[i]! * zOne[i]!;
          oneDy += zOne[i]! * zY[i]!;
          yDy += zY[i]! * zY[i]!;
        }
        if (linkRank > 0) {
          const zU: number[][] = blk.uCols.map((col) => solveLowerTriangular(fac.L, col));
          for (let a = 0; a < linkRank; a++) {
            const za = zU[a]!;
            let d1 = 0;
            let dy = 0;
            for (let i = 0; i < m; i++) {
              d1 += za[i]! * zOne[i]!;
              dy += za[i]! * zY[i]!;
            }
            uD1[a] = uD1[a]! + d1;
            uDy[a] = uDy[a]! + dy;
            for (let b = a; b < linkRank; b++) {
              const zb = zU[b]!;
              let dab = 0;
              for (let i = 0; i < m; i++) dab += za[i]! * zb[i]!;
              uDu[a]![b] = uDu[a]![b]! + dab;
            }
          }
        }
      }
    }

    let logDetV = logDetD;
    let oneInvOne = oneD1;
    let oneInvY = oneDy;
    let yInvY = yDy;
    if (linkRank > 0) {
      const capMat: number[][] = Array.from({ length: linkRank }, (_, a) =>
        Array.from({ length: linkRank }, (__, b) => {
          const val = a <= b ? uDu[a]![b]! : uDu[b]![a]!;
          return a === b ? 1 + val : val;
        }),
      );
      const capFac = choleskyBlockFactor(capMat);
      if (!capFac) return { logLik: Number.NEGATIVE_INFINITY, mu: 0 };
      logDetV += capFac.logDet;
      const wOne = solveLowerTriangular(capFac.L, uD1);
      const wY = solveLowerTriangular(capFac.L, uDy);
      for (let a = 0; a < linkRank; a++) {
        oneInvOne -= wOne[a]! * wOne[a]!;
        oneInvY -= wOne[a]! * wY[a]!;
        yInvY -= wY[a]! * wY[a]!;
      }
    }

    if (!(oneInvOne > 1e-12)) return { logLik: Number.NEGATIVE_INFINITY, mu: 0 };
    const mu = oneInvY / oneInvOne;
    const quad = Math.max(0, yInvY - mu * oneInvY);
    return { logLik: -0.5 * (logDetV + Math.log(oneInvOne) + quad), mu };
  };

  // Evaluate dense log-spaced grid and refine every local peak plus both endpoints to guarantee the global maximum
  const GRID_N = 120;
  const logMin = Math.log(TAU_MODEL_SQ_MIN);
  const logMax = Math.log(TAU_MODEL_SQ_MAX);
  const gridVals: number[] = [];
  const gridLiks: number[] = [];
  for (let i = 0; i <= GRID_N; i++) {
    const t2 = Math.exp(logMin + ((logMax - logMin) * i) / GRID_N);
    gridVals.push(t2);
    gridLiks.push(evalReml(t2).logLik);
  }

  const candidateBrackets: [number, number][] = [];
  for (let i = 0; i <= GRID_N; i++) {
    const cur = gridLiks[i]!;
    const left = i > 0 ? gridLiks[i - 1]! : Number.NEGATIVE_INFINITY;
    const right = i < GRID_N ? gridLiks[i + 1]! : Number.NEGATIVE_INFINITY;
    if (i === 0 || i === GRID_N || (cur >= left && cur >= right)) {
      candidateBrackets.push([gridVals[Math.max(0, i - 1)]!, gridVals[Math.min(GRID_N, i + 1)]!]);
    }
  }

  const invPhi = (Math.sqrt(5) - 1) / 2;
  let bestTau2 = TAU_MODEL_SQ_MIN;
  let bestEval = evalReml(TAU_MODEL_SQ_MIN);
  const endpointMax = evalReml(TAU_MODEL_SQ_MAX);
  if (endpointMax.logLik > bestEval.logLik) {
    bestTau2 = TAU_MODEL_SQ_MAX;
    bestEval = endpointMax;
  }

  for (const [loInit, hiInit] of candidateBrackets) {
    let a = loInit;
    let b = hiInit;
    let c = b - invPhi * (b - a);
    let d = a + invPhi * (b - a);
    let fc = evalReml(c).logLik;
    let fd = evalReml(d).logLik;
    for (let iter = 0; iter < 40; iter++) {
      if (fc < fd) {
        a = c;
        c = d;
        fc = fd;
        d = a + invPhi * (b - a);
        fd = evalReml(d).logLik;
      } else {
        b = d;
        d = c;
        fd = fc;
        c = b - invPhi * (b - a);
        fc = evalReml(c).logLik;
      }
    }
    const mid = Math.min(TAU_MODEL_SQ_MAX, Math.max(TAU_MODEL_SQ_MIN, (a + b) / 2));
    const ev = evalReml(mid);
    if (ev.logLik > bestEval.logLik) {
      bestTau2 = mid;
      bestEval = ev;
    }
  }

  return {
    priorMean: Number(Math.min(2, Math.max(-2, bestEval.mu)).toFixed(6)),
    tauModelSq: Number(bestTau2.toFixed(6)),
  };
}

export interface ConfigPosteriorResult {
  thetaMle: number;
  fpcTerm: number;
  measTerm: number;
  shrinkageFactor: number;
  theta: number;
  se: number;
  samplingSe: number;
  residualSe: number;
  score: number;
  exactSeRecomputable: boolean;
}

// Recompute exact Morris Empirical Bayes posterior and variance components from persisted benchmark details and anchors
export function computeConfigPosterior(
  benchmarks: readonly BenchmarkScoreDetail[],
  anchorStats: Readonly<Record<string, AnchorStats>>,
  regime: HarnessRegime,
  activeBenchmarkIds: readonly string[],
  withheldBenchmarkIds: readonly string[],
  calibrationTauResidSq: number,
  priorMean: number,
  tauModelSq: number,
  orientationOverrides?: ReadonlyMap<string, 1 | -1>,
  linkJointCov?: LinkJointCov | null,
): ConfigPosteriorResult | null {
  const keyFor = (bmId: string) => (regime === "standardized" ? `${bmId}::standardized` : bmId);
  const withheldSet = new Set(withheldBenchmarkIds);
  const calibratedIds: string[] = [];
  let totalUniverseWeight = 0;
  for (const bmId of activeBenchmarkIds) {
    if (withheldSet.has(bmId)) continue;
    const st = anchorStats[keyFor(bmId)];
    if (!st || st.effectiveWeight <= 0) continue;
    calibratedIds.push(bmId);
    totalUniverseWeight += st.effectiveWeight;
  }

  let sumW = 0;
  let sumWAdj = 0;
  let sumW2SampVarZ = 0;
  let exactSeRecomputable = true;
  const observedIds = new Set<string>();
  const linkTermsRaw: RemlLinkTerm[] = [];

  for (const bm of benchmarks) {
    const st = anchorStats[keyFor(bm.benchmarkId)];
    if (!st || st.sd <= 0 || st.effectiveWeight <= 0) return null;
    const w = st.effectiveWeight;
    sumW += w;
    sumWAdj += w * (bm.zScore - st.raschDelta);
    observedIds.add(bm.benchmarkId);

    let rawSe: number | null = null;
    if (bm.seModel === "upstream_ci") {
      if (
        bm.ciLower !== null &&
        bm.ciUpper !== null &&
        Number.isFinite(bm.ciLower) &&
        Number.isFinite(bm.ciUpper) &&
        bm.ciUpper > bm.ciLower
      ) {
        rawSe = (bm.ciUpper - bm.ciLower) / (2 * 1.96);
      } else if (bm.ciHalfWidth !== null && Number.isFinite(bm.ciHalfWidth) && bm.ciHalfWidth > 0) {
        rawSe = bm.ciHalfWidth / 1.96;
      } else {
        exactSeRecomputable = false;
      }
    } else if (bm.seModel === "upstream_se") {
      if (
        bm.seRaw !== undefined &&
        bm.seRaw !== null &&
        Number.isFinite(bm.seRaw) &&
        bm.seRaw > 0
      ) {
        rawSe = bm.seRaw;
      } else if (bm.ciHalfWidth !== null && Number.isFinite(bm.ciHalfWidth) && bm.ciHalfWidth > 0) {
        rawSe = bm.ciHalfWidth / 1.96;
      } else {
        exactSeRecomputable = false;
      }
    } else if (bm.seModel === "popoviciu_upper_bound") {
      // Strictly require frozen popoviciuSe on anchorStats so later registry edits never mutate archived posteriors
      if (st.popoviciuSe !== undefined && Number.isFinite(st.popoviciuSe) && st.popoviciuSe > 0) {
        rawSe = st.popoviciuSe;
      } else {
        exactSeRecomputable = false;
      }
    } else if (bm.seModel !== "unreported") {
      exactSeRecomputable = false;
    }

    const sign = orientationOverrides?.get(bm.benchmarkId) ?? (st.invertScore ? -1 : 1);
    const oriented = sign * bm.rawScore;
    let sampVarZ: number;
    if (
      (bm.seModel === "upstream_ci" || bm.seModel === "upstream_se") &&
      rawSe !== null &&
      rawSe > 0
    ) {
      const rawZ = (oriented - st.mean) / st.sd;
      sampVarZ = clippedNormalVariance(rawZ, rawSe / st.sd, Z_SCORE_MIN, Z_SCORE_MAX);
    } else {
      const seZ = rawSe !== null ? rawSe / st.sd : UNREPORTED_SE_Z;
      sampVarZ = seZ * seZ;
    }
    sumW2SampVarZ += w * w * sampVarZ;

    if (
      st.linkedViaMeanSigma &&
      st.linkVarIntercept !== undefined &&
      st.linkVarSlope !== undefined &&
      st.linkCovIS !== undefined
    ) {
      linkTermsRaw.push({
        benchmarkId: bm.benchmarkId,
        interceptCoeff: w,
        slopeCoeff: w * oriented,
        linkVarIntercept: st.linkVarIntercept,
        linkVarSlope: st.linkVarSlope,
        linkCovIS: st.linkCovIS,
      });
    }
  }

  if (sumW <= 0) return null;

  let fpcWeightSumSq = 0;
  if (totalUniverseWeight > 0) {
    for (const bmId of calibratedIds) {
      const w = anchorStats[keyFor(bmId)]!.effectiveWeight;
      const cIb = (observedIds.has(bmId) ? w / sumW : 0) - w / totalUniverseWeight;
      fpcWeightSumSq += cIb * cIb;
    }
  }

  const jointLinkVar = Math.max(
    0,
    computeJointLinkCovariance(linkTermsRaw, linkTermsRaw, linkJointCov),
  );
  const thetaMle = sumWAdj / sumW;
  const fpcTerm = Math.max(0, fpcWeightSumSq) * Math.max(0, calibrationTauResidSq);
  const measTerm = (sumW2SampVarZ + jointLinkVar) / (sumW * sumW);
  const totalVar = Math.max(0, fpcTerm + measTerm);
  const shrinkageFactor = tauModelSq / (tauModelSq + totalVar);
  const theta = priorMean + shrinkageFactor * (thetaMle - priorMean);
  const seTheta = Math.sqrt(Math.max(0, shrinkageFactor * totalVar));

  return {
    thetaMle,
    fpcTerm,
    measTerm,
    shrinkageFactor,
    theta: Number(theta.toFixed(6)),
    se: Number((DISPLAY_SPREAD * seTheta).toFixed(2)),
    samplingSe: Number(
      (DISPLAY_SPREAD * Math.sqrt(Math.max(0, shrinkageFactor * measTerm))).toFixed(4),
    ),
    residualSe: Number(
      (DISPLAY_SPREAD * Math.sqrt(Math.max(0, shrinkageFactor * fpcTerm))).toFixed(4),
    ),
    score: Number((DISPLAY_BASE + DISPLAY_SPREAD * theta).toFixed(2)),
    exactSeRecomputable,
  };
}

export function aggregateDomain(
  observations: readonly ObservedCell[],
  activeBenchmarkIds: readonly string[],
  minLabs: number,
  frozenAnchors?: Readonly<Record<string, AnchorStats>>,
  frozenWithheldIds?: readonly string[],
  frozenCalibrationTauResidSq?: number,
  configuredCoverageFloor?: number,
  configuredAnchorMinCoverage?: number,
  frozenTauModelSq?: number,
  frozenPriorMean?: number,
  frozenLinkJointCov?: LinkJointCov,
  weightPolicy: AggregateWeightPolicy = "quality",
): DomainAggregationResult {
  const balanceMeasurementFamilies = weightPolicy !== "quality";
  if (balanceMeasurementFamilies && !frozenAnchors) {
    assertDisjointRoster(
      activeBenchmarkIds.map((benchmarkId) => ({
        benchmarkId,
        measurementFamily: measurementFamilyFor(benchmarkId),
        datasetPools: datasetPoolsFor(benchmarkId),
      })),
    );
  }
  const activeSet = new Set(activeBenchmarkIds);
  const frozenWithheldSet = new Set(frozenWithheldIds ?? []);
  const activeObs = observations.filter((o) => activeSet.has(o.benchmarkId));
  const coverageFloor = Math.max(
    1,
    Math.min(activeBenchmarkIds.length, configuredCoverageFloor ?? 1),
  );
  const anchorMinCoverage = Math.max(
    1,
    Math.min(activeBenchmarkIds.length, configuredAnchorMinCoverage ?? coverageFloor),
  );

  const obsByConfig = new Map<string, ObservedCell[]>();
  const obsByBm = new Map<string, ObservedCell[]>();

  for (const obs of activeObs) {
    const cList = obsByConfig.get(obs.configId) ?? [];
    cList.push(obs);
    obsByConfig.set(obs.configId, cList);

    const bList = obsByBm.get(obs.benchmarkId) ?? [];
    bList.push(obs);
    obsByBm.set(obs.benchmarkId, bList);
  }

  const anchorConfigIds = new Set<string>();
  for (const [cfgId, list] of obsByConfig.entries()) {
    const distinctBms = new Set(list.map((c) => c.benchmarkId));
    if (distinctBms.size >= anchorMinCoverage) anchorConfigIds.add(cfgId);
  }

  const quality = activeBenchmarkIds
    .filter((id) => !frozenWithheldSet.has(id) && !frozenAnchors?.[id])
    .map((benchmarkId) => ({
      benchmarkId,
      ...computeBenchmarkQualityWeight(
        benchmarkId,
        obsByBm.get(benchmarkId) ?? [],
        minLabs,
        balanceMeasurementFamilies,
      ),
    }));
  if (
    balanceMeasurementFamilies &&
    quality.length &&
    activeBenchmarkIds.some((id) => frozenAnchors?.[id])
  ) {
    throw new Error("Cannot allocate family weights across a partially frozen roster");
  }
  const familyWeights = balanceMeasurementFamilies
    ? allocateFamilyWeights(
        quality.map((q) => ({
          benchmarkId: q.benchmarkId,
          measurementFamily: measurementFamilyFor(q.benchmarkId),
          qualityWeight: q.effectiveWeight,
        })),
        weightPolicy,
      )
    : null;
  const calibrationWeight = new Map(
    quality.map((q) => [
      q.benchmarkId,
      {
        reliability: q.reliability,
        discrimination: q.discrimination,
        effectiveWeight: familyWeights?.get(q.benchmarkId) ?? q.effectiveWeight,
        ...(weightPolicy !== "quality"
          ? {
              measurementFamily: measurementFamilyFor(q.benchmarkId),
              datasetPools: [...datasetPoolsFor(q.benchmarkId)],
              qualityWeight: q.effectiveWeight,
              weightPolicy,
            }
          : {}),
      },
    ]),
  );

  // Classify restricted-range benchmarks by distinct model population breadth (< 40% of the broadest cohort)
  // so multi-effort sweeps never falsely flag broad benchmarks while elite subsets still use Mean-Sigma linking
  let maxAnchorModels = 0;
  for (const bmId of activeBenchmarkIds) {
    if (frozenWithheldSet.has(bmId) || frozenAnchors?.[bmId]) continue;
    const modelCount = new Set(
      (obsByBm.get(bmId) ?? [])
        .filter((c) => anchorConfigIds.has(c.configId))
        .map((c) => `${c.provider}:${c.modelSlug}`),
    ).size;
    if (modelCount > maxAnchorModels) maxAnchorModels = modelCount;
  }

  const anchorStats: Record<string, AnchorStats> = {};
  const withheldBenchmarkIds: string[] = [];
  const denseBenchmarks: string[] = [];
  const sparseBenchmarks: string[] = [];

  for (const bmId of activeBenchmarkIds) {
    if (frozenWithheldSet.has(bmId)) {
      withheldBenchmarkIds.push(bmId);
      continue;
    }
    const frozen = frozenAnchors?.[bmId];
    if (frozen) {
      anchorStats[bmId] = frozen;
      denseBenchmarks.push(bmId);
      continue;
    }

    const bmCells = obsByBm.get(bmId) ?? [];
    const anchorCells = bmCells.filter((c) => anchorConfigIds.has(c.configId));
    const anchorLabs = new Set(anchorCells.map((c) => c.provider));
    const anchorModelCount = new Set(anchorCells.map((c) => `${c.provider}:${c.modelSlug}`)).size;
    const isRangeRestricted =
      (balanceMeasurementFamilies || maxAnchorModels >= 35) &&
      anchorModelCount < maxAnchorModels * 0.4;

    if (!isRangeRestricted && anchorCells.length >= minLabs && anchorLabs.size >= minLabs) {
      const stats = computeLabBalancedStats(
        anchorCells.map((c) => ({ provider: c.provider, value: orientScore(bmId, c.rawScore) })),
      );
      if (stats.sd > 1e-6) {
        const bmMeta = BENCHMARK_BY_ID[bmId];
        const popoviciuSe =
          bmMeta &&
          bmMeta.boundedMax !== null &&
          bmMeta.boundedMax > 0 &&
          bmMeta.sampleSize !== null &&
          bmMeta.sampleSize > 0
            ? Number((bmMeta.boundedMax / (2 * Math.sqrt(bmMeta.sampleSize))).toFixed(6))
            : undefined;
        anchorStats[bmId] = {
          benchmarkId: bmId,
          mean: Number(stats.mean.toFixed(6)),
          sd: Number(stats.sd.toFixed(6)),
          anchorCount: anchorCells.length,
          anchorLabs: stats.labCount,
          linkedViaMeanSigma: false,
          raschDelta: 0,
          ...calibrationWeight.get(bmId)!,
          introducedAt: bmMeta?.introducedAt ?? "2026-01-01",
          invertScore: bmMeta?.invertScore ?? false,
          ...(popoviciuSe !== undefined ? { popoviciuSe } : {}),
        };
        denseBenchmarks.push(bmId);
        continue;
      }
    }

    sparseBenchmarks.push(bmId);
  }

  // Link sparse or restricted-range benchmarks via iterative Mean-Sigma overlap across connected anchors; withhold if linking fails
  const overlapByLinkedBm = new Map<
    string,
    { configId: string; provider: ProviderId; benchmarkRaw: number; refTheta: number }[]
  >();
  let remainingSparse = [...sparseBenchmarks];
  while (remainingSparse.length > 0 && Object.keys(anchorStats).length > 0) {
    const prelimWeights = new Map<string, number>();
    for (const [bmId, st] of Object.entries(anchorStats)) {
      prelimWeights.set(bmId, st.effectiveWeight);
    }
    const prelimZ: RaschCell[] = [];
    for (const obs of activeObs) {
      const st = anchorStats[obs.benchmarkId];
      if (!st) continue;
      prelimZ.push({
        configId: obs.configId,
        benchmarkId: obs.benchmarkId,
        zScore: clampZScore((orientScore(obs.benchmarkId, obs.rawScore) - st.mean) / st.sd),
      });
    }
    const prelimFit = solveTwoWayLinearRasch(prelimZ, undefined, prelimWeights);

    const nextRemaining: string[] = [];
    let linkedThisPass = 0;
    for (const bmId of remainingSparse) {
      const bmCells = obsByBm.get(bmId) ?? [];
      const overlap = bmCells
        .filter((c) => prelimFit.thetaByConfig.has(c.configId))
        .map((c) => ({
          configId: c.configId,
          provider: c.provider,
          benchmarkRaw: orientScore(bmId, c.rawScore),
          refTheta: prelimFit.thetaByConfig.get(c.configId)!,
        }));

      const linked = linkBenchmarkMeanSigma(overlap, minLabs, balanceMeasurementFamilies);
      if (linked.linked) {
        overlapByLinkedBm.set(bmId, overlap);
        const bmMeta = BENCHMARK_BY_ID[bmId];
        const popoviciuSe =
          bmMeta &&
          bmMeta.boundedMax !== null &&
          bmMeta.boundedMax > 0 &&
          bmMeta.sampleSize !== null &&
          bmMeta.sampleSize > 0
            ? Number((bmMeta.boundedMax / (2 * Math.sqrt(bmMeta.sampleSize))).toFixed(6))
            : undefined;
        anchorStats[bmId] = {
          benchmarkId: bmId,
          mean: Number(linked.mean.toFixed(6)),
          sd: Number(linked.sd.toFixed(6)),
          anchorCount: overlap.length,
          anchorLabs: new Set(overlap.map((o) => o.provider)).size,
          linkedViaMeanSigma: true,
          raschDelta: 0,
          ...calibrationWeight.get(bmId)!,
          introducedAt: bmMeta?.introducedAt ?? "2026-01-01",
          invertScore: bmMeta?.invertScore ?? false,
          ...(popoviciuSe !== undefined ? { popoviciuSe } : {}),
          ...(linked.linkVarIntercept !== undefined
            ? { linkVarIntercept: linked.linkVarIntercept }
            : {}),
          ...(linked.minProviderCorrelation === undefined
            ? {}
            : { linkMinProviderCorrelation: linked.minProviderCorrelation }),
          ...(linked.linkVarSlope !== undefined ? { linkVarSlope: linked.linkVarSlope } : {}),
          ...(linked.linkCovIS !== undefined ? { linkCovIS: linked.linkCovIS } : {}),
        };
        linkedThisPass++;
      } else {
        nextRemaining.push(bmId);
      }
    }
    remainingSparse = nextRemaining;
    if (linkedThisPass === 0) break;
  }
  withheldBenchmarkIds.push(...remainingSparse);

  const raschCells: RaschCell[] = [];
  const zByConfigBm = new Map<string, number>();
  const weightByBenchmark = new Map<string, number>();
  for (const [bmId, st] of Object.entries(anchorStats)) {
    weightByBenchmark.set(bmId, st.effectiveWeight);
  }

  for (const obs of activeObs) {
    const st = anchorStats[obs.benchmarkId];
    if (!st) continue;
    const rawZ = (orientScore(obs.benchmarkId, obs.rawScore) - st.mean) / st.sd;
    const z = clampZScore(rawZ);
    const meta = BENCHMARK_BY_ID[obs.benchmarkId];
    const seModel = resolveSeModel(obs.ciHalfWidth, obs.ciLower, obs.ciUpper, obs.seRaw, meta);
    // Debias tauResidSq strictly from measured upstream CI/SE propagated through z-score clipping
    let cellMeasVarZ = 0;
    if (seModel === "upstream_ci" || seModel === "upstream_se") {
      const rawSe = meta
        ? computeMeasurementSe(
            obs.rawScore,
            obs.ciHalfWidth,
            meta,
            obs.ciLower,
            obs.ciUpper,
            obs.seRaw,
          )
        : null;
      if (rawSe !== null && rawSe > 0) {
        const seZ = rawSe / st.sd;
        cellMeasVarZ = clippedNormalVariance(rawZ, seZ, Z_SCORE_MIN, Z_SCORE_MAX);
      }
    }
    raschCells.push({
      configId: obs.configId,
      benchmarkId: obs.benchmarkId,
      zScore: z,
      measVarZ: cellMeasVarZ,
    });
    zByConfigBm.set(`${obs.configId}::${obs.benchmarkId}`, z);
  }

  const frozenDeltaMap = new Map<string, number>();
  if (frozenAnchors) {
    for (const [k, v] of Object.entries(frozenAnchors)) {
      frozenDeltaMap.set(k, v.raschDelta);
    }
  }

  // Fit and freeze calibration deltas strictly for benchmarks retained in the connected calibration component
  const needsCalibration = Object.keys(anchorStats).some((bmId) => !frozenDeltaMap.has(bmId));
  let calibrationTauResidSq = frozenCalibrationTauResidSq ?? 0;

  if (needsCalibration) {
    const calibrationFit = solveTwoWayLinearRasch(raschCells, frozenDeltaMap, weightByBenchmark);
    calibrationTauResidSq = Number(calibrationFit.tauResidSq.toFixed(8));
    for (const [bmId, st] of Object.entries(anchorStats)) {
      if (frozenDeltaMap.has(bmId)) continue;
      const fitted = calibrationFit.deltaByBenchmark.get(bmId);
      if (fitted === undefined) {
        delete anchorStats[bmId];
        weightByBenchmark.delete(bmId);
        if (!withheldBenchmarkIds.includes(bmId)) withheldBenchmarkIds.push(bmId);
        continue;
      }
      const roundedDelta = Number(fitted.toFixed(6));
      st.raschDelta = roundedDelta;
      frozenDeltaMap.set(bmId, roundedDelta);
    }
  }

  const calibratedCells = raschCells.filter((c) => anchorStats[c.benchmarkId] !== undefined);
  const raschFit = solveTwoWayLinearRasch(calibratedCells, frozenDeltaMap, weightByBenchmark);
  const effectiveTauResidSq =
    frozenCalibrationTauResidSq !== undefined || needsCalibration
      ? calibrationTauResidSq
      : raschFit.tauResidSq;

  const calibratedBenchmarkIds = Object.keys(anchorStats);
  // Build exact joint delete-one jackknife covariance over the union of all linked benchmark panels (full precision PSD Gram)
  let linkJointCov: LinkJointCov | undefined = frozenLinkJointCov;
  if (!linkJointCov) {
    const linkedCalibratedIds = calibratedBenchmarkIds
      .filter((id) => anchorStats[id]?.linkedViaMeanSigma)
      .toSorted(compareAscii);
    if (linkedCalibratedIds.length > 0) {
      const dim = linkedCalibratedIds.length * 2;
      const unionSet = new Set<string>();
      const fullParamsByIdx: { a: number; b: number }[] = [];
      const panelByIdx: {
        overlap: {
          configId: string;
          provider: ProviderId;
          benchmarkRaw: number;
          refTheta: number;
        }[];
        idxByConfig: Map<string, number>;
      }[] = [];
      let allPanelsPresent = true;
      for (const bmId of linkedCalibratedIds) {
        const overlap = overlapByLinkedBm.get(bmId);
        const full = overlap ? computeMeanSigmaParams(overlap) : null;
        if (!overlap || !full) {
          allPanelsPresent = false;
          break;
        }
        fullParamsByIdx.push({ a: -full.mean / full.sd, b: 1 / full.sd });
        const idxByConfig = new Map<string, number>();
        for (let i = 0; i < overlap.length; i++) {
          const cid = overlap[i]!.configId;
          unionSet.add(cid);
          idxByConfig.set(cid, i);
        }
        panelByIdx.push({ overlap, idxByConfig });
      }
      const unionConfigIds = [...unionSet].toSorted(compareAscii);
      const nUnion = unionConfigIds.length;
      const mat: number[][] = Array.from({ length: dim }, () =>
        Array.from({ length: dim }, () => 0),
      );

      if (allPanelsPresent && nUnion >= 2) {
        const reps: number[][] = [];
        for (const delId of unionConfigIds) {
          const vec = Array.from({ length: dim }, () => 0);
          for (let k = 0; k < linkedCalibratedIds.length; k++) {
            const panel = panelByIdx[k]!;
            const fullP = fullParamsByIdx[k]!;
            const dropIdx = panel.idxByConfig.get(delId);
            if (dropIdx !== undefined) {
              const sub = panel.overlap.filter((_, idx) => idx !== dropIdx);
              const subP = computeMeanSigmaParams(sub);
              vec[2 * k] = subP ? -subP.mean / subP.sd : fullP.a;
              vec[2 * k + 1] = subP ? 1 / subP.sd : fullP.b;
            } else {
              vec[2 * k] = fullP.a;
              vec[2 * k + 1] = fullP.b;
            }
          }
          reps.push(vec);
        }
        const meanVec = Array.from({ length: dim }, () => 0);
        for (const vec of reps) {
          for (let r = 0; r < dim; r++) meanVec[r] = meanVec[r]! + vec[r]! / nUnion;
        }
        const factor = (nUnion - 1) / nUnion;
        for (const vec of reps) {
          for (let r = 0; r < dim; r++) {
            const dr = vec[r]! - meanVec[r]!;
            for (let c = r; c < dim; c++) {
              const dc = vec[c]! - meanVec[c]!;
              mat[r]![c] = mat[r]![c]! + factor * dr * dc;
            }
          }
        }
        for (let r = 0; r < dim; r++) {
          for (let c = 0; c < r; c++) mat[r]![c] = mat[c]![r]!;
        }
        // Synchronize per-benchmark 2x2 diagonal blocks with the exact joint jackknife Gram matrix
        for (let k = 0; k < linkedCalibratedIds.length; k++) {
          const stK = anchorStats[linkedCalibratedIds[k]!]!;
          stK.linkVarIntercept = mat[2 * k]![2 * k]!;
          stK.linkCovIS = mat[2 * k]![2 * k + 1]!;
          stK.linkVarSlope = mat[2 * k + 1]![2 * k + 1]!;
        }
      } else {
        for (let k = 0; k < linkedCalibratedIds.length; k++) {
          const stK = anchorStats[linkedCalibratedIds[k]!]!;
          mat[2 * k]![2 * k] = stK.linkVarIntercept ?? 0;
          mat[2 * k]![2 * k + 1] = stK.linkCovIS ?? 0;
          mat[2 * k + 1]![2 * k] = stK.linkCovIS ?? 0;
          mat[2 * k + 1]![2 * k + 1] = stK.linkVarSlope ?? 0;
        }
      }
      linkJointCov = { benchmarkIds: linkedCalibratedIds, covMatrix: mat };
    }
  }

  let totalUniverseWeight = 0;
  for (const bmId of calibratedBenchmarkIds) {
    totalUniverseWeight += anchorStats[bmId]!.effectiveWeight;
  }

  const activeB = calibratedBenchmarkIds.length || activeBenchmarkIds.length;
  const eligible: AggregatedConfigResult[] = [];
  const provisional: AggregatedConfigResult[] = [];

  const anchorLabSet = new Set<ProviderId>();
  for (const cfgId of anchorConfigIds) {
    const first = obsByConfig.get(cfgId)?.[0];
    if (first) anchorLabSet.add(first.provider);
  }

  interface PendingConfig {
    cfgId: string;
    sample: ObservedCell;
    k: number;
    thetaMle: number;
    fpcTerm: number;
    measTerm: number;
    suiteCostUsd: number | null;
    usesFallbackRouting: boolean;
    sumObservedResidual: number;
    missingOlderWeight: number;
    details: AggregatedBenchmarkDetail[];
  }

  const pendingConfigs: PendingConfig[] = [];

  for (const [cfgId, list] of obsByConfig.entries()) {
    if (raschFit.droppedConfigIds.has(cfgId)) continue;
    const sample = list[0];
    if (!sample) continue;

    const validCells = list.filter((c) => anchorStats[c.benchmarkId] !== undefined);
    if (validCells.length === 0) continue;

    const thetaMle = raschFit.thetaByConfig.get(cfgId) ?? 0;
    const k = validCells.length;

    let sumW = 0;
    let sumW2SampVarZ = 0;
    let sumObservedResidual = 0;
    const linkTermsRaw: RemlLinkTerm[] = [];
    const suiteCostCandidates: { cost: number; healthyAt: string | null }[] = [];
    let usesFallbackRouting = false;
    const details: AggregatedBenchmarkDetail[] = [];

    for (const c of validCells) {
      const st = anchorStats[c.benchmarkId]!;
      const w = st.effectiveWeight;
      sumW += w;
      const meta = BENCHMARK_BY_ID[c.benchmarkId];
      const z = zByConfigBm.get(`${cfgId}::${c.benchmarkId}`) ?? 0;
      const delta = st.raschDelta;
      sumObservedResidual += w * (z - delta);

      if (c.suiteCostUsd !== null && c.suiteCostUsd > 0) {
        suiteCostCandidates.push({
          cost: c.suiteCostUsd,
          healthyAt: c.subFeedHealthyAt ?? null,
        });
      }
      if (c.fallbackRouting) usesFallbackRouting = true;

      const resolvedSeModel = resolveSeModel(c.ciHalfWidth, c.ciLower, c.ciUpper, c.seRaw, meta);
      let rawSe: number | null = null;
      if (
        resolvedSeModel === "popoviciu_upper_bound" &&
        st.popoviciuSe !== undefined &&
        st.popoviciuSe > 0
      ) {
        rawSe = st.popoviciuSe;
      } else if (meta) {
        rawSe = computeMeasurementSe(
          c.rawScore,
          c.ciHalfWidth,
          meta,
          c.ciLower,
          c.ciUpper,
          c.seRaw,
        );
      }
      const oriented = orientScore(c.benchmarkId, c.rawScore);
      let sampVarZ: number;
      if (
        (resolvedSeModel === "upstream_ci" || resolvedSeModel === "upstream_se") &&
        rawSe !== null &&
        rawSe > 0
      ) {
        const rawZ = (oriented - st.mean) / st.sd;
        sampVarZ = clippedNormalVariance(rawZ, rawSe / st.sd, Z_SCORE_MIN, Z_SCORE_MAX);
      } else {
        // Unreported-SE benchmarks use conservative 1.0 SD z-uncertainty instead of zero
        const seZ = rawSe !== null ? rawSe / st.sd : UNREPORTED_SE_Z;
        sampVarZ = seZ * seZ;
      }
      sumW2SampVarZ += w * w * sampVarZ;
      if (
        st.linkedViaMeanSigma &&
        st.linkVarIntercept !== undefined &&
        st.linkVarSlope !== undefined &&
        st.linkCovIS !== undefined
      ) {
        linkTermsRaw.push({
          benchmarkId: c.benchmarkId,
          interceptCoeff: w,
          slopeCoeff: w * oriented,
          linkVarIntercept: st.linkVarIntercept,
          linkVarSlope: st.linkVarSlope,
          linkCovIS: st.linkCovIS,
        });
      }

      const effectiveCiHalfWidth =
        c.ciHalfWidth ??
        (c.seRaw !== null && c.seRaw > 0 ? Number((c.seRaw * 1.96).toFixed(4)) : null);

      details.push({
        benchmarkId: c.benchmarkId,
        benchmarkVersion: c.benchmarkVersion,
        sourceId: c.sourceId,
        sourceRowId: c.sourceRowId,
        observedHarness: c.observedHarness,
        rawScore: c.rawScore,
        zScore: Number(z.toFixed(4)),
        seModel: resolvedSeModel,
        ...(c.seRaw !== null && c.seRaw > 0 ? { seRaw: c.seRaw } : {}),
        ciHalfWidth: effectiveCiHalfWidth,
        ciLower: c.ciLower,
        ciUpper: c.ciUpper,
        measuredCostUsd: c.measuredCostUsd,
        ...(c.measuredCostEstimated ? { measuredCostEstimated: true } : {}),
        ...(c.fallbackRouting ? { fallbackRouting: true } : {}),
        ...(c.refusalRate !== undefined && c.refusalRate !== null && c.refusalRate > 0
          ? { refusalRate: c.refusalRate }
          : {}),
        evalDate: c.evalDate,
        publishedDate: c.publishedDate,
        sourceUrl: c.sourceUrl,
      });
    }

    // Reconcile suite cost strictly from the freshest healthy benchmark partition; fail closed on equal-freshness conflict
    let suiteCostUsd: number | null = null;
    if (suiteCostCandidates.length > 0) {
      let freshestAt: string | null = null;
      for (const cand of suiteCostCandidates) {
        if (cand.healthyAt === null) continue;
        if (freshestAt === null) {
          freshestAt = cand.healthyAt;
        } else {
          const cmp = compareIsoInstants(cand.healthyAt, freshestAt);
          if (cmp !== null && cmp > 0) freshestAt = cand.healthyAt;
        }
      }
      const freshestCands =
        freshestAt !== null
          ? suiteCostCandidates.filter(
              (cand) =>
                cand.healthyAt !== null && compareIsoInstants(cand.healthyAt, freshestAt) === 0,
            )
          : suiteCostCandidates;
      const refCost = freshestCands[0]?.cost ?? null;
      const allAgree =
        refCost !== null && freshestCands.every((cand) => Math.abs(cand.cost - refCost) <= 1e-6);
      suiteCostUsd = allAgree ? refCost : null;
    }

    // Exact weighted finite-roster residual variance: tau_resid^2 * sum_{b in U} (w_b*1[b in O_i]/W_i - w_b/W_U)^2
    const observedIds = new Set(validCells.map((c) => c.benchmarkId));
    let fpcWeightSumSq = 0;
    if (totalUniverseWeight > 0 && sumW > 0) {
      for (const bmId of calibratedBenchmarkIds) {
        const w = anchorStats[bmId]!.effectiveWeight;
        const cIb = (observedIds.has(bmId) ? w / sumW : 0) - w / totalUniverseWeight;
        fpcWeightSumSq += cIb * cIb;
      }
    }
    const fpcTerm = Math.max(0, fpcWeightSumSq) * effectiveTauResidSq;
    const jointLinkVar = Math.max(
      0,
      computeJointLinkCovariance(linkTermsRaw, linkTermsRaw, linkJointCov),
    );
    const measTerm = sumW > 0 ? (sumW2SampVarZ + jointLinkVar) / (sumW * sumW) : 0;

    let missingOlderWeight = 0;
    for (const bmId of activeBenchmarkIds) {
      if (observedIds.has(bmId)) continue;
      const st = anchorStats[bmId];
      if (!st || !sample.releaseDate) continue;
      if (st.introducedAt <= sample.releaseDate) missingOlderWeight += st.effectiveWeight;
    }

    pendingConfigs.push({
      cfgId,
      sample,
      k,
      thetaMle,
      fpcTerm,
      measTerm,
      suiteCostUsd,
      usesFallbackRouting,
      sumObservedResidual,
      missingOlderWeight,
      details,
    });
  }

  // Estimate block-correlated heteroscedastic REML Empirical Bayes prior (priorMean, tauModelSq) matching ranking covariance
  let priorMean = frozenPriorMean ?? 0;
  let tauModelSq = frozenTauModelSq ?? 1.0;
  if (frozenTauModelSq === undefined || frozenPriorMean === undefined) {
    const fitted = fitHeteroscedasticRemlPrior(
      pendingConfigs.map((p) => ({
        thetaMle: p.thetaMle,
        totalVar: Math.max(0, p.fpcTerm + p.measTerm),
        provider: p.sample.provider,
        modelSlug: p.sample.modelSlug,
        residCoeffs: buildResidCoeffs(
          new Set(p.details.map((d) => d.benchmarkId)),
          calibratedBenchmarkIds,
          anchorStats,
          "native",
          effectiveTauResidSq,
        ),
        linkTerms: buildRemlLinkTerms(p.details, anchorStats, "native"),
      })),
      linkJointCov,
    );
    if (frozenPriorMean === undefined) priorMean = fitted.priorMean;
    if (frozenTauModelSq === undefined) tauModelSq = fitted.tauModelSq;
  }

  for (const p of pendingConfigs) {
    // Morris Empirical Bayes shrinkage pulls sparse or noisy estimates toward priorMean proportionally to error variance
    const totalVar = Math.max(0, p.fpcTerm + p.measTerm);
    const shrinkage = tauModelSq / (tauModelSq + totalVar);
    const thetaEb = priorMean + shrinkage * (p.thetaMle - priorMean);
    const seTheta = Math.sqrt(Math.max(0, shrinkage * totalVar));

    const score = Number((DISPLAY_BASE + DISPLAY_SPREAD * thetaEb).toFixed(2));
    const seScore = Number((DISPLAY_SPREAD * seTheta).toFixed(2));
    const samplingSe = Number(
      (DISPLAY_SPREAD * Math.sqrt(Math.max(0, shrinkage * p.measTerm))).toFixed(4),
    );
    const residualSe = Number(
      (DISPLAY_SPREAD * Math.sqrt(Math.max(0, shrinkage * p.fpcTerm))).toFixed(4),
    );

    // Require at least half of a frontier score to come from observed data rather than the domain prior
    const meetsCoverage = p.k >= coverageFloor && shrinkage >= MIN_FRONTIER_SHRINKAGE;
    const result: AggregatedConfigResult = {
      configId: p.cfgId,
      provider: p.sample.provider,
      modelSlug: p.sample.modelSlug,
      displayName: p.sample.displayName,
      releaseDate: p.sample.releaseDate,
      effort: p.sample.effort,
      harness: p.sample.harness,
      harnessRegime: p.sample.harnessRegime,
      theta: Number(thetaEb.toFixed(6)),
      shrinkageFactor: Number(shrinkage.toFixed(6)),
      score,
      se: seScore,
      samplingSe,
      residualSe,
      suiteCostUsd: p.suiteCostUsd,
      usesFallbackRouting: p.usesFallbackRouting,
      coverageCount: p.k,
      activeBenchmarkCount: activeB,
      eligibleForFrontier: meetsCoverage,
      sumObservedResidual: p.sumObservedResidual,
      missingOlderCount: Number(p.missingOlderWeight.toFixed(6)),
      benchmarks: p.details.toSorted((a, b) => compareAscii(a.benchmarkId, b.benchmarkId)),
    };

    if (meetsCoverage) eligible.push(result);
    else provisional.push(result);
  }

  return {
    anchorStats,
    ...(linkJointCov ? { linkJointCov } : {}),
    tauResid: Math.sqrt(Math.max(0, effectiveTauResidSq)),
    calibrationTauResidSq: Number(effectiveTauResidSq.toFixed(8)),
    priorMean,
    tauModelSq,
    coverageFloor,
    anchorLabs: anchorLabSet.size,
    withheldBenchmarkIds,
    eligible,
    provisional,
  };
}
