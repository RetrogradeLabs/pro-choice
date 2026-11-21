import type {
  AnchorStats,
  EvaluatedConfig,
  FrontierPoint,
  LinkJointCov,
  PrunedConfig,
} from "../schema.ts";
import {
  compareAscii,
  computeJointLinkCovariance,
  DISPLAY_SPREAD,
  factorJointLinkCovariance,
  type RemlLinkTerm,
  type ShrinkageMode,
  Z_SCORE_MAX,
  Z_SCORE_MIN,
} from "./aggregate.ts";
import {
  type DomainCostBootstrapModel,
  erfcx,
  GL8_NODES,
  GL8_WEIGHTS,
  logNormalCdf,
  logNormalInterval,
  type PartialBasketCostModel,
} from "./cost.ts";

// Calibrated from n=4,804 empirical Rasch residual pairs (same-family r~0.53, cross-family same-lab r~0.09)
export const SAME_FAMILY_CORR = 0.5;
export const SAME_PROVIDER_CORR = 0.1;
const SQRT_PROV = Math.sqrt(SAME_PROVIDER_CORR);
const SQRT_FAM = Math.sqrt(SAME_FAMILY_CORR - SAME_PROVIDER_CORR);
const SQRT_INDIV = Math.sqrt(1 - SAME_FAMILY_CORR);

export const COST_EPSILON = 1e-6;
export const SCORE_TIE_EPSILON = 1e-9;

function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const poly =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - d * poly;
  return z >= 0 ? p : 1 - p;
}

// Acklam minimax rational approximation to standard normal quantile Phi^-1(p) (|err| < 1.15e-9)
function normalInvCdf(pRaw: number): number {
  const p = Math.min(1 - 1e-12, Math.max(1e-12, pRaw));
  const a1 = -3.969683028665376e1;
  const a2 = 2.209460984245205e2;
  const a3 = -2.759285104469687e2;
  const a4 = 1.38357751867269e2;
  const a5 = -3.066479806614716e1;
  const a6 = 2.506628277459239;
  const b1 = -5.447609879822406e1;
  const b2 = 1.615858368580409e2;
  const b3 = -1.556989798598866e2;
  const b4 = 6.680131188771972e1;
  const b5 = -1.328068155288572e1;
  const c1 = -7.784894002430293e-3;
  const c2 = -3.223964580411365e-1;
  const c3 = -2.400758277161838;
  const c4 = -2.549732539343734;
  const c5 = 4.374664141464968;
  const c6 = 2.938163982698783;
  const d1 = 7.784695709041462e-3;
  const d2 = 3.224671290700398e-1;
  const d3 = 2.445134137142996;
  const d4 = 3.754408661907416;
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
    );
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q) /
      (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
    ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
  );
}

interface TruncatedCostSamplerSpec {
  mode: "fixed" | "unbounded" | "truncated";
  mu: number;
  sd: number;
  alpha: number;
  beta: number;
  lo: number;
  hi: number;
}

// Exact shifted quadrature integral of exp(-0.5*(t^2 - tRef^2)) on [a, x] for narrow truncated normal inversion
function narrowNormalIntegral(a: number, x: number, tRef: number): number {
  const half = 0.5 * (x - a);
  if (!(half > 0)) return 0;
  const mid = 0.5 * (a + x);
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const t = mid + half * GL8_NODES[i]!;
    sum += GL8_WEIGHTS[i]! * Math.exp(-0.5 * (t * t - tRef * tRef));
  }
  return half * sum;
}

// Tail-stable inverse-CDF sampler for Z ~ N(0, 1) truncated to [alpha, beta] with narrow-interval accuracy
function sampleTruncatedStandardNormal(alpha: number, beta: number, uRaw: number): number {
  const u = Math.min(1 - 1e-12, Math.max(1e-12, uRaw));
  const tRef =
    Number.isFinite(alpha) && Number.isFinite(beta) ? Math.min(beta, Math.max(alpha, 0)) : 0;
  if (
    Number.isFinite(alpha) &&
    Number.isFinite(beta) &&
    beta - alpha < 0.05 &&
    (beta - alpha) * (1 + Math.abs(tRef)) < 1.5
  ) {
    const h = beta - alpha;
    if (!(h > 1e-15)) return 0.5 * (alpha + beta);
    const total = narrowNormalIntegral(alpha, beta, tRef);
    const target = u * total;
    let lo = alpha;
    let hi = beta;
    let z = alpha + u * h;
    for (let iter = 0; iter < 12; iter++) {
      const f = narrowNormalIntegral(alpha, z, tRef) - target;
      if (Math.abs(f) <= 1e-14 * total) break;
      if (f < 0) lo = z;
      else hi = z;
      const fp = Math.exp(-0.5 * (z * z - tRef * tRef));
      const cand = fp > 1e-300 ? z - f / fp : 0.5 * (lo + hi);
      z = cand > lo && cand < hi ? cand : 0.5 * (lo + hi);
    }
    return z;
  }
  if (alpha > 2) {
    const logSa = logNormalCdf(-alpha);
    const logSb = Number.isFinite(beta) ? logNormalCdf(-beta) : Number.NEGATIVE_INFINITY;
    const logTargetS = Number.isFinite(logSb)
      ? logSa + Math.log1p(u * Math.expm1(logSb - logSa))
      : logSa + Math.log(1 - u);
    const invSqrtTwoPi = Math.sqrt(2 / Math.PI);
    const twoNegLog = Math.max(1, -2 * logTargetS);
    let z = Math.max(alpha, Math.sqrt(Math.max(0, twoNegLog - Math.log(Math.PI * twoNegLog))));
    if (Number.isFinite(beta)) z = Math.min(beta, z);
    let lo = alpha;
    let hi = Number.isFinite(beta) ? beta : Number.POSITIVE_INFINITY;
    for (let iter = 0; iter < 12; iter++) {
      const f = logNormalCdf(-z) - logTargetS;
      if (Math.abs(f) < 1e-12) break;
      if (f > 0) lo = z;
      else hi = z;
      const fp = -invSqrtTwoPi / erfcx(z / Math.SQRT2);
      const next = z - f / fp;
      if (next > lo && next < hi) z = next;
      else z = Number.isFinite(hi) ? 0.5 * (lo + hi) : lo + 0.5;
    }
    return z;
  }
  if (beta < -2) {
    return -sampleTruncatedStandardNormal(-beta, -alpha, 1 - u);
  }
  const cdfLo = Number.isFinite(alpha) ? Math.exp(logNormalCdf(alpha)) : 0;
  const cdfHi = Number.isFinite(beta) ? Math.exp(logNormalCdf(beta)) : 1;
  return normalInvCdf(cdfLo + u * (cdfHi - cdfLo));
}

// Calibrates exact tail-stable truncated log-normal parameters on [lo, hi] whose arithmetic mean equals targetMean
function buildTruncatedCostSpec(
  targetMean: number,
  sd: number,
  lo: number,
  hi: number,
): TruncatedCostSamplerSpec {
  if (!(sd > 0) || !(targetMean > 0)) {
    return {
      mode: "fixed",
      mu: 0,
      sd: 0,
      alpha: Number.NEGATIVE_INFINITY,
      beta: Number.POSITIVE_INFINITY,
      lo,
      hi,
    };
  }
  const hasLo = lo > 0 && Number.isFinite(lo);
  const hasHi = Number.isFinite(hi);
  if (!hasLo && !hasHi) {
    return {
      mode: "unbounded",
      mu: Math.log(targetMean) - 0.5 * sd * sd,
      sd,
      alpha: Number.NEGATIVE_INFINITY,
      beta: Number.POSITIVE_INFINITY,
      lo: 0,
      hi: Number.POSITIVE_INFINITY,
    };
  }
  // A bounded random variable whose mean sits on its hard boundary is a point mass
  if ((hasLo && targetMean <= lo * (1 + 1e-12)) || (hasHi && targetMean >= hi * (1 - 1e-12))) {
    return {
      mode: "fixed",
      mu: 0,
      sd: 0,
      alpha: Number.NEGATIVE_INFINITY,
      beta: Number.POSITIVE_INFINITY,
      lo,
      hi,
    };
  }
  const loLog = hasLo ? Math.log(lo) : Number.NEGATIVE_INFINITY;
  const hiLog = hasHi ? Math.log(hi) : Number.POSITIVE_INFINITY;
  const evalTruncMean = (mu: number): number => {
    const a = hasLo ? (loLog - mu) / sd : Number.NEGATIVE_INFINITY;
    const b = hasHi ? (hiLog - mu) / sd : Number.POSITIVE_INFINITY;
    const logDenom = logNormalInterval(a, b);
    const logNum = logNormalInterval(a - sd, b - sd);
    if (!Number.isFinite(logDenom) || !Number.isFinite(logNum)) {
      if (hasHi && mu > hiLog) return hi;
      if (hasLo && mu < loLog) return lo;
      return Math.exp(mu + 0.5 * sd * sd);
    }
    return Math.exp(mu + 0.5 * sd * sd + (logNum - logDenom));
  };
  let muLo = Math.log(targetMean) - 0.5 * sd * sd - 6 * sd;
  let muHi = Math.log(targetMean) - 0.5 * sd * sd + 6 * sd;
  while (evalTruncMean(muLo) > targetMean && muLo > -200) muLo -= 6 * sd;
  while (evalTruncMean(muHi) < targetMean && muHi < 200) muHi += 6 * sd;
  for (let iter = 0; iter < 65; iter++) {
    const mid = 0.5 * (muLo + muHi);
    if (evalTruncMean(mid) < targetMean) muLo = mid;
    else muHi = mid;
  }
  const muStar = 0.5 * (muLo + muHi);
  const alpha = hasLo ? (loLog - muStar) / sd : Number.NEGATIVE_INFINITY;
  const beta = hasHi ? (hiLog - muStar) / sd : Number.POSITIVE_INFINITY;
  if (beta <= alpha + 1e-12) {
    return {
      mode: "fixed",
      mu: 0,
      sd: 0,
      alpha: Number.NEGATIVE_INFINITY,
      beta: Number.POSITIVE_INFINITY,
      lo,
      hi,
    };
  }
  return { mode: "truncated", mu: muStar, sd, alpha, beta, lo, hi };
}

// Positive-semidefinite Cholesky factor L (L * L^T = mat) permitting zero eigenvalues on constrained subspaces
function psdCholesky(mat: readonly (readonly number[])[]): number[][] {
  const n = mat.length;
  const L: number[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = mat[i]![j]!;
      for (let k = 0; k < j; k++) sum -= L[i]![k]! * L[j]![k]!;
      if (i === j) {
        L[i]![i] = sum > 1e-12 ? Math.sqrt(sum) : 0;
      } else {
        L[i]![j] = L[j]![j]! > 1e-12 ? sum / L[j]![j]! : 0;
      }
    }
  }
  return L;
}

function lookupAnchorForRegime(
  anchorStats: Readonly<Record<string, AnchorStats>> | undefined,
  benchmarkId: string,
  regime: EvaluatedConfig["harnessRegime"],
): AnchorStats | undefined {
  if (!anchorStats) return undefined;
  return regime === "standardized"
    ? anchorStats[`${benchmarkId}::standardized`]
    : anchorStats[benchmarkId];
}

function buildConfigLinkScoreTerms(
  cfg: EvaluatedConfig,
  weightByBenchmark?: ReadonlyMap<string, number>,
  anchorStats?: Readonly<Record<string, AnchorStats>>,
): RemlLinkTerm[] {
  if (!anchorStats) return [];
  const regime = cfg.harnessRegime;
  const hasExplicitWeights = weightByBenchmark !== undefined;
  const weightOf = (bmId: string): number => {
    if (hasExplicitWeights) {
      const w = weightByBenchmark.get(bmId);
      return w !== undefined && Number.isFinite(w) && w > 0 ? w : 0;
    }
    const w = lookupAnchorForRegime(anchorStats, bmId, regime)?.effectiveWeight;
    return w !== undefined && Number.isFinite(w) && w > 0 ? w : 1;
  };
  let wSum = 0;
  for (const bm of cfg.benchmarks) wSum += weightOf(bm.benchmarkId);
  if (wSum <= 0) return [];
  const terms: RemlLinkTerm[] = [];
  for (const bm of cfg.benchmarks) {
    const wb = weightOf(bm.benchmarkId);
    if (!(wb > 0)) continue;
    const st = lookupAnchorForRegime(anchorStats, bm.benchmarkId, regime);
    if (
      !st?.linkedViaMeanSigma ||
      !(st.sd > 0) ||
      st.linkVarIntercept === undefined ||
      st.linkVarSlope === undefined ||
      st.linkCovIS === undefined
    ) {
      continue;
    }
    const sign = st.invertScore ? -1 : 1;
    const oriented = sign * bm.rawScore;
    const rawZ = (oriented - st.mean) / st.sd;
    if (!(rawZ > Z_SCORE_MIN && rawZ < Z_SCORE_MAX)) continue;
    const scale = DISPLAY_SPREAD * cfg.shrinkageFactor * (wb / wSum);
    terms.push({
      benchmarkId: bm.benchmarkId,
      interceptCoeff: scale,
      slopeCoeff: scale * oriented,
      linkVarIntercept: st.linkVarIntercept,
      linkVarSlope: st.linkVarSlope,
      linkCovIS: st.linkCovIS,
    });
  }
  return terms;
}

// Exact shared Mean-Sigma calibration covariance (including cross-benchmark joint jackknife overlap)
function sharedLinkCovariance(
  low: EvaluatedConfig,
  high: EvaluatedConfig,
  weightByBenchmark?: ReadonlyMap<string, number>,
  anchorStats?: Readonly<Record<string, AnchorStats>>,
  linkJointCov?: LinkJointCov | null,
): number {
  if (!anchorStats) return 0;
  const termsLow = buildConfigLinkScoreTerms(low, weightByBenchmark, anchorStats);
  const termsHigh = buildConfigLinkScoreTerms(high, weightByBenchmark, anchorStats);
  return computeJointLinkCovariance(termsLow, termsHigh, linkJointCov);
}

function observedBenchmarkOverlap(a: EvaluatedConfig, b: EvaluatedConfig): number {
  const setA = new Set(a.benchmarks.map((bm) => bm.benchmarkId));
  let overlap = 0;
  for (const bm of b.benchmarks) {
    if (setA.has(bm.benchmarkId)) overlap++;
  }
  return overlap;
}

function weightedResidualNormAndInner(
  low: EvaluatedConfig,
  high: EvaluatedConfig,
  weightByBenchmark?: ReadonlyMap<string, number>,
): { normLowSq: number; normHighSq: number; innerProd: number } | null {
  // Treat an explicitly supplied map (including empty or singleton) as authoritative across all paths
  if (weightByBenchmark !== undefined) {
    const lowSet = new Set(low.benchmarks.map((b) => b.benchmarkId));
    const highSet = new Set(high.benchmarks.map((b) => b.benchmarkId));
    let activePositive = 0;
    let wU = 0;
    let wLow = 0;
    let wHigh = 0;
    for (const [bmId, w] of weightByBenchmark.entries()) {
      if (!(Number.isFinite(w) && w > 0)) continue;
      activePositive++;
      wU += w;
      if (lowSet.has(bmId)) wLow += w;
      if (highSet.has(bmId)) wHigh += w;
    }
    if (activePositive <= 1 || wU <= 0 || wLow <= 0 || wHigh <= 0) return null;
    let normLowSq = 0;
    let normHighSq = 0;
    let innerProd = 0;
    for (const [bmId, w] of weightByBenchmark.entries()) {
      if (!(Number.isFinite(w) && w > 0)) continue;
      const cLow = (lowSet.has(bmId) ? w / wLow : 0) - w / wU;
      const cHigh = (highSet.has(bmId) ? w / wHigh : 0) - w / wU;
      normLowSq += cLow * cLow;
      normHighSq += cHigh * cHigh;
      innerProd += cLow * cHigh;
    }
    return normLowSq > 0 && normHighSq > 0 ? { normLowSq, normHighSq, innerProd } : null;
  }

  const activeB = Math.max(low.activeBenchmarkCount, high.activeBenchmarkCount);
  if (activeB <= 1) return null;
  const kLow = low.benchmarks.length;
  const kHigh = high.benchmarks.length;
  const normLowSq = Math.max(0, 1 / kLow - 1 / activeB);
  const normHighSq = Math.max(0, 1 / kHigh - 1 / activeB);
  if (normLowSq <= 0 || normHighSq <= 0) return null;
  const overlap = observedBenchmarkOverlap(low, high);
  return { normLowSq, normHighSq, innerProd: overlap / (kLow * kHigh) - 1 / activeB };
}

export function stepSignificance(
  low: EvaluatedConfig,
  high: EvaluatedConfig,
  weightByBenchmark?: ReadonlyMap<string, number>,
  anchorStats?: Readonly<Record<string, AnchorStats>>,
  linkJointCov?: LinkJointCov | null,
  shrinkageMode: ShrinkageMode = "measurement",
): { zStep: number; pBetter: number; statisticallyTied: boolean } {
  // Exact weighted finite-roster covariance: B_i * B_j * rho * sigma_resid^2 * sum_b c_ib * c_jb
  const rho =
    low.provider !== high.provider
      ? 0
      : low.modelSlug === high.modelSlug
        ? SAME_FAMILY_CORR
        : SAME_PROVIDER_CORR;
  const diff = high.score - low.score;
  const covLink = sharedLinkCovariance(low, high, weightByBenchmark, anchorStats, linkJointCov);
  const varSampling = Math.max(
    0,
    low.samplingSe * low.samplingSe + high.samplingSe * high.samplingSe - 2 * covLink,
  );

  let covResid = 0;
  if (low.residualSe > 0 && high.residualSe > 0) {
    const geom = weightedResidualNormAndInner(low, high, weightByBenchmark);
    if (geom) {
      // Under measurement-only shrinkage, residualSe already carries B_i linearly; under v1 total shrinkage it carries sqrt(B_i)
      const shrinkScale =
        shrinkageMode === "measurement"
          ? 1
          : Math.sqrt(Math.max(0, low.shrinkageFactor * high.shrinkageFactor));
      const sigmaResidSq =
        ((low.residualSe * high.residualSe) / Math.sqrt(geom.normLowSq * geom.normHighSq)) *
        shrinkScale;
      covResid = rho * sigmaResidSq * geom.innerProd;
    }
  }

  const varResid =
    low.residualSe * low.residualSe + high.residualSe * high.residualSe - 2 * covResid;
  const varDiff = Math.max(1e-9, varSampling + Math.max(0, varResid));
  const zStep = diff / Math.sqrt(varDiff);
  return {
    zStep: Number(zStep.toFixed(3)),
    pBetter: Number(normalCdf(zStep).toFixed(4)),
    statisticallyTied: zStep < 1.0,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createGaussianSampler(rng: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    spare = r * Math.sin(theta);
    return r * Math.cos(theta);
  };
}

interface PricedConfig extends EvaluatedConfig {
  effectiveCostUsd: number;
}

function isPriced(cfg: EvaluatedConfig): cfg is PricedConfig {
  return (
    cfg.effectiveCostUsd !== null &&
    Number.isFinite(cfg.effectiveCostUsd) &&
    cfg.effectiveCostUsd > 0
  );
}

/**
 * Deterministic ascending-cost, descending-score sort for frontier extraction.
 */
function sortByCostAscScoreDesc(configs: readonly PricedConfig[]): PricedConfig[] {
  return configs.toSorted((a, b) => {
    if (a.effectiveCostUsd !== b.effectiveCostUsd) {
      return a.effectiveCostUsd - b.effectiveCostUsd;
    }
    if (b.score !== a.score) return b.score - a.score;
    return compareAscii(a.id, b.id);
  });
}

/**
 * Correlated Monte Carlo bootstrap Pareto inclusion probability drawing exact per-benchmark
 * missing-cell residuals (rho=0.50 same modelSlug, rho=0.10 same lab) plus independent sampling SE.
 */
export function computeBootstrapParetoProb(
  providerConfigs: readonly EvaluatedConfig[],
  seedKey: string,
  activeBenchmarkIds?: readonly string[],
  tauResid?: number,
  draws = 10_000,
  weightByBenchmark?: ReadonlyMap<string, number>,
  anchorStats?: Readonly<Record<string, AnchorStats>>,
  costModel?: DomainCostBootstrapModel | PartialBasketCostModel | null,
  linkJointCov?: LinkJointCov | null,
  shrinkageMode: ShrinkageMode = "measurement",
): Map<string, number> {
  const priced = providerConfigs.filter(isPriced);
  const counts = new Map<string, number>();
  for (const c of providerConfigs) counts.set(c.id, 0);
  if (priced.length === 0) return counts;
  if (priced.length === 1) {
    counts.set(priced[0]!.id, 1);
    return counts;
  }

  const normalizedCostModel: DomainCostBootstrapModel | null =
    costModel == null
      ? null
      : "partialBasket" in costModel
        ? costModel
        : {
            partialBasket: costModel,
            siblingBaselines: new Map(),
            olsModel: null,
            unidentifiedCells: new Map(),
          };
  const partialBasketModel = normalizedCostModel?.partialBasket ?? null;

  const ordered = sortByCostAscScoreDesc(priced);
  const n = ordered.length;
  const costs = ordered.map((c) => c.effectiveCostUsd);
  const costFixedFloors = ordered.map((c) =>
    Math.min(c.effectiveCostUsd, Math.max(0, c.costFixedFloorUsd ?? 0)),
  );
  const pbBmIdx = new Map<string, number>(
    (partialBasketModel?.freeBenchmarks ?? []).map((id, idx) => [id, idx]),
  );
  const pbChol =
    partialBasketModel && partialBasketModel.deltaCovMatrix.length > 0
      ? psdCholesky(partialBasketModel.deltaCovMatrix)
      : null;
  const pbTauSd =
    partialBasketModel && partialBasketModel.tauResidSq > 0
      ? Math.sqrt(partialBasketModel.tauResidSq)
      : 0;
  const pbBasketSize = Math.max(1, partialBasketModel?.basketSize ?? 1);
  const pbDim = pbChol?.length ?? 0;
  const pbZ = new Float64Array(pbDim);
  const pbEta = new Float64Array(pbDim);

  // Shared sibling-baseline draws (preserving exact marginals via Gaussian copula under brackets + shared parent partial-basket draws)
  const sibGroupIdxByKey = new Map<string, number>();
  const sibConfigs = ordered.map((c) => {
    const sb = normalizedCostModel?.siblingBaselines.get(c.id);
    if (!sb) return null;
    let gIdx = sibGroupIdxByKey.get(sb.groupKey);
    if (gIdx === undefined) {
      gIdx = sibGroupIdxByKey.size;
      sibGroupIdxByKey.set(sb.groupKey, gIdx);
    }
    return { ...sb, groupIdx: gIdx };
  });
  const numSibGroups = sibGroupIdxByKey.size;
  const sibZ = new Float64Array(numSibGroups);

  // Collect all unique partial-basket configs needed (both slice members and referenced sibling parents) so each draws once per draw
  interface CompiledPbEntry {
    configId: string;
    fixedFloorUsd: number;
    obsIdxs: number[];
    invK: number;
    baseSd: number;
    missing: { bmIdx: number; logCenter: number }[];
  }
  const pbCompiledById = new Map<string, CompiledPbEntry>();
  const registerPbConfig = (configId: string, fallbackFloor: number) => {
    if (pbCompiledById.has(configId)) return;
    const entry = partialBasketModel?.byConfigId.get(configId);
    if (!entry || entry.missingTerms.length === 0) return;
    pbCompiledById.set(configId, {
      configId,
      fixedFloorUsd: entry.fixedFloorUsd ?? fallbackFloor,
      obsIdxs: entry.observedIds.map((id) => pbBmIdx.get(id) ?? -1),
      invK: 1 / Math.max(1, entry.observedIds.length),
      baseSd: pbTauSd / Math.sqrt(Math.max(1, entry.observedIds.length)),
      missing: entry.missingTerms.map((t) => ({
        bmIdx: pbBmIdx.get(t.benchmarkId) ?? -1,
        logCenter: t.logCenter,
      })),
    });
  };
  for (let i = 0; i < n; i++) {
    const c = ordered[i]!;
    registerPbConfig(c.id, costFixedFloors[i]!);
    const sib = sibConfigs[i];
    if (sib) {
      for (const pid of sib.parentPartialIds) registerPbConfig(pid, 0);
    }
  }
  const pbConfigs = ordered.map((c) => pbCompiledById.get(c.id) ?? null);
  const pbDrawList = [...pbCompiledById.values()];
  const pbDrawCostById = new Map<string, number>();
  const hasSharedPartialBasket = pbDrawList.length > 0;

  // Shared OLS coefficient draws across new-model log-cost predictions
  const olsModel = normalizedCostModel?.olsModel ?? null;
  const olsConfigs = ordered.map((c) => olsModel?.byConfigId.get(c.id) ?? null);
  const hasOlsCostNoise = olsModel !== null && olsConfigs.some((x) => x !== null);
  const olsRank = olsModel?.factorMatrix[0]?.length ?? 0;
  const olsDim = olsModel?.factorMatrix.length ?? 0;
  const olsZ = new Float64Array(olsRank);
  const olsDeltaBeta = new Float64Array(olsDim);

  // Shared cell-mean draws for unidentified-tariff cell predictions
  const cellIdxByKey = new Map<string, number>();
  const unidCellConfigs = ordered.map((c) => {
    const uc = normalizedCostModel?.unidentifiedCells.get(c.id);
    if (!uc) return null;
    let cIdx = cellIdxByKey.get(uc.cellKey);
    if (cIdx === undefined) {
      cIdx = cellIdxByKey.size;
      cellIdxByKey.set(uc.cellKey, cIdx);
    }
    return { ...uc, cellIdx: cIdx };
  });
  const numUnidCells = cellIdxByKey.size;
  const unidCellZ = new Float64Array(numUnidCells);

  const costSpecs = ordered.map((c, i) => {
    if (
      pbConfigs[i] !== null ||
      sibConfigs[i] !== null ||
      olsConfigs[i] !== null ||
      unidCellConfigs[i] !== null
    ) {
      return buildTruncatedCostSpec(0, 0, 0, Number.POSITIVE_INFINITY);
    }
    const cSd = c.costImputed && c.costLogSd ? c.costLogSd : 0;
    const floor = costFixedFloors[i]!;
    const varPart = Math.max(0, c.effectiveCostUsd - floor);
    const minC =
      c.costMinUsd !== undefined && Number.isFinite(c.costMinUsd) && c.costMinUsd > 0
        ? Math.max(0, c.costMinUsd - floor)
        : 0;
    const maxC =
      c.costMaxUsd !== undefined && Number.isFinite(c.costMaxUsd) && c.costMaxUsd > 0
        ? Math.max(0, c.costMaxUsd - floor)
        : Number.POSITIVE_INFINITY;
    return buildTruncatedCostSpec(varPart, cSd, minC, maxC);
  });
  const hasAnyCostNoise =
    hasSharedPartialBasket ||
    numSibGroups > 0 ||
    hasOlsCostNoise ||
    numUnidCells > 0 ||
    costSpecs.some((s) => s.mode !== "fixed");
  const scores = ordered.map((c) => c.score);
  const samplingSes = ordered.map((c) => c.samplingSe);
  const residualSes = ordered.map((c) => c.residualSe);

  // Treat an explicitly supplied map (even empty or all-zero) as authoritative; infer universe ONLY when omitted
  const observedUniverse = new Set<string>();
  const hasExplicitWeightMap = weightByBenchmark !== undefined;
  if (hasExplicitWeightMap) {
    for (const [bmId, w] of weightByBenchmark.entries()) {
      if (Number.isFinite(w) && w > 0) observedUniverse.add(bmId);
    }
  } else {
    for (const bmId of activeBenchmarkIds ?? []) observedUniverse.add(bmId);
    for (const cfg of ordered) {
      for (const bm of cfg.benchmarks) observedUniverse.add(bm.benchmarkId);
    }
  }
  const activeB = hasExplicitWeightMap
    ? observedUniverse.size
    : Math.max(observedUniverse.size, ...ordered.map((c) => c.activeBenchmarkCount));
  const bmIndexList = [...observedUniverse].toSorted(compareAscii);
  while (bmIndexList.length < activeB) bmIndexList.push(`__unobserved_${bmIndexList.length}`);
  const bmIdxById = new Map<string, number>(bmIndexList.map((id, idx) => [id, idx]));
  const bmWeights = Float64Array.from(bmIndexList, (id) => {
    const w = weightByBenchmark?.get(id);
    return w !== undefined && Number.isFinite(w) && w > 0 ? w : 1;
  });
  let totalUniverseW = 0;
  for (let b = 0; b < activeB; b++) totalUniverseW += bmWeights[b]!;

  const observedIndices = ordered.map((cfg) =>
    cfg.benchmarks.map((bm) => bmIdxById.get(bm.benchmarkId)!).filter((idx) => idx !== undefined),
  );
  const observedMasks = observedIndices.map((idxs) => {
    const mask = new Uint8Array(activeB);
    for (const idx of idxs) mask[idx] = 1;
    return mask;
  });
  const observedWeightSums = observedMasks.map((mask) => {
    let s = 0;
    for (let b = 0; b < activeB; b++) {
      if (mask[b] === 1) s += bmWeights[b]!;
    }
    return s;
  });

  let sigmaResidScore = tauResid !== undefined && tauResid > 0 ? DISPLAY_SPREAD * tauResid : 0;
  if (sigmaResidScore === 0 && totalUniverseW > 0) {
    for (let i = 0; i < n; i++) {
      const wObs = observedWeightSums[i]!;
      const mask = observedMasks[i]!;
      let normSq = 0;
      if (wObs > 0) {
        for (let b = 0; b < activeB; b++) {
          const w = bmWeights[b]!;
          const cIb = (mask[b] === 1 ? w / wObs : 0) - w / totalUniverseW;
          normSq += cIb * cIb;
        }
      }
      if (residualSes[i]! > 0 && normSq > 0) {
        const residScale =
          shrinkageMode === "measurement"
            ? Math.max(1e-12, ordered[i]!.shrinkageFactor)
            : Math.sqrt(Math.max(1e-12, ordered[i]!.shrinkageFactor));
        sigmaResidScore = residualSes[i]! / (Math.sqrt(normSq) * residScale);
        break;
      }
    }
  }
  const hasAnyResidual = sigmaResidScore > 0 && activeB > 1 && residualSes.some((s) => s > 0);

  // Under measurement-only shrinkage, residualSe = B_i * unshrunkSe is fully shared; under v1 total shrinkage, (1-B_i)*residualSe^2 stays independent
  const sharedResidScales = new Float64Array(n);
  const indepResidVars = new Float64Array(n);
  if (hasAnyResidual && totalUniverseW > 0) {
    for (let i = 0; i < n; i++) {
      const wObs = observedWeightSums[i]!;
      const mask = observedMasks[i]!;
      let normSq = 0;
      if (wObs > 0 && wObs < totalUniverseW - 1e-12) {
        for (let b = 0; b < activeB; b++) {
          const w = bmWeights[b]!;
          const cIb = (mask[b] === 1 ? w / wObs : 0) - w / totalUniverseW;
          normSq += cIb * cIb;
        }
      }
      const unshrunkSe = sigmaResidScore * Math.sqrt(normSq);
      const shrink = Math.min(1, Math.max(0, ordered[i]!.shrinkageFactor));
      const fullScale = unshrunkSe > 1e-12 ? residualSes[i]! / unshrunkSe : 0;
      const sharedScale =
        shrinkageMode === "measurement" ? fullScale : fullScale * Math.sqrt(shrink);
      sharedResidScales[i] = sharedScale;
      const sharedVar = sharedScale * unshrunkSe * (sharedScale * unshrunkSe);
      indepResidVars[i] = Math.max(0, residualSes[i]! * residualSes[i]! - sharedVar);
    }
  } else {
    for (let i = 0; i < n; i++) {
      indepResidVars[i] = residualSes[i]! * residualSes[i]!;
    }
  }

  const familyIndexBySlug = new Map<string, number>();
  const famIdx = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const slug = ordered[i]!.modelSlug;
    let idx = familyIndexBySlug.get(slug);
    if (idx === undefined) {
      idx = familyIndexBySlug.size;
      familyIndexBySlug.set(slug, idx);
    }
    famIdx[i] = idx;
  }
  const numFamilies = familyIndexBySlug.size;

  const groupStart: number[] = [];
  const groupEnd: number[] = [];
  let gi = 0;
  while (gi < n) {
    let gj = gi + 1;
    const baseCost = costs[gi]!;
    while (gj < n && costs[gj]! - baseCost <= COST_EPSILON) gj++;
    groupStart.push(gi);
    groupEnd.push(gj);
    gi = gj;
  }

  // Precompute joint Cholesky factors across linked benchmarks so shared calibration configs covary across benchmarks & models
  const jointFactor = factorJointLinkCovariance(linkJointCov);
  const jointCovered = new Set<string>(jointFactor ? jointFactor.bmIndex.keys() : []);
  const fallbackLinkedBms: { bmId: string; l00: number; l10: number; l11: number }[] = [];
  const fallbackIdxByBm = new Map<string, number>();
  const configJointCoeffs: Float64Array[] = [];
  const configFallbackTerms: { linkIdx: number; scale: number; oriented: number }[][] = Array.from(
    { length: n },
    () => [],
  );
  const indepSamplingVars = new Float64Array(n);
  for (let i = 0; i < n; i++) indepSamplingVars[i] = samplingSes[i]! * samplingSes[i]!;

  if (anchorStats) {
    const regime = ordered[0]!.harnessRegime;
    for (const bmId of bmIndexList) {
      if (jointCovered.has(bmId)) continue;
      const st = lookupAnchorForRegime(anchorStats, bmId, regime);
      if (
        !st?.linkedViaMeanSigma ||
        st.linkVarIntercept === undefined ||
        st.linkVarSlope === undefined ||
        st.linkCovIS === undefined
      ) {
        continue;
      }
      const l00 = Math.sqrt(Math.max(0, st.linkVarIntercept));
      const l10 = l00 > 1e-12 ? st.linkCovIS / l00 : 0;
      const l11 = Math.sqrt(Math.max(0, st.linkVarSlope - l10 * l10));
      if (l00 > 0 || l11 > 0) {
        fallbackIdxByBm.set(bmId, fallbackLinkedBms.length);
        fallbackLinkedBms.push({ bmId, l00, l10, l11 });
      }
    }
    const jRank = jointFactor?.rank ?? 0;
    for (let i = 0; i < n; i++) {
      const cfg = ordered[i]!;
      const wObs = observedWeightSums[i]!;
      const jCoeffs = new Float64Array(jRank);
      configJointCoeffs.push(jCoeffs);
      if (wObs <= 0) continue;
      const scoreTerms: RemlLinkTerm[] = [];
      const fbTerms = configFallbackTerms[i]!;
      for (const bm of cfg.benchmarks) {
        const bmPos = bmIdxById.get(bm.benchmarkId);
        if (bmPos === undefined) continue;
        const st = lookupAnchorForRegime(anchorStats, bm.benchmarkId, regime);
        if (
          !st?.linkedViaMeanSigma ||
          !(st.sd > 0) ||
          st.linkVarIntercept === undefined ||
          st.linkVarSlope === undefined ||
          st.linkCovIS === undefined
        ) {
          continue;
        }
        const wb = bmWeights[bmPos] ?? st.effectiveWeight;
        const sign = st.invertScore ? -1 : 1;
        const oriented = sign * bm.rawScore;
        const rawZ = (oriented - st.mean) / st.sd;
        if (!(rawZ > Z_SCORE_MIN && rawZ < Z_SCORE_MAX)) continue;
        const scale = DISPLAY_SPREAD * cfg.shrinkageFactor * (wb / wObs);
        scoreTerms.push({
          benchmarkId: bm.benchmarkId,
          interceptCoeff: scale,
          slopeCoeff: scale * oriented,
          linkVarIntercept: st.linkVarIntercept,
          linkVarSlope: st.linkVarSlope,
          linkCovIS: st.linkCovIS,
        });
        const jIdx = jointFactor?.bmIndex.get(bm.benchmarkId);
        if (jointFactor && jIdx !== undefined) {
          const rowA = jointFactor.factor[2 * jIdx]!;
          const rowS = jointFactor.factor[2 * jIdx + 1]!;
          for (let c = 0; c < jRank; c++) {
            jCoeffs[c] = jCoeffs[c]! + scale * (rowA[c]! + oriented * rowS[c]!);
          }
        } else {
          const fbIdx = fallbackIdxByBm.get(bm.benchmarkId);
          if (fbIdx !== undefined) fbTerms.push({ linkIdx: fbIdx, scale, oriented });
        }
      }
      if (scoreTerms.length > 0) {
        const ownLinkVar = Math.max(
          0,
          computeJointLinkCovariance(scoreTerms, scoreTerms, linkJointCov),
        );
        indepSamplingVars[i] = Math.max(0, indepSamplingVars[i]! - ownLinkVar);
      }
    }
  }
  const indepNoiseSes = Float64Array.from({ length: n }, (_, i) =>
    Math.sqrt(Math.max(0, indepSamplingVars[i]! + indepResidVars[i]!)),
  );
  const jointLinkRank = jointFactor?.rank ?? 0;
  const hasJointLink = jointLinkRank > 0 && configJointCoeffs.length === n;
  const hasFallbackLink = fallbackLinkedBms.length > 0;
  const jointLinkZ = new Float64Array(jointLinkRank);
  const linkDrawA = new Float64Array(fallbackLinkedBms.length);
  const linkDrawS = new Float64Array(fallbackLinkedBms.length);

  const rng = mulberry32(hashSeed(seedKey));
  const gaussian = createGaussianSampler(rng);
  const hits = new Uint32Array(n);
  const provBmNoise = new Float64Array(activeB);
  const famBmNoise = new Float64Array(numFamilies * activeB);

  const sampledScores = new Float64Array(n);
  const sampledCosts = new Float64Array(n);
  const drawOrder = Array.from({ length: n }, (_, idx) => idx);

  for (let d = 0; d < draws; d++) {
    if (hasJointLink) {
      for (let c = 0; c < jointLinkRank; c++) jointLinkZ[c] = gaussian();
    }
    if (hasFallbackLink) {
      for (let li = 0; li < fallbackLinkedBms.length; li++) {
        const lb = fallbackLinkedBms[li]!;
        const z1 = gaussian();
        const z2 = gaussian();
        linkDrawA[li] = lb.l00 * z1;
        linkDrawS[li] = lb.l10 * z1 + lb.l11 * z2;
      }
    }
    if (hasAnyResidual) {
      for (let b = 0; b < activeB; b++) provBmNoise[b] = gaussian();
      for (let fb = 0; fb < numFamilies * activeB; fb++) famBmNoise[fb] = gaussian();
    }

    if (hasAnyCostNoise) {
      if (hasSharedPartialBasket && pbChol && pbDim > 0) {
        for (let k = 0; k < pbDim; k++) pbZ[k] = gaussian();
        for (let r = 0; r < pbDim; r++) {
          const row = pbChol[r]!;
          let s = 0;
          for (let c = 0; c <= r; c++) s += row[c]! * pbZ[c]!;
          pbEta[r] = s;
        }
        pbDrawCostById.clear();
        for (const pbe of pbDrawList) {
          let etaObsSum = 0;
          for (const oi of pbe.obsIdxs) {
            if (oi >= 0) etaObsSum += pbEta[oi]!;
          }
          const etaObsMean = etaObsSum * pbe.invK;
          const eBase = pbe.baseSd * gaussian();
          let missDollars = 0;
          for (const m of pbe.missing) {
            const etaMiss = m.bmIdx >= 0 ? pbEta[m.bmIdx]! : 0;
            const eMiss = pbTauSd * gaussian();
            missDollars += Math.exp(m.logCenter + etaMiss - etaObsMean + eMiss - eBase);
          }
          pbDrawCostById.set(pbe.configId, pbe.fixedFloorUsd + missDollars / pbBasketSize);
        }
      }
      for (let g = 0; g < numSibGroups; g++) sibZ[g] = gaussian();
      if (hasOlsCostNoise && olsModel && olsRank > 0) {
        for (let k = 0; k < olsRank; k++) olsZ[k] = gaussian();
        for (let r = 0; r < olsDim; r++) {
          const row = olsModel.factorMatrix[r]!;
          let s = 0;
          for (let k = 0; k < olsRank; k++) s += row[k]! * olsZ[k]!;
          olsDeltaBeta[r] = s;
        }
      }
      for (let c = 0; c < numUnidCells; c++) unidCellZ[c] = gaussian();

      for (let i = 0; i < n; i++) {
        const epsIndep = indepNoiseSes[i]! * gaussian();
        let epsLink = 0;
        if (hasJointLink) {
          const jc = configJointCoeffs[i]!;
          for (let c = 0; c < jointLinkRank; c++) {
            const v = jc[c]!;
            if (v !== 0) epsLink += v * jointLinkZ[c]!;
          }
        }
        if (hasFallbackLink) {
          for (const t of configFallbackTerms[i]!) {
            epsLink += t.scale * (linkDrawA[t.linkIdx]! + linkDrawS[t.linkIdx]! * t.oriented);
          }
        }
        let epsResidual = 0;
        if (hasAnyResidual && sharedResidScales[i]! > 0) {
          const wObs = observedWeightSums[i]!;
          if (wObs > 0 && wObs < totalUniverseW - 1e-12) {
            const fOff = famIdx[i]! * activeB;
            const mask = observedMasks[i]!;
            let sumAllW = 0;
            let sumObsW = 0;
            for (let b = 0; b < activeB; b++) {
              const rIb =
                sigmaResidScore *
                (SQRT_PROV * provBmNoise[b]! +
                  SQRT_FAM * famBmNoise[fOff + b]! +
                  SQRT_INDIV * gaussian());
              const wb = bmWeights[b]!;
              sumAllW += wb * rIb;
              if (mask[b] === 1) sumObsW += wb * rIb;
            }
            epsResidual = (sumObsW / wObs - sumAllW / totalUniverseW) * sharedResidScales[i]!;
          }
        }
        sampledScores[i] = scores[i]! + epsIndep + epsLink + epsResidual;
        const pb = pbConfigs[i];
        const sib = sibConfigs[i];
        const olsCfg = olsConfigs[i];
        const unidCell = unidCellConfigs[i];
        if (pb) {
          sampledCosts[i] = pbDrawCostById.get(ordered[i]!.id) ?? costs[i]!;
        } else if (sib) {
          if (Number.isFinite(sib.loLog) || Number.isFinite(sib.hiLog)) {
            // Exact Gaussian copula preserves the published truncated-log-normal marginal across any slice size
            const withinDenom = Math.hypot(sib.baseSd, sib.tierSd);
            const zCorr =
              withinDenom > 0
                ? (sib.baseSd * sibZ[sib.groupIdx]! + sib.tierSd * gaussian()) / withinDenom
                : gaussian();
            const u = normalCdf(zCorr);
            const alpha = Number.isFinite(sib.loLog)
              ? (sib.loLog - sib.rawMu) / sib.totalSd
              : Number.NEGATIVE_INFINITY;
            const beta = Number.isFinite(sib.hiLog)
              ? (sib.hiLog - sib.rawMu) / sib.totalSd
              : Number.POSITIVE_INFINITY;
            const zDraw = sampleTruncatedStandardNormal(alpha, beta, u);
            const logVal = Math.min(
              sib.hiLog,
              Math.max(sib.loLog, sib.rawMu + sib.totalSd * zDraw),
            );
            sampledCosts[i] = Math.exp(logVal);
          } else if (sib.parentPartialIds.length > 0) {
            let parentLogSum = 0;
            let validParents = 0;
            for (const pid of sib.parentPartialIds) {
              const pCost = pbDrawCostById.get(pid);
              if (pCost !== undefined && pCost > 0) {
                parentLogSum += Math.log(pCost);
                validParents++;
              }
            }
            const baseLog =
              validParents === sib.parentPartialIds.length && validParents > 0
                ? parentLogSum / validParents - sib.avgParentEffOff + sib.targetEffOff
                : sib.rawMu;
            sampledCosts[i] = Math.exp(
              baseLog + sib.baseSd * sibZ[sib.groupIdx]! + sib.tierSd * gaussian(),
            );
          } else {
            sampledCosts[i] = Math.exp(
              sib.rawMu + sib.baseSd * sibZ[sib.groupIdx]! + sib.tierSd * gaussian(),
            );
          }
        } else if (olsCfg && olsModel) {
          let coeffShift = 0;
          for (let r = 0; r < olsDim; r++) coeffShift += olsCfg.xVec[r]! * olsDeltaBeta[r]!;
          sampledCosts[i] = Math.exp(
            olsCfg.predMeanLog + coeffShift + olsModel.residSd * gaussian(),
          );
        } else if (unidCell) {
          sampledCosts[i] = Math.exp(
            unidCell.cellMeanLog +
              unidCell.meanSd * unidCellZ[unidCell.cellIdx]! +
              unidCell.residSd * gaussian(),
          );
        } else {
          const spec = costSpecs[i]!;
          if (spec.mode === "unbounded") {
            sampledCosts[i] = costFixedFloors[i]! + Math.exp(spec.mu + spec.sd * gaussian());
          } else if (spec.mode === "truncated") {
            const zDraw = sampleTruncatedStandardNormal(spec.alpha, spec.beta, rng());
            const varDraw = Math.min(
              spec.hi,
              Math.max(spec.lo, Math.exp(spec.mu + spec.sd * zDraw)),
            );
            sampledCosts[i] = costFixedFloors[i]! + varDraw;
          } else {
            sampledCosts[i] = costs[i]!;
          }
        }
        drawOrder[i] = i;
      }
      drawOrder.sort((a, b) => sampledCosts[a]! - sampledCosts[b]!);
      let bestSoFar = -Infinity;
      let idxPos = 0;
      while (idxPos < n) {
        let endPos = idxPos + 1;
        const baseC = sampledCosts[drawOrder[idxPos]!]!;
        while (endPos < n && sampledCosts[drawOrder[endPos]!]! - baseC <= COST_EPSILON) endPos++;
        let bestIdx = -1;
        let bestVal = -Infinity;
        for (let k = idxPos; k < endPos; k++) {
          const ci = drawOrder[k]!;
          const sc = sampledScores[ci]!;
          if (sc > bestVal) {
            bestVal = sc;
            bestIdx = ci;
          }
        }
        if (bestIdx >= 0 && bestVal > bestSoFar) {
          hits[bestIdx] = hits[bestIdx]! + 1;
          bestSoFar = bestVal;
        }
        idxPos = endPos;
      }
      continue;
    }

    let bestSoFar = -Infinity;
    for (let g = 0; g < groupStart.length; g++) {
      const start = groupStart[g]!;
      const end = groupEnd[g]!;
      let bestIdx = -1;
      let bestVal = -Infinity;

      for (let i = start; i < end; i++) {
        const epsIndep = indepNoiseSes[i]! * gaussian();
        let epsLink = 0;
        if (hasJointLink) {
          const jc = configJointCoeffs[i]!;
          for (let c = 0; c < jointLinkRank; c++) {
            const v = jc[c]!;
            if (v !== 0) epsLink += v * jointLinkZ[c]!;
          }
        }
        if (hasFallbackLink) {
          for (const t of configFallbackTerms[i]!) {
            epsLink += t.scale * (linkDrawA[t.linkIdx]! + linkDrawS[t.linkIdx]! * t.oriented);
          }
        }
        let epsResidual = 0;
        if (hasAnyResidual && sharedResidScales[i]! > 0) {
          const wObs = observedWeightSums[i]!;
          if (wObs > 0 && wObs < totalUniverseW - 1e-12) {
            const fOff = famIdx[i]! * activeB;
            const mask = observedMasks[i]!;
            let sumAllW = 0;
            let sumObsW = 0;
            for (let b = 0; b < activeB; b++) {
              const rIb =
                sigmaResidScore *
                (SQRT_PROV * provBmNoise[b]! +
                  SQRT_FAM * famBmNoise[fOff + b]! +
                  SQRT_INDIV * gaussian());
              const wb = bmWeights[b]!;
              sumAllW += wb * rIb;
              if (mask[b] === 1) sumObsW += wb * rIb;
            }
            epsResidual = (sumObsW / wObs - sumAllW / totalUniverseW) * sharedResidScales[i]!;
          }
        }
        const sampled = scores[i]! + epsIndep + epsLink + epsResidual;
        if (sampled > bestVal) {
          bestVal = sampled;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0 && bestVal > bestSoFar) {
        hits[bestIdx] = hits[bestIdx]! + 1;
        bestSoFar = bestVal;
      }
    }
  }

  for (let i = 0; i < n; i++) {
    counts.set(ordered[i]!.id, Number((hits[i]! / draws).toFixed(4)));
  }
  return counts;
}

/**
 * Computes the single strictly monotonic upper Pareto frontier for one provider slice.
 * Guarantees cost[i] < cost[i+1] and score[i] < score[i+1] with zero parallel lines.
 */
export function computeProviderFrontier(
  providerConfigs: readonly EvaluatedConfig[],
  paretoProbById?: ReadonlyMap<string, number>,
  imputationSensitiveById?: ReadonlyMap<string, boolean>,
  weightByBenchmark?: ReadonlyMap<string, number>,
  anchorStats?: Readonly<Record<string, AnchorStats>>,
  linkJointCov?: LinkJointCov | null,
  shrinkageMode: ShrinkageMode = "measurement",
): {
  frontier: FrontierPoint[];
  pruned: PrunedConfig[];
} {
  const priced = providerConfigs.filter(isPriced);
  if (priced.length === 0) return { frontier: [], pruned: [] };

  const ordered = sortByCostAscScoreDesc(priced);
  const surviving: PricedConfig[] = [];
  const pruned: PrunedConfig[] = [];

  let bestScore = -Infinity;
  let bestLeader: PricedConfig | null = null;

  let i = 0;
  while (i < ordered.length) {
    let j = i + 1;
    const tierCost = ordered[i]!.effectiveCostUsd;
    while (j < ordered.length && ordered[j]!.effectiveCostUsd - tierCost <= COST_EPSILON) {
      j++;
    }

    // Choose the highest-scoring config inside the cost-epsilon cluster to match computeBootstrapParetoProb
    let winnerIdx = i;
    for (let k = i + 1; k < j; k++) {
      const cur = ordered[k]!;
      const best = ordered[winnerIdx]!;
      if (
        cur.score > best.score + SCORE_TIE_EPSILON ||
        (Math.abs(cur.score - best.score) <= SCORE_TIE_EPSILON &&
          (cur.effectiveCostUsd < best.effectiveCostUsd ||
            (cur.effectiveCostUsd === best.effectiveCostUsd && compareAscii(cur.id, best.id) < 0)))
      ) {
        winnerIdx = k;
      }
    }

    const tierWinner = ordered[winnerIdx]!;
    if (tierWinner.score > bestScore + SCORE_TIE_EPSILON) {
      surviving.push(tierWinner);
      bestScore = tierWinner.score;
      bestLeader = tierWinner;

      for (let k = i; k < j; k++) {
        if (k === winnerIdx) continue;
        const loser = ordered[k]!;
        const sameListSku =
          loser.costSource === "list" &&
          tierWinner.costSource === "list" &&
          loser.modelSlug === tierWinner.modelSlug &&
          Math.abs(loser.effectiveCostUsd - tierWinner.effectiveCostUsd) <= COST_EPSILON;
        pruned.push({
          configId: loser.id,
          dominatedById: tierWinner.id,
          scoreDeficit: Number(Math.max(0, tierWinner.score - loser.score).toFixed(2)),
          costRatio: sameListSku
            ? null
            : Number((loser.effectiveCostUsd / tierWinner.effectiveCostUsd).toFixed(2)),
          costComparisonNote: sameListSku ? "same list SKU, effort cost not priced" : null,
        });
      }
    } else if (bestLeader) {
      for (let k = i; k < j; k++) {
        const loser = ordered[k]!;
        const sameListSku =
          loser.costSource === "list" &&
          bestLeader.costSource === "list" &&
          loser.modelSlug === bestLeader.modelSlug &&
          Math.abs(loser.effectiveCostUsd - bestLeader.effectiveCostUsd) <= COST_EPSILON;
        pruned.push({
          configId: loser.id,
          dominatedById: bestLeader.id,
          scoreDeficit: Number(Math.max(0, bestLeader.score - loser.score).toFixed(2)),
          costRatio: sameListSku
            ? null
            : Number((loser.effectiveCostUsd / bestLeader.effectiveCostUsd).toFixed(2)),
          costComparisonNote: sameListSku ? "same list SKU, effort cost not priced" : null,
        });
      }
    }

    i = j;
  }

  const frontier: FrontierPoint[] = surviving.map((cfg, idx) => {
    const paretoProb = paretoProbById?.get(cfg.id) ?? cfg.paretoProb;
    const imputationSensitive = imputationSensitiveById?.get(cfg.id) ?? cfg.imputationSensitive;
    if (idx === 0) {
      return {
        configId: cfg.id,
        zStepFromPrev: null,
        pBetterThanPrev: null,
        statisticallyTied: false,
        imputationSensitive,
        paretoProb,
        marginalScorePerDollar: null,
        costMultipleFromPrev: null,
      };
    }

    const prev = surviving[idx - 1]!;
    const sig = stepSignificance(
      prev,
      cfg,
      weightByBenchmark,
      anchorStats,
      linkJointCov,
      shrinkageMode,
    );
    const deltaCost = Math.max(COST_EPSILON, cfg.effectiveCostUsd - prev.effectiveCostUsd);
    const marginal = (cfg.score - prev.score) / deltaCost;

    return {
      configId: cfg.id,
      zStepFromPrev: sig.zStep,
      pBetterThanPrev: sig.pBetter,
      statisticallyTied: sig.statisticallyTied,
      imputationSensitive,
      paretoProb,
      marginalScorePerDollar: Number(marginal.toFixed(3)),
      costMultipleFromPrev: Number((cfg.effectiveCostUsd / prev.effectiveCostUsd).toFixed(2)),
    };
  });

  return { frontier, pruned };
}

/**
 * Extracts Budget, Knee Default (largest perpendicular elevation above the budget-to-max
 * chord in normalized log-cost vs score space that beats Budget by >= 1.0 SE), and Max.
 */
export function extractVerdictPicks(
  frontier: readonly FrontierPoint[],
  configById: ReadonlyMap<string, EvaluatedConfig>,
  options?: {
    preferDistinctModelSlug?: boolean;
    weightByBenchmark?: ReadonlyMap<string, number>;
    anchorStats?: Readonly<Record<string, AnchorStats>>;
    linkJointCov?: LinkJointCov | null | undefined;
    shrinkageMode?: ShrinkageMode;
  },
): { budgetId: string | null; defaultId: string | null; maxId: string | null } {
  if (frontier.length === 0) {
    return { budgetId: null, defaultId: null, maxId: null };
  }

  const budgetId = frontier[0]!.configId;
  const maxId = frontier[frontier.length - 1]!.configId;

  if (frontier.length < 3) {
    return { budgetId, defaultId: null, maxId };
  }

  const first = configById.get(budgetId);
  const last = configById.get(maxId);
  if (!first || !last || first.effectiveCostUsd === null || last.effectiveCostUsd === null) {
    return { budgetId, defaultId: null, maxId };
  }

  const logMin = Math.log10(Math.max(1e-6, first.effectiveCostUsd));
  const logMax = Math.log10(Math.max(1e-6, last.effectiveCostUsd));
  const logSpan = Math.max(1e-6, logMax - logMin);
  const scoreSpan = Math.max(1e-6, last.score - first.score);
  const preferDistinct = options?.preferDistinctModelSlug ?? false;
  const weightByBenchmark = options?.weightByBenchmark;
  const anchorStats = options?.anchorStats;
  const linkJointCov = options?.linkJointCov;
  const shrinkageMode = options?.shrinkageMode ?? "measurement";
  const endpointSlugs = new Set<string>([first.modelSlug, last.modelSlug]);

  let bestQualifiedAnyId: string | null = null;
  let bestQualifiedAnyLift = 0.02;
  let bestQualifiedDistinctId: string | null = null;
  let bestQualifiedDistinctLift = 0.02;

  let bestDiscountAnyId: string | null = null;
  let bestDiscountAnyLift = Number.NEGATIVE_INFINITY;
  let bestDiscountDistinctId: string | null = null;
  let bestDiscountDistinctLift = Number.NEGATIVE_INFINITY;

  let bestAnyId: string | null = null;
  let bestAnyLift = 0.02;
  let bestDistinctId: string | null = null;
  let bestDistinctLift = 0.02;

  let bestConvexAnyId: string | null = null;
  let bestConvexAnyLift = Number.NEGATIVE_INFINITY;
  let bestConvexDistinctId: string | null = null;
  let bestConvexDistinctLift = Number.NEGATIVE_INFINITY;

  for (let idx = 1; idx < frontier.length - 1; idx++) {
    const pt = frontier[idx]!;
    const cfg = configById.get(pt.configId);
    if (!cfg || cfg.effectiveCostUsd === null) continue;
    // Require a statistically reliable gain (>= 1.0 SE) over Budget rather than over the adjacent step
    if (
      stepSignificance(first, cfg, weightByBenchmark, anchorStats, linkJointCov, shrinkageMode)
        .statisticallyTied
    )
      continue;

    const normCost = (Math.log10(Math.max(1e-6, cfg.effectiveCostUsd)) - logMin) / logSpan;
    const normScore = (cfg.score - first.score) / scoreSpan;
    const liftAboveChord = normScore - normCost;

    // Best value targets serious contenders (>= 55% of the score gain and within 1 SD of Top score)
    const isSeriousContender = normScore >= 0.55 && last.score - cfg.score <= 15;
    if (isSeriousContender) {
      if (liftAboveChord > bestQualifiedAnyLift) {
        bestQualifiedAnyLift = liftAboveChord;
        bestQualifiedAnyId = pt.configId;
      }
      if (
        preferDistinct &&
        !endpointSlugs.has(cfg.modelSlug) &&
        liftAboveChord > bestQualifiedDistinctLift
      ) {
        bestQualifiedDistinctLift = liftAboveChord;
        bestQualifiedDistinctId = pt.configId;
      }
      // On convex curves with an ultra-cheap Budget anchor, allow serious contenders priced <= 50% of Top score
      if (cfg.effectiveCostUsd <= last.effectiveCostUsd * 0.5) {
        if (liftAboveChord > bestDiscountAnyLift) {
          bestDiscountAnyLift = liftAboveChord;
          bestDiscountAnyId = pt.configId;
        }
        if (
          preferDistinct &&
          !endpointSlugs.has(cfg.modelSlug) &&
          liftAboveChord > bestDiscountDistinctLift
        ) {
          bestDiscountDistinctLift = liftAboveChord;
          bestDiscountDistinctId = pt.configId;
        }
      }
    }

    if (liftAboveChord > bestAnyLift) {
      bestAnyLift = liftAboveChord;
      bestAnyId = pt.configId;
    }
    if (preferDistinct && !endpointSlugs.has(cfg.modelSlug) && liftAboveChord > bestDistinctLift) {
      bestDistinctLift = liftAboveChord;
      bestDistinctId = pt.configId;
    }

    // Last-resort convex-curve pick only when no interior point sits above the log-cost chord
    if (
      normScore >= 0.45 &&
      last.score - cfg.score <= 15 &&
      cfg.effectiveCostUsd <= last.effectiveCostUsd * 0.5
    ) {
      if (liftAboveChord > bestConvexAnyLift) {
        bestConvexAnyLift = liftAboveChord;
        bestConvexAnyId = pt.configId;
      }
      if (
        preferDistinct &&
        !endpointSlugs.has(cfg.modelSlug) &&
        liftAboveChord > bestConvexDistinctLift
      ) {
        bestConvexDistinctLift = liftAboveChord;
        bestConvexDistinctId = pt.configId;
      }
    }
  }

  const bestQualifiedId = preferDistinct
    ? (bestQualifiedDistinctId ?? bestQualifiedAnyId)
    : bestQualifiedAnyId;
  const bestDiscountId = preferDistinct
    ? (bestDiscountDistinctId ?? bestDiscountAnyId)
    : bestDiscountAnyId;
  const bestFallbackId = preferDistinct ? (bestDistinctId ?? bestAnyId) : bestAnyId;
  const bestConvexId = preferDistinct ? (bestConvexDistinctId ?? bestConvexAnyId) : bestConvexAnyId;
  return {
    budgetId,
    defaultId: bestQualifiedId ?? bestFallbackId ?? bestDiscountId ?? bestConvexId,
    maxId,
  };
}
