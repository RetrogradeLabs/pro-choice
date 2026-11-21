import type { HarnessEntry, HarnessLeaderboardSnapshot, HarnessModelSlice } from "./schema.ts";

export function controlledBoardName(slice: HarnessModelSlice) {
  return slice.instrumentId === "deep-swe" ? "DeepSWE 1.1" : "Terminal-Bench 4.0";
}

export function controlledBoard(leaderboard: HarnessLeaderboardSnapshot, sliceId = "_all") {
  const selected = leaderboard.slices.find((s) => s.sliceId === sliceId) ?? leaderboard.slices[0]!;
  const pooled = leaderboard.slices.filter((s) => s.controlModelId === null);
  const controls = leaderboard.slices.filter((s) => s.instrumentId === selected.instrumentId);
  const metric = selected.entries[0]!.benchmarks[0]!;
  return {
    selected,
    pooled,
    controls,
    metric,
    name: controlledBoardName(selected),
    scope: `${controlledBoardName(selected)} · ${selected.label}`,
    sourceId: selected.instrumentId === "deep-swe" ? "harness-leaderboard" : "frontier-harness",
  };
}

export function harnessInterval(entry: HarnessEntry): string {
  if (entry.ciLower === null || entry.ciUpper === null) return "95% interval unavailable";
  const kind = entry.benchmarks[0]?.ciIsUpperBound ? "95% interval upper bound" : "95% interval";
  return `${kind} ${entry.ciLower.toFixed(1)} to ${entry.ciUpper.toFixed(1)}%`;
}
