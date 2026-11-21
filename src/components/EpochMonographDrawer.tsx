"use client";

import { Dialog } from "@base-ui/react/dialog";
import { ExternalLink, X } from "lucide-react";
import { RankEvidenceDetails } from "@/components/RankEvidenceDetails";
import { BENCHMARK_BY_ID, DOMAIN_BY_ID } from "@/config/benchmarks";
import { HARNESS_BY_ID } from "@/config/harnesses";
import { isRetiredPurchaseSku, PROVIDER_BY_ID } from "@/config/providers";
import { controlledBoard } from "@/lib/controlled-boards";
import { formatEffort, formatScore } from "@/lib/format";
import type { HarnessViewTab } from "@/lib/gallery-url";
import type {
  BenchmarkAudit,
  DomainSnapshot,
  EvaluatedConfig,
  HarnessLeaderboardSnapshot,
  HarnessRegime,
  LifecycleReport,
  SourceHealth,
} from "@/lib/schema";

interface EpochMonographDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domain: DomainSnapshot;
  activeRegime: HarnessRegime;
  activeHarnessTab: HarnessViewTab;
  controlledSliceId: string;
  harnessLeaderboard: HarnessLeaderboardSnapshot;
  lifecycle: LifecycleReport;
  sources: readonly SourceHealth[];
  provisionalConfigs: readonly EvaluatedConfig[];
  hasDisplayedListTariffs: boolean;
  generatedAt: string;
}

function formatUtcDate(iso: string | null): string {
  if (!iso) return "Never";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso.slice(0, 10);
  return new Date(ms).toISOString().slice(0, 10);
}

function statusBadge(status: BenchmarkAudit["status"]): { label: string; tone: string } {
  switch (status) {
    case "healthy":
      return {
        label: "Healthy",
        tone: "border-(--healthy)/40 text-(--healthy)",
      };
    case "warning":
      return {
        label: "Watchlist",
        tone: "border-(--warning)/40 text-(--warning)",
      };
    case "retire_trigger":
      return {
        label: "Needs review",
        tone: "border-(--danger)/40 text-(--danger)",
      };
    case "probation_ready":
      return {
        label: "Ready",
        tone: "border-(--healthy)/40 text-(--healthy)",
      };
    case "probation_wait":
      return {
        label: "Pending",
        tone: "border-(--border) text-(--ink-muted)",
      };
    case "insufficient":
      return {
        label: "Few providers",
        tone: "border-(--warning)/40 text-(--warning)",
      };
  }
}

export function EpochMonographDrawer({
  open,
  onOpenChange,
  domain,
  activeRegime,
  activeHarnessTab,
  controlledSliceId,
  harnessLeaderboard,
  lifecycle,
  sources,
  provisionalConfigs,
  hasDisplayedListTariffs,
  generatedAt,
}: EpochMonographDrawerProps) {
  const meta = DOMAIN_BY_ID[domain.domainId];
  const regimeInfo = domain.regimeMeta[activeRegime];
  const activeBenchmarks = (regimeInfo?.activeBenchmarkIds ?? []).map((id) => BENCHMARK_BY_ID[id]!);
  const auditByKey = new Map(
    lifecycle.audits.map((a) => [`${a.benchmarkId}::${a.harnessRegime}`, a]),
  );

  const isControlledHarnesses =
    domain.domainId === "harnesses" && activeHarnessTab === "controlled";
  const hasArenaBenchmarks = activeBenchmarks.some((b) => b.isArena);

  const board = controlledBoard(harnessLeaderboard, controlledSliceId);
  const controlledHarnessCount = board.selected.entries.length;
  const controlledModelSlices = board.controls.filter((s) => s.controlModelId !== null);
  const anchorProviderCount = regimeInfo?.anchorLabs ?? 0;
  const rankEvidence = lifecycle.rankEvidence.find(
    (row) => row.domainId === domain.domainId && row.harnessRegime === activeRegime,
  );
  const ranked = domain.configs.filter((cfg) => cfg.harnessRegime === activeRegime);
  const coverage = new Map<string, number>();
  if (open && !isControlledHarnesses) {
    for (const config of ranked) {
      for (const { benchmarkId } of config.benchmarks) {
        coverage.set(benchmarkId, (coverage.get(benchmarkId) ?? 0) + 1);
      }
    }
  }

  const anchorFor = (benchmarkId: string) =>
    activeRegime === "standardized"
      ? domain.anchorStats[`${benchmarkId}::standardized`]
      : domain.anchorStats[benchmarkId];

  const activeSourceIds = new Set(
    isControlledHarnesses ? [board.sourceId] : activeBenchmarks.map((b) => b.sourceId),
  );
  const showPricingSource =
    !isControlledHarnesses && (domain.domainId === "writing" || hasDisplayedListTariffs);
  const pricingSourceIds = new Set<string>(showPricingSource ? ["pricing"] : []);
  const sensitivity = lifecycle.sourceSensitivity.filter(
    (row) => row.domainId === domain.domainId && row.harnessRegime === activeRegime,
  );

  const domainSources = sources
    .filter((s) => activeSourceIds.has(s.sourceId) || pricingSourceIds.has(s.sourceId))
    .map((src) => {
      const hasBenchmarks = activeSourceIds.has(src.sourceId);
      const hasPricing = pricingSourceIds.has(src.sourceId);
      const role =
        hasBenchmarks && hasPricing
          ? "Benchmarks + Pricing"
          : hasBenchmarks
            ? "Benchmarks"
            : "Pricing";
      return { src, role };
    });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px] transition-opacity duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-(--border) bg-(--surface) text-(--ink) shadow-2xl transition-transform duration-200 ease-out data-ending-style:translate-x-full data-starting-style:translate-x-full">
          <div className="flex items-start justify-between gap-4 border-b border-(--border) px-6 py-5">
            <div>
              <Dialog.Title className="font-display text-[26px] leading-tight font-normal text-(--ink)">
                {meta.indexTitle} methodology
              </Dialog.Title>
              <Dialog.Description className="mt-1 font-mono text-[11.5px] text-(--ink-muted) tabular">
                {isControlledHarnesses
                  ? `Updated ${formatUtcDate(board.selected.upstreamGeneratedAt ?? null)} · ${board.scope} · ${controlledHarnessCount} harnesses`
                  : `Updated ${formatUtcDate(generatedAt)} · ${activeBenchmarks.length} benchmarks`}
              </Dialog.Description>
            </div>

            <Dialog.Close
              aria-label="Close methodology"
              className="cursor-pointer rounded-md p-1.5 text-(--ink-muted) hover:bg-(--surface-hover) hover:text-(--ink)"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="flex-1 space-y-8 overflow-y-auto overscroll-contain px-6 py-6">
            <section className="space-y-3">
              <h3 className="text-[12px] font-medium text-(--ink)">How scores work</h3>
              {isControlledHarnesses ? (
                <div className="space-y-2.5 text-[13px] leading-relaxed text-(--ink-secondary)">
                  <p>
                    {board.name} measures how often a coding agent completes each of its{" "}
                    {board.metric.nTasks} tasks. The selected control is {board.selected.label}.
                    Compare harnesses within this selection using the pass rate and cost per run
                    measured on the same task set.
                  </p>
                  <p>
                    Terminal-Bench 4.0 comes from FrontierHarness. DeepSWE 1.1 comes from Harness
                    Leaderboard. Each benchmark keeps its own roster, model controls, costs and
                    uncertainty intervals. The shared Terminal-Bench 2.1 results are excluded from
                    both boards. Pass all 3 measures repeat success on the same task; its sampling
                    interval is unreported.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5 text-[13px] leading-relaxed text-(--ink-secondary)">
                  <p>
                    Different benchmarks use different units, such as percentages, Elo ratings, or
                    rubric points, and few models are tested on every benchmark. Averaging raw
                    scores would mix incompatible units and reward models tested only on easier
                    benchmarks.
                  </p>
                  <p>
                    To compare two models tested on different benchmarks, we convert every benchmark
                    onto one common score scale where 50 is the provider average and 15 points is
                    one standard deviation. Whenever two benchmarks share models, those shared
                    models measure how much harder or easier one benchmark is than the other, and we
                    remove that difficulty gap before scoring any model.
                  </p>
                  <p>
                    A model&apos;s score starts from the weighted average of its converted benchmark
                    scores. The less precise the evidence, the further we pull the estimate toward
                    the domain average. A single strong result can still lead a table. Reported
                    intervals assume independent sampling errors across benchmarks and comparable
                    performance on missing tasks. The 95% model interval uses the score estimate
                    plus or minus 1.96 posterior standard errors, conditional on this panel and the
                    model assumptions. It excludes changes of judge, task mix and missingness that
                    the model does not capture.
                  </p>
                  <p>
                    {domain.domainId === "writing"
                      ? "Every model is priced for a standard writing brief of 10,000 input tokens and 4,000 output tokens using its published first-party API token rates. If a model costs more and scores lower than another model from the same provider, it is left off the chart."
                      : domain.domainId === "cyber"
                        ? "CWE-bench tests whether a patch repairs the defect while preserving legitimate behavior. Aikido measures detection, including false alarms. The chart compares cost per task, with missing costs estimated only where the model has public API pricing and the domain supplies measured costs."
                        : "Every model is plotted against one cost per task scale. When a benchmark does not report dollar cost, we estimate task cost from the model's public API token price and measured dollar costs in this domain. If a model costs more and scores lower than another model from the same provider, it is left off the chart."}
                  </p>
                </div>
              )}

              {isControlledHarnesses ? (
                <div className="space-y-2 rounded-md border border-(--border) bg-(--subtle) p-3 font-mono text-[11.5px] tabular">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[10.5px] text-(--ink-faint)">Pass rate</span>
                    <span className="text-right text-(--ink)">{board.name} task pass rate (%)</span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-(--border) pt-2">
                    <span className="text-[10.5px] text-(--ink-faint)">Cost per run</span>
                    <span className="text-right text-(--ink)">
                      Measured cost per run on {board.name} (USD, log scale)
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 border-t border-(--border) pt-2">
                    <div>
                      <span className="block text-[10.5px] text-(--ink-faint)">Harnesses</span>
                      <span className="font-medium text-(--ink)">{controlledHarnessCount}</span>
                    </div>
                    <div>
                      <span className="block text-[10.5px] text-(--ink-faint)">Test models</span>
                      <span className="font-medium text-(--ink)">
                        {controlledModelSlices.map((s) => s.label).join(", ")}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-2 rounded-md border border-(--border) bg-(--subtle) p-3 font-mono text-[11.5px] tabular">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[10.5px] text-(--ink-faint)">Reference scale</span>
                    <span className="text-(--ink)">
                      50 = anchor-benchmark mean across {anchorProviderCount} domain providers, 15
                      pts = 1 anchor SD
                    </span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-(--border) pt-2">
                    <span className="text-[10.5px] text-(--ink-faint)">Cost per task</span>
                    <span className="text-right text-(--ink)">{meta.costAxisLabel}</span>
                  </div>
                  <div
                    className={`grid gap-2 border-t border-(--border) pt-2 ${
                      hasArenaBenchmarks ? "grid-cols-2" : "grid-cols-1"
                    }`}
                  >
                    <div>
                      <span className="block text-[10.5px] text-(--ink-faint)">Providers</span>
                      <span className="font-medium text-(--ink)">{anchorProviderCount}</span>
                    </div>
                    {hasArenaBenchmarks ? (
                      <div>
                        <span className="block text-[10.5px] text-(--ink-faint)">
                          Crowd-arena filter
                        </span>
                        <span className="font-medium text-(--ink)">
                          {domain.domainId === "design_code"
                            ? "<= 25 Elo · >= 300 votes, or >= 1,000 without SE"
                            : "<= 25 Elo · >= 300 votes"}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
            </section>

            {!isControlledHarnesses ? (
              <>
                <section className="space-y-3">
                  <h3 className="text-[12px] font-medium text-(--ink)">
                    Benchmarks ({activeBenchmarks.length})
                  </h3>
                  <p className="text-[12.5px] leading-relaxed text-(--ink-secondary)">
                    Coverage counts ranked configurations across all providers and reasoning
                    efforts.
                    {Object.values(domain.anchorStats).some((a) => a.measurementFamily)
                      ? " One benchmark represents each distinct task family. Each receives equal weight on the full panel. The quality diagnostic describes measurement precision and separation among providers."
                      : " Each benchmark’s weight reflects its precision and how clearly it separates the leading providers."}
                  </p>

                  <div className="space-y-2.5">
                    {activeBenchmarks.map((bm) => {
                      const audit = auditByKey.get(`${bm.id}::${activeRegime}`);
                      const anchor = anchorFor(bm.id);
                      const badge = audit
                        ? statusBadge(audit.status)
                        : {
                            label: "Unaudited",
                            tone: "border-(--border) text-(--ink-muted)",
                          };

                      return (
                        <div
                          key={bm.id}
                          className="rounded-md border border-(--border) bg-(--bg) p-4"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-[13.5px] font-medium text-(--ink)">
                                  {bm.name}
                                </span>
                                <span className="font-mono text-[11px] text-(--ink-faint)">
                                  v{domain.benchmarkVersions[bm.id]}
                                </span>
                                <a
                                  href={bm.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  aria-label={`Open ${bm.name}`}
                                  className="text-(--ink-faint) hover:text-(--ink)"
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                              </div>
                              {anchor ? (
                                <p className="mt-0.5 font-mono text-[11px] text-(--ink-faint) tabular">
                                  {coverage.get(bm.id) ?? 0} of {ranked.length} ranked
                                  configurations · Weight {anchor.effectiveWeight.toFixed(2)}
                                  {anchor.measurementFamily && anchor.qualityWeight !== undefined
                                    ? ` · ${anchor.measurementFamily} · Quality diagnostic ${anchor.qualityWeight.toFixed(2)}`
                                    : ""}
                                </p>
                              ) : (
                                <p className="mt-0.5 font-mono text-[11px] text-(--warning)">
                                  Excluded from score
                                </p>
                              )}
                            </div>

                            <span
                              className={`rounded border px-2 py-0.5 font-mono text-[10.5px] ${badge.tone}`}
                            >
                              {badge.label}
                            </span>
                          </div>

                          {audit && anchor ? (
                            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-(--border) pt-3 font-mono text-[11px] tabular">
                              <div>
                                <span className="block text-[10px] text-(--ink-faint)">
                                  Precision
                                </span>
                                <span className="text-(--ink)">
                                  {Math.round(anchor.reliability * 100)}%
                                </span>
                              </div>
                              <div>
                                <span className="block text-[10px] text-(--ink-faint)">
                                  Top-provider separation
                                </span>
                                <span className="text-(--ink)">
                                  {audit.separability !== null
                                    ? `${Math.round(audit.separability * 100)}%`
                                    : "N/A"}
                                </span>
                              </div>
                              <div>
                                <span className="block text-[10px] text-(--ink-faint)">
                                  Peer rank agreement
                                </span>
                                <span className="text-(--ink)">
                                  {audit.itemRestTau !== null
                                    ? audit.itemRestTau.toFixed(2)
                                    : "N/A"}
                                </span>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="space-y-2.5">
                  <h3 className="text-[12px] font-medium text-(--ink)">
                    Models left off the chart ({provisionalConfigs.length})
                  </h3>
                  <p className="text-[12.5px] leading-relaxed text-(--ink-secondary)">
                    {domain.domainId === "harnesses"
                      ? "A model stays off the chart if it is no longer available to buy, has no public API price, ran in a harness with no measured run costs, or has too little benchmark precision for a reliable score."
                      : "A model stays off the chart if it is no longer available to buy, has no public API price, or has too little benchmark precision for a reliable score."}
                  </p>
                  {provisionalConfigs.length === 0 ? (
                    <p className="font-mono text-[11px] text-(--ink-faint)">
                      None in the current provider selection.
                    </p>
                  ) : (
                    <div className="divide-y divide-(--border) rounded-md border border-(--border) font-mono text-[11px] tabular">
                      {provisionalConfigs.map((cfg) => {
                        const explicitHarness =
                          domain.domainId === "harnesses" &&
                          cfg.harness !== "direct" &&
                          cfg.harness !== "standardized-suite" &&
                          cfg.harness !== "multi-harness"
                            ? HARNESS_BY_ID[cfg.harness].name
                            : null;
                        const basketSet = new Set(regimeInfo?.measuredCostBenchmarkIds ?? []);
                        const hasInBasketCost = cfg.benchmarks.some(
                          (b) => b.measuredCostUsd !== null && basketSet.has(b.benchmarkId),
                        );
                        const hasOutOfBasketCost = cfg.benchmarks.some(
                          (b) => b.measuredCostUsd !== null && !basketSet.has(b.benchmarkId),
                        );
                        const heldOutReason = isRetiredPurchaseSku(cfg.provider, cfg.modelSlug)
                          ? "Discontinued"
                          : cfg.inputPer1mUsd === null || cfg.outputPer1mUsd === null
                            ? "No public API price"
                            : cfg.effectiveCostUsd === null
                              ? hasInBasketCost
                                ? "Incomplete basket cost"
                                : hasOutOfBasketCost
                                  ? "Measured cost outside pricing basket"
                                  : domain.domainId === "harnesses"
                                    ? "No measured harness cost"
                                    : "No task cost"
                              : cfg.shrinkageFactor < 0.5
                                ? "High uncertainty"
                                : "Excluded";
                        return (
                          <div
                            key={cfg.id}
                            className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2"
                          >
                            <div className="min-w-0">
                              <span className="font-sans text-[12.5px] font-medium text-(--ink)">
                                {explicitHarness
                                  ? `${explicitHarness} + ${cfg.displayName}`
                                  : cfg.displayName}
                              </span>
                              <span className="ml-1.5 text-(--ink-faint)">
                                {PROVIDER_BY_ID[cfg.provider].shortName} ·{" "}
                                {formatEffort(cfg.effort)}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 text-(--ink-muted)">
                              <span>{formatScore(cfg.score)}</span>
                              <span>
                                {cfg.coverageCount}/{cfg.activeBenchmarkCount}
                              </span>
                              <span className="text-(--ink-faint)">{heldOutReason}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              </>
            ) : null}

            <section className="space-y-2.5">
              <h3 className="text-[12px] font-medium text-(--ink)">Data sources</h3>
              {!isControlledHarnesses && rankEvidence && (
                <RankEvidenceDetails evidence={rankEvidence} />
              )}
              <p className="text-[12.5px] leading-relaxed text-(--ink-secondary)">
                The daily update checks each feed. The date shows when it last passed validation.
              </p>
              <div className="divide-y divide-(--border) rounded-md border border-(--border) font-mono text-[11px] tabular">
                {domainSources.map(({ src, role }) => (
                  <div
                    key={src.sourceId}
                    className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5"
                  >
                    <div>
                      <a
                        href={src.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-sans text-[12.5px] font-medium text-(--ink) hover:underline"
                      >
                        {src.label}
                      </a>
                      <span className="block text-[10.5px] text-(--ink-faint)">
                        {src.rowCount} rows · {src.license} · {formatUtcDate(src.lastHealthyAt)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="rounded border border-(--healthy)/40 px-2 py-0.5 text-[10.5px] text-(--healthy)">
                        {role}
                      </span>
                      {src.status !== "ok" ? (
                        <span className="rounded border border-(--warning)/40 px-2 py-0.5 text-[10.5px] text-(--warning)">
                          Stale {src.staleDays}d
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
              {!isControlledHarnesses && sensitivity.length > 0 && (
                <details className="border-y border-(--border) py-3 text-[12.5px]">
                  <summary className="cursor-pointer font-medium text-(--ink)">
                    How much does each feed affect the ranking?
                  </summary>
                  <p className="mt-2 leading-relaxed text-(--ink-secondary)">
                    We remove one feed at a time and score the affected configurations again,
                    keeping the calibration and costs fixed. Rank agreement compares configurations
                    that still qualify. A value of 1 means the order stayed the same.
                  </p>
                  <table className="mt-3 w-full text-left text-[11.5px]">
                    <thead className="text-(--ink-muted)">
                      <tr>
                        <th scope="col" className="py-2 font-medium">
                          Feed removed
                        </th>
                        <th scope="col" className="px-2 text-right font-medium">
                          Still qualify
                        </th>
                        <th scope="col" className="text-right font-medium">
                          Rank agreement
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sensitivity.map((row) => (
                        <tr key={row.sourceId} className="border-t border-(--border)">
                          <th scope="row" className="py-2 font-normal">
                            {sources.find((s) => s.sourceId === row.sourceId)?.label ??
                              row.sourceId}
                          </th>
                          <td className="px-2 text-right font-mono tabular">
                            {row.retainedConfigs}/{row.affectedConfigs}
                          </td>
                          <td className="text-right font-mono tabular">
                            {row.kendallTau?.toFixed(2) ?? "Unavailable"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </section>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
