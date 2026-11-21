"use client";

import { ChevronRight, ExternalLink } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Activity, Fragment } from "react";
import { BENCHMARK_BY_ID } from "@/config/benchmarks";
import { HARNESS_BY_ID } from "@/config/harnesses";
import { PROVIDER_BY_ID } from "@/config/providers";
import { formatCost, formatEffort, formatRawMetric, formatScore } from "@/lib/format";
import type {
  AnchorStats,
  CostUnit,
  EvaluatedConfig,
  HarnessRegime,
  ProviderFrontier,
} from "@/lib/schema";

interface PrunedCatalogueProps {
  frontiers: readonly ProviderFrontier[];
  configById: ReadonlyMap<string, EvaluatedConfig>;
  anchorStats: Readonly<Record<string, AnchorStats>>;
  activeRegime: HarnessRegime;
  priorMean?: number;
  costUnit: CostUnit;
  isHarnessDomain?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expandedPrunedIds: readonly string[];
  onSelectPrunedConfig: (id: string) => void;
}

const DETAIL_EASE = [0.22, 1, 0.36, 1] as const;

function resolveHarnessLabel(cfg: EvaluatedConfig): string | null {
  if (
    cfg.harness !== "direct" &&
    cfg.harness !== "standardized-suite" &&
    cfg.harness !== "multi-harness"
  ) {
    return HARNESS_BY_ID[cfg.harness].name;
  }
  if (cfg.harness === "multi-harness") {
    return (
      cfg.benchmarks.find((b) => b.benchmarkId === "tbench_4_1")?.observedHarness ??
      cfg.benchmarks.find((b) => b.observedHarness && b.observedHarness !== "Direct API")
        ?.observedHarness ??
      "Multi-harness"
    );
  }
  return null;
}

export function PrunedCatalogue({
  frontiers,
  configById,
  anchorStats,
  activeRegime,
  priorMean = 0,
  costUnit,
  isHarnessDomain = false,
  open,
  onOpenChange,
  expandedPrunedIds,
  onSelectPrunedConfig,
}: PrunedCatalogueProps) {
  const prefersReducedMotion = useReducedMotion();
  const expandedSet = new Set(expandedPrunedIds);
  const domainAvg = 50 + 15 * priorMean;
  const lookupAnchor = (benchmarkId: string): AnchorStats | undefined =>
    activeRegime === "standardized"
      ? anchorStats[`${benchmarkId}::standardized`]
      : anchorStats[benchmarkId];

  const prunedRows = frontiers
    .flatMap((pf) =>
      pf.pruned.map((pr) => ({
        provider: pf.provider,
        pruned: configById.get(pr.configId),
        winner: configById.get(pr.dominatedById),
        scoreDeficit: pr.scoreDeficit,
        costRatio: pr.costRatio,
        costComparisonNote: pr.costComparisonNote,
      })),
    )
    .filter(
      (
        r,
      ): r is {
        provider: ProviderFrontier["provider"];
        pruned: EvaluatedConfig;
        winner: EvaluatedConfig;
        scoreDeficit: number;
        costRatio: number | null;
        costComparisonNote: string | null;
      } => r.pruned !== undefined && r.winner !== undefined,
    )
    .toSorted((a, b) => (b.costRatio ?? 0) - (a.costRatio ?? 0) || b.scoreDeficit - a.scoreDeficit);

  return (
    <section aria-label="Pruned models" className="border-t border-[var(--border)] bg-[var(--bg)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex w-full cursor-pointer items-center justify-between px-5 py-3.5 text-left transition-colors hover:bg-[var(--subtle)] sm:px-9 lg:px-11"
      >
        <span className="flex items-center gap-2 text-[13px] font-medium text-[var(--ink)]">
          <ChevronRight
            aria-hidden="true"
            className={`h-3.5 w-3.5 text-[var(--ink-faint)] transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
          <span>Pruned</span>
          <span className="font-mono font-normal text-[var(--ink-faint)]">
            · {prunedRows.length}
          </span>
        </span>
      </button>

      <Activity mode={open ? "visible" : "hidden"}>
        {prunedRows.length === 0 ? (
          <div className="border-t border-[var(--border)] px-5 py-5 text-[13px] text-[var(--ink-muted)] sm:px-9 lg:px-11">
            No dominated models in this selection.
          </div>
        ) : (
          <div className="overflow-x-auto border-t border-[var(--border)]">
            <table className="w-full min-w-[680px] table-fixed border-collapse text-left text-[12.5px] tabular">
              <colgroup>
                <col className="w-[33%]" />
                <col className="w-[10%]" />
                <col className="w-[12%]" />
                <col className="w-[27%]" />
                <col className="w-[18%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--subtle)] font-mono text-[11px] text-[var(--ink-faint)]">
                  <th className="py-2.5 pl-5 pr-3 font-normal whitespace-nowrap sm:pl-9 lg:pl-11">
                    Pruned
                  </th>
                  <th className="px-3 py-2.5 text-right font-normal whitespace-nowrap">Score</th>
                  <th className="px-3 py-2.5 text-right font-normal whitespace-nowrap">Cost</th>
                  <th className="px-3 py-2.5 font-normal whitespace-nowrap">Beaten by</th>
                  <th className="py-2.5 pl-3 pr-5 text-right font-normal whitespace-nowrap sm:pr-9 lg:pr-11">
                    Gap
                  </th>
                </tr>
              </thead>
              <tbody>
                {prunedRows.map((row) => {
                  const pMeta = PROVIDER_BY_ID[row.provider];
                  const prunedHarness = isHarnessDomain ? resolveHarnessLabel(row.pruned) : null;
                  const winnerHarness = isHarnessDomain ? resolveHarnessLabel(row.winner) : null;
                  const expanded = expandedSet.has(row.pruned.id);
                  const rowDomId = `pruned-${encodeURIComponent(row.pruned.id)}`;

                  return (
                    <Fragment key={row.pruned.id}>
                      <tr
                        id={rowDomId}
                        className={`scroll-mt-16 border-b border-[var(--border)] transition-[background-color] duration-150 last:border-b-0 ${
                          expanded ? "bg-[var(--subtle)]" : "hover:bg-[var(--subtle)]/70"
                        }`}
                      >
                        <td className="py-2.5 pl-5 pr-3 sm:pl-9 lg:pl-11">
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => onSelectPrunedConfig(row.pruned.id)}
                            className="flex w-full min-w-0 cursor-pointer items-center gap-2 text-left"
                          >
                            <ChevronRight
                              aria-hidden="true"
                              className={`h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)] transition-transform duration-150 ${
                                expanded ? "rotate-90" : ""
                              }`}
                            />
                            <span
                              aria-hidden="true"
                              className="inline-block h-2 w-2 shrink-0 rotate-45 border"
                              style={{ borderColor: pMeta.cssVar }}
                            />
                            {isHarnessDomain && prunedHarness ? (
                              <>
                                <span className="shrink-0 whitespace-nowrap text-[var(--ink-secondary)] line-through decoration-[var(--ink-faint)]">
                                  {prunedHarness}
                                </span>
                                <span className="truncate font-mono text-[11px] text-[var(--ink-faint)]">
                                  + {row.pruned.displayName} · {formatEffort(row.pruned.effort)}
                                </span>
                              </>
                            ) : (
                              <>
                                <span className="truncate text-[var(--ink-secondary)] line-through decoration-[var(--ink-faint)]">
                                  {row.pruned.displayName}
                                </span>
                                <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-[var(--ink-faint)]">
                                  {formatEffort(row.pruned.effort)}
                                  {prunedHarness ? ` · ${prunedHarness}` : ""}
                                </span>
                              </>
                            )}
                          </button>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-[var(--ink-muted)]">
                          {formatScore(row.pruned.score)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap text-[var(--ink-muted)]">
                          {formatCost(row.pruned.effectiveCostUsd, costUnit)}
                        </td>
                        <td className="px-3 py-2.5">
                          {isHarnessDomain && winnerHarness ? (
                            <>
                              <span className="font-medium text-[var(--ink)]">{winnerHarness}</span>
                              <span className="ml-1.5 font-mono text-[11px] text-[var(--ink-muted)]">
                                + {row.winner.displayName} · {formatEffort(row.winner.effort)}
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="font-medium text-[var(--ink)]">
                                {row.winner.displayName}
                              </span>
                              <span className="ml-1.5 font-mono text-[11px] text-[var(--ink-muted)]">
                                {formatEffort(row.winner.effort)}
                                {winnerHarness ? ` · ${winnerHarness}` : ""}
                              </span>
                            </>
                          )}
                        </td>
                        <td className="py-2.5 pl-3 pr-5 text-right font-mono text-[11.5px] whitespace-nowrap text-[var(--danger)] sm:pr-9 lg:pr-11">
                          -{row.scoreDeficit.toFixed(1)} pts ·{" "}
                          {row.costRatio !== null
                            ? `${row.costRatio.toFixed(2)}x cost`
                            : (row.costComparisonNote ?? "same price")}
                        </td>
                      </tr>

                      {expanded ? (
                        <tr className="border-b border-[var(--border)] bg-[var(--subtle)] last:border-b-0">
                          <td
                            id={`${rowDomId}-details`}
                            aria-label={`${isHarnessDomain && prunedHarness ? `${prunedHarness} + ` : ""}${row.pruned.displayName} benchmark details`}
                            tabIndex={-1}
                            colSpan={5}
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
                                  for (const item of row.pruned.benchmarks) {
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
                                  const pullPct = Math.round(
                                    (1 - row.pruned.shrinkageFactor) * 100,
                                  );
                                  const isPartialBasket = (row.pruned.costFixedFloorUsd ?? 0) > 0;
                                  return (
                                    <>
                                      <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--ink-muted)]">
                                        {rawWeightedAvg !== null && pullPct >= 2
                                          ? `Weighted average ${rawWeightedAvg.toFixed(1)} is pulled ${pullPct}% toward the domain average (${domainAvg.toFixed(1)}) to give ${formatScore(row.pruned.score)} across ${row.pruned.coverageCount} of ${row.pruned.activeBenchmarkCount} benchmarks.`
                                          : `Combined score ${formatScore(row.pruned.score)} across ${row.pruned.coverageCount} of ${row.pruned.activeBenchmarkCount} benchmarks.`}
                                        {row.pruned.costImputed
                                          ? isPartialBasket
                                            ? " Task cost combines measured benchmark cost with an estimate for the unmeasured cost benchmark in this domain."
                                            : " Task cost is estimated from public API token prices and measured costs in this domain."
                                          : ""}
                                      </p>
                                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                                        {row.pruned.benchmarks.map((bm) => {
                                          const bMeta = BENCHMARK_BY_ID[bm.benchmarkId];
                                          const stat = lookupAnchor(bm.benchmarkId);
                                          const adjScore =
                                            stat !== undefined
                                              ? 50 + 15 * (bm.zScore - stat.raschDelta)
                                              : null;
                                          const weightSharePct =
                                            stat !== undefined && totalWeight > 0
                                              ? Math.round(
                                                  (stat.effectiveWeight / totalWeight) * 100,
                                                )
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
                                              className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3"
                                            >
                                              <div className="flex items-start justify-between gap-2">
                                                <span className="text-[12px] font-medium text-[var(--ink)]">
                                                  {bMeta?.name ?? bm.benchmarkId}
                                                </span>
                                                <a
                                                  href={bm.sourceUrl}
                                                  target="_blank"
                                                  rel="noreferrer"
                                                  aria-label={`Open ${bMeta?.name ?? bm.benchmarkId}`}
                                                  className="text-[var(--ink-faint)] hover:text-[var(--ink)]"
                                                >
                                                  <ExternalLink className="h-3.5 w-3.5" />
                                                </a>
                                              </div>

                                              <div className="mt-2 flex items-baseline justify-between font-mono tabular">
                                                <span className="text-[14px] font-medium text-[var(--ink)]">
                                                  {formatRawMetric(
                                                    bm.rawScore,
                                                    bMeta?.scale ?? "percent",
                                                  )}
                                                </span>
                                                {tileCostLabel ? (
                                                  <span className="text-[11px] text-[var(--ink-muted)]">
                                                    {tileCostLabel}
                                                  </span>
                                                ) : null}
                                              </div>

                                              {adjScore !== null && weightSharePct !== null ? (
                                                <div className="mt-1 font-mono text-[10.5px] text-[var(--ink-secondary)] tabular">
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
                                                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[10.5px] text-[var(--ink-faint)]">
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
      </Activity>
    </section>
  );
}
