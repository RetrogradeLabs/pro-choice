import { compareIsoInstants } from "../format.ts";
import type { HarnessEntry, HarnessLeaderboardSnapshot, HarnessModelSlice } from "../schema.ts";
import { compareAscii } from "./aggregate.ts";

export const MIN_CONTROLLED_HARNESSES = 8;

const CANONICAL_HARNESS_PROVIDER_BY_KEY: Readonly<Record<string, string>> = {
  "z.ai": "Zhipu",
  "z ai": "Zhipu",
  zai: "Zhipu",
  "z-ai": "Zhipu",
  "zai-org": "Zhipu",
  zhipu: "Zhipu",
  zhipuai: "Zhipu",
  "zhipu ai": "Zhipu",
  moonshot: "Moonshot",
  "moonshot ai": "Moonshot",
  moonshotai: "Moonshot",
  kimi: "Moonshot",
  alibaba: "Alibaba",
  "alibaba cloud": "Alibaba",
  dashscope: "Alibaba",
  qwen: "Alibaba",
  xai: "SpaceXAI",
  "x.ai": "SpaceXAI",
  spacexai: "SpaceXAI",
  deepseek: "DeepSeek",
  "deepseek-ai": "DeepSeek",
  recursive: "Recursive",
  recursivesi: "Recursive",
  "recursive si": "Recursive",
  ricursive: "Ricursive",
  ricursiveai: "Ricursive",
  "ricursive ai": "Ricursive",
  meta: "Meta",
  "meta-llama": "Meta",
  "meta-models": "Meta",
  facebook: "Meta",
};

export function canonicalizeHarnessProviderName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  return Object.hasOwn(CANONICAL_HARNESS_PROVIDER_BY_KEY, key)
    ? CANONICAL_HARNESS_PROVIDER_BY_KEY[key]!
    : trimmed;
}

export function normalizeHarnessVersion(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^v/i, "");
  return cleaned.length > 0 ? cleaned : null;
}

export type RawHarnessEntryInput = Omit<
  HarnessEntry,
  "onFrontier" | "dominatedById" | "scoreDeficit" | "costRatio"
>;

// Compute exact single-envelope Pareto frontier across harnesses (higher pass rate, lower cost per trial)
export function annotateHarnessPareto(rawEntries: readonly RawHarnessEntryInput[]): HarnessEntry[] {
  const byCost = rawEntries.toSorted(
    (a, b) =>
      a.costPerTrialUsd - b.costPerTrialUsd ||
      b.passRate - a.passRate ||
      compareAscii(a.harnessId, b.harnessId),
  );

  const frontier: RawHarnessEntryInput[] = [];
  const metaById = new Map<
    string,
    {
      onFrontier: boolean;
      dominatedById: string | null;
      scoreDeficit: number | null;
      costRatio: number | null;
    }
  >();

  for (const item of byCost) {
    const prev = frontier.at(-1);
    if (!prev || item.passRate > prev.passRate + 1e-6) {
      frontier.push(item);
      metaById.set(item.harnessId, {
        onFrontier: true,
        dominatedById: null,
        scoreDeficit: null,
        costRatio: null,
      });
    } else {
      const dominator =
        frontier.find(
          (f) =>
            f.costPerTrialUsd <= item.costPerTrialUsd + 1e-9 && f.passRate >= item.passRate - 1e-6,
        ) ?? prev;
      metaById.set(item.harnessId, {
        onFrontier: false,
        dominatedById: dominator.harnessId,
        scoreDeficit: Number(Math.max(0, dominator.passRate - item.passRate).toFixed(2)),
        costRatio: Number((item.costPerTrialUsd / dominator.costPerTrialUsd).toFixed(2)),
      });
    }
  }

  return rawEntries
    .map((entry) => {
      const meta = metaById.get(entry.harnessId) ?? {
        onFrontier: false,
        dominatedById: null,
        scoreDeficit: null,
        costRatio: null,
      };
      return {
        harnessId: entry.harnessId,
        name: entry.name,
        vendor: canonicalizeHarnessProviderName(entry.vendor) ?? "Community",
        color: entry.color,
        version: normalizeHarnessVersion(entry.version),
        passRate: entry.passRate,
        ciLower: entry.ciLower,
        ciUpper: entry.ciUpper,
        costPerTrialUsd: entry.costPerTrialUsd,
        costPerPassUsd: entry.costPerPassUsd,
        passAll3Rate: entry.passAll3Rate,
        tokensPerTrial: entry.tokensPerTrial,
        agentSecondsPerTrial: entry.agentSecondsPerTrial,
        nScored: entry.nScored,
        onFrontier: meta.onFrontier,
        dominatedById: meta.dominatedById,
        scoreDeficit: meta.scoreDeficit,
        costRatio: meta.costRatio,
        benchmarks: [...entry.benchmarks].toSorted((a, b) =>
          compareAscii(a.benchmarkId, b.benchmarkId),
        ),
      };
    })
    .toSorted(
      (a, b) =>
        b.passRate - a.passRate ||
        a.costPerTrialUsd - b.costPerTrialUsd ||
        compareAscii(a.harnessId, b.harnessId),
    );
}

export interface ControlledHarnessPick {
  tag: "Lowest cost" | "Cost–score tradeoff" | "Highest pass rate";
  entry: HarnessEntry;
}

// Single source of truth for Controlled Harness picks across HomeView and HarnessesView
export function selectControlledHarnessPicks(
  entries: readonly HarnessEntry[],
): ControlledHarnessPick[] {
  const frontier = entries
    .filter((e) => e.onFrontier)
    .toSorted((a, b) => a.costPerTrialUsd - b.costPerTrialUsd);
  if (frontier.length === 0) return [];
  const budget = frontier[0]!;
  const top = frontier[frontier.length - 1]!;
  if (frontier.length === 1) return [{ tag: "Highest pass rate", entry: top }];
  if (frontier.length === 2) {
    return [
      { tag: "Lowest cost", entry: budget },
      { tag: "Highest pass rate", entry: top },
    ];
  }

  const interior = frontier.slice(1, -1);
  const pricedInterior = interior.filter(
    (e): e is HarnessEntry & { costPerPassUsd: number } =>
      e.costPerPassUsd !== null && Number.isFinite(e.costPerPassUsd),
  );
  let mid = interior[0]!;
  if (pricedInterior.length > 0) {
    mid = pricedInterior.toSorted(
      (a, b) => a.costPerPassUsd - b.costPerPassUsd || b.passRate - a.passRate,
    )[0]!;
  } else {
    const logMin = Math.log10(Math.max(1e-6, budget.costPerTrialUsd));
    const logMax = Math.log10(Math.max(1e-6, top.costPerTrialUsd));
    const logSpan = Math.max(1e-6, logMax - logMin);
    const rateSpan = Math.max(1e-6, top.passRate - budget.passRate);
    let bestLift = -Infinity;
    for (const cand of interior) {
      const lift =
        (cand.passRate - budget.passRate) / rateSpan -
        (Math.log10(Math.max(1e-6, cand.costPerTrialUsd)) - logMin) / logSpan;
      if (lift > bestLift) {
        bestLift = lift;
        mid = cand;
      }
    }
  }

  return [
    { tag: "Lowest cost", entry: budget },
    { tag: "Cost–score tradeoff", entry: mid },
    { tag: "Highest pass rate", entry: top },
  ];
}

// Align equivalent harness IDs across FrontierHarness v1.1 and Harness Leaderboard while keeping OpenCode 1.19.4 distinct
function canonicalizeFrontierHarnessId(rawId: string): string {
  if (rawId === "opencode-2.2.7") return "opencode";
  if (rawId === "opencode") return "opencode-1.19";
  if (rawId === "deepseek-standard") return "deepseek-harness";
  return rawId;
}

function canonicalizeDisplayName(
  hid: string,
  fhEntry?: HarnessEntry,
  hlbEntry?: HarnessEntry,
): string {
  if (hid === "opencode") return "OpenCode";
  if (hid === "kimi-code") return "Kimi Code";
  if (hid === "deepseek-harness") return "DeepSeek Harness";
  return fhEntry?.name ?? hlbEntry?.name ?? hid;
}

export const FRONTIER_HARNESS_BENCHMARK_IDS = ["terminal-bench-2.1", "terminal-bench-4.0"] as const;
export const HARNESS_LB_BENCHMARK_IDS = ["deep-swe", "terminal-bench-2.1"] as const;

export function validateHarnessSourceBenchmarks(
  board: HarnessLeaderboardSnapshot,
  expectedBenchmarkIds: readonly string[],
  sourceLabel: string,
): void {
  const expectedSorted = [...expectedBenchmarkIds].toSorted(compareAscii);
  const isMultiModelHlb = sourceLabel === "Harness Leaderboard" && board.slices.length > 2;
  for (const slice of board.slices) {
    for (const entry of slice.entries) {
      const actualSorted = entry.benchmarks.map((b) => b.benchmarkId).toSorted(compareAscii);
      if (
        actualSorted.length !== expectedSorted.length ||
        actualSorted.some((id, idx) => id !== expectedSorted[idx])
      ) {
        throw new Error(
          `${sourceLabel} slice '${slice.sliceId}' harness '${entry.harnessId}' has benchmark roster [${actualSorted.join(",")}] !== expected [${expectedSorted.join(",")}]`,
        );
      }
      if (isMultiModelHlb && slice.sliceId === "_all") {
        for (const b of entry.benchmarks) {
          if (b.ciLower !== null && b.ciUpper !== null && !b.ciIsUpperBound) {
            throw new Error(
              `${sourceLabel} pooled '_all' slice harness '${entry.harnessId}' benchmark '${b.benchmarkId}' must mark multi-model CI as ciIsUpperBound=true`,
            );
          }
        }
      }
    }
  }
}

function canonicalModelTail(sliceId: string): string {
  const trimmed = sliceId.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function canonicalSliceOrg(slice: HarnessModelSlice): string | null {
  const explicit = canonicalizeHarnessProviderName(slice.org)?.toLowerCase() ?? null;
  const trimmed = slice.sliceId.trim();
  const slash = trimmed.indexOf("/");
  const nsOrg =
    slash > 0
      ? (canonicalizeHarnessProviderName(trimmed.slice(0, slash))?.toLowerCase() ?? null)
      : null;
  if (explicit && nsOrg && explicit !== nsOrg) {
    throw new Error(
      `Conflicting provider provenance for slice '${slice.sliceId}': namespace '${nsOrg}' !== org '${explicit}'`,
    );
  }
  return explicit ?? nsOrg;
}

function assertUniqueCanonicalModelSlices(
  slices: readonly HarnessModelSlice[],
  sourceLabel: string,
): Map<string, HarnessModelSlice> {
  const byCanon = new Map<string, HarnessModelSlice>();
  for (const s of slices) {
    const tail = canonicalModelTail(s.sliceId);
    const org = canonicalSliceOrg(s);
    const key = `${org ?? ""}::${tail}`;
    const existing = byCanon.get(key);
    if (existing) {
      throw new Error(
        `${sourceLabel} contains duplicate canonical control model '${key}' ('${existing.sliceId}' vs '${s.sliceId}')`,
      );
    }
    byCanon.set(key, s);
  }
  return byCanon;
}

function projectControlledBoard(
  board: HarnessLeaderboardSnapshot,
  instrumentId: "terminal-bench-4.0" | "deep-swe",
): HarnessModelSlice[] {
  const isTerminal = instrumentId === "terminal-bench-4.0";
  const modelCount = board.slices.filter((slice) => slice.sliceId !== "_all").length;
  assertUniqueCanonicalModelSlices(
    board.slices.filter((s) => s.sliceId !== "_all"),
    instrumentId,
  );
  return board.slices.map((slice) => {
    const pooled = slice.sliceId === "_all";
    return {
      sliceId: pooled && isTerminal ? "_all" : `${instrumentId}::${slice.sliceId}`,
      instrumentId,
      controlModelId: pooled ? null : slice.sliceId,
      sourceVersion: board.sourceVersion,
      upstreamGeneratedAt: board.upstreamGeneratedAt,
      label: pooled ? `All ${modelCount} models` : slice.label,
      org: canonicalizeHarnessProviderName(slice.org),
      entries: annotateHarnessPareto(
        slice.entries.map((entry) => {
          const metric = entry.benchmarks.find((b) => b.benchmarkId === instrumentId)!;
          const hid = isTerminal ? canonicalizeFrontierHarnessId(entry.harnessId) : entry.harnessId;
          return {
            ...entry,
            harnessId: hid,
            name: canonicalizeDisplayName(hid, entry),
            passRate: metric.passRate,
            ciLower: metric.ciLower,
            ciUpper: metric.ciUpper,
            costPerTrialUsd: metric.costPerTrialUsd,
            costPerPassUsd:
              metric.passRate > 0
                ? Number(((metric.costPerTrialUsd * 100) / metric.passRate).toFixed(6))
                : null,
            passAll3Rate: metric.passAll3Rate ?? null,
            nScored: metric.nScored ?? null,
            tokensPerTrial: metric.tokensPerTrial ?? null,
            agentSecondsPerTrial: metric.agentSecondsPerTrial ?? null,
            benchmarks: [{ ...metric, sourceUrl: metric.sourceUrl ?? board.sourceUrl }],
          };
        }),
      ),
    };
  });
}

export function mergeControlledHarnessSuites(
  fh: HarnessLeaderboardSnapshot,
  hlb: HarnessLeaderboardSnapshot,
): HarnessLeaderboardSnapshot {
  validateHarnessSourceBenchmarks(fh, FRONTIER_HARNESS_BENCHMARK_IDS, "FrontierHarness");
  validateHarnessSourceBenchmarks(hlb, HARNESS_LB_BENCHMARK_IDS, "Harness Leaderboard");
  const cmp = compareIsoInstants(fh.upstreamGeneratedAt, hlb.upstreamGeneratedAt);
  return {
    sourceVersion: `instrument-panels:${fh.sourceVersion}+${hlb.sourceVersion}`,
    upstreamGeneratedAt: cmp !== null && cmp < 0 ? hlb.upstreamGeneratedAt : fh.upstreamGeneratedAt,
    sourceUrl: fh.sourceUrl,
    slices: [
      ...projectControlledBoard(fh, "terminal-bench-4.0"),
      ...projectControlledBoard(hlb, "deep-swe"),
    ].toSorted((a, b) =>
      a.sliceId === b.sliceId
        ? 0
        : a.sliceId === "_all"
          ? -1
          : b.sliceId === "_all"
            ? 1
            : compareAscii(a.sliceId, b.sliceId),
    ),
  };
}

// Recompute dominance, versions, and deterministic ordering from scratch so cached frontier claims are never trusted
export function recomputeHarnessLeaderboard(
  raw: HarnessLeaderboardSnapshot,
): HarnessLeaderboardSnapshot {
  const pooled = raw.slices.filter((s) => s.sliceId === "_all");
  const models = raw.slices
    .filter((s) => s.sliceId !== "_all")
    .toSorted((a, b) => compareAscii(a.sliceId, b.sliceId));
  const ordered = [...pooled, ...models];

  return {
    sourceVersion: raw.sourceVersion,
    upstreamGeneratedAt: raw.upstreamGeneratedAt,
    sourceUrl: raw.sourceUrl,
    slices: ordered.map((slice) => ({
      ...slice,
      label:
        !slice.instrumentId && slice.sliceId === "_all"
          ? `All ${models.length} models`
          : slice.label,
      org: canonicalizeHarnessProviderName(slice.org),
      entries: annotateHarnessPareto(
        slice.entries.map(
          ({
            onFrontier: _onFrontier,
            dominatedById: _dominatedById,
            scoreDeficit: _scoreDeficit,
            costRatio: _costRatio,
            ...base
          }) => base,
        ),
      ),
    })),
  };
}
