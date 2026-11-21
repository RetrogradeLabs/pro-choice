"use client";

import { scaleLinear, scaleLog } from "d3-scale";
import { ChevronRight, ExternalLink } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Fragment,
  type PointerEvent,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { formatAxisCost, formatCost } from "@/lib/format";
import { normalizeHarnessVersion, selectControlledHarnessPicks } from "@/lib/math/harness-pareto";
import type { HarnessEntry, HarnessLeaderboardSnapshot, HarnessModelSlice } from "@/lib/schema";

interface HarnessesControlledViewProps {
  leaderboard: HarnessLeaderboardSnapshot;
  selectedModelSlice: string;
  sliceMotionDx?: number;
}

const CHART_HEIGHT = 400;
const DEFAULT_CHART_WIDTH = 1058;
const MARGIN = { top: 34, right: 28, bottom: 42, left: 50 };
const EASE = [0.22, 1, 0.36, 1] as const;
const SNAP_RADIUS_PX = 24;

function formatVersionLabel(version: string | null): string | null {
  const cleaned = normalizeHarnessVersion(version);
  if (!cleaned) return null;
  return cleaned
    .split(" / ")
    .map((part) => `v${part.replace(/^v/i, "")}`)
    .join(" / ");
}

function formatTokens(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "N/A";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "N/A";
  const mins = Math.round(seconds / 60);
  if (mins < 1) return `${Math.round(seconds)}s`;
  return `${mins}m`;
}

interface HarnessColumnSpec {
  id: "tb21" | "tb40" | "deepswe";
  label: string;
  matchIds: readonly string[];
}

const HARNESS_BENCHMARK_COLS: readonly HarnessColumnSpec[] = [
  {
    id: "tb21",
    label: "TB 2.1",
    matchIds: ["terminal-bench-2.1", "tb21-frontierharness", "tb21-harness-lb"],
  },
  { id: "tb40", label: "TB 4.0", matchIds: ["terminal-bench-4.0"] },
  { id: "deepswe", label: "DeepSWE", matchIds: ["deep-swe"] },
];

function computeColumnPassRate(entry: HarnessEntry, col: HarnessColumnSpec): number | null {
  const matches = entry.benchmarks.filter((b) => col.matchIds.includes(b.benchmarkId));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!.passRate;
  // Combine multiple TB 2.1 suites using transparent task-count weights (never using upper-bound CIs as inverse variances)
  let wSum = 0;
  let wxSum = 0;
  for (const m of matches) {
    const w = m.nTasks > 0 ? m.nTasks : 1;
    wSum += w;
    wxSum += w * m.passRate;
  }
  return wSum > 0 ? wxSum / wSum : matches[0]!.passRate;
}

export function HarnessesControlledView({
  leaderboard,
  selectedModelSlice,
  sliceMotionDx = 0,
}: HarnessesControlledViewProps) {
  const prefersReducedMotion = useReducedMotion();
  const clipId = useId();
  const containerRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(DEFAULT_CHART_WIDTH);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<readonly string[]>([]);
  const expandedSet = new Set(expandedIds);

  const slice: HarnessModelSlice | undefined =
    leaderboard.slices.find((s) => s.sliceId === selectedModelSlice) ?? leaderboard.slices[0];
  const activeSliceId = slice?.sliceId ?? "_all";
  const [initialSliceId] = useState(activeSliceId);

  const onEscapeKeyDown = useEffectEvent((e: globalThis.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (document.querySelector('[role="dialog"]')) return;
    setHoveredId(null);
  });

  useEffect(() => {
    window.addEventListener("keydown", onEscapeKeyDown);
    return () => window.removeEventListener("keydown", onEscapeKeyDown);
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = (w: number) => {
      if (w > 0) setWidth(Math.max(300, Math.round(w)));
    };
    sync(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((items) => {
      const first = items[0];
      if (first) sync(first.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!slice) return null;

  const entries = slice.entries;
  const frontierEntries = entries
    .filter((e) => e.onFrontier)
    .toSorted((a, b) => a.costPerTrialUsd - b.costPerTrialUsd);
  const dominatedEntries = entries.filter((e) => !e.onFrontier);
  const entryById = new Map(entries.map((e) => [e.harnessId, e]));
  const picks = selectControlledHarnessPicks(entries);

  const innerWidth = Math.max(200, width - MARGIN.left - MARGIN.right);
  const innerHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;

  const costs = entries.map((e) => e.costPerTrialUsd);
  const rates = entries.map((e) => e.passRate);
  const minCost = Math.max(1e-4, Math.min(...costs) * 0.78);
  const maxCost = Math.max(minCost * 1.8, Math.max(...costs) * 1.25);
  const minRate = Math.max(0, Math.floor((Math.min(...rates) - 4) / 5) * 5);
  const maxRate = Math.min(100, Math.ceil((Math.max(...rates) + 4) / 5) * 5);

  const xScale = scaleLog().domain([minCost, maxCost]).range([0, innerWidth]).clamp(true);
  const yScale = scaleLinear().domain([minRate, maxRate]).range([innerHeight, 0]);
  const yTicks = yScale.ticks(5);
  const xTicks = (() => {
    const out: { value: number; label: string; x: number }[] = [];
    const seen = new Set<string>();
    let lastX = -Infinity;
    for (const t of xScale.ticks(6)) {
      const x = xScale(t);
      const label = formatAxisCost(t, "usd_per_task");
      if (x - lastX >= 68 && !seen.has(label)) {
        out.push({ value: t, label, x });
        seen.add(label);
        lastX = x;
      }
    }
    return out;
  })();

  const hoveredEntry = hoveredId ? (entryById.get(hoveredId) ?? null) : null;

  const svgPointToPlot = (
    svg: SVGSVGElement | null,
    clientX: number,
    clientY: number,
  ): { relX: number; relY: number } | null => {
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const scale = Math.min(rect.width / width, rect.height / CHART_HEIGHT);
    if (scale <= 0) return null;
    const offsetX = (rect.width - width * scale) / 2;
    const offsetY = (rect.height - CHART_HEIGHT * scale) / 2;
    const relX = (clientX - rect.left - offsetX) / scale - MARGIN.left;
    const relY = (clientY - rect.top - offsetY) / scale - MARGIN.top;
    if (relX < -8 || relX > innerWidth + 8 || relY < -8 || relY > innerHeight + 8) return null;
    return { relX, relY };
  };

  const findNearestHarness = (relX: number, relY: number): HarnessEntry | null => {
    let best: HarnessEntry | null = null;
    let bestDist = SNAP_RADIUS_PX;
    for (const entry of entries) {
      const d = Math.hypot(xScale(entry.costPerTrialUsd) - relX, yScale(entry.passRate) - relY);
      if (d < bestDist) {
        bestDist = d;
        best = entry;
      }
    }
    return best;
  };

  const handleSvgPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "touch") return;
    const pt = svgPointToPlot(e.currentTarget, e.clientX, e.clientY);
    if (!pt) {
      setHoveredId(null);
      return;
    }
    const nearest = findNearestHarness(pt.relX, pt.relY);
    setHoveredId(nearest ? nearest.harnessId : null);
  };

  const handleSvgPointerUp = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || (e.target as Element | null)?.closest("a")) return;
    const pt = svgPointToPlot(e.currentTarget, e.clientX, e.clientY);
    const nearest = pt ? findNearestHarness(pt.relX, pt.relY) : null;
    if (nearest) selectHarnessRow(nearest.harnessId, true);
  };

  const selectHarnessRow = (harnessId: string, scrollIntoView = false) => {
    setExpandedIds((prev) => {
      if (scrollIntoView) {
        return prev.includes(harnessId) ? prev : [...prev, harnessId];
      }
      return prev.includes(harnessId)
        ? prev.filter((item) => item !== harnessId)
        : [...prev, harnessId];
    });
    if (scrollIntoView) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const row = document.getElementById(`harness-${encodeURIComponent(harnessId)}`);
          if (row) {
            const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            row.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
          }
        });
      });
    }
  };

  const pillStyle = (() => {
    if (!hoveredEntry) return null;
    const px = MARGIN.left + xScale(hoveredEntry.costPerTrialUsd);
    const py = MARGIN.top + yScale(hoveredEntry.passRate);
    const placeBelow = py < 46;
    const clampedX = Math.max(92, Math.min(width - 92, px));
    return {
      left: `${clampedX}px`,
      top: `${placeBelow ? py + 14 : py - 14}px`,
      transform: placeBelow ? "translate(-50%, 0)" : "translate(-50%, -100%)",
    };
  })();

  return (
    <div>
      {/* Top 3 Controlled Harness Picks */}
      {picks.length > 0 ? (
        <motion.section
          key={`hpicks-${slice.sliceId}`}
          aria-label="Top harness picks"
          initial={
            sliceMotionDx === 0 || prefersReducedMotion ? false : { opacity: 0, x: sliceMotionDx }
          }
          animate={{ opacity: 1, x: 0 }}
          transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.18, ease: EASE }}
          className={`grid grid-cols-1 divide-y divide-(--border) border-t border-(--border) ${
            picks.length === 3 ? "md:grid-cols-3" : picks.length === 2 ? "md:grid-cols-2" : ""
          } md:divide-x md:divide-y-0`}
        >
          {picks.map((item) => {
            const h = item.entry;
            const isHighlighted = hoveredId === h.harnessId || expandedSet.has(h.harnessId);
            return (
              <article
                key={item.tag}
                onPointerEnter={() => setHoveredId(h.harnessId)}
                onPointerLeave={() => setHoveredId(null)}
                className={`relative flex flex-col justify-between px-5 py-6 transition-colors duration-150 sm:px-7 lg:first:pl-11 lg:last:pr-11 ${
                  isHighlighted ? "bg-(--subtle)" : "bg-(--surface) hover:bg-(--subtle)/70"
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
                    <span className="text-(--ink-muted)">{h.vendor}</span>
                  </div>

                  <h2 className="mt-2.5 font-display text-[22px] leading-[1.15] font-normal tracking-[-0.02em] text-(--ink)">
                    <button
                      type="button"
                      onClick={() => selectHarnessRow(h.harnessId, true)}
                      className="cursor-pointer text-left after:absolute after:inset-0 focus-visible:outline-none"
                    >
                      {h.name}
                    </button>
                  </h2>

                  <p className="mt-1 font-mono text-[11px] text-(--ink-faint)">
                    {formatVersionLabel(h.version) ?? "Latest"}
                    {h.costPerPassUsd !== null
                      ? ` · ${formatCost(h.costPerPassUsd, "usd_per_task")} / solved`
                      : ""}
                  </p>
                </div>

                <div className="mt-5 flex items-baseline justify-between gap-3 border-t border-(--border)/60 pt-3 font-mono tabular">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[18px] font-medium tracking-[-0.02em] text-(--ink)">
                      {h.passRate.toFixed(1)}%
                    </span>
                    <span className="text-[10.5px] text-(--ink-faint)">pass rate</span>
                  </div>

                  <div className="flex items-baseline gap-1 text-right">
                    <span className="text-[14.5px] font-medium text-(--ink)">
                      {formatCost(h.costPerTrialUsd, "usd_per_task")}
                    </span>
                    <span className="text-[10.5px] text-(--ink-faint)">/ run</span>
                  </div>
                </div>
              </article>
            );
          })}
        </motion.section>
      ) : null}

      {/* Clean Tufte Pareto chart for Controlled Harnesses */}
      <section
        aria-label="Harness Pareto frontier chart"
        className="border-t border-(--border) bg-(--bg)"
      >
        <figure
          ref={containerRef}
          aria-label="Coding-agent harness pass rate versus cost per run"
          className="relative w-full border-b border-(--border) bg-(--bg)"
          onPointerLeave={() => setHoveredId(null)}
        >
          <div className="relative h-100 w-full">
            <svg
              viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
              height={CHART_HEIGHT}
              preserveAspectRatio="xMidYMid meet"
              onPointerMove={handleSvgPointerMove}
              onPointerUp={handleSvgPointerUp}
              className="block h-100 w-full select-none"
            >
              <title>Coding-agent harness pass rate versus cost per run</title>
              <defs>
                <clipPath id={clipId}>
                  <motion.rect
                    key={slice.sliceId}
                    x={-12}
                    y={-12}
                    width={innerWidth + 24}
                    height={innerHeight + 24}
                    style={{ transformOrigin: "0px 0px" }}
                    initial={
                      slice.sliceId === initialSliceId || prefersReducedMotion
                        ? false
                        : { scaleX: 0 }
                    }
                    animate={{ scaleX: 1 }}
                    transition={
                      prefersReducedMotion ? { duration: 0 } : { duration: 0.34, ease: EASE }
                    }
                  />
                </clipPath>
              </defs>

              <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
                <text
                  x={0}
                  y={-14}
                  textAnchor="start"
                  fill="var(--ink-faint)"
                  className="font-mono text-[10.5px]"
                >
                  Pass rate (%)
                </text>
                <text
                  x={innerWidth}
                  y={-14}
                  textAnchor="end"
                  fill="var(--ink-faint)"
                  className="font-mono text-[10.5px]"
                >
                  Cost / run (log)
                </text>

                {yTicks.map((tick) => {
                  const y = yScale(tick);
                  return (
                    <g key={`hy-${tick}`}>
                      <line
                        x1={0}
                        x2={innerWidth}
                        y1={y}
                        y2={y}
                        stroke="var(--border)"
                        strokeOpacity={0.65}
                      />
                      <text
                        x={-10}
                        y={y}
                        dy="0.32em"
                        textAnchor="end"
                        fill="var(--ink-faint)"
                        className="font-mono text-[10.5px] tabular"
                      >
                        {tick}%
                      </text>
                    </g>
                  );
                })}

                {xTicks.map((tick) => (
                  <g key={`hx-${tick.value}`} transform={`translate(${tick.x},0)`}>
                    <line
                      x1={0}
                      x2={0}
                      y1={innerHeight}
                      y2={innerHeight + 4}
                      stroke="var(--border-strong)"
                    />
                    <text
                      x={0}
                      y={innerHeight + 20}
                      textAnchor="middle"
                      fill="var(--ink-faint)"
                      className="font-mono text-[10.5px] tabular"
                    >
                      {tick.label}
                    </text>
                  </g>
                ))}

                <line
                  x1={0}
                  x2={innerWidth}
                  y1={innerHeight}
                  y2={innerHeight}
                  stroke="var(--border-strong)"
                />

                {/* Solid Pareto frontier connecting leading harnesses */}
                <g clipPath={`url(#${clipId})`}>
                  {frontierEntries.map((entry, idx) => {
                    if (idx === 0) return null;
                    const prev = frontierEntries[idx - 1]!;
                    return (
                      <line
                        key={`hseg-${prev.harnessId}-${entry.harnessId}`}
                        x1={xScale(prev.costPerTrialUsd)}
                        y1={yScale(prev.passRate)}
                        x2={xScale(entry.costPerTrialUsd)}
                        y2={yScale(entry.passRate)}
                        stroke="var(--interactive)"
                        strokeWidth={2.2}
                        strokeLinecap="round"
                      />
                    );
                  })}
                </g>

                {/* Non-leading harnesses plotted as subdued circles */}
                {dominatedEntries.map((entry) => {
                  const cx = xScale(entry.costPerTrialUsd);
                  const cy = yScale(entry.passRate);
                  return (
                    <g key={`hdom-${entry.harnessId}`}>
                      <a
                        href={`#harness-${encodeURIComponent(entry.harnessId)}`}
                        aria-label={`${entry.name}, ${entry.passRate.toFixed(1)}% pass rate, ${formatCost(entry.costPerTrialUsd, "usd_per_task")} per run`}
                        className="cursor-pointer"
                        onPointerEnter={() => setHoveredId(entry.harnessId)}
                        onFocus={() => setHoveredId(entry.harnessId)}
                        onBlur={() => setHoveredId((cur) => (cur === entry.harnessId ? null : cur))}
                        onClick={(e) => {
                          e.preventDefault();
                          const pt =
                            e.detail > 0
                              ? svgPointToPlot(e.currentTarget.closest("svg"), e.clientX, e.clientY)
                              : null;
                          const nearest = pt ? findNearestHarness(pt.relX, pt.relY) : null;
                          selectHarnessRow(nearest ? nearest.harnessId : entry.harnessId, true);
                        }}
                      >
                        <circle cx={cx} cy={cy} r={10} fill="transparent" />
                        <circle
                          cx={cx}
                          cy={cy}
                          r={3.75}
                          fill="var(--bg)"
                          stroke="var(--ink-muted)"
                          strokeWidth={1.6}
                          opacity={0.75}
                        />
                      </a>
                    </g>
                  );
                })}

                {/* Leading harness markers */}
                {frontierEntries.map((entry) => {
                  const cx = xScale(entry.costPerTrialUsd);
                  const cy = yScale(entry.passRate);
                  return (
                    <g key={`hfront-${entry.harnessId}`}>
                      <a
                        href={`#harness-${encodeURIComponent(entry.harnessId)}`}
                        aria-label={`${entry.name}, ${entry.passRate.toFixed(1)}% pass rate, ${formatCost(entry.costPerTrialUsd, "usd_per_task")} per run`}
                        className="cursor-pointer"
                        onPointerEnter={() => setHoveredId(entry.harnessId)}
                        onFocus={() => setHoveredId(entry.harnessId)}
                        onBlur={() => setHoveredId((cur) => (cur === entry.harnessId ? null : cur))}
                        onClick={(e) => {
                          e.preventDefault();
                          const pt =
                            e.detail > 0
                              ? svgPointToPlot(e.currentTarget.closest("svg"), e.clientX, e.clientY)
                              : null;
                          const nearest = pt ? findNearestHarness(pt.relX, pt.relY) : null;
                          selectHarnessRow(nearest ? nearest.harnessId : entry.harnessId, true);
                        }}
                      >
                        <circle cx={cx} cy={cy} r={11} fill="transparent" />
                        <circle
                          cx={cx}
                          cy={cy}
                          r={4.5}
                          fill="var(--interactive)"
                          stroke="var(--bg)"
                          strokeWidth={1.75}
                        />
                      </a>
                    </g>
                  );
                })}
              </g>
            </svg>

            {/* Minimal hover pill: harness name + version only */}
            <AnimatePresence>
              {pillStyle && hoveredEntry ? (
                <div
                  key={hoveredEntry.harnessId}
                  style={pillStyle}
                  className="pointer-events-none absolute z-20"
                >
                  <motion.div
                    data-pareto-tooltip="true"
                    initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    {...(prefersReducedMotion ? {} : { exit: { opacity: 0, scale: 0.97 } })}
                    transition={{ duration: 0.11, ease: EASE }}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-(--border-strong) bg-(--surface)/95 px-2.5 py-1 text-[12px] shadow-(--shadow-button) backdrop-blur-sm"
                  >
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 rounded-full"
                      style={{
                        backgroundColor: hoveredEntry.onFrontier
                          ? "var(--interactive)"
                          : "var(--ink-muted)",
                      }}
                    />
                    <span className="font-medium text-(--ink)">{hoveredEntry.name}</span>
                    {formatVersionLabel(hoveredEntry.version) ? (
                      <>
                        <span aria-hidden="true" className="text-(--ink-faint)">
                          ·
                        </span>
                        <span className="font-mono text-[10.5px] text-(--ink-faint)">
                          {formatVersionLabel(hoveredEntry.version)}
                        </span>
                      </>
                    ) : null}
                  </motion.div>
                </div>
              ) : null}
            </AnimatePresence>
          </div>
        </figure>
      </section>

      {/* Clean Harness Comparison Table */}
      <section aria-label="Harness rankings" className="bg-(--bg)">
        {(() => {
          const presentCols = HARNESS_BENCHMARK_COLS.filter((col) =>
            entries.some((e) => e.benchmarks.some((b) => col.matchIds.includes(b.benchmarkId))),
          );
          const firstColPct = 22 + (3 - presentCols.length) * 7.5;
          return (
            <div className="overflow-x-auto">
              <table className="w-full min-w-220 table-fixed border-collapse text-left text-[12.5px] tabular">
                <colgroup>
                  <col style={{ width: `${firstColPct}%` }} />
                  <col style={{ width: "11%" }} />
                  <col style={{ width: "9%" }} />
                  {presentCols.map((col) => (
                    <col key={col.id} style={{ width: "7.5%" }} />
                  ))}
                  <col style={{ width: "10.5%" }} />
                  <col style={{ width: "12.5%" }} />
                  <col style={{ width: "12.5%" }} />
                </colgroup>
                <thead>
                  <tr className="border-b border-(--border) bg-(--subtle) font-mono text-[11px] font-normal text-(--ink-faint)">
                    <th className="py-2.5 pl-5 pr-3 font-normal whitespace-nowrap sm:pl-9 lg:pl-11">
                      Harness
                    </th>
                    <th className="px-3 py-2.5 font-normal whitespace-nowrap">Provider</th>
                    <th className="px-3 py-2.5 text-right font-normal whitespace-nowrap">
                      Pass rate
                    </th>
                    {presentCols.map((col) => (
                      <th
                        key={col.id}
                        className="px-3 py-2.5 text-right font-normal whitespace-nowrap"
                      >
                        {col.label}
                      </th>
                    ))}
                    <th className="px-3 py-2.5 text-right font-normal whitespace-nowrap">
                      Cost / run
                    </th>
                    <th className="px-3 py-2.5 text-right font-normal whitespace-nowrap">
                      Cost / solved
                    </th>
                    <th className="py-2.5 pl-3 pr-5 text-right font-normal whitespace-nowrap sm:pr-9 lg:pr-11">
                      Pass all 3
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const expanded = expandedSet.has(entry.harnessId);
                    const hovered = hoveredId === entry.harnessId;

                    return (
                      <Fragment key={entry.harnessId}>
                        <tr
                          id={`harness-${encodeURIComponent(entry.harnessId)}`}
                          onPointerEnter={() => setHoveredId(entry.harnessId)}
                          onPointerLeave={() => setHoveredId(null)}
                          className={`scroll-mt-16 border-b border-(--border) transition-[background-color] duration-150 last:border-b-0 ${
                            expanded || hovered ? "bg-(--subtle)" : "hover:bg-(--subtle)/70"
                          }`}
                        >
                          <td className="py-2.5 pl-5 pr-3 sm:pl-9 lg:pl-11">
                            <button
                              type="button"
                              aria-expanded={expanded}
                              onClick={() => selectHarnessRow(entry.harnessId, false)}
                              className="flex w-full min-w-0 cursor-pointer items-center gap-2 text-left"
                            >
                              <ChevronRight
                                aria-hidden="true"
                                className={`h-3.5 w-3.5 shrink-0 text-(--ink-faint) transition-transform duration-150 ${
                                  expanded ? "rotate-90" : ""
                                }`}
                              />
                              <span
                                className={`truncate font-medium ${
                                  entry.onFrontier ? "text-(--ink)" : "text-(--ink-secondary)"
                                }`}
                              >
                                {entry.name}
                              </span>
                              {formatVersionLabel(entry.version) ? (
                                <span className="shrink-0 whitespace-nowrap font-mono text-[10.5px] text-(--ink-faint)">
                                  {formatVersionLabel(entry.version)}
                                </span>
                              ) : null}
                              {entry.onFrontier ? (
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--interactive)" />
                              ) : null}
                            </button>
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap text-(--ink-muted)">
                            {entry.vendor}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono font-medium whitespace-nowrap text-(--ink)">
                            {entry.passRate.toFixed(1)}%
                          </td>
                          {presentCols.map((col) => {
                            const val = computeColumnPassRate(entry, col);
                            return (
                              <td
                                key={col.id}
                                className="px-3 py-2.5 text-right font-mono whitespace-nowrap text-(--ink-secondary)"
                              >
                                {val !== null ? `${val.toFixed(1)}%` : "N/A"}
                              </td>
                            );
                          })}
                          <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap text-(--ink)">
                            {formatCost(entry.costPerTrialUsd, "usd_per_task")}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap text-(--ink-muted)">
                            {entry.costPerPassUsd !== null
                              ? formatCost(entry.costPerPassUsd, "usd_per_task")
                              : "N/A"}
                          </td>
                          <td className="py-2.5 pl-3 pr-5 text-right font-mono whitespace-nowrap text-(--ink-muted) sm:pr-9 lg:pr-11">
                            {entry.passAll3Rate !== null
                              ? `${entry.passAll3Rate.toFixed(1)}%`
                              : "N/A"}
                          </td>
                        </tr>

                        {expanded ? (
                          <tr className="border-b border-(--border) bg-(--subtle) last:border-b-0">
                            <td
                              colSpan={6 + presentCols.length}
                              aria-label={`${entry.name} benchmark details`}
                              className="p-0"
                            >
                              <motion.div
                                initial={prefersReducedMotion ? false : { opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                transition={{ duration: 0.18, ease: EASE }}
                                className="overflow-hidden"
                              >
                                <div className="px-5 py-4 sm:px-9 lg:px-11">
                                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                                    {entry.benchmarks.map((bm) => (
                                      <div
                                        key={bm.benchmarkId}
                                        className="rounded-md border border-(--border) bg-(--surface) p-3"
                                      >
                                        <div className="flex items-start justify-between gap-2">
                                          <span className="text-[12px] font-medium text-(--ink)">
                                            {bm.name}
                                          </span>
                                          <a
                                            href={bm.sourceUrl ?? leaderboard.sourceUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            aria-label={`Open ${bm.name}`}
                                            className="text-(--ink-faint) hover:text-(--ink)"
                                          >
                                            <ExternalLink className="h-3.5 w-3.5" />
                                          </a>
                                        </div>
                                        <div className="mt-2 flex items-baseline justify-between font-mono tabular">
                                          <span className="text-[14px] font-medium text-(--ink)">
                                            {bm.passRate.toFixed(1)}%
                                          </span>
                                          <span className="text-[11px] text-(--ink-muted)">
                                            {formatCost(bm.costPerTrialUsd, "usd_per_task")} / run
                                          </span>
                                        </div>
                                        <div className="mt-1 font-mono text-[10.5px] text-(--ink-faint)">
                                          {bm.nTasks} tasks
                                          {bm.ciLower !== null && bm.ciUpper !== null
                                            ? ` · ${bm.ciIsUpperBound ? "CI upper bound" : "95% CI"} [${bm.ciLower.toFixed(1)}, ${bm.ciUpper.toFixed(1)}]%`
                                            : ""}
                                        </div>
                                      </div>
                                    ))}

                                    <div className="rounded-md border border-(--border) bg-(--surface) p-3 font-mono text-[11px] tabular">
                                      <div className="font-sans text-[12px] font-medium text-(--ink)">
                                        Run profile
                                      </div>
                                      <div className="mt-2 space-y-1 text-(--ink-muted)">
                                        <div className="flex justify-between">
                                          <span className="text-(--ink-faint)">Tokens / run</span>
                                          <span>{formatTokens(entry.tokensPerTrial)}</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-(--ink-faint)">Mean time</span>
                                          <span>{formatDuration(entry.agentSecondsPerTrial)}</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-(--ink-faint)">Scored runs</span>
                                          <span>{entry.nScored.toLocaleString("en-US")}</span>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
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
          );
        })()}
      </section>
    </div>
  );
}
