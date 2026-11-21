import { type BenchmarkMeta, DOMAIN_BY_ID } from "../../config/benchmarks.ts";
import type {
  AnchorStats,
  BenchmarkAudit,
  CrossDomainCorrelation,
  DomainId,
  DomainSnapshot,
  EpochLink,
  EvaluatedConfig,
  HarnessRegime,
  LinkJointCov,
  ProviderId,
} from "../schema.ts";
import { compareAscii, computeConfigPosterior, computeMeasurementSe } from "./aggregate.ts";

export const SUSTAINED_RETIRE_DAYS = 14;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Akhtar ICML 2026 n_eff = sqrt(n) inflation applies only to range-bounded Popoviciu SEs, not upstream CIs or SEs
function effectiveSeAkhtar(
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

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function rawKendallTauB(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 4) return null;

  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = xs[i]! - xs[j]!;
      const dy = ys[i]! - ys[j]!;
      const tx = Math.abs(dx) < 1e-9;
      const ty = Math.abs(dy) < 1e-9;
      if (tx && ty) continue;
      if (tx) {
        tiesX++;
      } else if (ty) {
        tiesY++;
      } else if (dx * dy > 0) {
        concordant++;
      } else {
        discordant++;
      }
    }
  }

  const denom = Math.sqrt((concordant + discordant + tiesX) * (concordant + discordant + tiesY));
  if (denom <= 0) return null;
  return (concordant - discordant) / denom;
}

export function kendallTauB(xs: readonly number[], ys: readonly number[]): number | null {
  const raw = rawKendallTauB(xs, ys);
  return raw === null ? null : Number(raw.toFixed(4));
}

function isValidCalendarYmd(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d;
}

// Parse strictly YYYY-MM-DD or exact ISO-8601 timestamp with Z / ±HH:MM offset into UTC midnight epoch ms
export function parseStrictUtcDateMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const trimmed = iso.trim();
  const dateOnly = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly?.[1] && dateOnly[2] && dateOnly[3]) {
    const y = Number(dateOnly[1]);
    const mo = Number(dateOnly[2]);
    const d = Number(dateOnly[3]);
    return isValidCalendarYmd(y, mo, d) ? Date.UTC(y, mo - 1, d) : null;
  }

  const fullIso = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!fullIso) return null;
  const y = Number(fullIso[1]);
  const mo = Number(fullIso[2]);
  const d = Number(fullIso[3]);
  const hh = Number(fullIso[4]);
  const mm = Number(fullIso[5]);
  const ss = Number(fullIso[6]);
  if (!isValidCalendarYmd(y, mo, d) || hh > 23 || mm > 59 || ss > 59) return null;

  let offsetMin = 0;
  const tz = fullIso[8]!;
  if (tz !== "Z") {
    const sign = tz[0] === "+" ? 1 : -1;
    const offH = Number(tz.slice(1, 3));
    const offM = Number(tz.slice(4, 6));
    if (offH > 23 || offM > 59) return null;
    offsetMin = sign * (offH * 60 + offM);
  }

  const ms = Date.UTC(y, mo - 1, d, hh, mm, ss) - offsetMin * 60_000;
  const utc = new Date(ms);
  return Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

export function utcCalendarDayDiff(fromIso: string, toIso: string): number | null {
  const start = parseStrictUtcDateMs(fromIso);
  const end = parseStrictUtcDateMs(toIso);
  if (start === null || end === null) return null;
  return Math.round((end - start) / MS_PER_DAY);
}

function monthsBetween(fromIso: string, toIso: string): number {
  const days = utcCalendarDayDiff(fromIso, toIso);
  if (days === null || days < 0) return 0;
  return Number((days / 30.4375).toFixed(1));
}

function daysBetweenStrict(fromIso: string, toIso: string): number | null {
  const days = utcCalendarDayDiff(fromIso, toIso);
  if (days === null || days < 0) return null;
  return days;
}

function orient(meta: BenchmarkMeta, rawScore: number): number {
  return meta.invertScore ? -rawScore : rawScore;
}

// Facing-side 1-SE half-widths for exact two-sample 95% pairwise separability test |A - B| > 1.96 * hypot(seLowA, seHighB)
function facingSeBounds(
  meta: BenchmarkMeta,
  obs: {
    rawScore: number;
    oriented: number;
    seRaw?: number | null;
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
    const seLow = Math.max(0, obs.oriented - low) / 1.96;
    const seHigh = Math.max(0, high - obs.oriented) / 1.96;
    return { seLow, seHigh };
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

function canonicalItemRestKey(
  provider: ProviderId,
  modelSlug: string,
  effort: string,
  harness: string,
  regime: HarnessRegime,
): string {
  const stableHarness = harness === "multi-harness" ? "direct" : harness;
  return `${provider}:${modelSlug}:${effort}:${stableHarness}:${regime}`;
}

export interface BenchmarkAuditInput {
  meta: BenchmarkMeta;
  harnessRegime: HarnessRegime;
  coverageFloor: number;
  domainConfigs: readonly EvaluatedConfig[];
  anchorStats: Readonly<Record<string, AnchorStats>>;
  activeBenchmarkIds?: readonly string[];
  withheldBenchmarkIds?: readonly string[];
  calibrationTauResidSq?: number;
  priorMean?: number;
  tauModelSq?: number;
  linkJointCov?: LinkJointCov;
  candidateRawScores?: readonly {
    configId: string;
    provider: ProviderId;
    modelSlug: string;
    effort: string;
    harness: string;
    rawScore: number;
    seRaw: number | null;
    ciHalfWidth: number | null;
    ciLower: number | null;
    ciUpper: number | null;
    evalDate: string | null;
  }[];
  priorAudit?: Pick<
    BenchmarkAudit,
    "benchmarkVersion" | "triggerSince" | "consecutiveTriggerDays"
  > | null;
  priorAuditedAt?: string | null;
  nowIso: string;
}

export function auditBenchmarkLifecycle(input: BenchmarkAuditInput): BenchmarkAudit {
  const { meta, harnessRegime, coverageFloor, domainConfigs, anchorStats, nowIso } = input;
  const minLabs = DOMAIN_BY_ID[meta.domainId].minLabsForSaturation;
  const regimeConfigs = domainConfigs.filter((c) => c.harnessRegime === harnessRegime);

  const perLabPeak = new Map<
    ProviderId,
    {
      provider: ProviderId;
      tieKey: string;
      rawScore: number;
      oriented: number;
      seRaw: number | null;
      ciHalfWidth: number | null;
      ciLower: number | null;
      ciUpper: number | null;
      akhtarSe: number | null;
      evalDate: string | null;
    }
  >();
  let latestEvalDate: string | null = null;
  const nowDateMs = parseStrictUtcDateMs(nowIso);

  const considerDate = (d: string | null) => {
    if (!d || nowDateMs === null) return;
    const ms = parseStrictUtcDateMs(d);
    if (ms === null || ms > nowDateMs) return;
    const normalized = new Date(ms).toISOString().slice(0, 10);
    if (!latestEvalDate || normalized > latestEvalDate) {
      latestEvalDate = normalized;
    }
  };

  const considerLeader = (
    provider: ProviderId,
    tieKey: string,
    rawScore: number,
    seRaw: number | null,
    ciHalfWidth: number | null,
    ciLower: number | null,
    ciUpper: number | null,
    evalDate: string | null,
  ) => {
    const oriented = orient(meta, rawScore);
    const akhtarSe = effectiveSeAkhtar(rawScore, ciHalfWidth, meta, ciLower, ciUpper, seRaw);
    const cur = perLabPeak.get(provider);
    const beatsTie =
      cur !== undefined &&
      oriented === cur.oriented &&
      ((akhtarSe ?? Number.POSITIVE_INFINITY) < (cur.akhtarSe ?? Number.POSITIVE_INFINITY) ||
        ((akhtarSe ?? Number.POSITIVE_INFINITY) === (cur.akhtarSe ?? Number.POSITIVE_INFINITY) &&
          compareAscii(tieKey, cur.tieKey) < 0));
    if (!cur || oriented > cur.oriented || beatsTie) {
      perLabPeak.set(provider, {
        provider,
        tieKey,
        rawScore,
        oriented,
        seRaw,
        ciHalfWidth,
        ciLower,
        ciUpper,
        akhtarSe,
        evalDate,
      });
    }
    considerDate(evalDate);
  };

  if (input.candidateRawScores && input.candidateRawScores.length > 0) {
    for (const row of input.candidateRawScores) {
      considerLeader(
        row.provider,
        `${row.configId}:${row.rawScore}:${row.ciLower ?? ""}:${row.ciUpper ?? ""}:${row.evalDate ?? ""}`,
        row.rawScore,
        row.seRaw,
        row.ciHalfWidth,
        row.ciLower,
        row.ciUpper,
        row.evalDate,
      );
    }
  } else {
    for (const cfg of regimeConfigs) {
      const bm = cfg.benchmarks.find((b) => b.benchmarkId === meta.id);
      if (!bm) continue;
      considerLeader(
        cfg.provider,
        cfg.id,
        bm.rawScore,
        bm.seRaw ??
          (bm.seModel === "upstream_se" && bm.ciHalfWidth !== null ? bm.ciHalfWidth / 1.96 : null),
        bm.ciHalfWidth,
        bm.ciLower,
        bm.ciUpper,
        bm.evalDate,
      );
    }
  }

  const labLeaders = [...perLabPeak.values()].toSorted((a, b) => {
    if (b.oriented !== a.oriented) return b.oriented - a.oriented;
    const seA = a.akhtarSe ?? Number.POSITIVE_INFINITY;
    const seB = b.akhtarSe ?? Number.POSITIVE_INFINITY;
    if (seA !== seB) return seA < seB ? -1 : 1;
    return compareAscii(a.provider, b.provider);
  });
  const coveredLabsCount = labLeaders.length;
  const topK = labLeaders.slice(0, minLabs);
  const ageMonths = monthsBetween(meta.introducedAt, nowIso);
  const upstreamLagDays = latestEvalDate ? daysBetweenStrict(latestEvalDate, nowIso) : null;

  let top1Score: number | null = null;
  let top5Score: number | null = null;
  let top5Median: number | null = null;
  let rawTop5Median: number | null = null;
  let rawRNorm: number | null = null;
  let rawSaturationIndex: number | null = null;
  let rawSeparability: number | null = null;
  let rNorm: number | null = null;
  let saturationIndex: number | null = null;
  let separability: number | null = null;

  if (topK.length >= minLabs) {
    const top1 = topK[0]!;
    const topLast = topK[topK.length - 1]!;
    rawTop5Median = median(topK.map((x) => x.rawScore));
    top1Score = Number(top1.rawScore.toFixed(2));
    top5Score = Number(topLast.rawScore.toFixed(2));
    top5Median = Number(rawTop5Median.toFixed(2));

    const se1Akhtar = effectiveSeAkhtar(
      top1.rawScore,
      top1.ciHalfWidth,
      meta,
      top1.ciLower,
      top1.ciUpper,
      top1.seRaw,
    );
    const seLastAkhtar = effectiveSeAkhtar(
      topLast.rawScore,
      topLast.ciHalfWidth,
      meta,
      topLast.ciLower,
      topLast.ciUpper,
      topLast.seRaw,
    );
    if (se1Akhtar !== null && seLastAkhtar !== null) {
      const seDelta = Math.sqrt(se1Akhtar * se1Akhtar + seLastAkhtar * seLastAkhtar);
      const spread = Math.max(0, top1.oriented - topLast.oriented);

      if (seDelta > 1e-9) {
        rawRNorm = spread / seDelta;
        rawSaturationIndex = Math.exp(-(rawRNorm * rawRNorm));
        rNorm = Number(rawRNorm.toFixed(3));
        saturationIndex = Number(rawSaturationIndex.toFixed(4));
      }
    }

    // Two-sample 95% statistical separability over all lab-leader pairs; fail closed if any leader lacks valid SE
    const leaderSeBounds = labLeaders.map((leader) => facingSeBounds(meta, leader));
    const allLeadersHaveSe = leaderSeBounds.every((b) => b !== null);
    if (allLeadersHaveSe && labLeaders.length >= 2) {
      let sepPairs = 0;
      const totalPairs = (labLeaders.length * (labLeaders.length - 1)) / 2;
      for (let i = 0; i < labLeaders.length; i++) {
        for (let j = i + 1; j < labLeaders.length; j++) {
          const hi = labLeaders[i]!;
          const lo = labLeaders[j]!;
          const seHi = leaderSeBounds[i]!;
          const seLo = leaderSeBounds[j]!;
          const diff = hi.oriented - lo.oriented;
          const threshold = 1.96 * Math.hypot(seHi.seLow, seLo.seHigh);
          if (diff > threshold) {
            sepPairs++;
          }
        }
      }
      rawSeparability = sepPairs / totalPairs;
      separability = Number(rawSeparability.toFixed(3));
    }
  }

  // Coverage-eligible LOO stability (null on weight-0 candidates) + item-rest correlation for both active & candidates
  const fullThetas: number[] = [];
  const withoutBThetas: number[] = [];
  const itemResids: number[] = [];
  const restThetas: number[] = [];
  let pairedWithTargetCount = 0;

  const deltaFor = (benchmarkId: string): number => {
    const key = harnessRegime === "standardized" ? `${benchmarkId}::standardized` : benchmarkId;
    return anchorStats[key]?.raschDelta ?? 0;
  };
  const weightFor = (benchmarkId: string): number => {
    const key = harnessRegime === "standardized" ? `${benchmarkId}::standardized` : benchmarkId;
    return anchorStats[key]?.effectiveWeight ?? 1;
  };

  if (meta.lifecycleState === "CANDIDATE") {
    if (input.candidateRawScores && input.candidateRawScores.length > 0) {
      // Join on stable canonical key independent of display relabeling (direct -> multi-harness)
      const cfgByKey = new Map(
        regimeConfigs.map((c) => [
          canonicalItemRestKey(c.provider, c.modelSlug, c.effort, c.harness, c.harnessRegime),
          c,
        ]),
      );
      for (const row of input.candidateRawScores) {
        const cfg = cfgByKey.get(
          canonicalItemRestKey(row.provider, row.modelSlug, row.effort, row.harness, harnessRegime),
        );
        if (!cfg || cfg.coverageCount < coverageFloor) continue;
        itemResids.push(orient(meta, row.rawScore));
        restThetas.push(cfg.theta);
      }
    }
  } else {
    const canComputeEbPosterior =
      input.activeBenchmarkIds !== undefined &&
      input.calibrationTauResidSq !== undefined &&
      input.priorMean !== undefined &&
      input.tauModelSq !== undefined;

    for (const cfg of regimeConfigs) {
      if (cfg.coverageCount < coverageFloor) continue;
      const target = cfg.benchmarks.find((b) => b.benchmarkId === meta.id);
      const restBenchmarks = cfg.benchmarks.filter((b) => b.benchmarkId !== meta.id);
      if (restBenchmarks.length === 0) continue;

      let fullTheta: number;
      let restTheta: number;
      if (canComputeEbPosterior) {
        const restPost = computeConfigPosterior(
          restBenchmarks,
          anchorStats,
          harnessRegime,
          input.activeBenchmarkIds!.filter((id) => id !== meta.id),
          input.withheldBenchmarkIds ?? [],
          input.calibrationTauResidSq!,
          input.priorMean!,
          input.tauModelSq!,
          undefined,
          input.linkJointCov,
        );
        if (!restPost) continue;
        fullTheta = cfg.theta;
        restTheta = restPost.theta;
      } else {
        let sumAllW = 0;
        let totalW = 0;
        let sumRestW = 0;
        let restW = 0;
        for (const bm of cfg.benchmarks) {
          const w = weightFor(bm.benchmarkId);
          const adj = bm.zScore - deltaFor(bm.benchmarkId);
          sumAllW += w * adj;
          totalW += w;
          if (bm.benchmarkId !== meta.id) {
            sumRestW += w * adj;
            restW += w;
          }
        }
        if (restW <= 0 || totalW <= 0) continue;
        fullTheta = sumAllW / totalW;
        restTheta = sumRestW / restW;
      }

      fullThetas.push(fullTheta);
      withoutBThetas.push(restTheta);

      if (target) {
        pairedWithTargetCount++;
        itemResids.push(target.zScore - deltaFor(meta.id));
        restThetas.push(restTheta);
      }
    }
  }

  // Require >= 2 surviving configs that actually observed this benchmark so removing it cannot yield a vacuous tau = 1
  const hasPairedLooEvidence = pairedWithTargetCount >= 2;
  const looCohortCount = hasPairedLooEvidence ? fullThetas.length : 0;
  const rawLooTau = hasPairedLooEvidence ? rawKendallTauB(fullThetas, withoutBThetas) : null;
  const looKendallTau = rawLooTau === null ? null : Number(rawLooTau.toFixed(4));
  const itemRestTau = kendallTauB(itemResids, restThetas);

  const reasons: string[] = [];

  if (meta.lifecycleState === "CANDIDATE") {
    const enoughLabs = coveredLabsCount >= minLabs;
    const unsaturated = rawSaturationIndex !== null && rawSaturationIndex < 0.55;
    const belowCeiling = !(
      meta.boundedMax === 100 &&
      rawTop5Median !== null &&
      rawTop5Median >= 90
    );
    const separable = rawSeparability !== null && rawSeparability >= 0.5;
    const fresh = upstreamLagDays !== null && upstreamLagDays <= 90;

    if (!enoughLabs) reasons.push(`Needs ${minLabs} distinct labs; has ${coveredLabsCount}`);
    if (!unsaturated) reasons.push("Saturation index missing or >= 0.55");
    if (!belowCeiling) {
      reasons.push(`Top-${minLabs} median ${top5Median?.toFixed(1)}% >= 90% ceiling`);
    }
    if (!separable) {
      reasons.push(
        separability === null
          ? "95% pairwise separability unavailable"
          : `95% pairwise separability ${(separability * 100).toFixed(0)}% < 50%`,
      );
    }
    if (!fresh) {
      reasons.push(
        upstreamLagDays === null
          ? "Per-model evalDate not published by upstream"
          : `Upstream feed stale (${upstreamLagDays}d > 90d)`,
      );
    }

    const ready = enoughLabs && unsaturated && belowCeiling && separable && fresh;
    if (ready) reasons.push("Cleared coverage, saturation, separability, and freshness gates");

    return {
      benchmarkId: meta.id,
      benchmarkVersion: meta.version,
      domainId: meta.domainId,
      harnessRegime,
      lifecycleState: meta.lifecycleState,
      top5LabsCount: topK.length,
      coveredLabsCount,
      top1Score,
      top5Score,
      top5Median,
      rNorm,
      saturationIndex,
      separability,
      looKendallTau,
      looCohortCount,
      itemRestTau,
      ageMonths,
      upstreamLagDays,
      triggerSince: null,
      consecutiveTriggerDays: 0,
      status: ready ? "probation_ready" : "probation_wait",
      reasons,
    };
  }

  if (coveredLabsCount < minLabs) {
    return {
      benchmarkId: meta.id,
      benchmarkVersion: meta.version,
      domainId: meta.domainId,
      harnessRegime,
      lifecycleState: meta.lifecycleState,
      top5LabsCount: topK.length,
      coveredLabsCount,
      top1Score,
      top5Score,
      top5Median,
      rNorm,
      saturationIndex,
      separability,
      looKendallTau,
      looCohortCount,
      itemRestTau,
      ageMonths,
      upstreamLagDays,
      triggerSince: null,
      consecutiveTriggerDays: 0,
      status: "insufficient",
      reasons: [`Insufficient lab coverage (${coveredLabsCount} of ${minLabs} required labs)`],
    };
  }

  let hardTrigger = false;
  let warnTrigger = false;

  if (rawSaturationIndex === null || rawSeparability === null) {
    warnTrigger = true;
    reasons.push("Uncertainty / separability unavailable");
  }

  if (rawSaturationIndex !== null && rawSaturationIndex >= 0.7) {
    hardTrigger = true;
    reasons.push(`Akhtar saturation index ${(saturationIndex ?? 0).toFixed(2)} >= 0.70`);
  } else if (rawSaturationIndex !== null && rawSaturationIndex >= 0.5) {
    warnTrigger = true;
    reasons.push(
      `Akhtar saturation index ${(saturationIndex ?? 0).toFixed(2)} approaching ceiling`,
    );
  }

  if (
    meta.boundedMax === 100 &&
    rawTop5Median !== null &&
    rawTop5Median >= 90 &&
    rawRNorm !== null &&
    rawRNorm < 2.0
  ) {
    hardTrigger = true;
    reasons.push(`Top-${minLabs} median ${(top5Median ?? 0).toFixed(1)}% with collapsed spread`);
  }

  // Require concurrent saturation pressure (>= 0.50) before low pairwise separability initiates hard retirement
  if (rawSeparability !== null && rawSeparability < 0.35) {
    if (rawSaturationIndex !== null && rawSaturationIndex >= 0.5) {
      hardTrigger = true;
      reasons.push(
        `Pairwise 95% separability ${((separability ?? 0) * 100).toFixed(0)}% < 35% with saturation pressure`,
      );
    } else {
      warnTrigger = true;
      reasons.push(
        `Pairwise 95% separability ${((separability ?? 0) * 100).toFixed(0)}% < 35% (small-N variance)`,
      );
    }
  } else if (rawSeparability !== null && rawSeparability < 0.5) {
    warnTrigger = true;
    reasons.push(`Pairwise 95% separability ${((separability ?? 0) * 100).toFixed(0)}% < 50%`);
  }

  if (rawLooTau !== null && rawLooTau < 0.5) {
    warnTrigger = true;
    reasons.push(`Leave-one-out composite tau ${(looKendallTau ?? 0).toFixed(2)} < 0.50`);
  }

  if (upstreamLagDays !== null && upstreamLagDays > 90) {
    hardTrigger = true;
    reasons.push(`Upstream leaderboard lag ${upstreamLagDays} days > 90 days`);
  }

  // Reconcile prior streak continuity against priorAuditedAt before extending UTC day counter
  const todayUtc = new Date(nowDateMs ?? Date.now()).toISOString().slice(0, 10);
  let triggerSince: string | null = null;
  let consecutiveTriggerDays = 0;

  if (hardTrigger) {
    const versionMatchesPrior = input.priorAudit?.benchmarkVersion === meta.version;
    const priorSince = versionMatchesPrior ? (input.priorAudit?.triggerSince ?? null) : null;
    const priorCount = versionMatchesPrior ? (input.priorAudit?.consecutiveTriggerDays ?? 0) : 0;
    const priorAuditedAt = input.priorAuditedAt ?? null;
    const priorDayDiff = priorAuditedAt ? utcCalendarDayDiff(priorAuditedAt, todayUtc) : null;
    const priorExpectedCount =
      priorSince && priorAuditedAt ? utcCalendarDayDiff(priorSince, priorAuditedAt) : null;
    const priorConsistent =
      priorSince !== null &&
      priorExpectedCount !== null &&
      priorExpectedCount >= 0 &&
      priorCount === priorExpectedCount + 1;

    if (priorConsistent && priorDayDiff !== null && (priorDayDiff === 0 || priorDayDiff === 1)) {
      const span = utcCalendarDayDiff(priorSince, todayUtc);
      if (span !== null && span >= 0) {
        triggerSince = priorSince;
        consecutiveTriggerDays = span + 1;
      } else {
        triggerSince = todayUtc;
        consecutiveTriggerDays = 1;
      }
    } else {
      triggerSince = todayUtc;
      consecutiveTriggerDays = 1;
    }
  }

  let status: BenchmarkAudit["status"] = "healthy";
  if (hardTrigger && consecutiveTriggerDays >= SUSTAINED_RETIRE_DAYS) {
    status = "retire_trigger";
    reasons.push(`Sustained trigger for ${consecutiveTriggerDays} consecutive UTC days`);
  } else if (hardTrigger || warnTrigger) {
    status = "warning";
    if (hardTrigger) {
      reasons.push(
        `Day ${consecutiveTriggerDays} of ${SUSTAINED_RETIRE_DAYS} sustained confirmation window`,
      );
    }
  } else {
    reasons.push("Unsaturated and discriminating across active frontier labs");
  }

  return {
    benchmarkId: meta.id,
    benchmarkVersion: meta.version,
    domainId: meta.domainId,
    harnessRegime,
    lifecycleState: meta.lifecycleState,
    top5LabsCount: topK.length,
    coveredLabsCount,
    top1Score,
    top5Score,
    top5Median,
    rNorm,
    saturationIndex,
    separability,
    looKendallTau,
    looCohortCount,
    itemRestTau,
    ageMonths,
    upstreamLagDays,
    triggerSince,
    consecutiveTriggerDays,
    status,
    reasons,
  };
}

// Empirical pairwise Kendall tau across all active domain-regime tracks
export function computeCrossDomainCorrelations(
  domains: Readonly<Record<DomainId, DomainSnapshot>>,
): CrossDomainCorrelation[] {
  const tracks: readonly { domainId: DomainId; regime: HarnessRegime }[] = [
    { domainId: "coding", regime: "standardized" },
    { domainId: "writing", regime: "native" },
    { domainId: "design_code", regime: "native" },
    { domainId: "research", regime: "native" },
    { domainId: "cyber", regime: "native" },
    { domainId: "harnesses", regime: "native" },
  ];

  const peakScoreByTrack = new Map<string, Map<string, number>>();
  for (const t of tracks) {
    const snap = domains[t.domainId];
    const coverageFloor = snap.regimeMeta[t.regime]?.coverageFloor ?? snap.coverageFloor;
    const map = new Map<string, number>();

    for (const cfg of [...snap.configs, ...snap.provisionalConfigs]) {
      if (cfg.harnessRegime !== t.regime) continue;
      if (cfg.coverageCount < coverageFloor) continue;
      const cur = map.get(cfg.modelSlug);
      if (cur === undefined || cfg.score > cur) {
        map.set(cfg.modelSlug, cfg.score);
      }
    }
    peakScoreByTrack.set(`${t.domainId}::${t.regime}`, map);
  }

  const out: CrossDomainCorrelation[] = [];
  for (let i = 0; i < tracks.length; i++) {
    for (let j = i + 1; j < tracks.length; j++) {
      const a = tracks[i]!;
      const b = tracks[j]!;
      const mapA = peakScoreByTrack.get(`${a.domainId}::${a.regime}`)!;
      const mapB = peakScoreByTrack.get(`${b.domainId}::${b.regime}`)!;

      const xs: number[] = [];
      const ys: number[] = [];
      for (const [slug, scoreA] of mapA.entries()) {
        const scoreB = mapB.get(slug);
        if (scoreB !== undefined) {
          xs.push(scoreA);
          ys.push(scoreB);
        }
      }

      out.push({
        domainA: a.domainId,
        regimeA: a.regime,
        domainB: b.domainId,
        regimeB: b.regime,
        overlapCount: xs.length,
        kendallTau: kendallTauB(xs, ys),
      });
    }
  }
  return out;
}

// Longitudinal Mean-Sigma linking per regime across consecutive MAJOR epochs
export function linkEpochScores(
  previousEpoch: string,
  overlap: readonly { provider: ProviderId; oldTheta: number; newTheta: number }[],
  minLabs: number,
): EpochLink {
  const labs = new Set(overlap.map((o) => o.provider));
  const minOverlap = minLabs <= 4 ? 6 : 8;
  if (overlap.length < minOverlap || labs.size < minLabs) {
    return {
      previousEpoch,
      linked: false,
      overlapCount: overlap.length,
      overlapLabs: labs.size,
      slope: null,
      intercept: null,
      pearsonR: null,
      reason: `Insufficient overlap (${overlap.length} configs across ${labs.size} labs; need >=${minOverlap} across >=${minLabs} labs)`,
    };
  }

  const n = overlap.length;
  const meanOld = overlap.reduce((a, b) => a + b.oldTheta, 0) / n;
  const meanNew = overlap.reduce((a, b) => a + b.newTheta, 0) / n;

  let varOld = 0;
  let varNew = 0;
  let cov = 0;
  for (const o of overlap) {
    const dx = o.oldTheta - meanOld;
    const dy = o.newTheta - meanNew;
    varOld += dx * dx;
    varNew += dy * dy;
    cov += dx * dy;
  }

  const sdOld = Math.sqrt(varOld / n);
  const sdNew = Math.sqrt(varNew / n);
  if (sdOld <= 1e-9 || sdNew <= 1e-9) {
    return {
      previousEpoch,
      linked: false,
      overlapCount: n,
      overlapLabs: labs.size,
      slope: null,
      intercept: null,
      pearsonR: null,
      reason: "Zero variance in overlap cohort; epoch scales are incomparable",
    };
  }

  const r = cov / (n * sdOld * sdNew);
  if (r < 0.85) {
    return {
      previousEpoch,
      linked: false,
      overlapCount: n,
      overlapLabs: labs.size,
      slope: null,
      intercept: null,
      pearsonR: Number(r.toFixed(4)),
      reason: `Construct shift detected (r=${r.toFixed(3)} < 0.85); epoch scales are incomparable`,
    };
  }

  const slope = sdOld / sdNew;
  const intercept = meanOld - slope * meanNew;
  return {
    previousEpoch,
    linked: true,
    overlapCount: n,
    overlapLabs: labs.size,
    slope: Number(slope.toFixed(6)),
    intercept: Number(intercept.toFixed(6)),
    pearsonR: Number(r.toFixed(4)),
    reason: `Verified Mean-Sigma link (n=${n}, labs=${labs.size}, r=${r.toFixed(3)})`,
  };
}
