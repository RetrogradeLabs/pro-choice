"use client";

import { HARNESS_BY_ID } from "@/config/harnesses";
import { PROVIDER_BY_ID } from "@/config/providers";
import {
  formatCost,
  formatEffort,
  formatScore,
  formatScoreEvidence,
  modelScoreEvidence,
} from "@/lib/format";
import { buildWeightMapFromAnchors } from "@/lib/math/aggregate";
import {
  computeProviderFrontier,
  extractVerdictPicks,
  sharedScoreOrder,
  unresolvedChallengers,
  usesCorroboratedVerdicts,
} from "@/lib/math/pareto";
import type {
  AnchorStats,
  CostUnit,
  EvaluatedConfig,
  FrontierPoint,
  HarnessId,
  HarnessRegime,
  LinkJointCov,
  ProviderFrontier,
  ProviderId,
} from "@/lib/schema";
import { ProviderMarkerIcon } from "./ProviderMarkerIcon";

interface VerdictPlacardsProps {
  epochVersion: string;
  selectedProviders: readonly ProviderId[];
  harnessFilter: HarnessId | "all";
  activeRegime: HarnessRegime;
  isHarnessDomain?: boolean;
  anchorStats: Readonly<Record<string, AnchorStats>>;
  linkJointCov?: LinkJointCov | undefined;
  frontiers: readonly ProviderFrontier[];
  eligibleConfigs: readonly EvaluatedConfig[];
  configById: ReadonlyMap<string, EvaluatedConfig>;
  costUnit: CostUnit;
  selectedConfigId: string | null;
  hoveredConfigId: string | null;
  onSelectConfig: (id: string) => void;
  onHoverConfig: (id: string | null) => void;
}

function resolveDisplayHarnessName(cfg: EvaluatedConfig): string | null {
  if (
    cfg.harness !== "direct" &&
    cfg.harness !== "standardized-suite" &&
    cfg.harness !== "multi-harness"
  ) {
    return HARNESS_BY_ID[cfg.harness].name;
  }
  if (cfg.harness === "multi-harness") {
    const primary =
      cfg.benchmarks.find((b) => b.benchmarkId === "tbench_4_1")?.observedHarness ??
      cfg.benchmarks.find((b) => b.observedHarness && b.observedHarness !== "Direct API")
        ?.observedHarness;
    return primary ?? "Multi-harness";
  }
  return null;
}

interface PlacardSpec {
  tag: string;
  config: EvaluatedConfig;
  accent: boolean;
}

export function VerdictPlacards({
  epochVersion,
  selectedProviders,
  harnessFilter,
  activeRegime,
  isHarnessDomain = false,
  anchorStats,
  linkJointCov,
  frontiers,
  eligibleConfigs,
  configById,
  costUnit,
  selectedConfigId,
  hoveredConfigId,
  onSelectConfig,
  onHoverConfig,
}: VerdictPlacardsProps) {
  const isSingleLabSelection = selectedProviders.length === 1;
  const weights = buildWeightMapFromAnchors(anchorStats, activeRegime);

  // Compute the cross-provider Pareto envelope in one pass over all eligible configs from the selected labs
  const slicePoints = new Map(
    frontiers.flatMap((f) => f.frontier.map((p) => [p.configId, p] as const)),
  );
  const filteredHarness = isHarnessDomain && harnessFilter !== "all";
  const probabilities = filteredHarness
    ? new Map(eligibleConfigs.map((c) => [c.id, slicePoints.get(c.id)?.paretoProb ?? 0]))
    : undefined;
  const sensitivity = filteredHarness
    ? new Map(
        eligibleConfigs.map((c) => [c.id, slicePoints.get(c.id)?.imputationSensitive ?? true]),
      )
    : undefined;
  const activeFrontier: readonly FrontierPoint[] =
    frontiers.length === 1
      ? frontiers[0]!.frontier
      : computeProviderFrontier(
          eligibleConfigs,
          probabilities,
          sensitivity,
          weights,
          anchorStats,
          linkJointCov,
        ).frontier;

  if (activeFrontier.length === 0) {
    const subject = isSingleLabSelection
      ? `${PROVIDER_BY_ID[selectedProviders[0]!].name} has no`
      : "No";
    const filterContext =
      harnessFilter !== "all" ? `on ${HARNESS_BY_ID[harnessFilter].name}` : "matching this filter";
    return (
      <section
        aria-label="Top Pareto picks"
        className="border-t border-(--border) px-5 py-6 sm:px-9 lg:px-11"
      >
        <p className="text-[13px] text-(--ink-muted)">
          {subject} priced frontier models {filterContext}.
        </p>
      </section>
    );
  }

  const options = {
    preferDistinctModelSlug: !isSingleLabSelection,
    weightByBenchmark: weights,
    anchorStats,
    linkJointCov,
    epochVersion,
    eligibleConfigs,
  };
  const picks = extractVerdictPicks(activeFrontier, configById, options);
  const budgetCfg = picks.budgetId ? (configById.get(picks.budgetId) ?? null) : null;
  const maxCfg = configById.get(activeFrontier[activeFrontier.length - 1]!.configId);
  const defaultCfg = picks.defaultId ? (configById.get(picks.defaultId) ?? null) : null;

  const placards: PlacardSpec[] = [];
  if (budgetCfg && budgetCfg.id !== maxCfg?.id)
    placards.push({ tag: "Lowest cost", config: budgetCfg, accent: false });
  if (defaultCfg) placards.push({ tag: "Best value", config: defaultCfg, accent: true });
  if (maxCfg)
    placards.push({
      tag: picks.maxId ? "Top score" : "Highest estimate",
      config: maxCfg,
      accent: false,
    });
  const unresolved =
    maxCfg && usesCorroboratedVerdicts(epochVersion) && !picks.maxId
      ? unresolvedChallengers(maxCfg, options).toSorted((a, b) => b.score - a.score)
      : [];

  const gridCols =
    placards.length === 3
      ? "md:grid-cols-3"
      : placards.length === 2
        ? "md:grid-cols-2"
        : "md:grid-cols-1";

  return (
    <section aria-label="Top Pareto picks">
      <div
        className={`grid grid-cols-1 divide-y divide-(--border) border-t border-(--border) ${gridCols} md:divide-x md:divide-y-0`}
      >
        {placards.map((item) => {
          const cfg = item.config;
          const pMeta = PROVIDER_BY_ID[cfg.provider];
          const isSelected = selectedConfigId === cfg.id;
          const isHovered = hoveredConfigId === cfg.id;
          const harnessName = isHarnessDomain ? resolveDisplayHarnessName(cfg) : null;
          const effortText = formatEffort(cfg.effort);
          const primaryTitle = isHarnessDomain && harnessName ? harnessName : cfg.displayName;
          const subtitleParts =
            isHarnessDomain && harnessName
              ? [cfg.displayName, effortText].filter(Boolean)
              : [effortText].filter(Boolean);

          return (
            <article
              key={item.tag}
              onPointerEnter={() => onHoverConfig(cfg.id)}
              onPointerLeave={() => onHoverConfig(null)}
              className={`relative flex flex-col justify-between px-5 py-6 transition-colors sm:px-7 lg:first:pl-11 lg:last:pr-11 ${
                isSelected || isHovered ? "bg-(--subtle)" : "bg-(--surface) hover:bg-(--subtle)/70"
              }`}
            >
              {item.accent ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-(--interactive)"
                />
              ) : null}

              <div>
                <div className="flex items-center justify-between gap-2 text-[11.5px]">
                  <span
                    className={
                      item.accent ? "font-medium text-(--interactive)" : "text-(--ink-faint)"
                    }
                  >
                    {item.tag}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-(--ink-muted)">
                    <ProviderMarkerIcon provider={cfg.provider} size={9} />
                    <span>{pMeta.shortName}</span>
                  </span>
                </div>

                <h2 className="mt-2.5 font-display text-[22px] leading-[1.15] font-normal tracking-[-0.02em] text-(--ink)">
                  <button
                    type="button"
                    aria-current={isSelected ? "true" : undefined}
                    onClick={() => onSelectConfig(cfg.id)}
                    className="cursor-pointer text-left after:absolute after:inset-0 focus-visible:outline-none"
                  >
                    {primaryTitle}
                  </button>
                </h2>

                <p className="mt-1 min-h-4 font-mono text-[11px] text-(--ink-faint)">
                  {subtitleParts.join(" · ")}
                </p>
              </div>

              <div className="mt-5 flex items-baseline justify-between gap-3 border-t border-(--border)/60 pt-3 font-mono tabular">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[18px] font-medium tracking-[-0.02em] text-(--ink)">
                    {formatScore(cfg.score)}
                  </span>
                  <span className="text-[10.5px] text-(--ink-faint)">score</span>
                </div>

                <div className="flex items-baseline gap-1 text-right">
                  <span className="text-[14.5px] font-medium text-(--ink)">
                    {formatCost(cfg.effectiveCostUsd, costUnit)}
                  </span>
                  <span className="text-[10.5px] text-(--ink-faint)">/ task</span>
                </div>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-(--ink-muted)">
                {formatScoreEvidence(modelScoreEvidence(cfg))}
              </p>
            </article>
          );
        })}
      </div>
      {maxCfg && !picks.maxId && (
        <details className="border-t border-(--border) px-5 py-3 text-[12px] text-(--ink-muted) sm:px-9 lg:px-11">
          <summary className="cursor-pointer text-(--ink)">Why there is no overall winner</summary>
          <p className="mt-2 max-w-prose leading-relaxed">
            A recommendation requires results from multiple feeds and task families. The leading
            estimate must also beat every alternative in this selection on shared benchmarks and by
            at least 1.96 standard errors of the score difference.
          </p>
          {unresolved.length > 0 && (
            <>
              <p className="mt-3 font-medium">Unresolved comparisons ({unresolved.length})</p>
              <ul className="mt-1 max-h-48 overflow-y-auto">
                {unresolved.map((c) => {
                  const shared = sharedScoreOrder(maxCfg, c, weights);
                  const reason =
                    shared === null
                      ? "Linked only"
                      : shared <= 0
                        ? "No lead on shared tests"
                        : "Within uncertainty";
                  return (
                    <li
                      key={c.id}
                      className="flex justify-between gap-3 border-b border-(--border) py-1"
                    >
                      <span>
                        {c.displayName} · {formatEffort(c.effort)}
                      </span>
                      <span>{reason}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </details>
      )}
    </section>
  );
}
