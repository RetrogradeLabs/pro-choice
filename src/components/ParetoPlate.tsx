"use client";

import { scaleLinear, scaleLog } from "d3-scale";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { DOMAIN_BY_ID } from "@/config/benchmarks";
import { HARNESS_BY_ID } from "@/config/harnesses";
import { PROVIDER_BY_ID } from "@/config/providers";
import {
  ceilSpendCapValue,
  formatAxisCost,
  formatCost,
  formatEffort,
  formatScore,
  formatScoreEvidence,
  formatSpendCap,
  modelScoreEvidence,
} from "@/lib/format";
import type {
  DomainSnapshot,
  EvaluatedConfig,
  FrontierPoint,
  HarnessRegime,
  ProviderFrontier,
  ProviderId,
  PrunedConfig,
} from "@/lib/schema";
import { markerPathAt, ProviderMarkerIcon } from "./ProviderMarkerIcon";

interface ParetoPlateProps {
  domain: DomainSnapshot;
  activeRegime: HarnessRegime;
  isHarnessDomain?: boolean;
  sliceInstanceKey: string;
  frontiers: readonly ProviderFrontier[];
  configById: ReadonlyMap<string, EvaluatedConfig>;
  showPruned: boolean;
  hoveredConfigId: string | null;
  onSelectConfig: (id: string) => void;
  onSelectPrunedConfig?: (id: string) => void;
  onHoverConfig: (id: string | null) => void;
}

interface PlotNode {
  kind: "frontier";
  provider: ProviderId;
  cfg: EvaluatedConfig;
  pt: FrontierPoint;
  cx: number;
  cy: number;
}

interface PrunedPlotNode {
  kind: "pruned";
  provider: ProviderId;
  cfg: EvaluatedConfig;
  domCfg: EvaluatedConfig;
  pr: PrunedConfig;
  cx: number;
  cy: number;
  dx: number;
  dy: number;
}

type AnyHoverNode = PlotNode | PrunedPlotNode;

const CHART_HEIGHT = 420;
const DEFAULT_CHART_WIDTH = 1058;
const MARGIN = { top: 34, right: 28, bottom: 42, left: 50 };
const EASE = [0.22, 1, 0.36, 1] as const;
const TAP_SLOP_PX = 8;
const SNAP_RADIUS_PX = 24;

function resolveBudgetPick(
  frontier: readonly FrontierPoint[],
  configById: ReadonlyMap<string, EvaluatedConfig>,
  budget: number,
): EvaluatedConfig | null {
  let active: EvaluatedConfig | null = null;
  for (const pt of frontier) {
    const cfg = configById.get(pt.configId);
    if (cfg && cfg.effectiveCostUsd !== null && cfg.effectiveCostUsd <= budget) {
      active = cfg;
    }
  }
  return active;
}

function filterLogTicksUnique(
  ticks: readonly number[],
  xScale: (v: number) => number,
  unit: DomainSnapshot["costUnit"],
  minPxGap = 68,
): { value: number; label: string; x: number }[] {
  const kept: { value: number; label: string; x: number }[] = [];
  const seenLabels = new Set<string>();
  let lastX = -Infinity;
  for (const t of ticks) {
    const x = xScale(t);
    const label = formatAxisCost(t, unit);
    if (x - lastX >= minPxGap && !seenLabels.has(label)) {
      kept.push({ value: t, label, x });
      seenLabels.add(label);
      lastX = x;
    }
  }
  return kept;
}

function resolveHarnessName(cfg: EvaluatedConfig): string | null {
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

function handleNodeKeyDown(e: KeyboardEvent<Element>, onActivate: () => void) {
  if (e.key === " ") {
    e.preventDefault();
    onActivate();
  }
}

export function ParetoPlate({
  domain,
  activeRegime,
  isHarnessDomain = false,
  sliceInstanceKey,
  frontiers,
  configById,
  showPruned,
  hoveredConfigId,
  onSelectConfig,
  onSelectPrunedConfig,
  onHoverConfig,
}: ParetoPlateProps) {
  const prefersReducedMotion = useReducedMotion();
  const clipId = useId();
  const spendHelpId = useId();
  const spendStepperRef = useRef<HTMLButtonElement>(null);

  // Only sweep the clip reveal on domain/regime switch, never when toggling individual providers
  const revealKey = `${domain.domainId}-${activeRegime}`;
  const [initialRevealKey] = useState(revealKey);

  // Match desktop column width (1260 - 200 sidebar - 2 borders = 1058) and refine before first paint via useLayoutEffect
  const containerRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(DEFAULT_CHART_WIDTH);
  const [hoverBudgetState, setHoverBudgetState] = useState<{
    sliceKey: string;
    value: number;
    pinned: boolean;
  } | null>(null);
  const [chartHoveredFrontierId, setChartHoveredFrontierId] = useState<string | null>(null);
  const [hoveredPrunedId, setHoveredPrunedId] = useState<string | null>(null);
  const [focusedNode, setFocusedNode] = useState<{
    kind: "frontier" | "pruned";
    id: string;
  } | null>(null);
  const [dismissedIds, setDismissedIds] = useState<readonly string[]>([]);

  const sliceKey = sliceInstanceKey;
  const hoverBudget = hoverBudgetState?.sliceKey === sliceKey ? hoverBudgetState.value : null;
  const hoverBudgetPinned =
    hoverBudgetState?.sliceKey === sliceKey ? hoverBudgetState.pinned : false;

  const downRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    moved: boolean;
  } | null>(null);
  const pinnedPenPosRef = useRef<{ x: number; y: number } | null>(null);
  const lastClientPosRef = useRef<{ x: number; y: number } | null>(null);
  const escapeFreezePosRef = useRef<{ x: number; y: number } | null>(null);

  const meta = DOMAIN_BY_ID[domain.domainId];
  const innerWidth = Math.max(200, width - MARGIN.left - MARGIN.right);
  const innerHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;

  const visibleConfigs: EvaluatedConfig[] = [];
  for (const pf of frontiers) {
    for (const pt of pf.frontier) {
      const cfg = configById.get(pt.configId);
      if (cfg && cfg.effectiveCostUsd !== null) visibleConfigs.push(cfg);
    }
    if (showPruned) {
      for (const pr of pf.pruned) {
        const cfg = configById.get(pr.configId);
        if (cfg && cfg.effectiveCostUsd !== null) visibleConfigs.push(cfg);
      }
    }
  }

  const hasVisibleConfigs = visibleConfigs.length > 0;
  useLayoutEffect(() => {
    if (!hasVisibleConfigs) return;
    const el = containerRef.current;
    if (!el) return;
    const sync = (w: number) => {
      if (w > 0) setWidth(Math.max(300, Math.round(w)));
    };
    sync(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) sync(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasVisibleConfigs]);
  // Keep axis bounds anchored to all providers in the active regime + harness slice (and always covering visible configs)
  // so toggling providers never shifts untouched curves and harness-filtered points always stay in bounds
  const activeHarnessFilter = frontiers[0]?.harnessFilter ?? "all";
  const scaleConfigById = new Map<string, EvaluatedConfig>();
  for (const pf of domain.frontiers) {
    if (pf.harnessRegime !== activeRegime || pf.harnessFilter !== activeHarnessFilter) continue;
    for (const pt of pf.frontier) {
      const cfg = configById.get(pt.configId);
      if (cfg && cfg.effectiveCostUsd !== null) scaleConfigById.set(cfg.id, cfg);
    }
    if (showPruned) {
      for (const pr of pf.pruned) {
        const cfg = configById.get(pr.configId);
        if (cfg && cfg.effectiveCostUsd !== null) scaleConfigById.set(cfg.id, cfg);
      }
    }
  }
  for (const cfg of visibleConfigs) scaleConfigById.set(cfg.id, cfg);
  const scaleConfigs = [...scaleConfigById.values()];
  const boundPool = scaleConfigs.length > 0 ? scaleConfigs : visibleConfigs;
  const rawCosts = hasVisibleConfigs ? boundPool.map((c) => c.effectiveCostUsd!) : [1];
  const rawScores = hasVisibleConfigs ? boundPool.map((c) => c.score) : [40, 60];

  const minCost = Math.max(1e-5, Math.min(...rawCosts) * 0.72);
  const maxCost = Math.max(minCost * 2, Math.max(...rawCosts) * 1.32);
  const minScore = Math.floor((Math.min(...rawScores) - 4) / 5) * 5;
  const maxScore = Math.ceil((Math.max(...rawScores) + 4) / 5) * 5;

  const xScale = scaleLog().domain([minCost, maxCost]).range([0, innerWidth]).clamp(true);
  const yScale = scaleLinear().domain([minScore, maxScore]).range([innerHeight, 0]);

  const xTicks = filterLogTicksUnique(xScale.ticks(6), (t) => xScale(t), domain.costUnit, 68);
  const yTicks = yScale.ticks(5);

  const frontierNodes: PlotNode[] = [];
  const prunedNodes: PrunedPlotNode[] = [];
  const nodesByProvider = new Map<ProviderId, PlotNode[]>();

  for (const pf of frontiers) {
    const list: PlotNode[] = [];
    for (const pt of pf.frontier) {
      const cfg = configById.get(pt.configId);
      if (!cfg || cfg.effectiveCostUsd === null) continue;
      const node: PlotNode = {
        kind: "frontier",
        provider: pf.provider,
        cfg,
        pt,
        cx: xScale(cfg.effectiveCostUsd),
        cy: yScale(cfg.score),
      };
      list.push(node);
      frontierNodes.push(node);
    }
    nodesByProvider.set(pf.provider, list);

    if (showPruned) {
      for (const pr of pf.pruned) {
        const cfg = configById.get(pr.configId);
        const domCfg = configById.get(pr.dominatedById);
        if (!cfg || !domCfg || cfg.effectiveCostUsd === null || domCfg.effectiveCostUsd === null) {
          continue;
        }
        prunedNodes.push({
          kind: "pruned",
          provider: pf.provider,
          cfg,
          domCfg,
          pr,
          cx: xScale(cfg.effectiveCostUsd),
          cy: yScale(cfg.score),
          dx: xScale(domCfg.effectiveCostUsd),
          dy: yScale(domCfg.score),
        });
      }
    }
  }

  const findNearestNode = (relX: number, relY: number): AnyHoverNode | null => {
    let best: AnyHoverNode | null = null;
    let bestDist = SNAP_RADIUS_PX;
    const pool: AnyHoverNode[] = showPruned ? [...frontierNodes, ...prunedNodes] : frontierNodes;
    for (const node of pool) {
      const d = Math.hypot(node.cx - relX, node.cy - relY);
      if (d < bestDist) {
        bestDist = d;
        best = node;
      }
    }
    return best;
  };

  const rawHoveredNode: AnyHoverNode | null = (() => {
    if (hoveredPrunedId) {
      return prunedNodes.find((n) => n.cfg.id === hoveredPrunedId) ?? null;
    }
    if (chartHoveredFrontierId) {
      return frontierNodes.find((n) => n.cfg.id === chartHoveredFrontierId) ?? null;
    }
    if (focusedNode) {
      return focusedNode.kind === "pruned"
        ? (prunedNodes.find((n) => n.cfg.id === focusedNode.id) ?? null)
        : (frontierNodes.find((n) => n.cfg.id === focusedNode.id) ?? null);
    }
    return null;
  })();

  const activeHoveredNode =
    rawHoveredNode &&
    !dismissedIds.includes(rawHoveredNode.cfg.id) &&
    !dismissedIds.includes("__all__")
      ? rawHoveredNode
      : null;

  const onEscapeKeyDown = useEffectEvent((e: globalThis.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (document.querySelector('[role="dialog"]')) return;
    const activeEl = document.activeElement as HTMLElement | null;
    const focusInSpendBar = Boolean(activeEl?.closest?.('[data-budget-readout="true"]'));

    if (activeHoveredNode !== null) {
      const toSuppress = [
        activeHoveredNode.cfg.id,
        chartHoveredFrontierId,
        hoveredPrunedId,
        focusedNode?.id,
      ].filter((id): id is string => Boolean(id));
      setDismissedIds(toSuppress.length > 0 ? [...new Set(toSuppress)] : ["__all__"]);
      escapeFreezePosRef.current = lastClientPosRef.current
        ? { ...lastClientPosRef.current }
        : null;
      lastClientPosRef.current = null;
      setChartHoveredFrontierId(null);
      setHoveredPrunedId(null);
      onHoverConfig(null);
      return;
    }

    if (hoverBudget !== null) {
      pinnedPenPosRef.current = null;
      if (focusInSpendBar && activeEl !== spendStepperRef.current) {
        spendStepperRef.current?.focus();
      }
      setHoverBudgetState(null);
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", onEscapeKeyDown);
    return () => window.removeEventListener("keydown", onEscapeKeyDown);
  }, []);

  const externalHighlightedProvider =
    hoveredConfigId !== null
      ? (frontierNodes.find((n) => n.cfg.id === hoveredConfigId)?.provider ?? null)
      : null;

  const effectiveFocusedProvider: ProviderId | null =
    frontiers.length > 1 ? (activeHoveredNode?.provider ?? externalHighlightedProvider) : null;

  const scrubX = !activeHoveredNode && hoverBudget !== null ? xScale(hoverBudget) : null;

  const effectiveBudget = hoverBudget !== null ? ceilSpendCapValue(hoverBudget) : null;

  const keyboardBudgetStops = [
    ...new Set(
      frontierNodes
        .map((n) => n.cfg.effectiveCostUsd)
        .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0)
        .map((v) => ceilSpendCapValue(v)),
    ),
  ].toSorted((a, b) => a - b);

  const budgetPicks =
    effectiveBudget !== null
      ? frontiers
          .map((pf) => ({
            provider: pf.provider,
            active: resolveBudgetPick(pf.frontier, configById, effectiveBudget),
          }))
          .filter(
            (entry): entry is { provider: ProviderId; active: EvaluatedConfig } =>
              entry.active !== null,
          )
          .toSorted((a, b) => b.active.score - a.active.score)
      : [];

  const svgElementToRawSvg = (
    svg: SVGSVGElement | null,
    clientX: number,
    clientY: number,
  ): { svgX: number; svgY: number } | null => {
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const scale = Math.min(rect.width / width, rect.height / CHART_HEIGHT);
    if (scale <= 0) return null;
    const offsetX = (rect.width - width * scale) / 2;
    const offsetY = (rect.height - CHART_HEIGHT * scale) / 2;
    return {
      svgX: (clientX - rect.left - offsetX) / scale,
      svgY: (clientY - rect.top - offsetY) / scale,
    };
  };

  const svgElementToPlot = (
    svg: SVGSVGElement | null,
    clientX: number,
    clientY: number,
  ): { relX: number; relY: number } | null => {
    const raw = svgElementToRawSvg(svg, clientX, clientY);
    if (!raw) return null;
    const relX = raw.svgX - MARGIN.left;
    const relY = raw.svgY - MARGIN.top;
    if (relX < -8 || relX > innerWidth + 8 || relY < -8 || relY > innerHeight + 8) return null;
    return {
      relX: Math.min(innerWidth, Math.max(0, relX)),
      relY: Math.min(innerHeight, Math.max(0, relY)),
    };
  };

  const pointerToPlot = (e: PointerEvent<SVGSVGElement>): { relX: number; relY: number } | null =>
    svgElementToPlot(e.currentTarget, e.clientX, e.clientY);

  const isFrozenAfterEscape = (clientX: number, clientY: number): boolean => {
    const freeze = escapeFreezePosRef.current;
    if (!freeze) return false;
    if (Math.hypot(clientX - freeze.x, clientY - freeze.y) <= 3) return true;
    escapeFreezePosRef.current = null;
    return false;
  };

  const preserveDismissedFocus = (activeId: string | null) => {
    setDismissedIds((prev) => {
      const keepFocusId =
        focusedNode && prev.includes(focusedNode.id) && focusedNode.id !== activeId
          ? focusedNode.id
          : null;
      if (keepFocusId === null) return prev.length === 0 ? prev : [];
      if (prev.length === 1 && prev[0] === keepFocusId) return prev;
      return [keepFocusId];
    });
  };

  const handlePointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || (e.target as Element | null)?.closest("a")) return;
    if (!pointerToPlot(e)) return;
    downRef.current = {
      pointerId: e.pointerId,
      clientX: e.clientX,
      clientY: e.clientY,
      moved: false,
    };
  };

  const handleMarkerPointerEnter = (e: PointerEvent<HTMLAnchorElement>) => {
    if (isFrozenAfterEscape(e.clientX, e.clientY)) return;
    lastClientPosRef.current = { x: e.clientX, y: e.clientY };
    const rawKind = e.currentTarget.dataset.markerKind;
    const rawId = e.currentTarget.dataset.markerId;
    if ((rawKind !== "frontier" && rawKind !== "pruned") || !rawId) return;
    const pt = svgElementToPlot(e.currentTarget.closest("svg"), e.clientX, e.clientY);
    const nearest = pt ? findNearestNode(pt.relX, pt.relY) : null;
    const kind = nearest ? nearest.kind : rawKind;
    const candidateId = nearest ? nearest.cfg.id : rawId;
    if (!dismissedIds.includes(candidateId)) {
      preserveDismissedFocus(candidateId);
    }
    if (kind === "frontier") {
      setHoveredPrunedId(null);
      setChartHoveredFrontierId(candidateId);
      onHoverConfig(candidateId);
    } else {
      setChartHoveredFrontierId(null);
      onHoverConfig(null);
      setHoveredPrunedId(candidateId);
    }
  };

  const handlePointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (downRef.current && downRef.current.pointerId === e.pointerId) {
      if (
        Math.hypot(e.clientX - downRef.current.clientX, e.clientY - downRef.current.clientY) >
        TAP_SLOP_PX
      ) {
        downRef.current.moved = true;
      }
    }

    if (e.pointerType === "pen" && hoverBudgetPinned && pinnedPenPosRef.current) {
      if (
        Math.hypot(e.clientX - pinnedPenPosRef.current.x, e.clientY - pinnedPenPosRef.current.y) <=
        TAP_SLOP_PX
      ) {
        return;
      }
      pinnedPenPosRef.current = null;
    }

    if (e.pointerType === "touch") return;
    if (isFrozenAfterEscape(e.clientX, e.clientY)) return;
    lastClientPosRef.current = { x: e.clientX, y: e.clientY };

    const rawSvg = svgElementToRawSvg(e.currentTarget, e.clientX, e.clientY);
    const pt = pointerToPlot(e);
    if (!pt) {
      const headingToSpendBar =
        rawSvg !== null &&
        rawSvg.svgY >= MARGIN.top + innerHeight &&
        rawSvg.svgX >= MARGIN.left - 8 &&
        rawSvg.svgX <= MARGIN.left + innerWidth + 8;
      if (!headingToSpendBar) {
        setHoverBudgetState((cur) => (cur?.pinned ? cur : null));
      }
      preserveDismissedFocus(null);
      setHoveredPrunedId(focusedNode?.kind === "pruned" ? focusedNode.id : null);
      setChartHoveredFrontierId(focusedNode?.kind === "frontier" ? focusedNode.id : null);
      onHoverConfig(focusedNode?.kind === "frontier" ? focusedNode.id : null);
      return;
    }

    const nearest = findNearestNode(pt.relX, pt.relY);
    if (nearest) {
      if (!dismissedIds.includes(nearest.cfg.id)) {
        preserveDismissedFocus(nearest.cfg.id);
      }
      setHoverBudgetState((cur) => (cur?.pinned ? cur : null));
      if (nearest.kind === "frontier") {
        setHoveredPrunedId(null);
        setChartHoveredFrontierId(nearest.cfg.id);
        if (hoveredConfigId !== nearest.cfg.id) onHoverConfig(nearest.cfg.id);
      } else {
        setChartHoveredFrontierId(null);
        onHoverConfig(null);
        setHoveredPrunedId(nearest.cfg.id);
      }
    } else {
      preserveDismissedFocus(null);
      setChartHoveredFrontierId(null);
      onHoverConfig(null);
      setHoveredPrunedId(null);
      const costVal = xScale.invert(pt.relX);
      setHoverBudgetState(
        Number.isFinite(costVal) && costVal > 0
          ? { sliceKey, value: costVal, pinned: false }
          : null,
      );
    }
  };

  const handlePointerUp = (e: PointerEvent<SVGSVGElement>) => {
    const down = downRef.current;
    downRef.current = null;
    if (!down || down.pointerId !== e.pointerId || down.moved) return;
    if ((e.target as Element | null)?.closest("a")) return;
    const pt = pointerToPlot(e);
    const nearest = pt ? findNearestNode(pt.relX, pt.relY) : null;
    if (nearest) {
      if (nearest.kind === "pruned") activatePrunedNode(nearest.cfg.id, nearest.domCfg.id);
      else onSelectConfig(nearest.cfg.id);
      return;
    }
    preserveDismissedFocus(null);
    setChartHoveredFrontierId(null);
    onHoverConfig(null);
    setHoveredPrunedId(null);
    if ((e.pointerType === "touch" || e.pointerType === "pen") && pt) {
      const costVal = xScale.invert(pt.relX);
      if (Number.isFinite(costVal) && costVal > 0) {
        pinnedPenPosRef.current = e.pointerType === "pen" ? { x: e.clientX, y: e.clientY } : null;
        setHoverBudgetState({ sliceKey, value: costVal, pinned: true });
      }
    }
  };

  const handleSpendKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (keyboardBudgetStops.length === 0) return;
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") {
      return;
    }
    e.preventDefault();
    pinnedPenPosRef.current = null;
    setChartHoveredFrontierId(null);
    setHoveredPrunedId(null);
    onHoverConfig(null);

    let nextIdx = 0;
    if (e.key === "Home") {
      nextIdx = 0;
    } else if (e.key === "End") {
      nextIdx = keyboardBudgetStops.length - 1;
    } else if (effectiveBudget === null) {
      nextIdx = e.key === "ArrowRight" ? 0 : keyboardBudgetStops.length - 1;
    } else if (e.key === "ArrowRight") {
      const higherIdx = keyboardBudgetStops.findIndex((c) => c > effectiveBudget * (1 + 1e-9));
      nextIdx = higherIdx === -1 ? keyboardBudgetStops.length - 1 : higherIdx;
    } else {
      let lowerIdx = 0;
      for (let i = keyboardBudgetStops.length - 1; i >= 0; i--) {
        if (keyboardBudgetStops[i]! < effectiveBudget * (1 - 1e-9)) {
          lowerIdx = i;
          break;
        }
      }
      nextIdx = lowerIdx;
    }
    const val = keyboardBudgetStops[nextIdx];
    if (val !== undefined) {
      setHoverBudgetState({ sliceKey, value: val, pinned: true });
    }
  };

  const activatePrunedNode = (prunedId: string, fallbackDominatorId: string) => {
    if (onSelectPrunedConfig) onSelectPrunedConfig(prunedId);
    else onSelectConfig(fallbackDominatorId);
  };

  // Compact pointer-events-none pill placed cleanly above/below the dot so moving to neighboring points is unobstructed
  const compactPillStyle = (() => {
    if (!activeHoveredNode) return null;
    const px = MARGIN.left + activeHoveredNode.cx;
    const py = MARGIN.top + activeHoveredNode.cy;
    const placeBelow = py < 74;
    const pillWidth = Math.min(292, width - 12);
    const half = pillWidth / 2 + 6;
    const clampedX = Math.max(half, Math.min(width - half, px));
    return {
      width: pillWidth,
      left: `${clampedX}px`,
      top: `${placeBelow ? py + 14 : py - 14}px`,
      transform: placeBelow ? "translate(-50%, 0)" : "translate(-50%, -100%)",
    };
  })();

  const activeHoveredHarness =
    isHarnessDomain && activeHoveredNode ? resolveHarnessName(activeHoveredNode.cfg) : null;

  const activeHoveredEffort = activeHoveredNode ? formatEffort(activeHoveredNode.cfg.effort) : null;

  if (!hasVisibleConfigs) {
    return (
      <section
        aria-label="Pareto frontier chart"
        className="border-t border-(--border) px-5 py-12 text-center sm:px-9"
      >
        <p className="text-[13px] text-(--ink-muted)">
          No priced frontier models match the selected providers and filters.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Pareto frontier chart" className="border-t border-(--border) bg-(--bg)">
      <figure
        ref={containerRef}
        aria-label={`${meta.label} score versus cost Pareto frontier`}
        className="relative w-full border-b border-(--border) bg-(--bg)"
        onPointerLeave={() => {
          downRef.current = null;
          lastClientPosRef.current = null;
          escapeFreezePosRef.current = null;
          setHoverBudgetState((cur) => (cur?.pinned ? cur : null));
          setDismissedIds((prev) =>
            focusedNode && prev.includes(focusedNode.id) ? [focusedNode.id] : [],
          );
          setHoveredPrunedId(focusedNode?.kind === "pruned" ? focusedNode.id : null);
          setChartHoveredFrontierId(focusedNode?.kind === "frontier" ? focusedNode.id : null);
          onHoverConfig(focusedNode?.kind === "frontier" ? focusedNode.id : null);
        }}
      >
        <div className="relative h-105 w-full">
          <svg
            viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
            height={CHART_HEIGHT}
            preserveAspectRatio="xMidYMid meet"
            className="block h-105 w-full touch-pan-y select-none"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => {
              downRef.current = null;
            }}
          >
            <title>{`${meta.label} score versus cost Pareto frontier`}</title>
            <defs>
              <clipPath id={clipId}>
                <motion.rect
                  key={revealKey}
                  x={-12}
                  y={-12}
                  width={innerWidth + 24}
                  height={innerHeight + 24}
                  style={{ transformOrigin: "0px 0px" }}
                  initial={
                    revealKey === initialRevealKey || prefersReducedMotion ? false : { scaleX: 0 }
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
                Score
              </text>

              {effectiveFocusedProvider ? (
                <text
                  x={innerWidth}
                  y={-14}
                  textAnchor="end"
                  fill={PROVIDER_BY_ID[effectiveFocusedProvider].cssVar}
                  className="font-sans text-[11.5px] font-medium"
                >
                  {PROVIDER_BY_ID[effectiveFocusedProvider].shortName}
                </text>
              ) : (
                <text
                  x={innerWidth}
                  y={-14}
                  textAnchor="end"
                  fill="var(--ink-faint)"
                  className="font-mono text-[10.5px]"
                >
                  Cost / task (log)
                </text>
              )}

              {yTicks.map((tick) => {
                const y = yScale(tick);
                return (
                  <g key={`y-${tick}`}>
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
                      {tick}
                    </text>
                  </g>
                );
              })}

              {xTicks.map((tick) => (
                <g key={`x-${tick.value}`} transform={`translate(${tick.x},0)`}>
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

              {scrubX !== null ? (
                <line
                  x1={scrubX}
                  x2={scrubX}
                  y1={0}
                  y2={innerHeight}
                  stroke="var(--ink-faint)"
                  strokeWidth={1}
                  strokeOpacity={0.45}
                  pointerEvents="none"
                />
              ) : null}

              {showPruned
                ? prunedNodes.map((n) => {
                    const pMeta = PROVIDER_BY_ID[n.provider];
                    const isHovered = hoveredPrunedId === n.cfg.id;
                    const dimmed =
                      effectiveFocusedProvider !== null && effectiveFocusedProvider !== n.provider;
                    const prunedHarness = isHarnessDomain ? resolveHarnessName(n.cfg) : null;
                    const prunedName =
                      isHarnessDomain && prunedHarness
                        ? `${prunedHarness} + ${n.cfg.displayName}`
                        : n.cfg.displayName;
                    const label = `${prunedName} ${formatEffort(n.cfg.effort)}, pruned, score ${formatScore(n.cfg.score)}, cost ${formatCost(n.cfg.effectiveCostUsd, domain.costUnit)}, ${formatScoreEvidence(modelScoreEvidence(n.cfg))}`;

                    return (
                      <g key={`pruned-${n.cfg.id}`} opacity={dimmed ? 0.14 : 0.72}>
                        {isHovered ? (
                          <line
                            x1={n.cx}
                            y1={n.cy}
                            x2={n.dx}
                            y2={n.dy}
                            stroke={pMeta.cssVar}
                            strokeWidth={1}
                            strokeOpacity={0.5}
                            pointerEvents="none"
                          />
                        ) : null}
                        <a
                          href={`#pruned-${encodeURIComponent(n.cfg.id)}`}
                          aria-label={label}
                          data-marker-kind="pruned"
                          data-marker-id={n.cfg.id}
                          className="cursor-pointer"
                          onPointerEnter={handleMarkerPointerEnter}
                          onFocus={() => {
                            setDismissedIds([]);
                            setFocusedNode({ kind: "pruned", id: n.cfg.id });
                            setChartHoveredFrontierId(null);
                            onHoverConfig(null);
                            setHoveredPrunedId(n.cfg.id);
                          }}
                          onBlur={() => {
                            setDismissedIds((prev) => prev.filter((id) => id !== n.cfg.id));
                            setFocusedNode((cur) => (cur?.id === n.cfg.id ? null : cur));
                            setHoveredPrunedId((cur) => (cur === n.cfg.id ? null : cur));
                          }}
                          onClick={(e) => {
                            if (
                              e.metaKey ||
                              e.ctrlKey ||
                              e.shiftKey ||
                              e.altKey ||
                              e.button !== 0
                            ) {
                              return;
                            }
                            e.preventDefault();
                            const clickPt =
                              e.detail > 0
                                ? svgElementToPlot(
                                    e.currentTarget.closest("svg"),
                                    e.clientX,
                                    e.clientY,
                                  )
                                : null;
                            const nearest = clickPt
                              ? findNearestNode(clickPt.relX, clickPt.relY)
                              : null;
                            if (nearest?.kind === "frontier") {
                              onSelectConfig(nearest.cfg.id);
                            } else if (nearest?.kind === "pruned") {
                              activatePrunedNode(nearest.cfg.id, nearest.domCfg.id);
                            } else {
                              activatePrunedNode(n.cfg.id, n.domCfg.id);
                            }
                          }}
                          onKeyDown={(e) =>
                            handleNodeKeyDown(e, () => activatePrunedNode(n.cfg.id, n.domCfg.id))
                          }
                        >
                          <circle
                            cx={n.cx}
                            cy={n.cy}
                            r={10}
                            fill="transparent"
                            data-hit-target="true"
                          />
                          <rect
                            x={n.cx - 3}
                            y={n.cy - 3}
                            width={6}
                            height={6}
                            transform={`rotate(45 ${n.cx} ${n.cy})`}
                            fill="var(--bg)"
                            stroke={pMeta.cssVar}
                            strokeWidth={1.35}
                          />
                        </a>
                      </g>
                    );
                  })
                : null}

              {/* Clean direct solid Pareto frontier lines with symmetric enter/exit */}
              <g clipPath={`url(#${clipId})`}>
                <AnimatePresence initial={false}>
                  {frontiers.map((pf) => {
                    const pMeta = PROVIDER_BY_ID[pf.provider];
                    const nodes = nodesByProvider.get(pf.provider) ?? [];
                    if (nodes.length === 0) return null;

                    const isFocused = effectiveFocusedProvider === pf.provider;
                    const dimmed = effectiveFocusedProvider !== null && !isFocused;
                    const strokeWidth = isFocused ? 2.5 : frontiers.length === 1 ? 2.2 : 1.85;

                    const linePath =
                      nodes.length >= 2
                        ? `M ${nodes[0]!.cx} ${nodes[0]!.cy} ${nodes
                            .slice(1)
                            .map((n) => `L ${n.cx} ${n.cy}`)
                            .join(" ")}`
                        : null;

                    return (
                      <motion.g
                        key={`curve-${pf.provider}-${pf.harnessFilter}`}
                        initial={prefersReducedMotion ? false : { opacity: 0 }}
                        animate={{ opacity: dimmed ? 0.14 : 1 }}
                        {...(prefersReducedMotion ? {} : { exit: { opacity: 0 } })}
                        transition={
                          prefersReducedMotion
                            ? { duration: 0 }
                            : { duration: 0.24, ease: "easeInOut" }
                        }
                      >
                        {linePath ? (
                          <motion.path
                            d={linePath}
                            fill="none"
                            stroke={pMeta.cssVar}
                            strokeWidth={strokeWidth}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            initial={prefersReducedMotion ? false : { pathLength: 0 }}
                            animate={{ pathLength: 1 }}
                            {...(prefersReducedMotion ? {} : { exit: { pathLength: 0 } })}
                            transition={
                              prefersReducedMotion ? { duration: 0 } : { duration: 0.3, ease: EASE }
                            }
                          />
                        ) : null}
                      </motion.g>
                    );
                  })}
                </AnimatePresence>
              </g>

              <AnimatePresence initial={false}>
                {frontiers.map((pf) => {
                  const pMeta = PROVIDER_BY_ID[pf.provider];
                  const nodes = nodesByProvider.get(pf.provider) ?? [];
                  const isFocused = effectiveFocusedProvider === pf.provider;
                  const dimmed = effectiveFocusedProvider !== null && !isFocused;

                  return (
                    <motion.g
                      key={`nodes-${pf.provider}-${pf.harnessFilter}`}
                      initial={prefersReducedMotion ? false : { opacity: 0 }}
                      animate={{ opacity: dimmed ? 0.16 : 1 }}
                      {...(prefersReducedMotion ? {} : { exit: { opacity: 0 } })}
                      transition={
                        prefersReducedMotion
                          ? { duration: 0 }
                          : { duration: 0.26, ease: "easeInOut" }
                      }
                    >
                      {nodes.map((node) => {
                        const { cfg, cx, cy } = node;
                        const r = 4.25;
                        const shapePath = markerPathAt(pMeta.marker, cx, cy, r);
                        const nodeHarness = isHarnessDomain ? resolveHarnessName(cfg) : null;
                        const nodeName =
                          isHarnessDomain && nodeHarness
                            ? `${nodeHarness} + ${cfg.displayName} (${pMeta.shortName})`
                            : `${pMeta.shortName} ${cfg.displayName}`;
                        const nodeLabel = `${nodeName} ${formatEffort(cfg.effort)}, score ${formatScore(cfg.score)}, cost ${formatCost(cfg.effectiveCostUsd, domain.costUnit)}, ${formatScoreEvidence(modelScoreEvidence(cfg))}`;

                        return (
                          <g key={`node-${cfg.id}`}>
                            <a
                              href={`#config-${encodeURIComponent(cfg.id)}`}
                              aria-label={nodeLabel}
                              data-marker-kind="frontier"
                              data-marker-id={cfg.id}
                              className="cursor-pointer"
                              onPointerEnter={handleMarkerPointerEnter}
                              onFocus={() => {
                                setDismissedIds([]);
                                setFocusedNode({ kind: "frontier", id: cfg.id });
                                setHoveredPrunedId(null);
                                setChartHoveredFrontierId(cfg.id);
                                onHoverConfig(cfg.id);
                              }}
                              onBlur={() => {
                                setDismissedIds((prev) => prev.filter((id) => id !== cfg.id));
                                setFocusedNode((cur) => (cur?.id === cfg.id ? null : cur));
                                setChartHoveredFrontierId((cur) => (cur === cfg.id ? null : cur));
                                onHoverConfig(null);
                              }}
                              onClick={(e) => {
                                if (
                                  e.metaKey ||
                                  e.ctrlKey ||
                                  e.shiftKey ||
                                  e.altKey ||
                                  e.button !== 0
                                ) {
                                  return;
                                }
                                e.preventDefault();
                                const clickPt =
                                  e.detail > 0
                                    ? svgElementToPlot(
                                        e.currentTarget.closest("svg"),
                                        e.clientX,
                                        e.clientY,
                                      )
                                    : null;
                                const nearest = clickPt
                                  ? findNearestNode(clickPt.relX, clickPt.relY)
                                  : null;
                                if (nearest?.kind === "pruned") {
                                  activatePrunedNode(nearest.cfg.id, nearest.domCfg.id);
                                } else {
                                  onSelectConfig(nearest ? nearest.cfg.id : cfg.id);
                                }
                              }}
                              onKeyDown={(e) => handleNodeKeyDown(e, () => onSelectConfig(cfg.id))}
                            >
                              <circle
                                cx={cx}
                                cy={cy}
                                r={10}
                                fill="transparent"
                                data-hit-target="true"
                              />
                              {pMeta.marker === "circle" ? (
                                <circle
                                  cx={cx}
                                  cy={cy}
                                  r={r}
                                  fill={pMeta.cssVar}
                                  stroke="var(--bg)"
                                  strokeWidth={1.75}
                                />
                              ) : (
                                <path
                                  d={shapePath}
                                  fill={pMeta.cssVar}
                                  stroke="var(--bg)"
                                  strokeWidth={1.45}
                                  strokeLinejoin="round"
                                />
                              )}
                            </a>
                          </g>
                        );
                      })}
                    </motion.g>
                  );
                })}
              </AnimatePresence>
            </g>
          </svg>

          {/* Compact model + harness (when explicit) + effort pill */}
          <AnimatePresence>
            {compactPillStyle && activeHoveredNode ? (
              <div
                key={activeHoveredNode.cfg.id}
                style={compactPillStyle}
                className="pointer-events-none absolute z-20"
              >
                <motion.div
                  data-pareto-tooltip="true"
                  initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  {...(prefersReducedMotion ? {} : { exit: { opacity: 0, scale: 0.97 } })}
                  transition={{ duration: 0.11, ease: EASE }}
                  className="flex max-w-[min(22rem,80vw)] flex-col gap-0.5 rounded-md border border-(--border-strong) bg-(--surface)/95 px-2.5 py-1 text-[12px] shadow-(--shadow-button) backdrop-blur-sm"
                >
                  <div className="flex items-center gap-1.5">
                    <ProviderMarkerIcon provider={activeHoveredNode.provider} size={9} />
                    {isHarnessDomain && activeHoveredHarness ? (
                      <>
                        <span className="shrink-0 font-medium text-(--ink)">
                          {activeHoveredHarness}
                        </span>
                        <span aria-hidden="true" className="text-(--ink-faint)">
                          +
                        </span>
                        <span className="truncate text-(--ink-secondary)">
                          {activeHoveredNode.cfg.displayName}
                        </span>
                      </>
                    ) : (
                      <span className="truncate font-medium text-(--ink)">
                        {activeHoveredNode.cfg.displayName}
                      </span>
                    )}
                    {activeHoveredEffort ? (
                      <>
                        <span aria-hidden="true" className="text-(--ink-faint)">
                          ·
                        </span>
                        <span className="shrink-0 font-mono text-[10.5px] text-(--ink-faint)">
                          {activeHoveredEffort}
                        </span>
                      </>
                    ) : null}
                  </div>
                  <span className="text-[10px] text-(--ink-muted)">
                    Score {formatScore(activeHoveredNode.cfg.score)} ·{" "}
                    {formatScoreEvidence(modelScoreEvidence(activeHoveredNode.cfg))}
                  </span>
                </motion.div>
              </div>
            ) : null}
          </AnimatePresence>
        </div>

        {/* Fixed-height zero-scrollbar spend-cap readout strip below the chart */}
        <div
          data-budget-readout="true"
          className="flex h-10 items-center gap-x-2.5 overflow-hidden whitespace-nowrap border-t border-(--border) bg-(--subtle)/50 px-5 font-mono text-[11px] tabular sm:px-9 lg:px-11"
        >
          <span id={spendHelpId} className="sr-only">
            Use Left, Right, Home, and End keys to compare qualifying models across spend caps, or
            Escape to clear.
          </span>
          <output aria-live="polite" aria-atomic="true" className="sr-only">
            {!hoverBudgetPinned || effectiveBudget === null
              ? ""
              : budgetPicks.length === 0
                ? `Spend cap ${formatSpendCap(effectiveBudget, domain.costUnit)}: no frontier model fits below this cap.`
                : `Spend cap ${formatSpendCap(effectiveBudget, domain.costUnit)}: ${budgetPicks.length} qualifying ${budgetPicks.length === 1 ? "provider" : "providers"}, ${budgetPicks
                    .map((p) => {
                      const hTag = isHarnessDomain ? resolveHarnessName(p.active) : null;
                      const pickName =
                        isHarnessDomain && hTag
                          ? `${hTag} + ${p.active.displayName} (${PROVIDER_BY_ID[p.provider].shortName})`
                          : `${PROVIDER_BY_ID[p.provider].shortName} ${p.active.displayName}`;
                      return `${pickName} ${formatEffort(p.active.effort)} ${formatScore(p.active.score)}, ${formatScoreEvidence(modelScoreEvidence(p.active))}`;
                    })
                    .join(", ")}.`}
          </output>
          <button
            ref={spendStepperRef}
            type="button"
            data-spend-stepper="true"
            aria-describedby={spendHelpId}
            onKeyDown={handleSpendKeyDown}
            className="shrink-0 cursor-default rounded px-0 py-0.5 text-left text-(--ink-faint) outline-none focus-visible:ring-1 focus-visible:ring-(--border-strong)"
          >
            {effectiveBudget !== null
              ? `Best <= ${formatSpendCap(effectiveBudget, domain.costUnit)}:`
              : "Move across chart to inspect spend caps"}
          </button>
          {effectiveBudget !== null ? (
            <>
              {budgetPicks.length === 0 ? (
                <span className="shrink-0 text-(--ink-muted)">
                  No frontier model fits below this cap.
                </span>
              ) : (
                <>
                  {budgetPicks.slice(0, 3).map(({ provider, active: cfg }, idx) => {
                    const harnessTag = isHarnessDomain ? resolveHarnessName(cfg) : null;
                    const visClass =
                      idx === 0
                        ? "inline-flex"
                        : idx === 1
                          ? "hidden sm:inline-flex"
                          : "hidden lg:inline-flex";
                    return (
                      <button
                        key={provider}
                        type="button"
                        data-budget-pick="true"
                        title={formatScoreEvidence(modelScoreEvidence(cfg))}
                        aria-label={`${cfg.displayName} ${formatEffort(cfg.effort)}, score ${formatScore(cfg.score)}, ${formatScoreEvidence(modelScoreEvidence(cfg))}`}
                        onClick={() => onSelectConfig(cfg.id)}
                        className={`${visClass} min-w-0 shrink cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 text-(--ink) transition-colors hover:bg-(--surface-hover)`}
                      >
                        <ProviderMarkerIcon provider={provider} size={9} />
                        {isHarnessDomain && harnessTag ? (
                          <>
                            <span className="shrink-0 font-sans font-medium">{harnessTag}</span>
                            <span className="truncate font-sans text-(--ink-secondary)">
                              + {cfg.displayName}
                            </span>
                          </>
                        ) : (
                          <span className="truncate font-sans font-medium">{cfg.displayName}</span>
                        )}
                        <span className="shrink-0 text-(--ink-faint)">
                          {formatEffort(cfg.effort)}
                        </span>
                      </button>
                    );
                  })}
                  {budgetPicks.length > 1 ? (
                    <span className="shrink-0 text-[10.5px] text-(--ink-faint) sm:hidden">
                      +{budgetPicks.length - 1}
                    </span>
                  ) : null}
                  {budgetPicks.length > 2 ? (
                    <span className="hidden shrink-0 text-[10.5px] text-(--ink-faint) sm:inline lg:hidden">
                      +{budgetPicks.length - 2}
                    </span>
                  ) : null}
                  {budgetPicks.length > 3 ? (
                    <span className="hidden shrink-0 text-[10.5px] text-(--ink-faint) lg:inline">
                      +{budgetPicks.length - 3} more
                    </span>
                  ) : null}
                </>
              )}
              {hoverBudgetPinned ? (
                <button
                  type="button"
                  onClick={() => {
                    pinnedPenPosRef.current = null;
                    spendStepperRef.current?.focus();
                    setHoverBudgetState(null);
                  }}
                  className="ml-auto shrink-0 cursor-pointer rounded border border-(--border) px-1.5 py-0.5 text-[10.5px] text-(--ink-muted) hover:bg-(--surface-hover) hover:text-(--ink)"
                >
                  Clear
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </figure>
    </section>
  );
}
