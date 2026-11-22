import { DOMAINS } from "../config/benchmarks.ts";
import { PROVIDER_BY_ID, WESTERN_PROVIDER_IDS } from "../config/providers.ts";
import { formatCost, formatEffort, formatScore } from "./format.ts";
import { buildWeightMapFromAnchors } from "./math/aggregate.ts";
import { normalizeHarnessVersion, selectControlledHarnessPicks } from "./math/harness-pareto.ts";
import { computeProviderFrontier, extractVerdictPicks } from "./math/pareto.ts";
import type {
  CostUnit,
  DomainId,
  DomainSnapshot,
  EvaluatedConfig,
  HarnessLeaderboardSnapshot,
  ProviderId,
} from "./schema.ts";

export interface HomeSparkPoint {
  x: number;
  y: number;
}

export interface HomeDomainPick {
  id: string;
  name: string;
  effort: string | null;
  provider: ProviderId | null;
  vendorLabel: string;
  metricText: string;
  costText: string;
}

export interface HomeDomainSummary {
  domainId: DomainId;
  label: string;
  tagline: string;
  evaluatedCount: number;
  frontierCount: number;
  costUnit: CostUnit;
  topPick: HomeDomainPick | null;
  secondaryTag: "Best value" | "Budget";
  secondaryPick: HomeDomainPick | null;
  sparkline: readonly HomeSparkPoint[];
}

function formatHomePickFromConfig(cfg: EvaluatedConfig, costUnit: CostUnit): HomeDomainPick {
  return {
    id: cfg.id,
    name: cfg.displayName,
    effort: formatEffort(cfg.effort),
    provider: cfg.provider,
    vendorLabel: PROVIDER_BY_ID[cfg.provider].shortName,
    metricText: formatScore(cfg.score),
    costText: formatCost(cfg.effectiveCostUsd, costUnit),
  };
}

function normalizeSparkline(pts: readonly { cost: number; score: number }[]): HomeSparkPoint[] {
  if (pts.length < 2) return [];
  const logCosts = pts.map((p) => Math.log10(Math.max(1e-6, p.cost)));
  const scores = pts.map((p) => p.score);
  const minX = Math.min(...logCosts);
  const maxX = Math.max(...logCosts);
  const minY = Math.min(...scores);
  const maxY = Math.max(...scores);
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  return pts.map((p, idx) => ({
    x: Number(((logCosts[idx]! - minX) / spanX).toFixed(4)),
    y: Number(((p.score - minY) / spanY).toFixed(4)),
  }));
}

export function buildHomeSummaries(
  domains: Record<DomainId, DomainSnapshot>,
  harnessLeaderboard: HarnessLeaderboardSnapshot,
): HomeDomainSummary[] {
  const defaultLabs = new Set<string>(WESTERN_PROVIDER_IDS);
  const pooledSlice =
    harnessLeaderboard.slices.find((s) => s.sliceId === "_all") ?? harnessLeaderboard.slices[0];
  const harnessCount = pooledSlice?.entries.length ?? 0;

  const taglines: Record<DomainId, string> = {
    coding: "Private repo engineering, systems ops, code migration, and live agentic coding.",
    writing: "Live blind-arena creative writing and private held-out long-form script writing.",
    design_code: "Live web, SVG, 3D, UI, dataviz, mobile app, and slide arenas.",
    research:
      "FrontierMath, ARC-AGI-3, long-context, science, finance, legal, and enterprise research.",
    cyber: "Held-out CVE patching, private detection, and live attack-defense CTF.",
    harnesses: "Coding agents compared on fixed test models and private stacks.",
  };

  return DOMAINS.map((meta) => {
    if (meta.id === "harnesses") {
      const sliceEntries = pooledSlice?.entries ?? [];
      const frontier = sliceEntries
        .filter((e) => e.onFrontier)
        .toSorted((a, b) => a.costPerTrialUsd - b.costPerTrialUsd);
      const harnessPicks = selectControlledHarnessPicks(sliceEntries);
      const top =
        harnessPicks.find((p) => p.tag === "Top score" || p.tag === "Top pick")?.entry ?? null;
      const valuePickEntry = harnessPicks.find((p) => p.tag === "Best value")?.entry ?? null;
      const budgetPickEntry = harnessPicks.find((p) => p.tag === "Budget")?.entry ?? null;
      const value = valuePickEntry ?? budgetPickEntry;
      const secondaryTag: "Best value" | "Budget" = valuePickEntry ? "Best value" : "Budget";

      const toHarnessPick = (h: NonNullable<typeof top>): HomeDomainPick => {
        const v = normalizeHarnessVersion(h.version);
        const formattedV = v
          ? v
              .split(" / ")
              .map((part) => `v${part.replace(/^v/i, "")}`)
              .join(" / ")
          : null;
        return {
          id: h.harnessId,
          name: h.name,
          effort: formattedV,
          provider: null,
          vendorLabel: h.vendor,
          metricText: `${h.passRate.toFixed(1)}%`,
          costText: formatCost(h.costPerTrialUsd, "usd_per_task"),
        };
      };

      return {
        domainId: meta.id,
        label: meta.label,
        tagline: taglines[meta.id],
        evaluatedCount: harnessCount,
        frontierCount: frontier.length,
        costUnit: meta.costUnit,
        topPick: top ? toHarnessPick(top) : null,
        secondaryTag,
        secondaryPick: value && value.harnessId !== top?.harnessId ? toHarnessPick(value) : null,
        sparkline: normalizeSparkline(
          frontier.map((e) => ({ cost: e.costPerTrialUsd, score: e.passRate })),
        ),
      };
    }

    const dom = domains[meta.id];
    const eligible = dom.configs.filter(
      (c) =>
        defaultLabs.has(c.provider) &&
        c.harnessRegime === meta.defaultRegime &&
        c.eligibleForFrontier &&
        c.effectiveCostUsd !== null,
    );
    const byId = new Map(eligible.map((c) => [c.id, c]));
    const weights = buildWeightMapFromAnchors(dom.anchorStats, meta.defaultRegime);
    const linkJointCov = dom.regimeMeta[meta.defaultRegime]?.linkJointCov;
    const env = computeProviderFrontier(
      eligible,
      undefined,
      undefined,
      weights,
      dom.anchorStats,
      linkJointCov,
    ).frontier;
    const envConfigs = env
      .map((pt) => byId.get(pt.configId))
      .filter((c): c is NonNullable<typeof c> => c !== undefined && c.effectiveCostUsd !== null);

    // Reuse exact VerdictPlacards statistical gate so Home and domain pages never disagree
    const verdicts = extractVerdictPicks(env, byId, {
      preferDistinctModelSlug: true,
      weightByBenchmark: weights,
      anchorStats: dom.anchorStats,
      linkJointCov,
    });
    const topCfg = verdicts.maxId ? (byId.get(verdicts.maxId) ?? null) : null;
    const valueCfg = verdicts.defaultId ? (byId.get(verdicts.defaultId) ?? null) : null;
    const budgetCfg = verdicts.budgetId ? (byId.get(verdicts.budgetId) ?? null) : null;

    const secondaryCfg =
      valueCfg && valueCfg.id !== topCfg?.id
        ? valueCfg
        : budgetCfg && budgetCfg.id !== topCfg?.id
          ? budgetCfg
          : null;
    const secondaryTag: "Best value" | "Budget" =
      valueCfg && secondaryCfg?.id === valueCfg.id ? "Best value" : "Budget";

    return {
      domainId: meta.id,
      label: meta.label,
      tagline: taglines[meta.id],
      evaluatedCount: eligible.length,
      frontierCount: envConfigs.length,
      costUnit: dom.costUnit,
      topPick: topCfg ? formatHomePickFromConfig(topCfg, dom.costUnit) : null,
      secondaryTag,
      secondaryPick: secondaryCfg ? formatHomePickFromConfig(secondaryCfg, dom.costUnit) : null,
      sparkline: normalizeSparkline(
        envConfigs.map((c) => ({ cost: c.effectiveCostUsd!, score: c.score })),
      ),
    };
  });
}
