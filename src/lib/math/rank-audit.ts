import {
  BENCHMARK_BY_ID,
  DOMAIN_BY_ID,
  getAnchorMinCoverageForDomain,
  getCoverageFloorForDomain,
  getRegimesForDomain,
} from "../../config/benchmarks.ts";
import type {
  DomainId,
  DomainSnapshot,
  EvaluatedConfig,
  HarnessRegime,
  PairOrderCounts,
  ProviderId,
  RankEvidence,
} from "../schema.ts";
import type { ObservedCell } from "./aggregate.ts";
import {
  aggregateDomain,
  buildWeightMapFromAnchors,
  DISPLAY_BASE,
  DISPLAY_SPREAD,
} from "./aggregate.ts";
import { kendallTauB } from "./lifecycle.ts";
import type { AggregateWeightPolicy } from "./measurement-families.ts";
import { epochWeightPolicy } from "./measurement-families.ts";
import { sharedScoreOrder } from "./pareto.ts";

function compareSharedBenchmarks(
  a: EvaluatedConfig,
  b: EvaluatedConfig,
  weights: ReadonlyMap<string, number>,
): keyof PairOrderCounts {
  const delta = sharedScoreOrder(a, b, weights);
  if (delta === null) return "noOverlap";
  if (a.score === b.score || Math.abs(delta) < 1e-9) return "tied";
  return (a.score - b.score) * delta > 0 ? "agreed" : "reversed";
}

function auditPairOrder(domain: DomainSnapshot, regime: HarnessRegime) {
  const weights = buildWeightMapFromAnchors(domain.anchorStats, regime);
  const configs = domain.configs.filter((c) => c.harnessRegime === regime && c.eligibleForFrontier);
  const byId = new Map(configs.map((c) => [c.id, c]));
  const allPairs: PairOrderCounts = { agreed: 0, reversed: 0, tied: 0, noOverlap: 0 };
  const frontierSteps = { ...allPairs };
  for (let i = 0; i < configs.length; i++) {
    for (let j = 0; j < i; j++)
      allPairs[compareSharedBenchmarks(configs[i]!, configs[j]!, weights)]++;
  }
  for (const line of domain.frontiers) {
    if (line.harnessRegime !== regime || line.harnessFilter !== "all") continue;
    for (let i = 1; i < line.frontier.length; i++) {
      const a = byId.get(line.frontier[i - 1]!.configId);
      const b = byId.get(line.frontier[i]!.configId);
      if (!a || !b) throw new Error(`Unknown frontier configuration in ${domain.epochVersion}`);
      frontierSteps[compareSharedBenchmarks(a, b, weights)]++;
    }
  }
  return { allPairs, frontierSteps };
}

function auditHeldOutFeeds(
  domain: DomainSnapshot,
  active: readonly string[],
  cells: readonly ObservedCell[],
): RankEvidence["heldOutBenchmarks"] {
  const { domainId } = domain;
  const bySource = Map.groupBy(active, (id) => BENCHMARK_BY_ID[id]!.sourceId);
  const byBenchmark = Map.groupBy(cells, (cell) => cell.benchmarkId);
  const rows: RankEvidence["heldOutBenchmarks"] = [];
  for (const [sourceId, withheld] of bySource) {
    const remaining = active.filter((id) => !withheld.includes(id));
    const training = cells.filter((cell) => cell.sourceId !== sourceId);
    const policy = epochWeightPolicy(domain.epochVersion);
    // A frozen calibration has seen this feed. Refit every learned parameter on the other feeds.
    const refit = (weightPolicy: AggregateWeightPolicy) =>
      aggregateDomain(
        training,
        remaining,
        DOMAIN_BY_ID[domainId].minLabsForSaturation,
        undefined,
        undefined,
        undefined,
        getCoverageFloorForDomain(domainId, remaining.length),
        getAnchorMinCoverageForDomain(domainId, remaining.length),
        undefined,
        undefined,
        undefined,
        weightPolicy,
      ).eligible;
    const alternate =
      policy === "quality"
        ? null
        : new Map(
            refit(policy === "family-equal" ? "family-quality" : "family-equal").map((c) => [
              c.configId,
              c.score,
            ]),
          );
    const predictions = new Map(
      refit(policy).map((c) => {
        const meanZ = c.benchmarks.reduce((sum, bm) => sum + bm.zScore, 0) / c.benchmarks.length;
        return [
          c.configId,
          {
            score: c.score,
            equalWeight: Number((DISPLAY_BASE + DISPLAY_SPREAD * meanZ).toFixed(2)),
          },
        ] as const;
      }),
    );
    for (const benchmarkId of withheld) {
      const target = byBenchmark.get(benchmarkId) ?? [];
      const orientation = BENCHMARK_BY_ID[benchmarkId]!.invertScore ? -1 : 1;
      const observed: number[] = [];
      const predicted: number[] = [];
      const baseline: number[] = [];
      const commonObserved: number[] = [];
      const commonPrimary: number[] = [];
      const commonAlternate: number[] = [];
      const providers = new Set<ProviderId>();
      for (const cell of target) {
        const prediction = predictions.get(cell.configId);
        if (!prediction) continue;
        observed.push(cell.rawScore * orientation);
        predicted.push(prediction.score);
        baseline.push(prediction.equalWeight);
        providers.add(cell.provider);
        const other = alternate?.get(cell.configId);
        if (other !== undefined) {
          commonObserved.push(cell.rawScore * orientation);
          commonPrimary.push(prediction.score);
          commonAlternate.push(other);
        }
      }
      rows.push({
        benchmarkId,
        sourceId,
        testConfigs: target.length,
        matchedConfigs: observed.length,
        matchedProviders: providers.size,
        kendallTau: kendallTauB(predicted, observed),
        equalWeightTau: kendallTauB(baseline, observed),
        familyPolicyComparison: alternate
          ? {
              matchedConfigs: commonObserved.length,
              equalFamilyTau: kendallTauB(
                policy === "family-equal" ? commonPrimary : commonAlternate,
                commonObserved,
              ),
              qualityFamilyTau: kendallTauB(
                policy === "family-quality" ? commonPrimary : commonAlternate,
                commonObserved,
              ),
            }
          : null,
      });
    }
  }
  return rows;
}

export function computeRankEvidence(
  domains: Readonly<Record<DomainId, DomainSnapshot>>,
  cellsByDomain: ReadonlyMap<DomainId, readonly ObservedCell[]>,
): RankEvidence[] {
  const results: RankEvidence[] = [];
  for (const domainId of [
    "coding",
    "writing",
    "design_code",
    "research",
    "harnesses",
    "cyber",
  ] as const) {
    const domain = domains[domainId];
    for (const harnessRegime of getRegimesForDomain(domainId)) {
      const meta = domain.regimeMeta[harnessRegime];
      if (!meta) throw new Error(`Missing ${harnessRegime} calibration for ${domainId}`);
      const cells = (cellsByDomain.get(domainId) ?? []).filter(
        (c) => c.harnessRegime === harnessRegime,
      );
      results.push({
        domainId,
        harnessRegime,
        ...auditPairOrder(domain, harnessRegime),
        heldOutBenchmarks: auditHeldOutFeeds(domain, meta.activeBenchmarkIds, cells),
      });
    }
  }
  return results;
}
