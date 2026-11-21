"use client";

import { Dialog } from "@base-ui/react/dialog";
import { ExternalLink, X } from "lucide-react";
import { DOMAIN_BY_ID, getActiveBenchmarksForRegime } from "@/config/benchmarks";
import { HARNESS_BY_ID } from "@/config/harnesses";
import { isRetiredPurchaseSku, PROVIDER_BY_ID } from "@/config/providers";
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
  harnessLeaderboard,
  lifecycle,
  sources,
  provisionalConfigs,
  hasDisplayedListTariffs,
  generatedAt,
}: EpochMonographDrawerProps) {
  const meta = DOMAIN_BY_ID[domain.domainId];
  const regimeInfo = domain.regimeMeta[activeRegime];
  const activeBenchmarks = getActiveBenchmarksForRegime(domain.domainId, activeRegime);
  const auditByKey = new Map(
    lifecycle.audits.map((a) => [`${a.benchmarkId}::${a.harnessRegime}`, a]),
  );

  const isControlledHarnesses =
    domain.domainId === "harnesses" && activeHarnessTab === "controlled";
  const hasArenaBenchmarks = activeBenchmarks.some((b) => b.isArena);

  const pooledHarnessSlice =
    harnessLeaderboard.slices.find((s) => s.sliceId === "_all") ?? harnessLeaderboard.slices[0];
  const controlledHarnessCount = pooledHarnessSlice?.entries.length ?? 0;
  const controlledModelSlices = harnessLeaderboard.slices.filter((s) => s.sliceId !== "_all");
  const anchorProviderCount = regimeInfo?.anchorLabs ?? 0;

  const anchorFor = (benchmarkId: string) =>
    activeRegime === "standardized"
      ? domain.anchorStats[`${benchmarkId}::standardized`]
      : domain.anchorStats[benchmarkId];

  const activeSourceIds = new Set(
    isControlledHarnesses
      ? ["frontier-harness", "harness-leaderboard"]
      : activeBenchmarks.map((b) => b.sourceId),
  );
  const showPricingSource =
    !isControlledHarnesses && (domain.domainId === "writing" || hasDisplayedListTariffs);
  const pricingSourceIds = new Set<string>(showPricingSource ? ["pricing"] : []);

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
                  ? `Updated ${formatUtcDate(harnessLeaderboard.upstreamGeneratedAt)} · ${controlledHarnessCount} harnesses · ${controlledModelSlices.length} test models`
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
                    This view isolates the coding agent harness by running different harnesses on
                    the same open-weight test models. It combines FrontierHarness v1.1 and Harness
                    Leaderboard into one ranking of {controlledHarnessCount} harnesses across{" "}
                    {controlledModelSlices.length} test models covering Terminal-Bench 2.1,
                    Terminal-Bench 4.0, and DeepSWE v1.1.
                  </p>
                  <p>
                    Nine harnesses appear on both leaderboards. Those nine shared harnesses measure
                    the difference in benchmark difficulty and average run cost between the two
                    leaderboards, putting every harness&apos;s pass rate and cost per run on one
                    common scale.
                  </p>
                  <p>
                    Terminal-Bench 2.1 appears on both leaderboards, so each copy gets half weight
                    and Terminal-Bench 2.1 is never counted twice. Benchmarks with smaller error
                    bars get higher weight, Pass all 3 reports how often a harness solves a task
                    three times in a row on that same shared scale, and harnesses tested on
                    different versions across the two leaderboards list both versions.
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
                    scores, with higher weight on benchmarks that have smaller error bars and
                    clearer separation among top providers. Models tested on fewer benchmarks are
                    pulled modestly toward the domain average so one lucky score cannot outrank a
                    model proven across many benchmarks.
                  </p>
                  <p>
                    {domain.domainId === "writing"
                      ? "Every model is priced for a standard writing brief of 10,000 input tokens and 4,000 output tokens using its published first-party API token rates. If a model costs more and scores lower than another model from the same provider, it is left off the chart."
                      : domain.domainId === "cyber"
                        ? "Aikido Arena runs all models in one shared security environment. CWE-bench v2 runs four rollouts per task inside one assigned CLI agent per model, and CyberArena likewise evaluates each model inside one assigned CLI agent, because upstream publishes no shared-scaffold split. Every model is plotted against one cost per task scale, with missing benchmark costs estimated from public API token rates and measured costs in this domain. If a model costs more and scores lower than another model from the same provider, it is left off the chart."
                        : "Every model is plotted against one cost per task scale. When a benchmark does not report dollar cost, we estimate task cost from the model's public API token price and measured dollar costs in this domain. If a model costs more and scores lower than another model from the same provider, it is left off the chart."}
                  </p>
                </div>
              )}

              {isControlledHarnesses ? (
                <div className="space-y-2 rounded-md border border-(--border) bg-(--subtle) p-3 font-mono text-[11.5px] tabular">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[10.5px] text-(--ink-faint)">Pass rate</span>
                    <span className="text-right text-(--ink)">
                      Weighted pass rate (%) across Terminal-Bench 2.1, Terminal-Bench 4.0, and
                      DeepSWE v1.1
                    </span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-(--border) pt-2">
                    <span className="text-[10.5px] text-(--ink-faint)">Cost per run</span>
                    <span className="text-right text-(--ink)">
                      Measured token cost per run on one common cost scale (USD, log scale)
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
                    Every benchmark below counts directly toward this domain&apos;s score. Weight
                    ranges from 0.10 to 1.00 based on measurement precision and how clearly the
                    benchmark separates top providers.
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
                                  v{bm.version}
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
                                  Weight {anchor.effectiveWeight.toFixed(2)} · Average{" "}
                                  {anchor.mean.toFixed(1)} · Spread {anchor.sd.toFixed(1)} ·{" "}
                                  {anchor.anchorLabs} providers
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
              <p className="text-[12.5px] leading-relaxed text-(--ink-secondary)">
                Every source below refreshes daily from its public leaderboard.
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
            </section>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
