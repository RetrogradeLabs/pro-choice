import { isRetiredPurchaseSku } from "../../config/providers.ts";
import type { CostSource, CostUnit, DomainId, PricingRecord, ProviderId } from "../schema.ts";
import { compareAscii, solveTwoWayLinearRasch } from "./aggregate.ts";

export interface CostInputRow {
  configId: string;
  provider: ProviderId;
  modelSlug: string;
  effort: string;
  harness?: string;
  suiteCostUsd: number | null;
  benchmarks: readonly {
    benchmarkId: string;
    sourceRowId: string;
    measuredCostUsd: number | null;
    measuredCostEstimated?: boolean | undefined;
  }[];
}

export interface ResolvedCost {
  effectiveCostUsd: number | null;
  costFixedFloorUsd?: number;
  costLogSd?: number;
  costMinUsd?: number;
  costMaxUsd?: number;
  costImputed: boolean;
  costEstimated: boolean;
  costUnit: CostUnit;
  costSource: CostSource;
  blendedListPricePer1mUsd: number | null;
  inputPer1mUsd: number | null;
  outputPer1mUsd: number | null;
  contextWindow: number | null;
}

export interface PartialBasketConfigModel {
  observedIds: readonly string[];
  fixedFloorUsd: number;
  meanUsd: number;
  totalLogVar: number;
  missingTerms: readonly { benchmarkId: string; logCenter: number }[];
}

export interface PartialBasketCostModel {
  basketSize: number;
  freeBenchmarks: readonly string[];
  deltaCovMatrix: readonly (readonly number[])[];
  tauResidSq: number;
  byConfigId: ReadonlyMap<string, PartialBasketConfigModel>;
}

export interface SiblingBaselineCostEntry {
  groupKey: string;
  baseSd: number;
  tierSd: number;
  totalSd: number;
  rawMu: number;
  loLog: number;
  hiLog: number;
  parentPartialIds: readonly string[];
  avgParentEffOff: number;
  targetEffOff: number;
}

export interface OlsCostBootstrapModel {
  factorMatrix: readonly (readonly number[])[];
  residSd: number;
  byConfigId: ReadonlyMap<string, { xVec: readonly number[]; predMeanLog: number }>;
}

export interface UnidentifiedCellCostEntry {
  cellKey: string;
  cellMeanLog: number;
  meanSd: number;
  residSd: number;
}

export interface DomainCostBootstrapModel {
  partialBasket: PartialBasketCostModel | null;
  siblingBaselines: ReadonlyMap<string, SiblingBaselineCostEntry>;
  olsModel: OlsCostBootstrapModel | null;
  unidentifiedCells: ReadonlyMap<string, UnidentifiedCellCostEntry>;
}

const ORDERED_EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
// Strictly explicitly ordered effort tiers may impose monotone price brackets (never default or generic thinking)
const ORDERED_EFFORT_RANK: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

function weightedTokenRate(inP: number, outP: number): number {
  return 0.25 * inP + 0.75 * outP;
}

// 8-point Gauss-Legendre nodes and weights on [-1, 1] for 15-digit quadrature with zero cancellation
export const GL8_NODES = [
  -0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498,
  0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363,
] as const;
export const GL8_WEIGHTS = [
  0.10122853629037626, 0.22238103445337448, 0.3137066458778873, 0.362683783378362,
  0.362683783378362, 0.3137066458778873, 0.22238103445337448, 0.10122853629037626,
] as const;
const INV_SQRT_PI = 1 / Math.sqrt(Math.PI);
const INV_SQRT_2PI = 0.3989422804014327;

// Continuous 15-digit erfcx(x) = exp(x^2) * erfc(x) for x >= 0 via Laplace quadrature + continued fraction
export function erfcx(x: number): number {
  if (x < 0) return 2 * Math.exp(x * x) - erfcx(-x);
  if (x >= 4.5) {
    let cf = 0;
    for (let k = 40; k >= 1; k--) cf = (0.5 * k) / (x + cf);
    return INV_SQRT_PI / (x + cf);
  }
  // Composite 8-point Gauss-Legendre of (2/sqrt(pi)) * int exp(-t^2 - 2xt) dt to full double precision
  let sum = 0;
  const segs: readonly [number, number][] = [
    [0, 0.25],
    [0.25, 0.75],
    [0.75, 1.5],
    [1.5, 2.5],
    [2.5, 3.8],
    [3.8, 5.1],
    [5.1, 6.5],
  ];
  for (const [lo, hi] of segs) {
    const mid = 0.5 * (lo + hi);
    const half = 0.5 * (hi - lo);
    for (let i = 0; i < 8; i++) {
      const t = mid + half * GL8_NODES[i]!;
      sum += half * GL8_WEIGHTS[i]! * Math.exp(-t * t - 2 * x * t);
    }
  }
  return 2 * INV_SQRT_PI * sum;
}

// Continuous 15-digit log(Phi(z)) accurate across all real z without boundary discontinuities or underflow
export function logNormalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 0 : Number.NEGATIVE_INFINITY;
  if (z <= 0) {
    return -0.5 * z * z + Math.log(0.5 * erfcx(-z / Math.SQRT2));
  }
  return Math.log1p(-0.5 * Math.exp(-0.5 * z * z) * erfcx(z / Math.SQRT2));
}

// Continuous 15-digit log(Phi(b) - Phi(a)) using shifted quadrature on narrow intervals and tail log-differences elsewhere
export function logNormalInterval(a: number, b: number): number {
  if (b <= a) return Number.NEGATIVE_INFINITY;
  const tRef = Number.isFinite(a) && Number.isFinite(b) ? Math.min(b, Math.max(a, 0)) : 0;
  if (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    b - a < 0.05 &&
    (b - a) * (1 + Math.abs(tRef)) < 1.5
  ) {
    const mid = 0.5 * (a + b);
    const half = 0.5 * (b - a);
    let qSum = 0;
    for (let i = 0; i < 8; i++) {
      const t = mid + half * GL8_NODES[i]!;
      qSum += GL8_WEIGHTS[i]! * Math.exp(-0.5 * (t * t - tRef * tRef));
    }
    return -0.5 * tRef * tRef + Math.log(half * INV_SQRT_2PI * qSum);
  }
  if (a >= 0) {
    const logSa = logNormalCdf(-a);
    const logSb = Number.isFinite(b) ? logNormalCdf(-b) : Number.NEGATIVE_INFINITY;
    const diff = logSb - logSa;
    if (!(diff < 0)) return Number.NEGATIVE_INFINITY;
    return logSa + Math.log(-Math.expm1(diff));
  }
  if (b <= 0) {
    const logFb = logNormalCdf(b);
    const logFa = Number.isFinite(a) ? logNormalCdf(a) : Number.NEGATIVE_INFINITY;
    const diff = logFa - logFb;
    if (!(diff < 0)) return Number.NEGATIVE_INFINITY;
    return logFb + Math.log(-Math.expm1(diff));
  }
  return Math.log(Math.max(1e-300, Math.exp(logNormalCdf(b)) - Math.exp(logNormalCdf(a))));
}

// Exact tail-scaled quadrature for E[exp(Y) | loLog <= Y <= hiLog] when density decays rapidly from one boundary
function tailScaledTruncatedLogNormalMean(
  mu: number,
  sigma: number,
  loLog: number,
  hiLog: number,
  side: "right" | "left",
): number | null {
  const h =
    Number.isFinite(loLog) && Number.isFinite(hiLog) ? hiLog - loLog : Number.POSITIVE_INFINITY;
  const dist = side === "right" ? loLog - mu : mu - hiLog;
  if (!(dist > 0) || !(sigma > 0)) return null;
  const zEdge = dist / sigma;
  const lambda = dist / (sigma * sigma);
  const sMax = Number.isFinite(h) ? Math.min(40, lambda * h) : 40;
  if (!(sMax > 0)) return null;
  const cuts = [0, 0.5, 1.5, 4.0, 10.0, 22.0, 40.0];
  let num = 0;
  let den = 0;
  for (let seg = 0; seg < cuts.length - 1; seg++) {
    const a = cuts[seg]!;
    if (a >= sMax) break;
    const b = Math.min(cuts[seg + 1]!, sMax);
    const mid = 0.5 * (a + b);
    const half = 0.5 * (b - a);
    for (let i = 0; i < 8; i++) {
      const s = mid + half * GL8_NODES[i]!;
      const logDens = -s - 0.5 * (s / zEdge) * (s / zEdge);
      const w = half * GL8_WEIGHTS[i]! * Math.exp(logDens);
      den += w;
      const shift = side === "right" ? s / lambda : -s / lambda;
      num += w * Math.exp(shift);
    }
  }
  if (!(den > 0) || !Number.isFinite(num / den)) return null;
  const anchor = side === "right" ? loLog : hiLog;
  return Math.exp(anchor) * (num / den);
}

// Exact tail-stable Bayes-conditioned mean of Y ~ LogNormal(mu, sigma^2) truncated to [exp(loLog), exp(hiLog)]
export function truncatedLogNormalPosterior(
  mu: number,
  sigma: number,
  loLog: number,
  hiLog: number,
): { meanUsd: number; degenerate: boolean } {
  if (!(sigma > 1e-9) || hiLog <= loLog + 1e-12) {
    const clamped = Math.min(hiLog, Math.max(loLog, mu));
    return { meanUsd: Math.exp(clamped), degenerate: true };
  }
  const alpha = Number.isFinite(loLog) ? (loLog - mu) / sigma : Number.NEGATIVE_INFINITY;
  const beta = Number.isFinite(hiLog) ? (hiLog - mu) / sigma : Number.POSITIVE_INFINITY;
  const tRef =
    Number.isFinite(alpha) && Number.isFinite(beta) ? Math.min(beta, Math.max(alpha, 0)) : 0;
  const minUsd = Number.isFinite(loLog) ? Math.exp(loLog) : 0;
  const maxUsd = Number.isFinite(hiLog) ? Math.exp(hiLog) : Number.POSITIVE_INFINITY;

  if (
    Number.isFinite(loLog) &&
    Number.isFinite(hiLog) &&
    beta - alpha < 0.05 &&
    (beta - alpha) * (1 + Math.abs(tRef)) < 1.5
  ) {
    const yRef = Math.min(hiLog, Math.max(loLog, mu));
    const mid = 0.5 * (loLog + hiLog);
    const half = 0.5 * (hiLog - loLog);
    const inv2Var = 0.5 / (sigma * sigma);
    let num = 0;
    let den = 0;
    for (let i = 0; i < 8; i++) {
      const y = mid + half * GL8_NODES[i]!;
      const logW = -inv2Var * ((y - mu) * (y - mu) - (yRef - mu) * (yRef - mu));
      const w = GL8_WEIGHTS[i]! * Math.exp(logW);
      den += w;
      num += w * Math.exp(y - mid);
    }
    if (den > 0 && Number.isFinite(num / den)) {
      const rawMean = Math.exp(mid) * (num / den);
      return {
        meanUsd: Math.min(maxUsd, Math.max(minUsd, rawMean)),
        degenerate: false,
      };
    }
  }
  if (alpha > 2) {
    const tailMean = tailScaledTruncatedLogNormalMean(mu, sigma, loLog, hiLog, "right");
    if (tailMean !== null && Number.isFinite(tailMean) && tailMean > 0) {
      return { meanUsd: Math.min(maxUsd, Math.max(minUsd, tailMean)), degenerate: false };
    }
  } else if (beta < -2) {
    const tailMean = tailScaledTruncatedLogNormalMean(mu, sigma, loLog, hiLog, "left");
    if (tailMean !== null && Number.isFinite(tailMean) && tailMean > 0) {
      return { meanUsd: Math.min(maxUsd, Math.max(minUsd, tailMean)), degenerate: false };
    }
  }
  const logDenom = logNormalInterval(alpha, beta);
  const logNum = logNormalInterval(alpha - sigma, beta - sigma);
  if (Number.isFinite(logDenom) && Number.isFinite(logNum)) {
    const rawMean = Math.exp(mu + 0.5 * sigma * sigma + (logNum - logDenom));
    if (Number.isFinite(rawMean) && rawMean > 0) {
      return { meanUsd: Math.min(maxUsd, Math.max(minUsd, rawMean)), degenerate: false };
    }
  }
  const clamped = Math.min(hiLog, Math.max(loLog, mu));
  return { meanUsd: Math.exp(clamped), degenerate: true };
}

// Symmetric Jacobi eigendecomposition A = V * diag(values) * V^T for unpenalized rank-revealing OLS & estimability checks
function jacobiSymmetricEigen(matrix: readonly (readonly number[])[]): {
  values: number[];
  vectors: number[][];
} {
  const n = matrix.length;
  const a = matrix.map((row) => [...row]);
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (__, j) => (i === j ? 1 : 0)),
  );
  const maxSweeps = 100 * n * n + 50;
  for (let iter = 0; iter < maxSweeps; iter++) {
    let p = 0;
    let q = 1;
    let maxOff = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const val = Math.abs(a[i]![j]!);
        if (val > maxOff) {
          maxOff = val;
          p = i;
          q = j;
        }
      }
    }
    if (maxOff < 1e-13) break;
    const app = a[p]![p]!;
    const aqq = a[q]![q]!;
    const apq = a[p]![q]!;
    const tau = (aqq - app) / (2 * apq);
    const t = tau >= 0 ? 1 / (tau + Math.hypot(1, tau)) : -1 / (-tau + Math.hypot(1, tau));
    const c = 1 / Math.hypot(1, t);
    const s = t * c;
    a[p]![p] = app - t * apq;
    a[q]![q] = aqq + t * apq;
    a[p]![q] = 0;
    a[q]![p] = 0;
    for (let r = 0; r < n; r++) {
      if (r === p || r === q) continue;
      const arp = a[r]![p]!;
      const arq = a[r]![q]!;
      a[r]![p] = c * arp - s * arq;
      a[p]![r] = a[r]![p]!;
      a[r]![q] = s * arp + c * arq;
      a[q]![r] = a[r]![q]!;
    }
    for (let r = 0; r < n; r++) {
      const vrp = v[r]![p]!;
      const vrq = v[r]![q]!;
      v[r]![p] = c * vrp - s * vrq;
      v[r]![q] = s * vrp + c * vrq;
    }
  }
  const values = Array.from({ length: n }, (_, i) => a[i]![i]!);
  return { values, vectors: v };
}

interface UnpenalizedOlsFit {
  beta: number[];
  rank: number;
  activeLambdas: number[];
  activeVecs: number[][];
  isEstimable: (x: readonly number[]) => boolean;
  leverage: (x: readonly number[]) => number;
}

function fitUnpenalizedOls(
  designRows: readonly (readonly number[])[],
  y: readonly number[],
): UnpenalizedOlsFit {
  const n = designRows.length;
  const p = designRows[0]?.length ?? 0;
  const xtx: number[][] = Array.from({ length: p }, () => Array.from({ length: p }, () => 0));
  const xty = Array.from({ length: p }, () => 0);
  for (let i = 0; i < n; i++) {
    const x = designRows[i]!;
    const yi = y[i]!;
    for (let r = 0; r < p; r++) {
      const xr = x[r]!;
      if (xr === 0) continue;
      xty[r] = xty[r]! + xr * yi;
      for (let c = r; c < p; c++) {
        const xc = x[c]!;
        if (xc !== 0) xtx[r]![c] = xtx[r]![c]! + xr * xc;
      }
    }
  }
  for (let r = 0; r < p; r++) {
    for (let c = 0; c < r; c++) xtx[r]![c] = xtx[c]![r]!;
  }
  const { values, vectors } = jacobiSymmetricEigen(xtx);
  const maxLam = values.reduce((m, v) => Math.max(m, v), 0);
  const tol = Math.max(1e-10, maxLam * 1e-8);
  const activeLambdas: number[] = [];
  const activeVecs: number[][] = [];
  for (let j = 0; j < p; j++) {
    const lam = values[j]!;
    if (lam > tol) {
      activeLambdas.push(lam);
      activeVecs.push(Array.from({ length: p }, (_, r) => vectors[r]![j]!));
    }
  }
  const rank = activeLambdas.length;
  const beta = Array.from({ length: p }, () => 0);
  for (let k = 0; k < rank; k++) {
    const q = activeVecs[k]!;
    let dot = 0;
    for (let r = 0; r < p; r++) dot += q[r]! * xty[r]!;
    const coeff = dot / activeLambdas[k]!;
    for (let r = 0; r < p; r++) beta[r] = beta[r]! + coeff * q[r]!;
  }
  const isEstimable = (x: readonly number[]): boolean => {
    let xNormSq = 0;
    let projNormSq = 0;
    for (let r = 0; r < p; r++) xNormSq += x[r]! * x[r]!;
    for (let k = 0; k < rank; k++) {
      const q = activeVecs[k]!;
      let dot = 0;
      for (let r = 0; r < p; r++) dot += q[r]! * x[r]!;
      projNormSq += dot * dot;
    }
    return Math.max(0, xNormSq - projNormSq) <= 1e-10 * Math.max(1, xNormSq);
  };
  const leverage = (x: readonly number[]): number => {
    let h = 0;
    for (let k = 0; k < rank; k++) {
      const q = activeVecs[k]!;
      let dot = 0;
      for (let r = 0; r < p; r++) dot += q[r]! * x[r]!;
      h += (dot * dot) / activeLambdas[k]!;
    }
    return Math.max(0, h);
  };
  return { beta, rank, activeLambdas, activeVecs, isEstimable, leverage };
}

// Frisch-Waugh-Lovell residual variance of target column after projecting out nuisance design columns via Modified Gram-Schmidt
function partialVarianceAfterProjection(
  target: readonly number[],
  nuisanceCols: readonly (readonly number[])[],
): number {
  const n = target.length;
  if (n === 0) return 0;
  const basis: number[][] = [];
  for (const col of nuisanceCols) {
    const v = [...col];
    for (const q of basis) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += q[i]! * v[i]!;
      for (let i = 0; i < n; i++) v[i] = v[i]! - dot * q[i]!;
    }
    let normSq = 0;
    for (let i = 0; i < n; i++) normSq += v[i]! * v[i]!;
    if (normSq > 1e-12) {
      const invNorm = 1 / Math.sqrt(normSq);
      for (let i = 0; i < n; i++) v[i] = v[i]! * invNorm;
      basis.push(v);
    }
  }
  const resid = [...target];
  for (const q of basis) {
    let dot = 0;
    for (let i = 0; i < n; i++) dot += q[i]! * resid[i]!;
    for (let i = 0; i < n; i++) resid[i] = resid[i]! - dot * q[i]!;
  }
  let rss = 0;
  for (let i = 0; i < n; i++) rss += resid[i]! * resid[i]!;
  return rss / n;
}

function isVerifiedFirstPartyTextPricing(
  pricing: PricingRecord | null,
  provider: ProviderId,
  modelSlug: string,
): pricing is PricingRecord {
  return (
    pricing !== null &&
    !isRetiredPurchaseSku(provider, modelSlug) &&
    pricing.sourceId === "litellm" &&
    pricing.servingProvider === provider &&
    pricing.apiSku !== null &&
    (pricing.inputPer1mUsd > 0 || pricing.outputPer1mUsd > 0)
  );
}

// Resolves one homogeneous cost axis per domain regime and withholds retired SKUs across every cost path
export function resolveDomainCostsWithModel(
  domainId: DomainId,
  rows: readonly CostInputRow[],
  pricingBySlug: ReadonlyMap<string, PricingRecord>,
  expectedMeasuredBenchmarkIds?: readonly string[],
): {
  costs: Map<string, ResolvedCost>;
  partialBasketModel: PartialBasketCostModel | null;
  costBootstrapModel: DomainCostBootstrapModel | null;
} {
  const out = new Map<string, ResolvedCost>();

  if (domainId === "writing") {
    // Standardized 10k-in / 4k-out brief priced strictly on currently served first-party API list SKUs
    const WRITING_IN_M = 0.01;
    const WRITING_OUT_M = 0.004;

    for (const row of rows) {
      const retired = isRetiredPurchaseSku(row.provider, row.modelSlug);
      const pricing = retired ? null : (pricingBySlug.get(row.modelSlug) ?? null);
      const firstParty = isVerifiedFirstPartyTextPricing(pricing, row.provider, row.modelSlug)
        ? pricing
        : null;
      const inputPrice = firstParty ? firstParty.inputPer1mUsd : null;
      const outputPrice = firstParty ? firstParty.outputPer1mUsd : null;
      const blended =
        inputPrice !== null && outputPrice !== null
          ? Number(((3 * inputPrice + outputPrice) / 4).toFixed(4))
          : null;
      const briefCost =
        inputPrice !== null && outputPrice !== null
          ? Number((WRITING_IN_M * inputPrice + WRITING_OUT_M * outputPrice).toFixed(6))
          : null;

      out.set(row.configId, {
        effectiveCostUsd: briefCost,
        costImputed: false,
        costEstimated: false,
        costUnit: "usd_per_task",
        costSource: "list",
        blendedListPricePer1mUsd: blended,
        inputPer1mUsd: inputPrice,
        outputPer1mUsd: outputPrice,
        contextWindow: firstParty?.contextWindow ?? null,
      });
    }
    return { costs: out, partialBasketModel: null, costBootstrapModel: null };
  }

  // Registry basket is authoritative: an explicit empty basket keeps suite pricing instead of auto-switching to measured
  const expectedBasket =
    expectedMeasuredBenchmarkIds !== undefined ? [...new Set(expectedMeasuredBenchmarkIds)] : null;
  const expectedBasketSet = expectedBasket ? new Set(expectedBasket) : null;

  // Average observed dollar costs directly; use log-Rasch solely to impute missing benchmarks when the full basket connects
  const logCostCells: { configId: string; benchmarkId: string; zScore: number }[] = [];
  const observedCostByConfig = new Map<string, Map<string, number>>();
  const estimatedCostByConfig = new Map<string, boolean>();
  const allPricedBenchmarkSet = new Set<string>();
  for (const row of rows) {
    for (const bm of row.benchmarks) {
      if (expectedBasketSet !== null && !expectedBasketSet.has(bm.benchmarkId)) continue;
      if (
        bm.measuredCostUsd !== null &&
        Number.isFinite(bm.measuredCostUsd) &&
        bm.measuredCostUsd > 0
      ) {
        allPricedBenchmarkSet.add(bm.benchmarkId);
        logCostCells.push({
          configId: row.configId,
          benchmarkId: bm.benchmarkId,
          zScore: Math.log(bm.measuredCostUsd),
        });
        const map = observedCostByConfig.get(row.configId) ?? new Map<string, number>();
        map.set(bm.benchmarkId, bm.measuredCostUsd);
        observedCostByConfig.set(row.configId, map);
        if (bm.measuredCostEstimated) {
          estimatedCostByConfig.set(row.configId, true);
        }
      }
    }
  }

  const allPricedBenchmarkIds = expectedBasket ?? [...allPricedBenchmarkSet];
  const usesBenchmarkMeasured =
    expectedBasket !== null ? expectedBasket.length > 0 : logCostCells.length > 0;
  const costFit =
    usesBenchmarkMeasured && logCostCells.length > 0 ? solveTwoWayLinearRasch(logCostCells) : null;
  const fullBasketConnected =
    Boolean(costFit?.tauResidIdentified) &&
    allPricedBenchmarkIds.length > 0 &&
    allPricedBenchmarkIds.every((id) => costFit!.deltaByBenchmark.has(id));
  const deltaCovIndex = new Map<string, number>(
    (costFit?.deltaCovByBenchmark?.freeBenchmarks ?? []).map((id, idx) => [id, idx]),
  );
  const deltaCovMat = costFit?.deltaCovByBenchmark?.covMatrix ?? null;
  const contrastDeltaCov = (
    wA: ReadonlyMap<string, number>,
    wB: ReadonlyMap<string, number>,
  ): number => {
    if (!deltaCovMat || deltaCovIndex.size === 0) return 0;
    const entriesA: { idx: number; w: number }[] = [];
    for (const [bmId, w] of wA.entries()) {
      const idx = deltaCovIndex.get(bmId);
      if (idx !== undefined && w !== 0) entriesA.push({ idx, w });
    }
    const entriesB: { idx: number; w: number }[] = [];
    for (const [bmId, w] of wB.entries()) {
      const idx = deltaCovIndex.get(bmId);
      if (idx !== undefined && w !== 0) entriesB.push({ idx, w });
    }
    let quad = 0;
    for (const a of entriesA) {
      const row = deltaCovMat[a.idx]!;
      for (const b of entriesB) quad += a.w * row[b.idx]! * b.w;
    }
    return quad;
  };
  const partialBasketByConfigId = new Map<string, PartialBasketConfigModel>();
  const partialTermsByConfigId = new Map<
    string,
    {
      sumDollars: number;
      obsInvK: number;
      missingTerms: readonly {
        benchmarkId: string;
        logCenter: number;
        mean: number;
        contrast: Map<string, number>;
      }[];
    }
  >();

  for (const row of rows) {
    const retired = isRetiredPurchaseSku(row.provider, row.modelSlug);
    const pricing = retired ? null : (pricingBySlug.get(row.modelSlug) ?? null);
    const firstParty = isVerifiedFirstPartyTextPricing(pricing, row.provider, row.modelSlug)
      ? pricing
      : null;
    const inputPrice = firstParty ? firstParty.inputPer1mUsd : null;
    const outputPrice = firstParty ? firstParty.outputPer1mUsd : null;
    const blended =
      inputPrice !== null && outputPrice !== null
        ? Number(((3 * inputPrice + outputPrice) / 4).toFixed(4))
        : null;

    let effectiveCostUsd: number | null = null;
    let partialCostFixedFloorUsd: number | undefined;
    let partialCostLogSd: number | undefined;
    let costImputed = false;
    let costEstimated = false;
    if (!retired) {
      if (usesBenchmarkMeasured && allPricedBenchmarkIds.length > 0) {
        const obsMap = observedCostByConfig.get(row.configId);
        if (obsMap && allPricedBenchmarkIds.every((bmId) => obsMap.has(bmId))) {
          let sumDollars = 0;
          for (const bmId of allPricedBenchmarkIds) sumDollars += obsMap.get(bmId)!;
          effectiveCostUsd = Number((sumDollars / allPricedBenchmarkIds.length).toFixed(6));
          costImputed = false;
          costEstimated = estimatedCostByConfig.get(row.configId) ?? false;
        } else if (
          fullBasketConnected &&
          costFit &&
          obsMap &&
          obsMap.size > 0 &&
          inputPrice !== null &&
          outputPrice !== null
        ) {
          const logTheta = costFit.thetaByConfig.get(row.configId);
          if (logTheta !== undefined && Number.isFinite(logTheta)) {
            let sumDollars = 0;
            let measuredDollars = 0;
            const obsIds = [...obsMap.keys()];
            const obsInvK = 1 / obsIds.length;
            const missingTerms: {
              benchmarkId: string;
              logCenter: number;
              mean: number;
              contrast: Map<string, number>;
            }[] = [];
            for (const bmId of allPricedBenchmarkIds) {
              const direct = obsMap.get(bmId);
              if (direct !== undefined) {
                sumDollars += direct;
                measuredDollars += direct;
              } else {
                const contrast = new Map<string, number>();
                for (const obsBmId of obsIds) {
                  contrast.set(obsBmId, (contrast.get(obsBmId) ?? 0) - obsInvK);
                }
                contrast.set(bmId, (contrast.get(bmId) ?? 0) + 1);
                // Exact prediction variance: tau^2 * (1 + 1/k) + Var(delta_b - mean(delta_obs))
                const singleMissingVar =
                  costFit.tauResidSq * (1 + obsInvK) +
                  Math.max(0, contrastDeltaCov(contrast, contrast));
                const delta = costFit.deltaByBenchmark.get(bmId) ?? 0;
                const logCenter = logTheta + delta;
                const est = Math.exp(logCenter + 0.5 * singleMissingVar);
                sumDollars += est;
                missingTerms.push({ benchmarkId: bmId, logCenter, mean: est, contrast });
              }
            }
            const missingCount = missingTerms.length;
            effectiveCostUsd = Number((sumDollars / allPricedBenchmarkIds.length).toFixed(6));
            costImputed = missingCount > 0;
            if (missingCount > 0 && sumDollars > 0) {
              partialCostFixedFloorUsd = Number(
                (measuredDollars / allPricedBenchmarkIds.length).toFixed(6),
              );
              // Exact first-two-moment Fenton-Wilkinson log-variance of missing sum and full basket
              let missMeanSum = 0;
              for (const t of missingTerms) missMeanSum += t.mean;
              let missDollarVar = 0;
              for (let a = 0; a < missingTerms.length; a++) {
                const ta = missingTerms[a]!;
                for (let b = 0; b < missingTerms.length; b++) {
                  const tb = missingTerms[b]!;
                  const covLog =
                    costFit.tauResidSq * ((a === b ? 1 : 0) + obsInvK) +
                    contrastDeltaCov(ta.contrast, tb.contrast);
                  missDollarVar += ta.mean * tb.mean * Math.expm1(covLog);
                }
              }
              const missingBasketVar =
                missMeanSum > 0 && missDollarVar > 0
                  ? Math.log1p(missDollarVar / (missMeanSum * missMeanSum))
                  : 0;
              const totalLogVar =
                sumDollars > 0 && missDollarVar > 0
                  ? Math.log1p(missDollarVar / (sumDollars * sumDollars))
                  : 0;
              if (missingBasketVar > 0) {
                const sd = Math.sqrt(missingBasketVar);
                if (Number.isFinite(sd) && sd > 0) partialCostLogSd = Number(sd.toFixed(4));
              }
              partialBasketByConfigId.set(row.configId, {
                observedIds: obsIds,
                fixedFloorUsd: partialCostFixedFloorUsd,
                meanUsd: effectiveCostUsd,
                totalLogVar,
                missingTerms: missingTerms.map((t) => ({
                  benchmarkId: t.benchmarkId,
                  logCenter: t.logCenter,
                })),
              });
              partialTermsByConfigId.set(row.configId, {
                sumDollars,
                obsInvK,
                missingTerms,
              });
            }
            costEstimated = estimatedCostByConfig.get(row.configId) ?? false;
          }
        }
      } else if (
        row.suiteCostUsd !== null &&
        Number.isFinite(row.suiteCostUsd) &&
        row.suiteCostUsd > 0
      ) {
        effectiveCostUsd = Number(row.suiteCostUsd.toFixed(6));
      }
    }

    out.set(row.configId, {
      effectiveCostUsd,
      ...(partialCostFixedFloorUsd !== undefined && partialCostFixedFloorUsd > 0
        ? { costFixedFloorUsd: partialCostFixedFloorUsd }
        : {}),
      ...(partialCostLogSd !== undefined ? { costLogSd: partialCostLogSd } : {}),
      costImputed,
      costEstimated,
      costUnit: "usd_per_task",
      costSource: usesBenchmarkMeasured ? "measured" : "suite",
      blendedListPricePer1mUsd: blended,
      inputPer1mUsd: inputPrice,
      outputPer1mUsd: outputPrice,
      contextWindow: firstParty?.contextWindow ?? null,
    });
  }

  // Joint OLS log(cost) = alpha + beta*log(rate) + gamma_effort (+ eta_harness on harnesses) with active-set monotone effort pooling
  const useHarnessEffects = domainId === "harnesses";
  const allCalPts: {
    logRate: number;
    logCost: number;
    effort: string;
    harness: string;
    modelSlug: string;
    imputed: boolean;
  }[] = [];
  const measuredByGroup = new Map<
    string,
    {
      configId: string;
      effort: string;
      logCost: number;
      expectedLogCost: number;
      imputed: boolean;
      estimated: boolean;
    }[]
  >();
  const measuredHarnesses = new Set<string>();
  const directMeasuredHarnesses = new Set<string>();

  for (const row of rows) {
    const cur = out.get(row.configId);
    if (
      !cur ||
      cur.effectiveCostUsd === null ||
      cur.effectiveCostUsd <= 0 ||
      cur.inputPer1mUsd === null ||
      cur.outputPer1mUsd === null
    ) {
      continue;
    }
    const rate = weightedTokenRate(cur.inputPer1mUsd, cur.outputPer1mUsd);
    if (rate <= 0) continue;
    const pbSpec = partialBasketByConfigId.get(row.configId);
    const logCost = Math.log(cur.effectiveCostUsd);
    // Debias E[log C] = log(E[C]) - 0.5*Var(log C) for partial-basket rows so missing-benchmark Jensen inflation never biases OLS or siblings
    const expectedLogCost = pbSpec ? logCost - 0.5 * pbSpec.totalLogVar : logCost;
    const harnessKey = row.harness ?? "direct";
    allCalPts.push({
      logRate: Math.log(rate),
      logCost: expectedLogCost,
      effort: row.effort,
      harness: harnessKey,
      modelSlug: row.modelSlug,
      imputed: cur.costImputed,
    });
    if (useHarnessEffects) {
      measuredHarnesses.add(harnessKey);
      if (!cur.costImputed) directMeasuredHarnesses.add(harnessKey);
    }
    const groupKey = useHarnessEffects ? `${row.modelSlug}::${harnessKey}` : row.modelSlug;
    const list = measuredByGroup.get(groupKey) ?? [];
    list.push({
      configId: row.configId,
      effort: row.effort,
      logCost,
      expectedLogCost,
      imputed: cur.costImputed,
      estimated: cur.costEstimated,
    });
    measuredByGroup.set(groupKey, list);
  }

  // Prefer 100% directly observed calibrators whenever >= 8 exist and cover all measured harnesses
  const directCalPts = allCalPts.filter((p) => !p.imputed);
  const allHarnessesCoveredDirect =
    !useHarnessEffects || [...measuredHarnesses].every((h) => directMeasuredHarnesses.has(h));
  const calPts = directCalPts.length >= 8 && allHarnessesCoveredDirect ? directCalPts : allCalPts;

  const siblingBaselines = new Map<string, SiblingBaselineCostEntry>();
  const unidentifiedCells = new Map<string, UnidentifiedCellCostEntry>();
  let olsModel: OlsCostBootstrapModel | null = null;

  if (calPts.length >= 8) {
    const effortCounts = new Map<string, number>();
    const harnessCounts = new Map<string, number>();
    for (const p of calPts) {
      effortCounts.set(p.effort, (effortCounts.get(p.effort) ?? 0) + 1);
      if (useHarnessEffects) {
        harnessCounts.set(p.harness, (harnessCounts.get(p.harness) ?? 0) + 1);
      }
    }
    const effortLevels = [...effortCounts.keys()].toSorted(compareAscii);
    const harnessLevels = useHarnessEffects ? [...harnessCounts.keys()].toSorted(compareAscii) : [];

    // Verify conditional tariff variation after controlling for effort and harness (Frisch-Waugh-Lovell identification)
    const nCal = calPts.length;
    const nuisanceCols: number[][] = [Array.from({ length: nCal }, () => 1)];
    for (let i = 1; i < effortLevels.length; i++) {
      const lvl = effortLevels[i]!;
      nuisanceCols.push(calPts.map((p) => (p.effort === lvl ? 1 : 0)));
    }
    for (let i = 1; i < harnessLevels.length; i++) {
      const lvl = harnessLevels[i]!;
      nuisanceCols.push(calPts.map((p) => (p.harness === lvl ? 1 : 0)));
    }
    const partialVarLogRate = partialVarianceAfterProjection(
      calPts.map((p) => p.logRate),
      nuisanceCols,
    );
    const tariffSlopeIdentified = partialVarLogRate > 1e-6;

    // Key unidentified-tariff cells by exact (effort, harness, tariff) so distinct tariffs never mix
    const cellLogsByKey = new Map<string, { logRate: number; vals: number[] }>();
    const fullCellKey = (effort: string, harness: string, logRate: number): string => {
      const rateKey = logRate.toFixed(6);
      return useHarnessEffects ? `${effort}::${harness}::${rateKey}` : `${effort}::${rateKey}`;
    };
    for (const p of calPts) {
      const ck = fullCellKey(p.effort, p.harness, p.logRate);
      const entry = cellLogsByKey.get(ck) ?? { logRate: p.logRate, vals: [] };
      entry.vals.push(p.logCost);
      cellLogsByKey.set(ck, entry);
    }
    const cellMeanByKey = new Map<string, number>();
    let cellResidSqSum = 0;
    let cellDf = 0;
    for (const [ck, entry] of cellLogsByKey.entries()) {
      const mean = entry.vals.reduce((s, v) => s + v, 0) / entry.vals.length;
      cellMeanByKey.set(ck, mean);
      if (entry.vals.length > 1) {
        for (const v of entry.vals) cellResidSqSum += (v - mean) * (v - mean);
        cellDf += entry.vals.length - 1;
      }
    }
    const cellResidVar = cellDf > 0 ? cellResidSqSum / cellDf : 0;

    // Fit unpenalized rank-revealing OLS to check pre-pooling Gauss-Markov estimability
    const dummyStart = tariffSlopeIdentified ? 2 : 1;
    const effColByLevel = new Map<string, number>();
    for (let i = 1; i < effortLevels.length; i++) {
      effColByLevel.set(effortLevels[i]!, dummyStart + (i - 1));
    }
    const harnessColStart = dummyStart + Math.max(0, effortLevels.length - 1);
    const harnessColByLevel = new Map<string, number>();
    for (let i = 1; i < harnessLevels.length; i++) {
      harnessColByLevel.set(harnessLevels[i]!, harnessColStart + (i - 1));
    }
    const rawDim = harnessColStart + Math.max(0, harnessLevels.length - 1);
    const buildRawRow = (logRate: number, effort: string, harness: string): number[] | null => {
      const x = Array.from({ length: rawDim }, () => 0);
      x[0] = 1;
      if (tariffSlopeIdentified) x[1] = logRate;
      if (effortCounts.has(effort)) {
        const ec = effColByLevel.get(effort);
        if (ec !== undefined) x[ec] = 1;
      } else if (effort === "thinking") {
        const avail = ["medium", "high"].filter((t) => effortCounts.has(t));
        if (avail.length === 0) return null;
        for (const t of avail) {
          const ec = effColByLevel.get(t);
          if (ec !== undefined) x[ec] = x[ec]! + 1 / avail.length;
        }
      } else {
        const tierIdx = ORDERED_EFFORT_LADDER.indexOf(
          effort as (typeof ORDERED_EFFORT_LADDER)[number],
        );
        if (tierIdx < 0) return null;
        let prevTier: string | null = null;
        let nextTier: string | null = null;
        for (let l = tierIdx - 1; l >= 0; l--) {
          if (effortCounts.has(ORDERED_EFFORT_LADDER[l]!)) {
            prevTier = ORDERED_EFFORT_LADDER[l]!;
            break;
          }
        }
        for (let r = tierIdx + 1; r < ORDERED_EFFORT_LADDER.length; r++) {
          if (effortCounts.has(ORDERED_EFFORT_LADDER[r]!)) {
            nextTier = ORDERED_EFFORT_LADDER[r]!;
            break;
          }
        }
        const neighbors = [prevTier, nextTier].filter((t): t is string => t !== null);
        if (neighbors.length === 0) return null;
        for (const nb of neighbors) {
          const ec = effColByLevel.get(nb);
          if (ec !== undefined) x[ec] = x[ec]! + 1 / neighbors.length;
        }
      }
      if (useHarnessEffects) {
        if (!measuredHarnesses.has(harness)) return null;
        const hc = harnessColByLevel.get(harness);
        if (hc !== undefined) x[hc] = 1;
      }
      return x;
    };

    const rawDesign = calPts.map((p) => buildRawRow(p.logRate, p.effort, p.harness)!);
    const yLogCosts = calPts.map((p) => p.logCost);
    const initialFit = fitUnpenalizedOls(rawDesign, yLogCosts);

    // Active-set monotone effort OLS: iteratively merge violated adjacent effort blocks and refit jointly until beta itself is monotone
    const observedLadder = ORDERED_EFFORT_LADDER.filter((e) => effortCounts.has(e));
    const ladderBlocks: string[][] = observedLadder.map((e) => [e]);
    const nonLadderEfforts = effortLevels.filter(
      (e) => !(ORDERED_EFFORT_LADDER as readonly string[]).includes(e),
    );

    const buildActiveBlockState = () => {
      const blockByEffort = new Map<string, string>();
      const blockNames: string[] = [];
      for (let bi = 0; bi < ladderBlocks.length; bi++) {
        const bName = `pava_${bi}`;
        blockNames.push(bName);
        for (const tier of ladderBlocks[bi]!) blockByEffort.set(tier, bName);
      }
      for (const nl of nonLadderEfforts) {
        blockByEffort.set(nl, nl);
        blockNames.push(nl);
      }
      const effCol = new Map<string, number>();
      for (let i = 1; i < blockNames.length; i++) {
        effCol.set(blockNames[i]!, dummyStart + (i - 1));
      }
      const hStart = dummyStart + Math.max(0, blockNames.length - 1);
      const hCol = new Map<string, number>();
      for (let i = 1; i < harnessLevels.length; i++) {
        hCol.set(harnessLevels[i]!, hStart + (i - 1));
      }
      const dim = hStart + Math.max(0, harnessLevels.length - 1);
      const buildRow = (logRate: number, effort: string, harness: string): number[] | null => {
        const x = Array.from({ length: dim }, () => 0);
        x[0] = 1;
        if (tariffSlopeIdentified) x[1] = logRate;
        const directBlock = blockByEffort.get(effort);
        if (directBlock !== undefined) {
          const ec = effCol.get(directBlock);
          if (ec !== undefined) x[ec] = 1;
        } else if (effort === "thinking") {
          const mBlock = blockByEffort.get("medium");
          const hBlock = blockByEffort.get("high");
          const blocks = [mBlock, hBlock].filter((b): b is string => b !== undefined);
          if (blocks.length === 0) return null;
          for (const b of blocks) {
            const ec = effCol.get(b);
            if (ec !== undefined) x[ec] = x[ec]! + 1 / blocks.length;
          }
        } else {
          const tierIdx = ORDERED_EFFORT_LADDER.indexOf(
            effort as (typeof ORDERED_EFFORT_LADDER)[number],
          );
          if (tierIdx < 0) return null;
          let prevTier: string | null = null;
          let nextTier: string | null = null;
          for (let l = tierIdx - 1; l >= 0; l--) {
            if (blockByEffort.has(ORDERED_EFFORT_LADDER[l]!)) {
              prevTier = ORDERED_EFFORT_LADDER[l]!;
              break;
            }
          }
          for (let r = tierIdx + 1; r < ORDERED_EFFORT_LADDER.length; r++) {
            if (blockByEffort.has(ORDERED_EFFORT_LADDER[r]!)) {
              nextTier = ORDERED_EFFORT_LADDER[r]!;
              break;
            }
          }
          const neighbors = [prevTier, nextTier].filter((t): t is string => t !== null);
          if (neighbors.length === 0) return null;
          for (const nb of neighbors) {
            const ec = effCol.get(blockByEffort.get(nb)!);
            if (ec !== undefined) x[ec] = x[ec]! + 1 / neighbors.length;
          }
        }
        if (useHarnessEffects) {
          if (!measuredHarnesses.has(harness)) return null;
          const hc = hCol.get(harness);
          if (hc !== undefined) x[hc] = 1;
        }
        return x;
      };

      const design = calPts.map((p) => buildRow(p.logRate, p.effort, p.harness)!);
      const fit = fitUnpenalizedOls(design, yLogCosts);
      const rawSlope = tariffSlopeIdentified ? (fit.beta[1] ?? 1) : 0;
      const slopeClamped = tariffSlopeIdentified && (rawSlope < 0.3 || rawSlope > 1.5);
      const clampedSlope = tariffSlopeIdentified ? Math.min(1.5, Math.max(0.3, rawSlope)) : 0;
      let activeFit = fit;
      let activeDesign = design;
      let activeY = yLogCosts;
      if (slopeClamped) {
        activeDesign = design.map((row) => [row[0]!, ...row.slice(2)]);
        activeY = calPts.map((p) => p.logCost - clampedSlope * p.logRate);
        activeFit = fitUnpenalizedOls(activeDesign, activeY);
      }
      const blockOffStart = tariffSlopeIdentified && !slopeClamped ? 2 : 1;
      const ladderVals = ladderBlocks.map((_, bi) =>
        bi === 0 ? 0 : (activeFit.beta[blockOffStart + (bi - 1)] ?? 0),
      );
      return {
        blockByEffort,
        blockNames,
        buildRow,
        slopeClamped,
        clampedSlope,
        activeFit,
        activeDesign,
        activeY,
        blockOffStart,
        ladderVals,
      };
    };

    let state = buildActiveBlockState();
    while (ladderBlocks.length >= 2) {
      let worstIdx = -1;
      let worstGap = 1e-10;
      for (let bi = 0; bi < ladderBlocks.length - 1; bi++) {
        const gap = state.ladderVals[bi]! - state.ladderVals[bi + 1]!;
        if (gap > worstGap) {
          worstGap = gap;
          worstIdx = bi;
        }
      }
      if (worstIdx < 0) break;
      ladderBlocks[worstIdx] = [...ladderBlocks[worstIdx]!, ...ladderBlocks[worstIdx + 1]!];
      ladderBlocks.splice(worstIdx + 1, 1);
      state = buildActiveBlockState();
    }

    const {
      blockByEffort: pavaBlockByEffort,
      blockNames: pooledEffortBlocks,
      buildRow: buildPooledRow,
      slopeClamped,
      clampedSlope,
      activeFit,
      activeDesign,
      activeY,
      blockOffStart,
    } = state;

    // Derive effort offsets directly from the converged monotone activeFit coefficients
    const effortOffset = new Map<string, number>();
    const refitEffOffset = new Map<string, number>();
    for (const lvl of effortLevels) {
      const blk = pavaBlockByEffort.get(lvl)!;
      const bi = pooledEffortBlocks.indexOf(blk);
      refitEffOffset.set(lvl, bi > 0 ? (activeFit.beta[blockOffStart + (bi - 1)] ?? 0) : 0);
    }
    for (const tier of ORDERED_EFFORT_LADDER) {
      const v = refitEffOffset.get(tier);
      if (v !== undefined) effortOffset.set(tier, v);
    }
    for (let i = 0; i < ORDERED_EFFORT_LADDER.length; i++) {
      const tier = ORDERED_EFFORT_LADDER[i]!;
      if (effortOffset.has(tier)) continue;
      let prevVal: number | null = null;
      let nextVal: number | null = null;
      for (let l = i - 1; l >= 0; l--) {
        const v = effortOffset.get(ORDERED_EFFORT_LADDER[l]!);
        if (v !== undefined) {
          prevVal = v;
          break;
        }
      }
      for (let r = i + 1; r < ORDERED_EFFORT_LADDER.length; r++) {
        const v = effortOffset.get(ORDERED_EFFORT_LADDER[r]!);
        if (v !== undefined) {
          nextVal = v;
          break;
        }
      }
      if (prevVal !== null && nextVal !== null) effortOffset.set(tier, (prevVal + nextVal) / 2);
      else if (prevVal !== null) effortOffset.set(tier, prevVal);
      else if (nextVal !== null) effortOffset.set(tier, nextVal);
    }
    const ladderValsAll = [...effortOffset.values()];
    const minEffVal = ladderValsAll.length > 0 ? Math.min(...ladderValsAll) : 0;
    const maxEffVal = ladderValsAll.length > 0 ? Math.max(...ladderValsAll) : 0;
    const rawThinking = refitEffOffset.get("thinking");
    if (rawThinking !== undefined) {
      effortOffset.set("thinking", Math.min(maxEffVal, Math.max(minEffVal, rawThinking)));
    } else {
      const med = effortOffset.get("medium");
      const hi = effortOffset.get("high");
      effortOffset.set(
        "thinking",
        med !== undefined && hi !== undefined ? (med + hi) / 2 : (med ?? hi ?? 0),
      );
    }

    let residSqSum = 0;
    for (let i = 0; i < calPts.length; i++) {
      const x = activeDesign[i]!;
      let pred = 0;
      for (let c = 0; c < x.length; c++) pred += x[c]! * activeFit.beta[c]!;
      const resid = activeY[i]! - pred;
      residSqSum += resid * resid;
    }
    const olsDf = calPts.length - activeFit.rank;
    const residVar = olsDf > 0 ? residSqSum / olsDf : 0;

    // Estimate within-model effort residual variance strictly from directly observed multi-effort groups
    let withinSqSum = 0;
    let withinDf = 0;
    for (const obsList of measuredByGroup.values()) {
      const directList = obsList.filter((o) => !o.imputed);
      const useList = directList.length >= 2 ? directList : obsList;
      if (useList.length < 2) continue;
      const baseMean =
        useList.reduce((s, o) => s + (o.expectedLogCost - (effortOffset.get(o.effort) ?? 0)), 0) /
        useList.length;
      for (const o of useList) {
        const diff = o.expectedLogCost - (baseMean + (effortOffset.get(o.effort) ?? 0));
        withinSqSum += diff * diff;
      }
      withinDf += useList.length - 1;
    }
    const hasFallbackDf = tariffSlopeIdentified ? olsDf > 0 : cellDf > 0;
    const fallbackResidVar = tariffSlopeIdentified ? residVar : cellResidVar;
    const hasWithinVariance = withinDf >= 3 || hasFallbackDf;
    const withinModelVar =
      withinDf >= 3 ? Math.min(fallbackResidVar, withinSqSum / withinDf) : fallbackResidVar;

    // Compute exact log-cost covariance between two partial-basket parents sharing benchmark offsets
    const partialParentLogCov = (idA: string, idB: string): number => {
      const pA = partialTermsByConfigId.get(idA);
      const pB = partialTermsByConfigId.get(idB);
      if (!pA || !pB || !(pA.sumDollars > 0) || !(pB.sumDollars > 0) || !costFit) return 0;
      let covDollars = 0;
      for (let i = 0; i < pA.missingTerms.length; i++) {
        const ta = pA.missingTerms[i]!;
        for (let j = 0; j < pB.missingTerms.length; j++) {
          const tb = pB.missingTerms[j]!;
          const sameConfig = idA === idB;
          const covLog =
            (sameConfig ? costFit.tauResidSq * ((i === j ? 1 : 0) + pA.obsInvK) : 0) +
            contrastDeltaCov(ta.contrast, tb.contrast);
          covDollars += ta.mean * tb.mean * Math.expm1(covLog);
        }
      }
      const ratio = covDollars / (pA.sumDollars * pB.sumDollars);
      return ratio > -0.999 ? Math.max(0, Math.log1p(ratio)) : 0;
    };

    const olsEntries = new Map<string, { xVec: readonly number[]; predMeanLog: number }>();

    for (const row of rows) {
      if (isRetiredPurchaseSku(row.provider, row.modelSlug)) continue;
      const cur = out.get(row.configId);
      if (!cur || cur.effectiveCostUsd !== null) continue;
      if (cur.inputPer1mUsd === null || cur.outputPer1mUsd === null) continue;
      const rate = weightedTokenRate(cur.inputPer1mUsd, cur.outputPer1mUsd);
      if (rate <= 0) continue;

      const harnessKey = row.harness ?? "direct";
      // Never infer a harness cost across unmeasured harnesses
      if (useHarnessEffects && !measuredHarnesses.has(harnessKey)) continue;

      const groupKey = useHarnessEffects ? `${row.modelSlug}::${harnessKey}` : row.modelSlug;
      const sameGroupAll = measuredByGroup.get(groupKey);
      const directParents = sameGroupAll?.filter((o) => !o.imputed) ?? [];
      const activeParents = directParents.length > 0 ? directParents : (sameGroupAll ?? []);
      const targetEffOff = effortOffset.get(row.effort) ?? 0;

      let inferredUsd: number;
      let inferredSd: number;
      let costMinUsd: number | undefined;
      let costMaxUsd: number | undefined;
      if (activeParents.length > 0) {
        if (!hasWithinVariance) continue;
        // Require Gauss-Markov estimability of the target-minus-observed effort contrast in the unpenalized design
        const targetRawX = buildRawRow(Math.log(rate), row.effort, harnessKey);
        if (!targetRawX) continue;
        const avgObsRawX = Array.from({ length: rawDim }, () => 0);
        let obsRowsValid = true;
        for (const obs of activeParents) {
          const ox = buildRawRow(Math.log(rate), obs.effort, harnessKey);
          if (!ox) {
            obsRowsValid = false;
            break;
          }
          for (let c = 0; c < rawDim; c++)
            avgObsRawX[c] = avgObsRawX[c]! + ox[c]! / activeParents.length;
        }
        if (!obsRowsValid) continue;
        const contrastVec = targetRawX.map((v, c) => v - avgObsRawX[c]!);
        if (!initialFit.isEstimable(contrastVec)) continue;

        let baseSum = 0;
        let obsEffSum = 0;
        let lowerBound = Number.NEGATIVE_INFINITY;
        let upperBound = Number.POSITIVE_INFINITY;
        const targetRank = ORDERED_EFFORT_RANK[row.effort];
        const parentPartialIds: string[] = [];
        for (const obs of activeParents) {
          const obsOff = effortOffset.get(obs.effort) ?? 0;
          baseSum += obs.expectedLogCost - obsOff;
          obsEffSum += obsOff;
          if (obs.imputed) parentPartialIds.push(obs.configId);
          if (!obs.imputed && !obs.estimated && targetRank !== undefined) {
            const obsRank = ORDERED_EFFORT_RANK[obs.effort];
            if (obsRank !== undefined) {
              if (obsRank < targetRank && obs.logCost > lowerBound) lowerBound = obs.logCost;
              if (obsRank > targetRank && obs.logCost < upperBound) upperBound = obs.logCost;
            }
          }
        }
        // Propagate parent partial-basket uncertainty into both published costLogSd and shared bootstrap draws
        let parentAvgVar = 0;
        if (parentPartialIds.length > 0) {
          const kP = activeParents.length;
          for (let a = 0; a < parentPartialIds.length; a++) {
            for (let b = 0; b < parentPartialIds.length; b++) {
              parentAvgVar +=
                partialParentLogCov(parentPartialIds[a]!, parentPartialIds[b]!) / (kP * kP);
            }
          }
        }
        const rawMu = baseSum / activeParents.length + targetEffOff;
        const withinPredVar = withinModelVar * (1 + 1 / activeParents.length);
        const predVar = withinPredVar + parentAvgVar;
        const predSd = Math.sqrt(Math.max(0, predVar));
        const predLogSd = Number(predSd.toFixed(4));
        const contradictory =
          Number.isFinite(lowerBound) && Number.isFinite(upperBound) && lowerBound > upperBound;
        const effLo = contradictory ? Number.NEGATIVE_INFINITY : lowerBound;
        const effHi = contradictory ? Number.POSITIVE_INFINITY : upperBound;
        const avgParentEffOff = obsEffSum / activeParents.length;
        if (Number.isFinite(effLo) || Number.isFinite(effHi)) {
          const post = truncatedLogNormalPosterior(rawMu, predSd, effLo, effHi);
          inferredUsd = post.meanUsd;
          inferredSd = post.degenerate ? 0 : predLogSd;
          if (Number.isFinite(effLo)) costMinUsd = Number(Math.exp(effLo).toFixed(6));
          if (Number.isFinite(effHi)) costMaxUsd = Number(Math.exp(effHi).toFixed(6));
          if (!post.degenerate && predSd > 0) {
            siblingBaselines.set(row.configId, {
              groupKey,
              baseSd: Math.sqrt(Math.max(0, withinModelVar / activeParents.length)),
              tierSd: Math.sqrt(Math.max(0, withinModelVar)),
              totalSd: predSd,
              rawMu,
              loLog: effLo,
              hiLog: effHi,
              parentPartialIds,
              avgParentEffOff,
              targetEffOff,
            });
          }
        } else {
          inferredUsd = Math.exp(rawMu + 0.5 * predVar);
          inferredSd = predLogSd;
          if (predSd > 0) {
            siblingBaselines.set(row.configId, {
              groupKey,
              baseSd: Math.sqrt(Math.max(0, withinModelVar / activeParents.length)),
              tierSd: Math.sqrt(Math.max(0, withinModelVar)),
              totalSd: predSd,
              rawMu,
              loLog: Number.NEGATIVE_INFINITY,
              hiLog: Number.POSITIVE_INFINITY,
              parentPartialIds,
              avgParentEffOff,
              targetEffOff,
            });
          }
        }
      } else if (!tariffSlopeIdentified) {
        // When tariff is collinear with effort/harness, predict strictly from exact (effort, harness, tariff) cells with df > 0
        if (cellDf <= 0) continue;
        const targetLogRate = Math.log(rate);
        let matchedKey: string | null = null;
        let matchedEntry: { logRate: number; vals: number[] } | null = null;
        const exactKey = fullCellKey(row.effort, harnessKey, targetLogRate);
        const directEntry = cellLogsByKey.get(exactKey);
        if (directEntry && Math.abs(directEntry.logRate - targetLogRate) <= 1e-6) {
          matchedKey = exactKey;
          matchedEntry = directEntry;
        } else {
          const prefix = useHarnessEffects ? `${row.effort}::${harnessKey}::` : `${row.effort}::`;
          for (const [ck, entry] of cellLogsByKey.entries()) {
            if (ck.startsWith(prefix) && Math.abs(entry.logRate - targetLogRate) <= 1e-6) {
              matchedKey = ck;
              matchedEntry = entry;
              break;
            }
          }
        }
        if (!matchedKey || !matchedEntry || matchedEntry.vals.length === 0) continue;
        const cellMean = cellMeanByKey.get(matchedKey)!;
        const cellCount = matchedEntry.vals.length;
        const predVar = cellResidVar * (1 + 1 / cellCount);
        inferredUsd = Math.exp(cellMean + 0.5 * predVar);
        inferredSd = Number(Math.sqrt(Math.max(0, predVar)).toFixed(4));
        if (predVar > 0) {
          unidentifiedCells.set(row.configId, {
            cellKey: matchedKey,
            cellMeanLog: cellMean,
            meanSd: Math.sqrt(Math.max(0, cellResidVar / cellCount)),
            residSd: Math.sqrt(Math.max(0, cellResidVar)),
          });
        }
      } else {
        if (olsDf <= 0) continue;
        const rawX = buildRawRow(Math.log(rate), row.effort, harnessKey);
        const fullX = buildPooledRow(Math.log(rate), row.effort, harnessKey);
        if (!rawX || !fullX) continue;
        // Require exact Gauss-Markov estimability before pooling and in the converged monotone design row space
        if (!initialFit.isEstimable(rawX)) continue;
        const xTarget = slopeClamped ? [fullX[0]!, ...fullX.slice(2)] : fullX;
        if (!activeFit.isEstimable(xTarget)) continue;
        let predMeanLog = slopeClamped ? clampedSlope * Math.log(rate) : 0;
        for (let c = 0; c < xTarget.length; c++) predMeanLog += xTarget[c]! * activeFit.beta[c]!;
        const lev = activeFit.leverage(xTarget);
        const predVar = residVar * (1 + lev);
        inferredUsd = Math.exp(predMeanLog + 0.5 * predVar);
        inferredSd = Number(Math.sqrt(Math.max(0, predVar)).toFixed(4));
        if (predVar > 0) {
          olsEntries.set(row.configId, { xVec: xTarget, predMeanLog });
        }
      }

      if (Number.isFinite(inferredUsd) && inferredUsd > 0) {
        const roundedUsd = Number(inferredUsd.toFixed(6));
        const clampedMin = costMinUsd !== undefined ? Math.min(roundedUsd, costMinUsd) : undefined;
        const clampedMax = costMaxUsd !== undefined ? Math.max(roundedUsd, costMaxUsd) : undefined;
        out.set(row.configId, {
          ...cur,
          effectiveCostUsd: roundedUsd,
          ...(inferredSd > 0 ? { costLogSd: inferredSd } : {}),
          ...(clampedMin !== undefined && clampedMin > 0 ? { costMinUsd: clampedMin } : {}),
          ...(clampedMax !== undefined && clampedMax > 0 ? { costMaxUsd: clampedMax } : {}),
          costImputed: true,
          costEstimated: true,
        });
      }
    }

    if (olsEntries.size > 0 && residVar > 0 && activeFit.rank > 0) {
      const pActive = activeFit.beta.length;
      const factorMatrix: number[][] = Array.from({ length: pActive }, (_, r) =>
        Array.from(
          { length: activeFit.rank },
          (__, k) =>
            activeFit.activeVecs[k]![r]! * Math.sqrt(residVar / activeFit.activeLambdas[k]!),
        ),
      );
      olsModel = {
        factorMatrix,
        residSd: Math.sqrt(residVar),
        byConfigId: olsEntries,
      };
    }
  }

  const partialBasketModel: PartialBasketCostModel | null =
    partialBasketByConfigId.size > 0 && costFit?.deltaCovByBenchmark
      ? {
          basketSize: allPricedBenchmarkIds.length,
          freeBenchmarks: costFit.deltaCovByBenchmark.freeBenchmarks,
          deltaCovMatrix: costFit.deltaCovByBenchmark.covMatrix,
          tauResidSq: costFit.tauResidSq,
          byConfigId: partialBasketByConfigId,
        }
      : null;

  const costBootstrapModel: DomainCostBootstrapModel | null =
    partialBasketModel !== null ||
    siblingBaselines.size > 0 ||
    olsModel !== null ||
    unidentifiedCells.size > 0
      ? {
          partialBasket: partialBasketModel,
          siblingBaselines,
          olsModel,
          unidentifiedCells,
        }
      : null;

  return { costs: out, partialBasketModel, costBootstrapModel };
}

export function resolveDomainCosts(
  domainId: DomainId,
  rows: readonly CostInputRow[],
  pricingBySlug: ReadonlyMap<string, PricingRecord>,
  expectedMeasuredBenchmarkIds?: readonly string[],
): Map<string, ResolvedCost> {
  return resolveDomainCostsWithModel(domainId, rows, pricingBySlug, expectedMeasuredBenchmarkIds)
    .costs;
}
