"use client";

import { ChevronRight, ExternalLink } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Fragment } from "react";
import { BENCHMARK_BY_ID } from "@/config/benchmarks";
import { HARNESS_BY_ID } from "@/config/harnesses";
import { PROVIDER_BY_ID } from "@/config/providers";
import {
  formatCost,
  formatEffort,
  formatPricePer1m,
  formatRawMetric,
  formatScore,
  formatScoreEvidence,
  formatScoreInterval,
  formatSharedOrder,
  modelScoreEvidence,
} from "@/lib/format";
import { buildWeightMapFromAnchors } from "@/lib/math/aggregate";
import { sharedScoreOrder } from "@/lib/math/pareto";
import type {
  AnchorStats,
  CostUnit,
  EvaluatedConfig,
  HarnessRegime,
  ProviderFrontier,
} from "@/lib/schema";
import { ProviderMarkerIcon } from "./ProviderMarkerIcon";

interface FrontierCatalogueProps {
  frontiers: readonly ProviderFrontier[];
  configById: ReadonlyMap<string, EvaluatedConfig>;
  anchorStats: Readonly<Record<string, AnchorStats>>;
  activeRegime: HarnessRegime;
  priorMean?: number;
  isHarnessDomain?: boolean;
  costUnit: CostUnit;
  expandedConfigIds: readonly string[];
  hoveredConfigId: string | null;
  onSelectConfig: (id: string) => void;
  onHoverConfig: (id: string | null) => void;
}

interface CatalogueRow {
  provider: ProviderFrontier["provider"];
  comparison: string;
  config: EvaluatedConfig;
}

const DETAIL_EASE = [0.22, 1, 0.36, 1] as const;

export function FrontierCatalogue({
  frontiers,
  configById,
  anchorStats,
  activeRegime,
  priorMean = 0,
  isHarnessDomain = false,
  costUnit,
  expandedConfigIds,
  hoveredConfigId,
  onSelectConfig,
  onHoverConfig,
}: FrontierCatalogueProps) {
  const prefersReducedMotion = useReducedMotion();
  const expandedSet = new Set(expandedConfigIds);
  const lookupAnchor = (benchmarkId: string): AnchorStats | undefined =>
    activeRegime === "standardized"
      ? anchorStats[`${benchmarkId}::standardized`]
      : anchorStats[benchmarkId];
  const rows: CatalogueRow[] = [];
  const weights = buildWeightMapFromAnchors(anchorStats, activeRegime);
  for (const pf of frontiers) {
    let previous: EvaluatedConfig | undefined;
    for (const pt of pf.frontier) {
      const cfg = configById.get(pt.configId);
      if (!cfg) continue;
      const comparison = previous
        ? formatSharedOrder(
            sharedScoreOrder(cfg, previous, weights),
            `${previous.displayName} (${formatEffort(previous.effort)})`,
          )
        : "";
      rows.push({ provider: pf.provider, comparison, config: cfg });
      previous = cfg;
    }
  }

  rows.sort((a, b) => b.config.score - a.config.score);
  const colSpan = 5;

  return (
    <section aria-label="Frontier configurations" className="border-t border-(--border) bg-(--bg)">
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-[13px] text-(--ink-muted) sm:px-9 lg:px-11">
          No surviving frontier models in this selection.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-190 table-fixed border-collapse text-left text-[12.5px] tabular">
            <colgroup>
              <col className="w-[40%]" />
              <col className="w-[14%]" />
              <col className="w-[10%]" />
              <col className="w-[14%]" />
              <col className="w-[22%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-(--border) bg-(--subtle) font-mono text-[11px] font-normal text-(--ink-faint)">
                <th className="py-2.5 pl-5 pr-3 font-normal whitespace-nowrap sm:pl-9 lg:pl-11">
                  {isHarnessDomain ? "Harness + model" : "Model"}
                </th>
                <th className="px-3 py-2.5 font-normal whitespace-nowrap">Provider</th>
                <th className="px-3 py-2.5 text-right font-normal whitespace-nowrap">Score</th>
                <th className="px-3 py-2.5 text-right font-normal whitespace-nowrap">
                  Cost / task
                </th>
                <th className="py-2.5 pl-3 pr-5 text-right font-normal whitespace-nowrap sm:pr-9 lg:pr-11">
                  Input / output ($/1M)
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ provider, config, comparison }) => {
                const pMeta = PROVIDER_BY_ID[provider];
                const expanded = expandedSet.has(config.id);
                const hovered = hoveredConfigId === config.id;
                const harnessName = isHarnessDomain
                  ? config.harness !== "direct" &&
                    config.harness !== "standardized-suite" &&
                    config.harness !== "multi-harness"
                    ? HARNESS_BY_ID[config.harness].name
                    : config.harness === "multi-harness"
                      ? (config.benchmarks.find((b) => b.benchmarkId === "tbench_4_1")
                          ?.observedHarness ??
                        config.benchmarks.find(
                          (b) => b.observedHarness && b.observedHarness !== "Direct API",
                        )?.observedHarness ??
                        "Multi-harness")
                      : null
                  : null;
                const effortLabel = formatEffort(config.effort);
                const rowDomId = `config-${encodeURIComponent(config.id)}`;

                return (
                  <Fragment key={config.id}>
                    <tr
                      id={rowDomId}
                      onPointerEnter={() => onHoverConfig(config.id)}
                      onPointerLeave={() => onHoverConfig(null)}
                      className={`scroll-mt-16 border-b border-(--border) transition-[background-color] duration-150 last:border-b-0 ${
                        expanded || hovered ? "bg-(--subtle)" : "hover:bg-(--subtle)/70"
                      }`}
                    >
                      <td className="py-2.5 pl-5 pr-3 sm:pl-9 lg:pl-11">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => onSelectConfig(config.id)}
                          className="flex w-full min-w-0 cursor-pointer items-center gap-2 text-left"
                        >
                          <ChevronRight
                            aria-hidden="true"
                            className={`h-3.5 w-3.5 shrink-0 text-(--ink-faint) transition-transform duration-150 ${
                              expanded ? "rotate-90" : ""
                            }`}
                          />
                          {isHarnessDomain && harnessName ? (
                            <>
                              <span className="shrink-0 whitespace-nowrap font-medium text-(--ink)">
                                {harnessName}
                              </span>
                              <span className="truncate text-(--ink-secondary)">
                                + {config.displayName}
                              </span>
                              {effortLabel ? (
                                <span className="shrink-0 whitespace-nowrap rounded bg-(--subtle) px-1.5 py-0.5 font-mono text-[10.5px] text-(--ink-muted) ring-1 ring-inset ring-(--border)">
                                  {effortLabel}
                                </span>
                              ) : null}
                            </>
                          ) : (
                            <>
                              <span className="truncate font-medium text-(--ink)">
                                {config.displayName}
                              </span>
                              {effortLabel ? (
                                <span className="shrink-0 whitespace-nowrap rounded bg-(--subtle) px-1.5 py-0.5 font-mono text-[10.5px] text-(--ink-muted) ring-1 ring-inset ring-(--border)">
                                  {effortLabel}
                                </span>
                              ) : null}
                              {harnessName ? (
                                <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-(--ink-faint)">
                                  {harnessName}
                                </span>
                              ) : null}
                            </>
                          )}
                        </button>
                        <div className="mt-1 pl-5 text-[10.5px] leading-snug text-(--ink-muted)">
                          {formatScoreEvidence(modelScoreEvidence(config))}
                          {comparison && <span className="block">{comparison}</span>}
                        </div>
                      </td>

                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-(--ink-secondary)">
                          <ProviderMarkerIcon provider={provider} size={9} />
                          {pMeta.shortName}
                        </span>
                      </td>

                      <td className="px-3 py-2.5 text-right font-mono font-medium whitespace-nowrap text-(--ink)">
                        {formatScore(config.score)}
                      </td>

                      <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap text-(--ink)">
                        {formatCost(config.effectiveCostUsd, costUnit)}
                      </td>

                      <td className="py-2.5 pl-3 pr-5 text-right font-mono whitespace-nowrap text-(--ink-muted) sm:pr-9 lg:pr-11">
                        {formatPricePer1m(config.inputPer1mUsd, config.outputPer1mUsd)}
                      </td>
                    </tr>

                    {expanded ? (
                      <tr className="border-b border-(--border) bg-(--subtle) last:border-b-0">
                        <td
                          id={`${rowDomId}-details`}
                          aria-label={`${config.displayName} benchmark details`}
                          tabIndex={-1}
                          colSpan={colSpan}
                          className="p-0 outline-none focus:outline-none focus-visible:outline-none"
                        >
                          <motion.div
                            initial={prefersReducedMotion ? false : { opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            transition={{ duration: 0.18, ease: DETAIL_EASE }}
                            className="overflow-hidden"
                          >
                            <div className="px-5 py-4 sm:px-9 lg:px-11">
                              {(() => {
                                let totalWeight = 0;
                                let weightedAdjSum = 0;
                                for (const item of config.benchmarks) {
                                  const st = lookupAnchor(item.benchmarkId);
                                  if (st) {
                                    totalWeight += st.effectiveWeight;
                                    weightedAdjSum +=
                                      st.effectiveWeight *
                                      (50 + 15 * (item.zScore - st.raschDelta));
                                  }
                                }
                                const rawWeightedAvg =
                                  totalWeight > 0 ? weightedAdjSum / totalWeight : null;
                                const pullPct = Math.round((1 - config.shrinkageFactor) * 100);
                                const domainAvg = 50 + 15 * priorMean;
                                const isPartialBasket = (config.costFixedFloorUsd ?? 0) > 0;
                                return (
                                  <>
                                    <p className="mb-3 text-[11.5px] leading-relaxed text-(--ink-muted)">
                                      This configuration has results on {config.coverageCount} of{" "}
                                      {config.activeBenchmarkCount} benchmarks. Shared models put
                                      the results below on the same score scale. Its 95% model
                                      interval runs from {formatScoreInterval(config)}.
                                      {rawWeightedAvg !== null && pullPct >= 2
                                        ? ` Pulling the weighted average of ${rawWeightedAvg.toFixed(1)} by ${pullPct}% toward the domain average of ${domainAvg.toFixed(1)} gives a score of ${formatScore(config.score)}.`
                                        : ""}
                                      {config.costImputed
                                        ? isPartialBasket
                                          ? " Task cost combines measured benchmark cost with an estimate for the unmeasured cost benchmark in this domain."
                                          : " Task cost is estimated from public API token prices and measured costs in this domain."
                                        : ""}
                                    </p>
                                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                                      {config.benchmarks.map((bm) => {
                                        const bMeta = BENCHMARK_BY_ID[bm.benchmarkId];
                                        const stat = lookupAnchor(bm.benchmarkId);
                                        const adjScore =
                                          stat !== undefined
                                            ? 50 + 15 * (bm.zScore - stat.raschDelta)
                                            : null;
                                        const weightSharePct =
                                          stat !== undefined && totalWeight > 0
                                            ? Math.round((stat.effectiveWeight / totalWeight) * 100)
                                            : null;
                                        const dateLabel = bm.evalDate ?? bm.publishedDate ?? null;
                                        const tileCostLabel =
                                          bm.measuredCostUsd !== null
                                            ? formatCost(bm.measuredCostUsd, costUnit)
                                            : null;

                                        const tileHarness = isHarnessDomain
                                          ? bm.observedHarness
                                          : null;

                                        return (
                                          <div
                                            key={bm.benchmarkId}
                                            className="rounded-md border border-(--border) bg-(--surface) p-3"
                                          >
                                            <div className="flex items-start justify-between gap-2">
                                              <span className="text-[12px] font-medium text-(--ink)">
                                                {bMeta?.name ?? bm.benchmarkId}
                                              </span>
                                              <a
                                                href={bm.sourceUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                aria-label={`Open ${bMeta?.name ?? bm.benchmarkId}`}
                                                className="text-(--ink-faint) hover:text-(--ink)"
                                              >
                                                <ExternalLink className="h-3.5 w-3.5" />
                                              </a>
                                            </div>

                                            <div className="mt-2 flex items-baseline justify-between font-mono tabular">
                                              <span className="text-[14px] font-medium text-(--ink)">
                                                {formatRawMetric(
                                                  bm.rawScore,
                                                  bMeta?.scale ?? "percent",
                                                )}
                                              </span>
                                              {tileCostLabel ? (
                                                <span className="text-[11px] text-(--ink-muted)">
                                                  {tileCostLabel}
                                                </span>
                                              ) : null}
                                            </div>

                                            {adjScore !== null && weightSharePct !== null ? (
                                              <div className="mt-1 font-mono text-[10.5px] text-(--ink-secondary) tabular">
                                                {adjScore.toFixed(1)} converted score ·{" "}
                                                {weightSharePct}% weight
                                              </div>
                                            ) : null}

                                            {tileHarness ||
                                            dateLabel ||
                                            bm.fallbackRouting ||
                                            bm.measuredCostEstimated ||
                                            (bm.refusalRate !== undefined &&
                                              bm.refusalRate !== null &&
                                              bm.refusalRate > 0) ? (
                                              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[10.5px] text-(--ink-faint)">
                                                <span>
                                                  {[
                                                    tileHarness,
                                                    bm.fallbackRouting ? "Fallback route" : null,
                                                    bm.measuredCostEstimated
                                                      ? "Estimated cost"
                                                      : null,
                                                    bm.refusalRate !== undefined &&
                                                    bm.refusalRate !== null &&
                                                    bm.refusalRate > 0
                                                      ? `${Math.round(bm.refusalRate * 100)}% refused`
                                                      : null,
                                                  ]
                                                    .filter(Boolean)
                                                    .join(" · ")}
                                                </span>
                                                {dateLabel ? <span>{dateLabel}</span> : null}
                                              </div>
                                            ) : null}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </>
                                );
                              })()}
                            </div>
                          </motion.div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
