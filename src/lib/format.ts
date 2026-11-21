import type { CostUnit, EvaluatedConfig, ReasoningEffort } from "./schema.ts";

export function formatCost(value: number | null, _unit?: CostUnit): string {
  if (value === null || !Number.isFinite(value)) return "Unpriced";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 0.1) return `$${value.toFixed(3)}`;
  if (value < 10) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(1)}`;
}

// Always round up so a displayed spend cap never falls below a qualifying model's actual cost
export function ceilSpendCapValue(value: number): number {
  if (value < 0.01) {
    return Number((Math.ceil(value * 10_000 - 1e-9) / 10_000).toFixed(4));
  }
  if (value < 1) {
    return Number((Math.ceil(value * 1_000 - 1e-9) / 1_000).toFixed(3));
  }
  if (value < 10) {
    return Number((Math.ceil(value * 100 - 1e-9) / 100).toFixed(2));
  }
  return Number((Math.ceil(value * 10 - 1e-9) / 10).toFixed(1));
}

export function formatSpendCap(value: number | null, _unit?: CostUnit): string {
  if (value === null || !Number.isFinite(value)) return "Unpriced";
  const rounded = ceilSpendCapValue(value);
  if (value < 0.01) return `$${rounded.toFixed(4)}`;
  if (value < 1) return `$${rounded.toFixed(3)}`;
  if (value < 10) return `$${rounded.toFixed(2)}`;
  return `$${rounded.toFixed(1)}`;
}

export function formatAxisCost(value: number, _unit?: CostUnit): string {
  if (value < 1) return `$${Number(value.toPrecision(2))}`;
  if (value < 10) return `$${Number.isInteger(value) ? value : value.toFixed(1)}`;
  return `$${Math.round(value)}`;
}

export function formatScore(score: number): string {
  return score.toFixed(1);
}

function modelInterval95(config: Pick<EvaluatedConfig, "score" | "se">) {
  const margin = 1.96 * config.se;
  return { lower: config.score - margin, upper: config.score + margin };
}

export function formatScoreInterval(config: Pick<EvaluatedConfig, "score" | "se">): string {
  const { lower, upper } = modelInterval95(config);
  return `${formatScore(lower)} to ${formatScore(upper)}`;
}

export function modelScoreEvidence(config: EvaluatedConfig) {
  return {
    observedBenchmarks: config.coverageCount,
    activeBenchmarks: config.activeBenchmarkCount,
    sourceCount: new Set(config.benchmarks.map((b) => b.sourceId)).size,
    interval95: modelInterval95(config),
  };
}

export type ModelScoreEvidence = ReturnType<typeof modelScoreEvidence>;

export function formatScoreEvidence(e: ModelScoreEvidence): string {
  return `${e.observedBenchmarks}/${e.activeBenchmarks} benchmarks · ${e.sourceCount} ${e.sourceCount === 1 ? "feed" : "feeds"} · 95% interval ${formatScore(e.interval95.lower)} to ${formatScore(e.interval95.upper)}`;
}

export function formatSharedOrder(order: number | null, other: string): string {
  if (order === null)
    return `Comparison with ${other} relies on linked scores. They share no benchmark.`;
  if (Math.abs(order) < 1e-9) return `Tied with ${other} on shared benchmarks.`;
  return order < 0 ? `The order reverses against ${other} on shared benchmarks.` : "";
}

export function formatEffort(effort: ReasoningEffort): string {
  switch (effort) {
    case "none":
      return "No think";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "thinking":
      return "Thinking";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Max";
  }
}

export function formatRawMetric(raw: number, scale: string): string {
  if (scale === "percent") return `${raw.toFixed(1)}%`;
  if (scale === "elo") return `${Math.round(raw)} Elo`;
  return raw.toFixed(2);
}

// Exact chronological instant comparator down to nanosecond fractional digits
export function compareIsoInstants(a: string, b: string): number | null {
  const msA = Date.parse(a);
  const msB = Date.parse(b);
  if (!Number.isFinite(msA) || !Number.isFinite(msB)) return null;
  if (msA !== msB) return msA < msB ? -1 : 1;
  const fracA = (a.match(/\.(\d+)/)?.[1] ?? "").padEnd(9, "0").slice(0, 9);
  const fracB = (b.match(/\.(\d+)/)?.[1] ?? "").padEnd(9, "0").slice(0, 9);
  if (fracA === fracB) return 0;
  return fracA < fracB ? -1 : 1;
}

function fmtPriceUnit(v: number): string {
  return v >= 10 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
}

export function formatPricePer1m(input: number | null, output: number | null): string {
  if (input === null || output === null) return "N/A";
  return `${fmtPriceUnit(input)} / ${fmtPriceUnit(output)}`;
}
