import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  BENCHMARK_BY_ID,
  DOMAINS,
  getActiveBenchmarks,
  getActiveBenchmarksForRegime,
  getAnchorMinCoverageForDomain,
  getCandidateBenchmarks,
  getCoverageFloorForDomain,
  getRegimesForDomain,
} from "../../src/config/benchmarks.ts";
import { NATIVE_SELECTABLE_HARNESSES } from "../../src/config/harnesses.ts";
import { ALL_PROVIDER_IDS, isRetiredPurchaseSku } from "../../src/config/providers.ts";
import {
  aggregateDomain,
  buildRemlLinkTerms,
  buildResidCoeffs,
  buildWeightMapFromAnchors,
  clampZScore,
  compareAscii,
  computeConfigPosterior,
  DISPLAY_BASE,
  DISPLAY_SPREAD,
  fitHeteroscedasticRemlPrior,
  MIN_FRONTIER_SHRINKAGE,
  type ObservedCell,
  type RemlPriorPoint,
  type ShrinkageMode,
} from "../../src/lib/math/aggregate.ts";
import { canonicalizeObservation } from "../../src/lib/math/canonicalize.ts";
import {
  type DomainCostBootstrapModel,
  type PartialBasketConfigModel,
  type PartialBasketCostModel,
  resolveDomainCostsWithModel,
  type SiblingBaselineCostEntry,
  type UnidentifiedCellCostEntry,
} from "../../src/lib/math/cost.ts";
import {
  mergeControlledHarnessSuites,
  recomputeHarnessLeaderboard,
} from "../../src/lib/math/harness-pareto.ts";
import { auditBenchmarkLifecycle, linkEpochScores } from "../../src/lib/math/lifecycle.ts";
import {
  computeBootstrapParetoProb,
  computeProviderFrontier,
  extractVerdictPicks,
} from "../../src/lib/math/pareto.ts";
import {
  type AnchorStats,
  type CostSource,
  type DomainId,
  type DomainSnapshot,
  DomainSnapshotSchema,
  type EpochLink,
  type EpochManifest,
  EpochManifestSchema,
  type EvaluatedConfig,
  type HarnessId,
  type HarnessLeaderboardSnapshot,
  HarnessLeaderboardSnapshotSchema,
  type HarnessRegime,
  type LinkJointCov,
  type PricingRecord,
  type ProChoiceSnapshot,
  ProChoiceSnapshotSchema,
  type ProviderFrontier,
  type RegimeMeta,
  type SourceHealth,
  type UnmappedRecord,
} from "../../src/lib/schema.ts";
import {
  recoverPendingRawCacheSwap,
  refreshMandatorySource,
  writeAllSourceCachesAtomically,
  writeShrinkState,
} from "./cache.ts";
import {
  fsyncDir,
  fsyncFile,
  isSameDirectory,
  recoverPendingSyncCommit,
  seedBaselineGenerationIfNeeded,
} from "./generation.ts";
import { withPublishLock } from "./lock.ts";
import { aikidoAdapter } from "./sources/aikido.ts";
import { artificialAnalysisAdapter } from "./sources/artificial-analysis.ts";
import { cweBenchAdapter } from "./sources/cwe-bench.ts";
import { cyberArenaAdapter } from "./sources/cyber-arena.ts";
import { designarenaAdapter } from "./sources/designarena.ts";
import { epochAdapter } from "./sources/epoch.ts";
import { frontierHarnessAdapter } from "./sources/frontier-harness.ts";
import { harnessLeaderboardAdapter } from "./sources/harness-leaderboard.ts";
import { livebenchAdapter } from "./sources/livebench.ts";
import { lmarenaAdapter } from "./sources/lmarena.ts";
import { pricingAdapter } from "./sources/pricing.ts";
import { scaleSealAdapter } from "./sources/scale-seal.ts";
import { surgeAdapter } from "./sources/surge.ts";
import { MIN_TBENCH_4_1_TRIALS, tbenchAdapter } from "./sources/tbench.ts";
import { valsAdapter } from "./sources/vals.ts";
import { vulcanbenchAdapter } from "./sources/vulcanbench.ts";
import { writingFeedsAdapter } from "./sources/writing-feeds.ts";
import type { CachedSourceFile, SourceAdapter } from "./types.ts";

const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");
export const EPOCH_MANIFEST_PATH = path.join(DEFAULT_DATA_DIR, "epochs", "manifest.json");
const MIN_ARENA_BATTLES = 300;
const MIN_ARENA_UNREPORTED_SE_BATTLES = 350;
const MAX_ARENA_ELO_CI_HALF = 25;
const MAX_RUBRIC_ELO_CI_HALF = 30;
const MAX_AGENT_CAPABILITY_CI_HALF = 60;

// Await settlement of every started filesystem promise before rethrowing so no mutation can outlive the publish lock
export async function awaitAllSettledOrThrow<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const firstRejection = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (firstRejection) throw firstRejection.reason;
  return settled.map((r) => (r as PromiseFulfilledResult<T>).value);
}

interface PendingCutoverJournal {
  stagingDir: string;
  files: EpochManifest;
}

export function sha256Hex(content: string | Uint8Array): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function readEpochManifest(dataDir?: string): Promise<EpochManifest | null> {
  const manifestPath = path.join(dataDir ?? DEFAULT_DATA_DIR, "epochs", "manifest.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    return EpochManifestSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Corrupt epoch manifest ${manifestPath}`, { cause: err });
  }
}

export async function recoverPendingEpochManifest(
  existingManifest: EpochManifest | null,
  epochsDir: string,
): Promise<EpochManifest | null> {
  const pendingManifestPath = path.join(epochsDir, ".manifest.pending.json");
  const epochManifestPath = path.join(epochsDir, "manifest.json");
  let rawPending: string;
  try {
    rawPending = await fs.readFile(pendingManifestPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Clean up orphaned .pending.* directories left behind by a crash before the journal was written
      let entries: string[] = [];
      try {
        entries = await fs.readdir(epochsDir);
      } catch (dirErr) {
        if ((dirErr as NodeJS.ErrnoException).code !== "ENOENT") throw dirErr;
      }
      await awaitAllSettledOrThrow(
        entries
          .filter((e) => e.startsWith(".pending."))
          .map((e) => fs.rm(path.join(epochsDir, e), { recursive: true, force: true })),
      );
      return existingManifest;
    }
    throw new Error(`Corrupt pending epoch manifest ${pendingManifestPath}`, { cause: err });
  }
  const parsed = JSON.parse(rawPending) as Partial<PendingCutoverJournal>;
  if (
    !parsed ||
    typeof parsed.stagingDir !== "string" ||
    !/^\.pending\.[a-z0-9-]+$/i.test(parsed.stagingDir)
  ) {
    throw new Error(`Malformed pending epoch journal ${pendingManifestPath}`);
  }
  const pendingFiles = EpochManifestSchema.parse(parsed.files);
  const stagingDirPath = path.join(epochsDir, parsed.stagingDir);

  // Preflight every journaled entry (immutability, predecessor MAJOR chain, on-disk/staged SHA-256, and archive validity) BEFORE linking any file
  const merged: Record<string, string> = existingManifest ? { ...existingManifest } : {};
  let changed = false;

  const preflightResults = await awaitAllSettledOrThrow(
    Object.entries(pendingFiles).map(async ([filename, expectedSha]) => {
      if (
        existingManifest &&
        Object.hasOwn(existingManifest, filename) &&
        existingManifest[filename] !== expectedSha
      ) {
        throw new Error(
          `Refusing to overwrite immutable MAJOR epoch pin '${filename}' during crash recovery (${existingManifest[filename]} !== ${expectedSha})`,
        );
      }

      const prevName = previousMajorEpochFilename(filename.replace(/\.json$/, ""));
      if (prevName) {
        if (!existingManifest || !Object.hasOwn(existingManifest, prevName)) {
          throw new Error(
            `Refusing pending MAJOR epoch recovery for '${filename}': predecessor '${prevName}' is not pinned in manifest.json`,
          );
        }
        const prevRaw = await fs.readFile(path.join(epochsDir, prevName), "utf8");
        if (sha256Hex(prevRaw) !== existingManifest[prevName]) {
          throw new Error(
            `Refusing pending MAJOR epoch recovery for '${filename}': predecessor '${prevName}' failed manifest SHA-256`,
          );
        }
        const prevErrors = validateFrozenMajorEpochSnapshot(prevName, JSON.parse(prevRaw));
        if (prevErrors.length > 0) {
          throw new Error(
            `Refusing pending MAJOR epoch recovery for '${filename}': predecessor '${prevName}' failed archive validation (${prevErrors.join("; ")})`,
          );
        }
      }

      const epochPath = path.join(epochsDir, filename);
      let existingContent: string | null = null;
      try {
        existingContent = await fs.readFile(epochPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }

      if (existingContent !== null) {
        const actualSha = sha256Hex(existingContent);
        if (actualSha !== expectedSha) {
          throw new Error(
            `Pending MAJOR epoch '${filename}' SHA-256 mismatch during crash recovery (${expectedSha} !== ${actualSha})`,
          );
        }
        const archiveErrors = validateFrozenMajorEpochSnapshot(
          filename,
          JSON.parse(existingContent),
        );
        if (archiveErrors.length > 0) {
          throw new Error(
            `Pending MAJOR epoch '${filename}' failed archive validation during crash recovery: ${archiveErrors.join("; ")}`,
          );
        }
        return { filename, expectedSha, linkSpec: null };
      }

      const stagedPath = path.join(stagingDirPath, filename);
      let stagedContent: string;
      try {
        stagedContent = await fs.readFile(stagedPath, "utf8");
      } catch (stageErr) {
        throw new Error(
          `Interrupted MAJOR cutover missing staged payload '${stagedPath}' for journaled '${filename}'`,
          { cause: stageErr },
        );
      }
      const stagedSha = sha256Hex(stagedContent);
      if (stagedSha !== expectedSha) {
        throw new Error(
          `Staged MAJOR epoch '${filename}' SHA-256 mismatch during crash recovery (${expectedSha} !== ${stagedSha})`,
        );
      }
      const archiveErrors = validateFrozenMajorEpochSnapshot(filename, JSON.parse(stagedContent));
      if (archiveErrors.length > 0) {
        throw new Error(
          `Staged MAJOR epoch '${filename}' failed archive validation during crash recovery: ${archiveErrors.join("; ")}`,
        );
      }
      return {
        filename,
        expectedSha,
        linkSpec: { filename, expectedSha, stagedPath, epochPath },
      };
    }),
  );

  const toLink = preflightResults
    .map((r) => r.linkSpec)
    .filter((item): item is NonNullable<typeof item> => item !== null);
  for (const r of preflightResults) {
    if (merged[r.filename] !== r.expectedSha) {
      merged[r.filename] = r.expectedSha;
      changed = true;
    }
  }

  await awaitAllSettledOrThrow(
    toLink.map(async (item) => {
      await fsyncFile(item.stagedPath);
      await fs.link(item.stagedPath, item.epochPath);
      await fsyncFile(item.epochPath);
    }),
  );

  let result = existingManifest;
  if (changed) {
    const sorted: Record<string, string> = {};
    for (const k of Object.keys(merged).toSorted(compareAscii)) {
      sorted[k] = merged[k]!;
    }
    result = EpochManifestSchema.parse(sorted);
    await atomicWriteJson(epochManifestPath, result);
  }
  await fsyncDir(epochsDir);
  await fs.unlink(pendingManifestPath).catch(() => undefined);
  await fs.rm(stagingDirPath, { recursive: true, force: true }).catch(() => undefined);
  return result;
}

export const MANDATORY_ADAPTERS: readonly SourceAdapter[] = [
  artificialAnalysisAdapter,
  aikidoAdapter,
  cweBenchAdapter,
  cyberArenaAdapter,
  epochAdapter,
  frontierHarnessAdapter,
  lmarenaAdapter,
  tbenchAdapter,
  harnessLeaderboardAdapter,
  livebenchAdapter,
  valsAdapter,
  vulcanbenchAdapter,
  designarenaAdapter,
  writingFeedsAdapter,
  scaleSealAdapter,
  surgeAdapter,
  pricingAdapter,
];

export function majorEpochFilename(epochVersion: string): string {
  const m = epochVersion.match(/^([a-z0-9-]+-v\d+)\.\d+\.\d+$/);
  const majorPrefix = m?.[1] ?? epochVersion;
  return `${majorPrefix}.0.0.json`;
}

export function previousMajorEpochFilename(epochVersion: string): string | null {
  const m = epochVersion.match(/^([a-z0-9-]+-v)(\d+)\.\d+\.\d+$/);
  if (!m?.[1] || !m[2]) return null;
  const major = Number(m[2]);
  if (!Number.isInteger(major) || major <= 1) return null;
  return `${m[1]}${major - 1}.0.0.json`;
}

export function parseEpochMajorNumber(epochOrFilename: string): number | null {
  const m = epochOrFilename.match(/-v(\d+)\.\d+\.\d+(?:\.json)?$/);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

async function readMajorEpoch(
  epochVersion: string,
  manifest: EpochManifest | null,
  epochsDir: string,
): Promise<DomainSnapshot | null> {
  const filename = majorEpochFilename(epochVersion);
  const filePath = path.join(epochsDir, filename);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (manifest && Object.hasOwn(manifest, filename)) {
        throw new Error(
          `Archived MAJOR epoch '${filename}' pinned in manifest.json is missing from disk`,
          { cause: err },
        );
      }
      return null;
    }
    throw new Error(`Failed to read frozen epoch baseline ${filePath}`, { cause: err });
  }
  if (!manifest || !Object.hasOwn(manifest, filename)) {
    throw new Error(
      `Archived MAJOR epoch '${filename}' exists on disk without a pin in data/epochs/manifest.json`,
    );
  }
  const actualHash = sha256Hex(raw);
  if (manifest[filename] !== actualHash) {
    throw new Error(
      `Archived MAJOR epoch '${filename}' SHA-256 mismatch (expected ${manifest[filename]}, got ${actualHash})`,
    );
  }
  const parsed = JSON.parse(raw) as unknown;
  const archiveErrors = validateFrozenMajorEpochSnapshot(filename, parsed);
  if (archiveErrors.length > 0) {
    throw new Error(
      `Archived MAJOR epoch '${filename}' failed archive validation: ${archiveErrors.join("; ")}`,
    );
  }
  return DomainSnapshotSchema.parse(parsed);
}

async function readPublishedSnapshotIfExists(dataDir: string): Promise<ProChoiceSnapshot | null> {
  const snapPath = path.join(dataDir, "snapshot.json");
  try {
    const raw = await fs.readFile(snapPath, "utf8");
    return ProChoiceSnapshotSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Existing snapshot.json is unreadable or corrupt: ${snapPath}`, { cause: err });
  }
}

function extractRegimeAnchors(
  anchors: Readonly<Record<string, AnchorStats>> | undefined,
  regime: HarnessRegime,
): Record<string, AnchorStats> | undefined {
  if (!anchors) return undefined;
  const out: Record<string, AnchorStats> = {};
  for (const [k, v] of Object.entries(anchors)) {
    if (regime === "standardized") {
      if (k.endsWith("::standardized")) {
        out[k.slice(0, -"::standardized".length)] = v;
      }
    } else if (!k.endsWith("::standardized")) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function canonicalLinkKey(c: EvaluatedConfig): string {
  const stableHarness = c.harness === "multi-harness" ? "direct" : c.harness;
  return `${c.provider}:${c.modelSlug}:${c.effort}:${stableHarness}:${c.harnessRegime}`;
}

function hasMetricConflict(a: number | null, b: number | null, tol = 1e-6): boolean {
  return a !== null && b !== null && Math.abs(a - b) > tol;
}

function groupHasConflict(list: readonly ObservedCell[]): boolean {
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j]!;
      if (
        hasMetricConflict(a.rawScore, b.rawScore, 1e-4) ||
        hasMetricConflict(a.seRaw, b.seRaw, 1e-5) ||
        hasMetricConflict(a.ciHalfWidth, b.ciHalfWidth, 1e-4) ||
        hasMetricConflict(a.ciLower, b.ciLower, 1e-4) ||
        hasMetricConflict(a.ciUpper, b.ciUpper, 1e-4) ||
        hasMetricConflict(a.measuredCostUsd, b.measuredCostUsd, 1e-6) ||
        hasMetricConflict(a.suiteCostUsd, b.suiteCostUsd, 1e-6) ||
        hasMetricConflict(a.refusalRate ?? null, b.refusalRate ?? null, 1e-4) ||
        Boolean(a.measuredCostEstimated) !== Boolean(b.measuredCostEstimated) ||
        Boolean(a.fallbackRouting) !== Boolean(b.fallbackRouting)
      ) {
        return true;
      }
    }
  }
  return false;
}

function compareCellsCanonically(a: ObservedCell, b: ObservedCell): number {
  const aHasCi =
    a.ciHalfWidth !== null || (a.ciLower !== null && a.ciUpper !== null) || a.seRaw !== null;
  const bHasCi =
    b.ciHalfWidth !== null || (b.ciLower !== null && b.ciUpper !== null) || b.seRaw !== null;
  if (aHasCi !== bHasCi) return aHasCi ? -1 : 1;
  if (a.evalDate !== b.evalDate) {
    if (a.evalDate === null) return 1;
    if (b.evalDate === null) return -1;
    return compareAscii(b.evalDate, a.evalDate);
  }
  const aHasCost = a.measuredCostUsd !== null;
  const bHasCost = b.measuredCostUsd !== null;
  if (aHasCost !== bHasCost) return aHasCost ? -1 : 1;
  return compareAscii(a.sourceRowId, b.sourceRowId);
}

function deduplicateCells(
  cells: readonly ObservedCell[],
  unmapped: UnmappedRecord[],
  seenUnmapped: Set<string>,
): ObservedCell[] {
  const grouped = new Map<string, ObservedCell[]>();
  for (const cell of cells) {
    const key = `${cell.configId}::${cell.benchmarkId}`;
    const list = grouped.get(key) ?? [];
    list.push(cell);
    grouped.set(key, list);
  }

  const out: ObservedCell[] = [];
  for (const rawList of grouped.values()) {
    if (rawList.length === 1) {
      out.push(rawList[0]!);
      continue;
    }

    // Order-independent resolution: compare score, uncertainty, and spend; quarantine conflicts unless newer verified evalDate resolves cleanly
    const list = rawList.toSorted(compareCellsCanonically);
    if (groupHasConflict(list)) {
      const dated = list.filter((c) => c.evalDate !== null);
      const maxDate =
        dated.length === list.length
          ? dated
              .map((c) => c.evalDate!)
              .toSorted(compareAscii)
              .at(-1)!
          : null;
      const latestOnly = maxDate ? dated.filter((c) => c.evalDate === maxDate) : [];

      if (latestOnly.length === 0 || groupHasConflict(latestOnly)) {
        const distinctLabels = new Set(list.map((c) => c.rawModelName.trim().toLowerCase()));
        const reasonPrefix =
          distinctLabels.size > 1 ? "ambiguous_alias_collision" : "ambiguous_duplicate_observation";
        for (const c of list) {
          const uKey = `collision::${c.sourceId}::${c.benchmarkId}::${c.rawModelName}::${c.rawScore.toFixed(4)}::${c.measuredCostUsd ?? "na"}::${c.measuredCostEstimated ? "est" : "act"}::${c.fallbackRouting ? "fb" : "std"}`;
          if (!seenUnmapped.has(uKey)) {
            seenUnmapped.add(uKey);
            unmapped.push({
              sourceId: c.sourceId,
              benchmarkId: c.benchmarkId,
              rawModelName: c.rawModelName,
              rawProvider: c.provider,
              rawHarness: c.observedHarness,
              reason: `${reasonPrefix}:${c.configId}`,
            });
          }
        }
        continue;
      }

      out.push(latestOnly[0]!);
      continue;
    }

    out.push(list[0]!);
  }
  return out;
}

// Single authoritative admission, quality-gate, version-lock, and deduplication filter shared by compiler and lifecycle audit
export function extractAcceptedCellsFromSources(results: readonly CachedSourceFile[]): {
  cellsByDomain: Map<DomainId, ObservedCell[]>;
  unmapped: UnmappedRecord[];
} {
  const unmapped: UnmappedRecord[] = [];
  const seenUnmapped = new Set<string>();
  const rawCellsByDomain = new Map<DomainId, ObservedCell[]>();

  const pushUnmapped = (rec: UnmappedRecord, dedupeKey: string) => {
    if (seenUnmapped.has(dedupeKey)) return;
    seenUnmapped.add(dedupeKey);
    unmapped.push(rec);
  };

  for (const r of results) {
    const subFeedHealthyAt = new Map(
      r.health.subFeeds.map((sf) => [sf.benchmarkId, sf.lastHealthyAt ?? r.health.lastHealthyAt]),
    );
    for (const obs of r.payload.observations) {
      if (obs.sourceId !== r.health.sourceId) continue;
      const bmMeta = BENCHMARK_BY_ID[obs.benchmarkId];
      if (!bmMeta) continue;
      if (
        obs.sourceId !== bmMeta.sourceId ||
        obs.domainId !== bmMeta.domainId ||
        !bmMeta.regimes.includes(obs.harnessRegime)
      ) {
        continue;
      }

      // Reject observations whose upstream version drifted from the registered benchmark version
      if (obs.benchmarkVersion !== bmMeta.version) {
        pushUnmapped(
          {
            sourceId: obs.sourceId,
            benchmarkId: obs.benchmarkId,
            rawModelName: obs.rawModelName,
            rawProvider: obs.rawProvider,
            rawHarness: obs.rawHarness,
            reason: `benchmark_version_mismatch:${obs.benchmarkVersion}!=${bmMeta.version}`,
          },
          `ver::${obs.sourceId}::${obs.benchmarkId}::${obs.benchmarkVersion}::${obs.rawModelName}`,
        );
        continue;
      }

      // Reapply raw admission quality gates on persisted cache rows (never trust raw cache blindly)
      if (bmMeta.boundedMax !== null && (obs.rawScore < 0 || obs.rawScore > bmMeta.boundedMax)) {
        continue;
      }
      if ((obs.ciLower !== null) !== (obs.ciUpper !== null)) continue;
      if (
        obs.ciLower !== null &&
        obs.ciUpper !== null &&
        (obs.ciUpper <= obs.ciLower ||
          obs.rawScore < obs.ciLower - 0.01 ||
          obs.rawScore > obs.ciUpper + 0.01)
      ) {
        continue;
      }

      const rawCiHalf =
        obs.ciLower !== null && obs.ciUpper !== null
          ? (obs.ciUpper - obs.ciLower) / 2
          : obs.seRaw !== undefined && obs.seRaw !== null && obs.seRaw > 0
            ? obs.seRaw * 1.96
            : obs.ciHalfWidth;

      if (bmMeta.id === "lmarena_agent") {
        if (
          obs.battleCount === null ||
          !Number.isInteger(obs.battleCount) ||
          obs.battleCount < MIN_ARENA_BATTLES ||
          obs.ciLower === null ||
          obs.ciUpper === null ||
          obs.ciUpper <= obs.ciLower
        ) {
          continue;
        }
        const exactCiHalf = (obs.ciUpper - obs.ciLower) / 2;
        if (exactCiHalf <= 0 || exactCiHalf > MAX_AGENT_CAPABILITY_CI_HALF) continue;
      } else if (bmMeta.isArena) {
        if (obs.battleCount === null || !Number.isInteger(obs.battleCount)) continue;
        if (obs.sourceId !== "designarena") {
          // Non-DesignArena crowd arenas (LMArena) strictly require explicit published CI endpoints
          if (obs.ciLower === null || obs.ciUpper === null || obs.ciUpper <= obs.ciLower) continue;
          const exactCiHalf = (obs.ciUpper - obs.ciLower) / 2;
          if (
            obs.battleCount < MIN_ARENA_BATTLES ||
            exactCiHalf <= 0 ||
            exactCiHalf > MAX_ARENA_ELO_CI_HALF
          ) {
            continue;
          }
        } else if (rawCiHalf !== null) {
          if (
            obs.battleCount < MIN_ARENA_BATTLES ||
            rawCiHalf <= 0 ||
            rawCiHalf > MAX_ARENA_ELO_CI_HALF
          ) {
            continue;
          }
        } else if (obs.battleCount < MIN_ARENA_UNREPORTED_SE_BATTLES) {
          continue;
        }
      } else if (bmMeta.scale === "elo") {
        // Require explicit published CI endpoints matching live Elo adapters (containment checked above)
        if (obs.ciLower === null || obs.ciUpper === null || obs.ciUpper <= obs.ciLower) continue;
        const exactCiHalf = (obs.ciUpper - obs.ciLower) / 2;
        const maxEloCi =
          bmMeta.id === "aa_briefcase" || bmMeta.id === "gdpval_aa"
            ? MAX_ARENA_ELO_CI_HALF
            : MAX_RUBRIC_ELO_CI_HALF;
        if (exactCiHalf <= 0 || exactCiHalf > maxEloCi) continue;
      } else if (bmMeta.id === "lechmazur_writing") {
        if (obs.ciLower === null || obs.ciUpper === null || obs.ciUpper <= obs.ciLower) continue;
      } else if (bmMeta.id === "tbench_4_1") {
        if (
          obs.battleCount === null ||
          !Number.isInteger(obs.battleCount) ||
          obs.battleCount < MIN_TBENCH_4_1_TRIALS ||
          obs.measuredCostUsd === null ||
          obs.measuredCostUsd <= 0
        ) {
          continue;
        }
      }

      const outcome = canonicalizeObservation(obs);
      if (outcome.kind === "unmapped") {
        pushUnmapped(
          {
            sourceId: obs.sourceId,
            benchmarkId: obs.benchmarkId,
            rawModelName: obs.rawModelName,
            rawProvider: obs.rawProvider,
            rawHarness: obs.rawHarness,
            reason: outcome.reason,
          },
          `${obs.sourceId}::${obs.benchmarkId}::${obs.rawModelName}::${obs.rawHarness ?? ""}`,
        );
        continue;
      }
      if (outcome.kind !== "ok") continue;
      if (
        obs.domainId !== "harnesses" &&
        outcome.config.harness !== "direct" &&
        outcome.config.harness !== "standardized-suite"
      ) {
        continue;
      }
      if (!bmMeta.regimes.includes(outcome.config.harnessRegime)) {
        pushUnmapped(
          {
            sourceId: obs.sourceId,
            benchmarkId: obs.benchmarkId,
            rawModelName: obs.rawModelName,
            rawProvider: obs.rawProvider,
            rawHarness: obs.rawHarness,
            reason: `regime_mismatch:${outcome.config.harnessRegime}`,
          },
          `reg::${obs.sourceId}::${obs.benchmarkId}::${obs.rawModelName}::${obs.rawHarness ?? ""}`,
        );
        continue;
      }

      const list = rawCellsByDomain.get(obs.domainId) ?? [];
      list.push({
        configId: outcome.config.configId,
        rawModelName: obs.rawModelName,
        provider: outcome.config.provider,
        modelSlug: outcome.config.modelSlug,
        displayName: outcome.config.displayName,
        releaseDate: outcome.config.releaseDate,
        effort: outcome.config.effort,
        harness: outcome.config.harness,
        observedHarness: obs.observedHarness,
        harnessRegime: outcome.config.harnessRegime,
        benchmarkId: obs.benchmarkId,
        benchmarkVersion: obs.benchmarkVersion,
        sourceId: obs.sourceId,
        sourceRowId: obs.sourceRowId,
        rawScore: obs.rawScore,
        seRaw: obs.seRaw ?? null,
        ciHalfWidth: obs.ciHalfWidth,
        ciLower: obs.ciLower,
        ciUpper: obs.ciUpper,
        battleCount: obs.battleCount,
        measuredCostUsd: obs.measuredCostUsd,
        ...(obs.measuredCostEstimated ? { measuredCostEstimated: true } : {}),
        ...(obs.fallbackRouting ? { fallbackRouting: true } : {}),
        ...(obs.refusalRate !== undefined && obs.refusalRate !== null
          ? { refusalRate: obs.refusalRate }
          : {}),
        subFeedHealthyAt: subFeedHealthyAt.get(obs.benchmarkId) ?? r.health.lastHealthyAt,
        suiteCostUsd: obs.suiteCostUsd,
        evalDate: obs.evalDate,
        publishedDate: obs.publishedDate,
        sourceUrl: obs.sourceUrl,
      });
      rawCellsByDomain.set(obs.domainId, list);
    }
  }

  const cellsByDomain = new Map<DomainId, ObservedCell[]>();
  for (const [domainId, list] of rawCellsByDomain.entries()) {
    cellsByDomain.set(domainId, deduplicateCells(list, unmapped, seenUnmapped));
  }

  return { cellsByDomain, unmapped };
}

function computeSliceImputationSensitivity(
  group: readonly EvaluatedConfig[],
  tauResid: number,
  missingOlderById: ReadonlyMap<string, number>,
  baseFrontierIds: ReadonlySet<string>,
  weightByBenchmark?: ReadonlyMap<string, number>,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const cfg of group) {
    const missingOlderW = missingOlderById.get(cfg.id) ?? 0;
    if (missingOlderW <= 0 || tauResid <= 0) {
      out.set(cfg.id, false);
      continue;
    }
    let observedW = 0;
    for (const bm of cfg.benchmarks) {
      observedW += weightByBenchmark?.get(bm.benchmarkId) ?? 1;
    }
    if (observedW <= 0) {
      out.set(cfg.id, false);
      continue;
    }
    // Relative -1.0 * tauResid shift below observed theta weighted by omitted older benchmarks (EB-scaled)
    const cfTheta =
      cfg.theta - (cfg.shrinkageFactor * missingOlderW * tauResid) / (observedW + missingOlderW);
    const cfScore = Number((DISPLAY_BASE + DISPLAY_SPREAD * cfTheta).toFixed(2));
    const counterfactual = group.map((entry) =>
      entry.id === cfg.id ? { ...entry, score: cfScore } : entry,
    );
    const cfFrontierIds = new Set(
      computeProviderFrontier(counterfactual, undefined, undefined, weightByBenchmark).frontier.map(
        (p) => p.configId,
      ),
    );
    out.set(cfg.id, baseFrontierIds.has(cfg.id) !== cfFrontierIds.has(cfg.id));
  }
  return out;
}

// Shared structural, arithmetic, and health guard for newly frozen MAJOR epochs and archived manifest entries
export function validateFrozenMajorEpochSnapshot(
  filename: string,
  raw: unknown,
  publishedEpochByDomain?: ReadonlyMap<DomainId, string>,
): string[] {
  const parsed = DomainSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return [`${filename}: invalid DomainSnapshot schema (${parsed.error.message})`];
  }
  const snap = parsed.data;
  const errors: string[] = [];
  const expectedFile = majorEpochFilename(snap.epochVersion);
  if (expectedFile !== filename) {
    errors.push(
      `${filename}: epochVersion '${snap.epochVersion}' maps to '${expectedFile}', not '${filename}'`,
    );
  }
  const domainMeta = DOMAINS.find((d) => d.id === snap.domainId);
  if (!domainMeta) {
    errors.push(`${filename}: unknown domainId '${snap.domainId}'`);
    return errors;
  }
  const expectedPrefix = majorEpochFilename(domainMeta.epochVersion).replace(
    /-v\d+\.0\.0\.json$/,
    "",
  );
  const actualPrefix = filename.replace(/-v\d+\.0\.0\.json$/, "");
  if (actualPrefix !== expectedPrefix) {
    errors.push(
      `${filename}: filename prefix '${actualPrefix}' does not match domain '${snap.domainId}'`,
    );
  }

  const archiveMajor = parseEpochMajorNumber(filename);
  const archiveShrinkageMode: ShrinkageMode =
    archiveMajor !== null && archiveMajor < 2 ? "total" : "measurement";
  const publishedEpoch = publishedEpochByDomain?.get(snap.domainId) ?? domainMeta.epochVersion;
  const currentMajor = parseEpochMajorNumber(publishedEpoch);
  if (archiveMajor === null || currentMajor === null) {
    errors.push(`${filename}: unparseable MAJOR version`);
  } else if (archiveMajor > currentMajor) {
    errors.push(
      `${filename}: archived MAJOR v${archiveMajor} exceeds published MAJOR v${currentMajor} for '${snap.domainId}'`,
    );
  }

  const requiredAnchorLabs =
    archiveMajor !== null && currentMajor !== null && archiveMajor < currentMajor
      ? 2
      : domainMeta.minLabsForSaturation;

  // Validate archived regimes across regimeMeta, configs, provisionalConfigs, anchorStats, and frontiers
  const archivedRegimes = Object.keys(snap.regimeMeta) as HarnessRegime[];
  const regimes =
    archiveMajor !== null && currentMajor !== null && archiveMajor < currentMajor
      ? archivedRegimes
      : getRegimesForDomain(snap.domainId);
  if (regimes.length === 0) {
    errors.push(`${filename}: archived regimeMeta is empty`);
  }
  const validRegimeSet = new Set<HarnessRegime>(regimes);
  for (const ar of archivedRegimes) {
    if (!validRegimeSet.has(ar)) {
      errors.push(`${filename}: regimeMeta contains unexpected regime '${ar}'`);
    }
  }
  for (const cfg of [...snap.configs, ...snap.provisionalConfigs]) {
    if (!validRegimeSet.has(cfg.harnessRegime)) {
      errors.push(`${filename}: config '${cfg.id}' uses invalid regime '${cfg.harnessRegime}'`);
    }
  }
  for (const anchorKey of Object.keys(snap.anchorStats)) {
    const anchorRegime: HarnessRegime = anchorKey.endsWith("::standardized")
      ? "standardized"
      : "native";
    if (!validRegimeSet.has(anchorRegime)) {
      errors.push(
        `${filename}: anchorStats entry '${anchorKey}' belongs to invalid regime '${anchorRegime}'`,
      );
    }
  }
  const globalSeenSlices = new Set<string>();
  for (const pf of snap.frontiers) {
    const globalKey = `${pf.harnessRegime}::${pf.provider}::${pf.harnessFilter}`;
    if (!validRegimeSet.has(pf.harnessRegime)) {
      errors.push(
        `${filename}: Pareto frontier slice '${globalKey}' uses invalid regime '${pf.harnessRegime}'`,
      );
    }
    if (globalSeenSlices.has(globalKey)) {
      errors.push(`${filename}: duplicate Pareto frontier slice '${globalKey}'`);
    }
    globalSeenSlices.add(globalKey);
  }
  for (const regime of regimes) {
    const rm = snap.regimeMeta[regime];
    if (!rm) {
      errors.push(`${filename} (${regime}): missing regimeMeta`);
      continue;
    }
    if (rm.activeBenchmarkIds.length === 0) {
      errors.push(`${filename} (${regime}): 0 active benchmarks`);
    }
    if (rm.withheldBenchmarkIds.length > 0) {
      errors.push(
        `${filename} (${regime}): frozen MAJOR epoch has withheld active benchmarks [${rm.withheldBenchmarkIds.join(", ")}]`,
      );
    }
    if (rm.anchorLabs < requiredAnchorLabs) {
      errors.push(
        `${filename} (${regime}): calibrated on ${rm.anchorLabs} labs < required ${requiredAnchorLabs}`,
      );
    }
    const regimeConfigs = snap.configs.filter((c) => c.harnessRegime === regime);
    if (regimeConfigs.length === 0) {
      errors.push(`${filename} (${regime}): 0 eligible configurations`);
    }
    const regimeActiveSet = new Set(rm.activeBenchmarkIds);
    if (regimeActiveSet.size !== rm.activeBenchmarkIds.length) {
      errors.push(
        `${filename} (${regime}): duplicate benchmark IDs in regimeMeta.activeBenchmarkIds`,
      );
    }
    if (
      !Number.isInteger(rm.coverageFloor) ||
      rm.coverageFloor < 1 ||
      rm.coverageFloor > regimeActiveSet.size
    ) {
      errors.push(
        `${filename} (${regime}): archived coverageFloor ${rm.coverageFloor} out of valid range [1, ${regimeActiveSet.size}]`,
      );
    }
    const archivedFloor = rm.coverageFloor;
    const measuredSet = new Set(rm.measuredCostBenchmarkIds);
    if (measuredSet.size !== rm.measuredCostBenchmarkIds.length) {
      errors.push(`${filename} (${regime}): duplicate IDs in measuredCostBenchmarkIds`);
    }
    for (const mbm of measuredSet) {
      if (!regimeActiveSet.has(mbm)) {
        errors.push(
          `${filename} (${regime}): measuredCostBenchmarkIds contains '${mbm}' outside activeBenchmarkIds`,
        );
      }
    }
    if (rm.costSource === "measured" && measuredSet.size === 0) {
      errors.push(
        `${filename} (${regime}): costSource 'measured' has empty measuredCostBenchmarkIds`,
      );
    } else if (rm.costSource !== "measured" && measuredSet.size > 0) {
      errors.push(
        `${filename} (${regime}): costSource '${rm.costSource}' must have empty measuredCostBenchmarkIds`,
      );
    }
    for (const cfg of regimeConfigs) {
      const uniqueRegimeBms = new Set(
        cfg.benchmarks.map((b) => b.benchmarkId).filter((id) => regimeActiveSet.has(id)),
      );
      if (!cfg.eligibleForFrontier || uniqueRegimeBms.size < archivedFloor) {
        errors.push(
          `${filename} (${regime}): eligible config '${cfg.id}' violates archived coverageFloor ${archivedFloor} (unique=${uniqueRegimeBms.size})`,
        );
      }
      if (
        cfg.effectiveCostUsd === null ||
        !Number.isFinite(cfg.effectiveCostUsd) ||
        cfg.effectiveCostUsd <= 0
      ) {
        errors.push(
          `${filename} (${regime}): eligible config '${cfg.id}' missing positive effectiveCostUsd`,
        );
      }
      if (cfg.inputPer1mUsd === null || cfg.outputPer1mUsd === null) {
        errors.push(
          `${filename} (${regime}): eligible config '${cfg.id}' missing verified public API pricing`,
        );
      } else if (snap.domainId === "writing") {
        const expectedBriefCost = Number(
          (0.01 * cfg.inputPer1mUsd + 0.004 * cfg.outputPer1mUsd).toFixed(6),
        );
        if (
          expectedBriefCost <= 0 ||
          cfg.effectiveCostUsd === null ||
          Math.abs(cfg.effectiveCostUsd - expectedBriefCost) > 1e-5
        ) {
          errors.push(
            `${filename} (${regime}): Writing config '${cfg.id}' effectiveCostUsd ${cfg.effectiveCostUsd} !== tariff brief cost ${expectedBriefCost}`,
          );
        }
      }
      if (
        cfg.costFixedFloorUsd !== undefined &&
        cfg.effectiveCostUsd !== null &&
        cfg.costFixedFloorUsd > cfg.effectiveCostUsd + 1e-6
      ) {
        errors.push(
          `${filename} (${regime}): eligible config '${cfg.id}' costFixedFloorUsd ${cfg.costFixedFloorUsd} > effectiveCostUsd ${cfg.effectiveCostUsd}`,
        );
      }
      if (cfg.shrinkageFactor < MIN_FRONTIER_SHRINKAGE - 1e-6) {
        errors.push(
          `${filename} (${regime}): eligible config '${cfg.id}' shrinkageFactor ${cfg.shrinkageFactor} < ${MIN_FRONTIER_SHRINKAGE}`,
        );
      }
      if (cfg.costSource !== rm.costSource) {
        errors.push(
          `${filename} (${regime}): eligible config '${cfg.id}' costSource '${cfg.costSource}' !== regime '${rm.costSource}'`,
        );
      }
    }
    const eligibleByIdInRegime = new Map(regimeConfigs.map((c) => [c.id, c]));
    const regimeWeights = buildWeightMapFromAnchors(snap.anchorStats, regime);
    const regimeCalibratedIds = [...regimeWeights.keys()];
    if (rm.linkJointCov) {
      const expectedLinked = regimeCalibratedIds
        .filter((bmId) => {
          const anchorKey = regime === "standardized" ? `${bmId}::standardized` : bmId;
          return snap.anchorStats[anchorKey]?.linkedViaMeanSigma === true;
        })
        .toSorted(compareAscii);
      const actualLinked = [...rm.linkJointCov.benchmarkIds].toSorted(compareAscii);
      if (
        actualLinked.length !== expectedLinked.length ||
        actualLinked.some((id, idx) => id !== expectedLinked[idx])
      ) {
        errors.push(
          `${filename} (${regime}): linkJointCov benchmarkIds [${actualLinked.join(",")}] !== linked calibrated benchmarks [${expectedLinked.join(",")}]`,
        );
      } else {
        for (let k = 0; k < rm.linkJointCov.benchmarkIds.length; k++) {
          const bmId = rm.linkJointCov.benchmarkIds[k]!;
          const anchorKey = regime === "standardized" ? `${bmId}::standardized` : bmId;
          const st = snap.anchorStats[anchorKey];
          const covII = rm.linkJointCov.covMatrix[2 * k]?.[2 * k] ?? 0;
          const covIS = rm.linkJointCov.covMatrix[2 * k]?.[2 * k + 1] ?? 0;
          const covSS = rm.linkJointCov.covMatrix[2 * k + 1]?.[2 * k + 1] ?? 0;
          if (
            !st ||
            Math.abs(covII - (st.linkVarIntercept ?? 0)) > 1e-8 ||
            Math.abs(covIS - (st.linkCovIS ?? 0)) > 1e-8 ||
            Math.abs(covSS - (st.linkVarSlope ?? 0)) > 1e-8
          ) {
            errors.push(
              `${filename} (${regime}): linkJointCov diagonal block for '${bmId}' disagrees with anchorStats`,
            );
          }
        }
      }
    }
    const verdictOpts = {
      weightByBenchmark: regimeWeights,
      anchorStats: snap.anchorStats,
      ...(rm.linkJointCov ? { linkJointCov: rm.linkJointCov } : {}),
      shrinkageMode: archiveShrinkageMode,
    };
    // Always recompute missingOlderWeight strictly from frozen anchorStats.introducedAt so registry edits never disable archive checks
    const missingOlderByIdArchive = new Map<string, number>();
    for (const cfg of regimeConfigs) {
      const obsIds = new Set(cfg.benchmarks.map((b) => b.benchmarkId));
      let missingOlderW = 0;
      for (const bmId of rm.activeBenchmarkIds) {
        if (obsIds.has(bmId)) continue;
        const anchorKey = regime === "standardized" ? `${bmId}::standardized` : bmId;
        const st = snap.anchorStats[anchorKey];
        if (!st || !cfg.releaseDate) continue;
        if (st.introducedAt <= cfg.releaseDate) missingOlderW += st.effectiveWeight;
      }
      missingOlderByIdArchive.set(cfg.id, Number(missingOlderW.toFixed(6)));
    }
    const expectedSliceKeys = new Set<string>();
    const pricedInRegime = regimeConfigs.filter((c) => c.effectiveCostUsd !== null);
    for (const c of pricedInRegime) {
      expectedSliceKeys.add(`${c.provider}::all`);
      if (snap.domainId === "harnesses" && regime === "native") {
        if (NATIVE_SELECTABLE_HARNESSES.some((h) => h.id === c.harness)) {
          expectedSliceKeys.add(`${c.provider}::${c.harness}`);
        }
      }
    }

    const seenSliceKeys = new Set<string>();
    for (const pf of snap.frontiers) {
      if (pf.harnessRegime !== regime) continue;
      const sliceKey = `${pf.provider}::${pf.harnessFilter}`;
      if (seenSliceKeys.has(sliceKey)) {
        continue;
      }
      seenSliceKeys.add(sliceKey);
      if (!expectedSliceKeys.has(sliceKey)) {
        errors.push(`${filename} (${regime}): unexpected Pareto frontier slice '${sliceKey}'`);
      }

      const sliceConfigs = pricedInRegime.filter(
        (c) =>
          c.provider === pf.provider &&
          (pf.harnessFilter === "all" || c.harness === pf.harnessFilter),
      );
      const expected = computeProviderFrontier(
        sliceConfigs,
        undefined,
        undefined,
        regimeWeights,
        snap.anchorStats,
        rm.linkJointCov,
        archiveShrinkageMode,
      );
      const expectedImpMap = computeSliceImputationSensitivity(
        sliceConfigs,
        rm.tauResid,
        missingOlderByIdArchive,
        new Set(expected.frontier.map((p) => p.configId)),
        regimeWeights,
      );
      const sliceHasImputedCost = sliceConfigs.some((c) => c.costImputed);
      const expectedExactProbs = !sliceHasImputedCost
        ? computeBootstrapParetoProb(
            sliceConfigs,
            candidateSetBootstrapSeed(snap.epochVersion, regime, pf.provider, sliceConfigs),
            regimeCalibratedIds,
            rm.tauResid,
            10_000,
            regimeWeights,
            snap.anchorStats,
            null,
            rm.linkJointCov,
            archiveShrinkageMode,
          )
        : null;
      if (pf.harnessFilter === "all") {
        for (const cfg of sliceConfigs) {
          if (cfg.imputationSensitive !== (expectedImpMap.get(cfg.id) ?? false)) {
            errors.push(
              `${filename} (${regime}): eligible config '${cfg.id}' imputationSensitive (${cfg.imputationSensitive}) !== recomputed (${expectedImpMap.get(cfg.id) ?? false})`,
            );
          }
          if (
            expectedExactProbs &&
            Math.abs(cfg.paretoProb - (expectedExactProbs.get(cfg.id) ?? 0)) > 1e-6
          ) {
            errors.push(
              `${filename} (${regime}): eligible config '${cfg.id}' paretoProb (${cfg.paretoProb}) !== recomputed (${expectedExactProbs.get(cfg.id) ?? 0})`,
            );
          }
        }
      }
      const expectedFrontIds = expected.frontier.map((p) => p.configId);
      const actualFrontIds = pf.frontier.map((p) => p.configId);
      if (JSON.stringify(actualFrontIds) !== JSON.stringify(expectedFrontIds)) {
        errors.push(
          `${filename} (${regime}): frontier IDs for '${pf.provider}/${pf.harnessFilter}' do not match recomputed Pareto frontier`,
        );
      } else {
        for (let idx = 0; idx < expected.frontier.length; idx++) {
          const expPt = expected.frontier[idx]!;
          const actPt = pf.frontier[idx]!;
          const target = eligibleByIdInRegime.get(actPt.configId);
          if (
            actPt.zStepFromPrev !== expPt.zStepFromPrev ||
            actPt.pBetterThanPrev !== expPt.pBetterThanPrev ||
            actPt.statisticallyTied !== expPt.statisticallyTied ||
            actPt.marginalScorePerDollar !== expPt.marginalScorePerDollar ||
            actPt.costMultipleFromPrev !== expPt.costMultipleFromPrev
          ) {
            errors.push(
              `${filename} (${regime}): frontier point metrics for '${actPt.configId}' in '${sliceKey}' do not match recomputed values`,
            );
          }
          if (
            expectedImpMap &&
            actPt.imputationSensitive !== (expectedImpMap.get(actPt.configId) ?? false)
          ) {
            errors.push(
              `${filename} (${regime}): frontier point '${actPt.configId}' in '${sliceKey}' imputationSensitive (${actPt.imputationSensitive}) !== recomputed (${expectedImpMap.get(actPt.configId) ?? false})`,
            );
          }
          if (pf.harnessFilter === "all" && target) {
            if (Math.abs(actPt.paretoProb - target.paretoProb) > 1e-6) {
              errors.push(
                `${filename} (${regime}): frontier point '${actPt.configId}' in '${sliceKey}' paretoProb (${actPt.paretoProb}) !== config paretoProb (${target.paretoProb})`,
              );
            }
            if (actPt.imputationSensitive !== target.imputationSensitive) {
              errors.push(
                `${filename} (${regime}): frontier point '${actPt.configId}' in '${sliceKey}' imputationSensitive (${actPt.imputationSensitive}) !== config imputationSensitive (${target.imputationSensitive})`,
              );
            }
          }
          if (
            expectedExactProbs &&
            Math.abs(actPt.paretoProb - (expectedExactProbs.get(actPt.configId) ?? 0)) > 1e-6
          ) {
            errors.push(
              `${filename} (${regime}): frontier point '${actPt.configId}' in '${sliceKey}' paretoProb (${actPt.paretoProb}) !== recomputed (${expectedExactProbs.get(actPt.configId) ?? 0})`,
            );
          }
        }
      }
      const expectedPrunedPairs = expected.pruned.map((p) => `${p.configId}->${p.dominatedById}`);
      const actualPrunedPairs = pf.pruned.map((p) => `${p.configId}->${p.dominatedById}`);
      if (JSON.stringify(actualPrunedPairs) !== JSON.stringify(expectedPrunedPairs)) {
        errors.push(
          `${filename} (${regime}): pruned dominance pairs for '${pf.provider}/${pf.harnessFilter}' do not match recomputed Pareto dominance`,
        );
      } else {
        for (let idx = 0; idx < expected.pruned.length; idx++) {
          const expPr = expected.pruned[idx]!;
          const actPr = pf.pruned[idx]!;
          if (
            actPr.scoreDeficit !== expPr.scoreDeficit ||
            actPr.costRatio !== expPr.costRatio ||
            actPr.costComparisonNote !== expPr.costComparisonNote
          ) {
            errors.push(
              `${filename} (${regime}): pruned gap metrics for '${actPr.configId}' in '${sliceKey}' do not match recomputed values`,
            );
          }
        }
      }
      const expectedVerdicts = extractVerdictPicks(
        expected.frontier,
        eligibleByIdInRegime,
        verdictOpts,
      );
      if (
        pf.verdicts.budgetId !== expectedVerdicts.budgetId ||
        pf.verdicts.defaultId !== expectedVerdicts.defaultId ||
        pf.verdicts.maxId !== expectedVerdicts.maxId
      ) {
        errors.push(
          `${filename} (${regime}): verdicts for '${sliceKey}' (${JSON.stringify(pf.verdicts)}) !== recomputed (${JSON.stringify(expectedVerdicts)})`,
        );
      }
      const frontierIdSet = new Set(actualFrontIds);
      for (const pt of pf.frontier) {
        const target = eligibleByIdInRegime.get(pt.configId);
        if (!target || target.provider !== pf.provider) {
          errors.push(
            `${filename} (${regime}): frontier point '${pt.configId}' missing from eligible configs for '${pf.provider}'`,
          );
        }
      }
      for (const pr of pf.pruned) {
        const loser = eligibleByIdInRegime.get(pr.configId);
        const winner = eligibleByIdInRegime.get(pr.dominatedById);
        if (
          !loser ||
          loser.provider !== pf.provider ||
          !winner ||
          winner.provider !== pf.provider ||
          pr.dominatedById === pr.configId ||
          !frontierIdSet.has(pr.dominatedById)
        ) {
          errors.push(
            `${filename} (${regime}): pruned entry '${pr.configId}' -> '${pr.dominatedById}' invalid dominance reference for '${pf.provider}'`,
          );
        }
      }
    }
    for (const expKey of expectedSliceKeys) {
      if (!seenSliceKeys.has(expKey)) {
        errors.push(`${filename} (${regime}): missing Pareto frontier slice '${expKey}'`);
      }
    }
    let weightedDeltaSum = 0;
    let totalAnchorW = 0;
    const seenFrozenLineages = new Map<string, string>();
    const requireV2Metadata = archiveMajor !== null && archiveMajor >= 2;
    for (const bmId of rm.activeBenchmarkIds) {
      const anchorKey = regime === "standardized" ? `${bmId}::standardized` : bmId;
      const anchor = snap.anchorStats[anchorKey];
      if (
        !anchor ||
        anchor.benchmarkId !== bmId ||
        !Number.isFinite(anchor.mean) ||
        !Number.isFinite(anchor.sd) ||
        anchor.sd <= 0
      ) {
        errors.push(`${filename} (${regime}): missing or invalid frozen anchor '${anchorKey}'`);
      } else {
        weightedDeltaSum += anchor.effectiveWeight * anchor.raschDelta;
        totalAnchorW += anchor.effectiveWeight;
        if (requireV2Metadata) {
          if (
            anchor.redundancyFactor === undefined ||
            !anchor.taskFamily ||
            !anchor.datasetLineageId
          ) {
            errors.push(
              `${filename} (${regime}): v${archiveMajor} anchor '${anchorKey}' missing required redundancyFactor, taskFamily, or datasetLineageId`,
            );
          } else {
            const prevBm = seenFrozenLineages.get(anchor.datasetLineageId);
            if (prevBm) {
              errors.push(
                `${filename} (${regime}): duplicate frozen datasetLineageId '${anchor.datasetLineageId}' on '${prevBm}' and '${bmId}'`,
              );
            } else {
              seenFrozenLineages.set(anchor.datasetLineageId, bmId);
            }
            const expectedW = Math.min(
              1,
              Math.max(0.1, anchor.reliability * anchor.discrimination * anchor.redundancyFactor),
            );
            if (Math.abs(anchor.effectiveWeight - expectedW) > 1e-3) {
              errors.push(
                `${filename} (${regime}): anchor '${anchorKey}' effectiveWeight ${anchor.effectiveWeight} !== clamp(rho*phi*red) (${expectedW.toFixed(4)})`,
              );
            }
          }
        }
      }
    }
    if (totalAnchorW > 0 && Math.abs(weightedDeltaSum) > 1e-3) {
      errors.push(
        `${filename} (${regime}): Rasch delta gauge drift sum(w*delta)=${weightedDeltaSum.toFixed(6)} !== 0`,
      );
    }
  }

  // Verify archived benchmark uniqueness, regime membership, declared version consistency, EB posterior, and display score arithmetic
  const allStatsByRegime = new Map<HarnessRegime, (RemlPriorPoint & { exact: boolean })[]>();
  for (const cfg of [...snap.configs, ...snap.provisionalConfigs]) {
    const rm = snap.regimeMeta[cfg.harnessRegime];
    const allowedBmIds = new Set(rm?.activeBenchmarkIds ?? []);
    const seenBmIds = new Set<string>();
    for (const bm of cfg.benchmarks) {
      if (seenBmIds.has(bm.benchmarkId)) {
        errors.push(`${filename}: ${cfg.id} has duplicate benchmark '${bm.benchmarkId}'`);
      }
      if (!allowedBmIds.has(bm.benchmarkId)) {
        errors.push(
          `${filename}: ${cfg.id} contains benchmark '${bm.benchmarkId}' outside regime activeBenchmarkIds`,
        );
      }
      const declaredVersion = snap.benchmarkVersions[bm.benchmarkId];
      if (!declaredVersion || bm.benchmarkVersion !== declaredVersion) {
        errors.push(
          `${filename}: ${cfg.id}/${bm.benchmarkId} version '${bm.benchmarkVersion}' !== archive benchmarkVersions '${declaredVersion ?? "missing"}'`,
        );
      }
      seenBmIds.add(bm.benchmarkId);
    }
    if (cfg.coverageCount !== seenBmIds.size || cfg.coverageCount !== cfg.benchmarks.length) {
      errors.push(`${filename}: ${cfg.id} coverageCount !== unique benchmark count`);
    }
    const expectedScore = Number((DISPLAY_BASE + DISPLAY_SPREAD * cfg.theta).toFixed(2));
    if (Math.abs(cfg.score - expectedScore) > 0.02) {
      errors.push(`${filename}: ${cfg.id} score ${cfg.score} !== 50 + 15*theta (${expectedScore})`);
    }
    let sumWeightedAdj = 0;
    let sumWeights = 0;
    let allAnchorsPresent = true;
    for (const bm of cfg.benchmarks) {
      const key =
        cfg.harnessRegime === "standardized" ? `${bm.benchmarkId}::standardized` : bm.benchmarkId;
      const anchor = snap.anchorStats[key];
      if (!anchor || anchor.sd <= 0 || anchor.effectiveWeight <= 0) {
        errors.push(`${filename}: ${cfg.id} missing frozen anchor '${key}'`);
        allAnchorsPresent = false;
        continue;
      }
      const w = anchor.effectiveWeight;
      // Orient strictly from frozen anchor.invertScore so future live registry changes never alter historical archive replay
      const oriented = anchor.invertScore ? -bm.rawScore : bm.rawScore;
      const expectedZ = clampZScore((oriented - anchor.mean) / anchor.sd);
      if (Math.abs(bm.zScore - expectedZ) > 0.002) {
        errors.push(
          `${filename}: ${cfg.id}/${bm.benchmarkId} zScore ${bm.zScore} !== ${expectedZ.toFixed(4)}`,
        );
      }
      sumWeightedAdj += w * (expectedZ - anchor.raschDelta);
      sumWeights += w;
    }
    if (allAnchorsPresent && sumWeights > 0 && rm) {
      const thetaMle = sumWeightedAdj / sumWeights;
      const expectedThetaFromB = rm.priorMean + cfg.shrinkageFactor * (thetaMle - rm.priorMean);
      if (Math.abs(cfg.theta - expectedThetaFromB) > 1e-3) {
        errors.push(
          `${filename}: ${cfg.id} theta ${cfg.theta} !== priorMean + shrinkage * (thetaMle - priorMean) (${expectedThetaFromB.toFixed(6)})`,
        );
      }
      const post = computeConfigPosterior(
        cfg.benchmarks,
        snap.anchorStats,
        cfg.harnessRegime,
        rm.activeBenchmarkIds,
        rm.withheldBenchmarkIds,
        rm.calibrationTauResidSq,
        rm.priorMean,
        rm.tauModelSq,
        undefined,
        rm.linkJointCov,
        archiveShrinkageMode,
      );
      if (!post?.exactSeRecomputable) {
        errors.push(
          `${filename}: ${cfg.id} posterior uncertainty cannot be recomputed from persisted SE metadata`,
        );
      } else {
        if (cfg.eligibleForFrontier && post.infoReliability < MIN_FRONTIER_SHRINKAGE - 1e-6) {
          errors.push(
            `${filename}: eligible config '${cfg.id}' infoReliability ${post.infoReliability} < ${MIN_FRONTIER_SHRINKAGE}`,
          );
        }
        const withheldSet = new Set(rm.withheldBenchmarkIds);
        const calibratedIds = rm.activeBenchmarkIds.filter((id) => !withheldSet.has(id));
        const list = allStatsByRegime.get(cfg.harnessRegime) ?? [];
        list.push({
          thetaMle: post.thetaMle,
          totalVar: post.fpcTerm + post.measTerm,
          provider: cfg.provider,
          modelSlug: cfg.modelSlug,
          residCoeffs: buildResidCoeffs(
            new Set(cfg.benchmarks.map((b) => b.benchmarkId)),
            calibratedIds,
            snap.anchorStats,
            cfg.harnessRegime,
            rm.calibrationTauResidSq,
          ),
          linkTerms: buildRemlLinkTerms(cfg.benchmarks, snap.anchorStats, cfg.harnessRegime),
          exact: post.exactSeRecomputable,
        });
        allStatsByRegime.set(cfg.harnessRegime, list);
        if (Math.abs(cfg.shrinkageFactor - post.shrinkageFactor) > 1e-3) {
          errors.push(
            `${filename}: ${cfg.id} shrinkageFactor ${cfg.shrinkageFactor} !== recomputed ${post.shrinkageFactor}`,
          );
        }
        if (Math.abs(cfg.theta - post.theta) > 1e-3) {
          errors.push(`${filename}: ${cfg.id} theta ${cfg.theta} !== recomputed ${post.theta}`);
        }
        if (Math.abs(cfg.se - post.se) > 0.03) {
          errors.push(`${filename}: ${cfg.id} se ${cfg.se} !== recomputed ${post.se}`);
        }
        if (Math.abs(cfg.samplingSe - post.samplingSe) > 0.02) {
          errors.push(
            `${filename}: ${cfg.id} samplingSe ${cfg.samplingSe} !== recomputed ${post.samplingSe}`,
          );
        }
        if (Math.abs(cfg.residualSe - post.residualSe) > 0.02) {
          errors.push(
            `${filename}: ${cfg.id} residualSe ${cfg.residualSe} !== recomputed ${post.residualSe}`,
          );
        }
      }
    }
  }

  for (const regime of regimes) {
    const rm = snap.regimeMeta[regime];
    const allStats = allStatsByRegime.get(regime) ?? [];
    if (rm && allStats.length >= 6 && allStats.every((m) => m.exact)) {
      const fitted = fitHeteroscedasticRemlPrior(allStats, rm.linkJointCov);
      if (Math.abs(rm.priorMean - fitted.priorMean) > 5e-3) {
        errors.push(
          `${filename} (${regime}): priorMean ${rm.priorMean} !== recomputed ${fitted.priorMean.toFixed(6)}`,
        );
      }
      if (Math.abs(rm.tauModelSq - fitted.tauModelSq) > 5e-3) {
        errors.push(
          `${filename} (${regime}): tauModelSq ${rm.tauModelSq} !== recomputed ${fitted.tauModelSq.toFixed(6)}`,
        );
      }
    }
  }
  return errors;
}

function assertFrozenEpochMatchesRegistry(
  domainId: DomainId,
  epochVersion: string,
  frozenEpoch: DomainSnapshot,
  allActiveIds: readonly string[],
  benchmarkVersions: Readonly<Record<string, string>>,
  regimes: readonly HarnessRegime[],
): void {
  if (majorEpochFilename(frozenEpoch.epochVersion) !== majorEpochFilename(epochVersion)) {
    throw new Error(
      `${domainId}: frozen epoch version ${frozenEpoch.epochVersion} mismatches ${epochVersion}`,
    );
  }
  if (JSON.stringify(frozenEpoch.activeBenchmarkIds) !== JSON.stringify(allActiveIds)) {
    throw new Error(
      `${domainId}: active benchmark roster changed without bumping MAJOR epoch (${epochVersion})`,
    );
  }
  if (JSON.stringify(frozenEpoch.benchmarkVersions) !== JSON.stringify(benchmarkVersions)) {
    throw new Error(
      `${domainId}: active benchmark versions changed without bumping MAJOR epoch (${epochVersion})`,
    );
  }

  const expectedAnchorKeys = new Set<string>();
  for (const regime of regimes) {
    const expectedActiveBms = getActiveBenchmarksForRegime(domainId, regime);
    const expectedActive = expectedActiveBms.map((b) => b.id);
    const expectedActiveSet = new Set(expectedActive);
    const expectedFloor = getCoverageFloorForDomain(domainId, expectedActive.length);
    const frozenMeta = frozenEpoch.regimeMeta[regime];
    if (!frozenMeta) {
      throw new Error(`${domainId}: frozen MAJOR epoch missing regimeMeta '${regime}'`);
    }
    if (
      JSON.stringify(frozenMeta.activeBenchmarkIds) !== JSON.stringify(expectedActive) ||
      frozenMeta.coverageFloor !== expectedFloor
    ) {
      throw new Error(
        `${domainId}/${regime}: regime roster drifted from frozen MAJOR epoch ${frozenEpoch.epochVersion}`,
      );
    }

    const withheldSet = new Set(frozenMeta.withheldBenchmarkIds);
    const expectedMeasuredIds = expectedActiveBms
      .filter((b) => b.providesMeasuredCost && !withheldSet.has(b.id))
      .map((b) => b.id);
    const expectedCostSource: CostSource =
      domainId === "writing" ? "list" : expectedMeasuredIds.length > 0 ? "measured" : "suite";
    if (
      frozenMeta.costSource !== expectedCostSource ||
      JSON.stringify(frozenMeta.measuredCostBenchmarkIds) !== JSON.stringify(expectedMeasuredIds)
    ) {
      throw new Error(
        `${domainId}/${regime}: cost axis or measured-cost basket drifted from frozen MAJOR epoch ${frozenEpoch.epochVersion}`,
      );
    }
    for (const w of withheldSet) {
      if (!expectedActiveSet.has(w)) {
        throw new Error(`${domainId}/${regime}: frozen withheld benchmark '${w}' is not active`);
      }
    }
    for (const bmId of expectedActive) {
      if (withheldSet.has(bmId)) continue;
      expectedAnchorKeys.add(regime === "standardized" ? `${bmId}::standardized` : bmId);
    }
  }

  const frozenAnchorKeys = new Set(Object.keys(frozenEpoch.anchorStats));
  for (const k of expectedAnchorKeys) {
    if (!frozenAnchorKeys.has(k)) {
      throw new Error(`${domainId}: frozen MAJOR epoch missing anchor '${k}'`);
    }
  }
  for (const k of frozenAnchorKeys) {
    if (!expectedAnchorKeys.has(k)) {
      throw new Error(`${domainId}: frozen MAJOR epoch contains stale anchor '${k}'`);
    }
  }
}

// Seed Monte Carlo bootstrap draws by sorted candidate membership so identical candidate sets yield identical paretoProb
function candidateSetBootstrapSeed(
  epochVersion: string,
  regime: HarnessRegime,
  provider: string,
  candidates: readonly EvaluatedConfig[],
): string {
  const memberHash = crypto
    .createHash("sha256")
    .update(
      candidates
        .map((c) => c.id)
        .toSorted(compareAscii)
        .join("|"),
    )
    .digest("hex")
    .slice(0, 12);
  return `${epochVersion}:${regime}:${provider}:${memberHash}`;
}

export function buildDomainFrontiers(
  domainId: DomainId,
  epochVersion: string,
  eligibleConfigs: readonly EvaluatedConfig[],
  tauResidByRegime?: Readonly<Partial<Record<HarnessRegime, number>>>,
  missingOlderById?: ReadonlyMap<string, number>,
  anchorStats?: Readonly<Record<string, AnchorStats>>,
  costBootstrapModelByRegime?: Readonly<
    Partial<Record<HarnessRegime, DomainCostBootstrapModel | PartialBasketCostModel | null>>
  >,
  linkJointCovByRegime?: Readonly<Partial<Record<HarnessRegime, LinkJointCov | undefined>>>,
): ProviderFrontier[] {
  const configById = new Map(eligibleConfigs.map((c) => [c.id, c]));
  const frontiers: ProviderFrontier[] = [];

  const regimes = getRegimesForDomain(domainId);

  for (const regime of regimes) {
    const regimeConfigs = eligibleConfigs.filter((c) => c.harnessRegime === regime);
    const tauResid = tauResidByRegime?.[regime] ?? 0;
    const weights = anchorStats ? buildWeightMapFromAnchors(anchorStats, regime) : undefined;
    const costBootstrapModel = costBootstrapModelByRegime?.[regime] ?? null;
    const linkJointCov = linkJointCovByRegime?.[regime];

    for (const provider of ALL_PROVIDER_IDS) {
      const providerConfigs = regimeConfigs.filter((c) => c.provider === provider);
      if (providerConfigs.length === 0) continue;

      const cachedProbsBySeed = new Map<string, Map<string, number>>();
      const regimeCalibratedIds =
        weights !== undefined
          ? [...weights.keys()]
          : getActiveBenchmarksForRegime(domainId, regime).map((b) => b.id);
      const getProbs = (subset: readonly EvaluatedConfig[]) => {
        const seed = candidateSetBootstrapSeed(epochVersion, regime, provider, subset);
        const existing = cachedProbsBySeed.get(seed);
        if (existing) return existing;
        const computed = computeBootstrapParetoProb(
          subset,
          seed,
          regimeCalibratedIds,
          tauResid,
          10_000,
          weights,
          anchorStats,
          costBootstrapModel,
          linkJointCov,
        );
        cachedProbsBySeed.set(seed, computed);
        return computed;
      };

      const allProbs = getProbs(providerConfigs);
      const baseAll = computeProviderFrontier(
        providerConfigs,
        allProbs,
        undefined,
        weights,
        anchorStats,
        linkJointCov,
      );
      const allImpMap = missingOlderById
        ? computeSliceImputationSensitivity(
            providerConfigs,
            tauResid,
            missingOlderById,
            new Set(baseAll.frontier.map((p) => p.configId)),
            weights,
          )
        : undefined;
      const { frontier, pruned } = computeProviderFrontier(
        providerConfigs,
        allProbs,
        allImpMap,
        weights,
        anchorStats,
        linkJointCov,
      );
      const verdictOpts = {
        ...(weights ? { weightByBenchmark: weights } : {}),
        ...(anchorStats ? { anchorStats } : {}),
        ...(linkJointCov ? { linkJointCov } : {}),
      };
      const verdicts = extractVerdictPicks(frontier, configById, verdictOpts);

      frontiers.push({
        provider,
        harnessRegime: regime,
        harnessFilter: "all",
        frontier,
        pruned,
        verdicts,
      });

      if (domainId === "harnesses" && regime === "native") {
        for (const h of NATIVE_SELECTABLE_HARNESSES) {
          const subset = providerConfigs.filter((c) => c.harness === h.id);
          if (subset.length === 0) continue;
          const hProbs = getProbs(subset);
          const baseSub = computeProviderFrontier(
            subset,
            hProbs,
            undefined,
            weights,
            anchorStats,
            linkJointCov,
          );
          const subImpMap = missingOlderById
            ? computeSliceImputationSensitivity(
                subset,
                tauResid,
                missingOlderById,
                new Set(baseSub.frontier.map((p) => p.configId)),
                weights,
              )
            : undefined;
          const sub = computeProviderFrontier(
            subset,
            hProbs,
            subImpMap,
            weights,
            anchorStats,
            linkJointCov,
          );
          frontiers.push({
            provider,
            harnessRegime: regime,
            harnessFilter: h.id,
            frontier: sub.frontier,
            pruned: sub.pruned,
            verdicts: extractVerdictPicks(sub.frontier, configById, verdictOpts),
          });
        }
      }
    }
  }

  return frontiers;
}

export function compileDomainsFromSources(
  results: readonly CachedSourceFile[],
  frozenByDomain: ReadonlyMap<DomainId, DomainSnapshot | null>,
  prevMajorByDomain: ReadonlyMap<DomainId, { name: string; snap: DomainSnapshot } | null>,
): {
  domainsRecord: Record<DomainId, DomainSnapshot>;
  harnessLeaderboard: HarnessLeaderboardSnapshot;
  canonicalHash: string;
  unmapped: UnmappedRecord[];
  epochLinkNotes: string[];
} {
  const pricingBySlug = new Map<string, PricingRecord>();
  const allPricingRecords: PricingRecord[] = [];

  // First-party LiteLLM verified API tariffs
  const orderedPricingResults = results.filter((r) => r.health.sourceId === "pricing");

  for (const r of orderedPricingResults) {
    for (const p of r.payload.pricing) {
      allPricingRecords.push(p);
      const prev = pricingBySlug.get(p.modelSlug);
      if (!prev) {
        pricingBySlug.set(p.modelSlug, p);
      } else {
        const isFirstPartyText = p.sourceId === "litellm";
        pricingBySlug.set(p.modelSlug, {
          ...prev,
          servingProvider: isFirstPartyText ? p.servingProvider : prev.servingProvider,
          apiSku: isFirstPartyText ? p.apiSku : (prev.apiSku ?? p.apiSku),
          inputPer1mUsd: isFirstPartyText ? p.inputPer1mUsd : prev.inputPer1mUsd,
          outputPer1mUsd: isFirstPartyText ? p.outputPer1mUsd : prev.outputPer1mUsd,
          cachedInputPer1mUsd: isFirstPartyText
            ? p.cachedInputPer1mUsd
            : (prev.cachedInputPer1mUsd ?? p.cachedInputPer1mUsd),
          contextWindow: p.contextWindow ?? prev.contextWindow,
          releaseDate: p.releaseDate ?? prev.releaseDate,
          sourceId: isFirstPartyText ? p.sourceId : prev.sourceId,
        });
      }
    }
  }

  const { cellsByDomain, unmapped } = extractAcceptedCellsFromSources(results);

  const domainsRecord = {} as Record<DomainId, DomainSnapshot>;
  const epochLinkNotes: string[] = [];

  for (const domain of DOMAINS) {
    const activeBenchmarks = getActiveBenchmarks(domain.id);
    const candidateBenchmarks = getCandidateBenchmarks(domain.id);
    const allActiveIds = activeBenchmarks.map((b) => b.id);
    const candidateIds = candidateBenchmarks.map((b) => b.id);
    const benchmarkVersions: Record<string, string> = Object.fromEntries(
      activeBenchmarks.map((b) => [b.id, b.version]),
    );
    const regimes = getRegimesForDomain(domain.id);

    const frozenEpoch = frozenByDomain.get(domain.id) ?? null;
    if (frozenEpoch) {
      assertFrozenEpochMatchesRegistry(
        domain.id,
        domain.epochVersion,
        frozenEpoch,
        allActiveIds,
        benchmarkVersions,
        regimes,
      );
    }

    const dedupedCells = cellsByDomain.get(domain.id) ?? [];
    const frozenAnchors = frozenEpoch?.anchorStats;
    const prevEntry = prevMajorByDomain.get(domain.id) ?? null;

    const allEligible: EvaluatedConfig[] = [];
    const allProvisional: EvaluatedConfig[] = [];
    const mergedAnchors: Record<string, AnchorStats> = frozenAnchors ? { ...frozenAnchors } : {};
    const regimeMetaRecord = {} as Record<HarnessRegime, RegimeMeta>;
    const tauResidByRegime: Partial<Record<HarnessRegime, number>> = {};
    const costBootstrapModelByRegime: Partial<
      Record<HarnessRegime, DomainCostBootstrapModel | null>
    > = {};
    const linkJointCovByRegime: Partial<Record<HarnessRegime, LinkJointCov | undefined>> = {};
    const missingOlderById = new Map<string, number>();

    for (const regime of regimes) {
      const regimeActiveIds = getActiveBenchmarksForRegime(domain.id, regime).map((b) => b.id);
      const regimeCells = dedupedCells.filter((c) => c.harnessRegime === regime);
      const regimeFrozen = extractRegimeAnchors(frozenAnchors, regime);
      const frozenRegimeMeta = frozenEpoch?.regimeMeta[regime];

      const agg = aggregateDomain(
        regimeCells,
        regimeActiveIds,
        domain.minLabsForSaturation,
        regimeFrozen,
        frozenRegimeMeta?.withheldBenchmarkIds,
        frozenRegimeMeta?.calibrationTauResidSq,
        getCoverageFloorForDomain(domain.id, regimeActiveIds.length),
        getAnchorMinCoverageForDomain(domain.id, regimeActiveIds.length),
        frozenRegimeMeta?.tauModelSq,
        frozenRegimeMeta?.priorMean,
        frozenRegimeMeta?.linkJointCov,
      );
      linkJointCovByRegime[regime] = agg.linkJointCov;

      for (const [k, v] of Object.entries(agg.anchorStats)) {
        const storageKey = regime === "standardized" ? `${k}::standardized` : k;
        if (!mergedAnchors[storageKey]) {
          mergedAnchors[storageKey] = v;
        }
      }

      const tauResid = Number(agg.tauResid.toFixed(4));
      tauResidByRegime[regime] = tauResid;

      const combined = [...agg.eligible, ...agg.provisional];
      const expectedMeasuredBenchmarkIds = getActiveBenchmarksForRegime(domain.id, regime)
        .filter((b) => b.providesMeasuredCost && !agg.withheldBenchmarkIds.includes(b.id))
        .map((b) => b.id);
      const expectedCostSource: CostSource =
        domain.id === "writing"
          ? "list"
          : expectedMeasuredBenchmarkIds.length > 0
            ? "measured"
            : "suite";
      const { costs: costMap, costBootstrapModel: rawCostModel } = resolveDomainCostsWithModel(
        domain.id,
        combined,
        pricingBySlug,
        expectedMeasuredBenchmarkIds,
      );
      const remappedPartialEntries = new Map<string, PartialBasketConfigModel>();
      const remappedSiblingEntries = new Map<string, SiblingBaselineCostEntry>();
      const remappedOlsEntries = new Map<
        string,
        { xVec: readonly number[]; predMeanLog: number }
      >();
      const remappedUnidCellEntries = new Map<string, UnidentifiedCellCostEntry>();

      const hydrate = (
        list: typeof agg.eligible,
      ): { eligible: EvaluatedConfig[]; unpriced: EvaluatedConfig[] } => {
        const pricedOut: EvaluatedConfig[] = [];
        const unpricedOut: EvaluatedConfig[] = [];

        for (const item of list) {
          const cost = costMap.get(item.configId)!;
          const isPriced = cost.effectiveCostUsd !== null && cost.effectiveCostUsd > 0;
          const hasPublicApiPrice = cost.inputPer1mUsd !== null && cost.outputPer1mUsd !== null;
          const canEnterFrontier =
            item.eligibleForFrontier &&
            isPriced &&
            hasPublicApiPrice &&
            !isRetiredPurchaseSku(item.provider, item.modelSlug);

          // Relabel heterogeneous native harness stacks strictly inside the Harnesses domain
          const distinctObserved = new Set(
            item.benchmarks.map((b) => b.observedHarness).filter((h): h is string => h !== null),
          );
          const resolvedHarness: HarnessId =
            domain.id === "harnesses" && item.harness === "direct" && distinctObserved.size > 1
              ? "multi-harness"
              : item.harness;
          const resolvedId =
            resolvedHarness === item.harness
              ? item.configId
              : `${item.provider}:${item.modelSlug}:${item.effort}:${resolvedHarness}:${item.harnessRegime}`;

          missingOlderById.set(resolvedId, item.missingOlderCount);
          const rawPb = rawCostModel?.partialBasket?.byConfigId.get(item.configId);
          if (rawPb) remappedPartialEntries.set(resolvedId, rawPb);
          const rawSib = rawCostModel?.siblingBaselines.get(item.configId);
          if (rawSib) remappedSiblingEntries.set(resolvedId, rawSib);
          const rawOls = rawCostModel?.olsModel?.byConfigId.get(item.configId);
          if (rawOls) remappedOlsEntries.set(resolvedId, rawOls);
          const rawUc = rawCostModel?.unidentifiedCells.get(item.configId);
          if (rawUc) remappedUnidCellEntries.set(resolvedId, rawUc);

          const cfg: EvaluatedConfig = {
            id: resolvedId,
            provider: item.provider,
            modelSlug: item.modelSlug,
            displayName: item.displayName,
            effort: item.effort,
            harness: resolvedHarness,
            harnessRegime: item.harnessRegime,
            domainId: domain.id,
            theta: item.theta,
            shrinkageFactor: item.shrinkageFactor,
            score: item.score,
            se: item.se,
            samplingSe: item.samplingSe,
            residualSe: item.residualSe,
            coverageCount: item.coverageCount,
            activeBenchmarkCount: item.activeBenchmarkCount,
            eligibleForFrontier: canEnterFrontier,
            imputationSensitive: false,
            effectiveCostUsd: cost.effectiveCostUsd,
            ...(cost.costFixedFloorUsd !== undefined && cost.costFixedFloorUsd > 0
              ? { costFixedFloorUsd: cost.costFixedFloorUsd }
              : {}),
            ...(cost.costLogSd !== undefined && cost.costLogSd > 0
              ? { costLogSd: cost.costLogSd }
              : {}),
            ...(cost.costMinUsd !== undefined && cost.costMinUsd > 0
              ? { costMinUsd: cost.costMinUsd }
              : {}),
            ...(cost.costMaxUsd !== undefined && cost.costMaxUsd > 0
              ? { costMaxUsd: cost.costMaxUsd }
              : {}),
            costImputed: cost.costImputed,
            costEstimated: cost.costEstimated,
            usesFallbackRouting: item.usesFallbackRouting,
            costUnit: cost.costUnit,
            costSource: cost.costSource,
            blendedListPricePer1mUsd: cost.blendedListPricePer1mUsd,
            inputPer1mUsd: cost.inputPer1mUsd,
            outputPer1mUsd: cost.outputPer1mUsd,
            contextWindow: cost.contextWindow,
            releaseDate: item.releaseDate,
            paretoProb: 0,
            benchmarks: item.benchmarks,
          };

          if (canEnterFrontier) pricedOut.push(cfg);
          else unpricedOut.push(cfg);
        }

        return { eligible: pricedOut, unpriced: unpricedOut };
      };

      const hydratedEligible = hydrate(agg.eligible);
      const hydratedProvisional = hydrate(agg.provisional);
      const regimeEligible = hydratedEligible.eligible;
      const regimeProvisional = [
        ...hydratedEligible.unpriced,
        ...hydratedProvisional.eligible,
        ...hydratedProvisional.unpriced,
      ];

      const remappedPartialBasket: PartialBasketCostModel | null =
        rawCostModel?.partialBasket && remappedPartialEntries.size > 0
          ? { ...rawCostModel.partialBasket, byConfigId: remappedPartialEntries }
          : null;
      const remappedOlsModel =
        rawCostModel?.olsModel && remappedOlsEntries.size > 0
          ? { ...rawCostModel.olsModel, byConfigId: remappedOlsEntries }
          : null;
      const regimeCostBootstrapModel: DomainCostBootstrapModel | null =
        remappedPartialBasket !== null ||
        remappedSiblingEntries.size > 0 ||
        remappedOlsModel !== null ||
        remappedUnidCellEntries.size > 0
          ? {
              partialBasket: remappedPartialBasket,
              siblingBaselines: remappedSiblingEntries,
              olsModel: remappedOlsModel,
              unidentifiedCells: remappedUnidCellEntries,
            }
          : null;
      costBootstrapModelByRegime[regime] = regimeCostBootstrapModel;

      // Compute primary-frontier paretoProb & weighted counterfactual relative-shift imputation sensitivity
      const regimeWeights = buildWeightMapFromAnchors(mergedAnchors, regime);
      const regimeCalibratedIds = [...regimeWeights.keys()];
      for (const provider of ALL_PROVIDER_IDS) {
        const group = regimeEligible.filter((c) => c.provider === provider);
        if (group.length === 0) continue;

        const probs = computeBootstrapParetoProb(
          group,
          candidateSetBootstrapSeed(domain.epochVersion, regime, provider, group),
          regimeCalibratedIds,
          tauResid,
          10_000,
          regimeWeights,
          mergedAnchors,
          regimeCostBootstrapModel,
          agg.linkJointCov,
        );
        const baseFrontierIds = new Set(
          computeProviderFrontier(
            group,
            probs,
            undefined,
            regimeWeights,
            mergedAnchors,
            agg.linkJointCov,
          ).frontier.map((p) => p.configId),
        );
        const impMap = computeSliceImputationSensitivity(
          group,
          tauResid,
          missingOlderById,
          baseFrontierIds,
          regimeWeights,
        );

        for (const cfg of group) {
          cfg.paretoProb = probs.get(cfg.id) ?? 0;
          cfg.imputationSensitive = impMap.get(cfg.id) ?? false;
        }
      }

      // Per-regime longitudinal Mean-Sigma linking across ALL score-qualified configs using stable canonical harness identity
      let epochLink: EpochLink | null = null;
      if (prevEntry) {
        const prevRegimeIds =
          prevEntry.snap.regimeMeta[regime]?.activeBenchmarkIds ??
          prevEntry.snap.activeBenchmarkIds;
        const prevFloor =
          prevEntry.snap.regimeMeta[regime]?.coverageFloor ??
          getCoverageFloorForDomain(domain.id, new Set(prevRegimeIds).size);
        const prevQualified = [
          ...prevEntry.snap.configs,
          ...prevEntry.snap.provisionalConfigs,
        ].filter((c) => c.harnessRegime === regime && c.coverageCount >= prevFloor);
        const prevThetaByKey = new Map(prevQualified.map((c) => [canonicalLinkKey(c), c.theta]));
        const curQualified = [...regimeEligible, ...regimeProvisional].filter(
          (c) => c.coverageCount >= agg.coverageFloor,
        );
        const overlap = curQualified
          .filter((c) => prevThetaByKey.has(canonicalLinkKey(c)))
          .map((c) => ({
            provider: c.provider,
            oldTheta: prevThetaByKey.get(canonicalLinkKey(c))!,
            newTheta: c.theta,
          }));
        epochLink = linkEpochScores(
          prevEntry.snap.epochVersion,
          overlap,
          domain.minLabsForSaturation,
        );
        epochLinkNotes.push(
          `${domain.epochVersion}/${regime} vs ${prevEntry.name}: ${epochLink.reason}`,
        );
      }

      regimeMetaRecord[regime] = {
        activeBenchmarkIds: regimeActiveIds,
        costSource: expectedCostSource,
        measuredCostBenchmarkIds: expectedMeasuredBenchmarkIds,
        coverageFloor: agg.coverageFloor,
        tauResid,
        calibrationTauResidSq: agg.calibrationTauResidSq,
        priorMean: agg.priorMean,
        tauModelSq: agg.tauModelSq,
        // Preserve the frozen MAJOR calibration lab count once archived so minor later row drops do not rewrite anchor metadata
        anchorLabs: frozenRegimeMeta?.anchorLabs ?? agg.anchorLabs,
        withheldBenchmarkIds: agg.withheldBenchmarkIds,
        ...(agg.linkJointCov ? { linkJointCov: agg.linkJointCov } : {}),
        epochLink,
      };

      allEligible.push(...regimeEligible);
      allProvisional.push(...regimeProvisional);
    }

    const defaultRegimeMeta = regimeMetaRecord[domain.defaultRegime];
    const frontiers = buildDomainFrontiers(
      domain.id,
      domain.epochVersion,
      allEligible,
      tauResidByRegime,
      missingOlderById,
      mergedAnchors,
      costBootstrapModelByRegime,
      linkJointCovByRegime,
    );

    domainsRecord[domain.id] = {
      domainId: domain.id,
      epochVersion: domain.epochVersion,
      costUnit: domain.costUnit,
      activeBenchmarkIds: allActiveIds,
      candidateBenchmarkIds: candidateIds,
      benchmarkVersions,
      coverageFloor: defaultRegimeMeta.coverageFloor,
      tauResid: defaultRegimeMeta.tauResid,
      regimeMeta: regimeMetaRecord,
      anchorStats: mergedAnchors,
      configs: allEligible.toSorted((a, b) => b.score - a.score || compareAscii(a.id, b.id)),
      provisionalConfigs: allProvisional.toSorted(
        (a, b) => b.score - a.score || compareAscii(a.id, b.id),
      ),
      frontiers,
    };
  }

  const rawFrontierHarness = results.find((r) => r.health.sourceId === "frontier-harness")?.payload
    .harnessLeaderboard;
  if (!rawFrontierHarness) {
    throw new Error("Missing mandatory harnessLeaderboard payload from frontier-harness source");
  }
  const rawTb21DeepSwe = results.find((r) => r.health.sourceId === "harness-leaderboard")?.payload
    .harnessLeaderboard;
  if (!rawTb21DeepSwe) {
    throw new Error("Missing mandatory harnessLeaderboard payload from harness-leaderboard source");
  }
  const harnessLeaderboard = HarnessLeaderboardSnapshotSchema.parse(
    mergeControlledHarnessSuites(
      recomputeHarnessLeaderboard(rawFrontierHarness),
      recomputeHarnessLeaderboard(rawTb21DeepSwe),
    ),
  );

  const canonicalHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ domains: domainsRecord, harnessLeaderboard }))
    .digest("hex")
    .slice(0, 16);

  return {
    domainsRecord,
    harnessLeaderboard,
    canonicalHash,
    unmapped,
    epochLinkNotes,
  };
}

async function atomicWriteJson(targetPath: string, data: unknown): Promise<void> {
  const tmpPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fsyncFile(tmpPath);
  await fs.rename(tmpPath, targetPath);
  await fsyncDir(path.dirname(targetPath));
}

export interface RunIngestionOptions {
  dataDir?: string;
  shrinkStatePath?: string;
}

export async function runIngestion(options: RunIngestionOptions = {}): Promise<ProChoiceSnapshot> {
  const nowIso = new Date().toISOString();
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const epochsDir = path.join(dataDir, "epochs");
  await fs.mkdir(epochsDir, { recursive: true });
  return withPublishLock(() =>
    runIngestionLocked(nowIso, dataDir, epochsDir, options.shrinkStatePath),
  );
}

async function runIngestionLocked(
  nowIso: string,
  dataDir: string,
  epochsDir: string,
  shrinkStatePath?: string,
): Promise<ProChoiceSnapshot> {
  const isLiveDataDir = await isSameDirectory(dataDir, DEFAULT_DATA_DIR);
  if (isLiveDataDir) {
    await recoverPendingSyncCommit(dataDir);
    await recoverPendingRawCacheSwap(dataDir);
    await seedBaselineGenerationIfNeeded(dataDir);
  } else {
    await recoverPendingRawCacheSwap(dataDir);
  }
  const epochManifestPath = path.join(epochsDir, "manifest.json");
  const pendingManifestPath = path.join(epochsDir, ".manifest.pending.json");
  const [existingPublished, rawManifest] = await Promise.all([
    readPublishedSnapshotIfExists(dataDir),
    readEpochManifest(dataDir),
  ]);
  const existingManifest = await recoverPendingEpochManifest(rawManifest, epochsDir);

  // Stage all raw refreshes in memory first so a later compilation or validation failure never corrupts persisted caches
  const results = await Promise.all(
    MANDATORY_ADAPTERS.map((adapter) =>
      refreshMandatorySource(adapter, nowIso, {
        writeToDisk: false,
        dataDir,
        ...(shrinkStatePath ? { shrinkStatePath } : {}),
      }),
    ),
  );
  // Persist shrink confirmation state independently so >7d outage recovery counters survive failed publication gates
  await writeShrinkState(results, {
    dataDir,
    ...(shrinkStatePath ? { shrinkStatePath } : {}),
  });
  const sources: SourceHealth[] = results.map((r) => r.health);

  const frozenByDomain = new Map<DomainId, DomainSnapshot | null>(
    await Promise.all(
      DOMAINS.map(async (d) => {
        const frozen = await readMajorEpoch(d.epochVersion, existingManifest, epochsDir);
        const publishedEpoch = existingPublished?.domains[d.id]?.epochVersion;
        if (
          !frozen &&
          publishedEpoch &&
          majorEpochFilename(publishedEpoch) === majorEpochFilename(d.epochVersion)
        ) {
          throw new Error(
            `${d.id}: frozen MAJOR epoch file ${majorEpochFilename(d.epochVersion)} is missing while snapshot.json already published ${publishedEpoch}; refusing to silently re-baseline`,
          );
        }
        return [d.id, frozen] as const;
      }),
    ),
  );

  // Require an intact, manifest-pinned, schema/arithmetic-validated predecessor MAJOR epoch for every domain at MAJOR >= 2
  const prevMajorByDomain = new Map<DomainId, { name: string; snap: DomainSnapshot } | null>(
    await Promise.all(
      DOMAINS.map(async (d) => {
        const prevName = previousMajorEpochFilename(d.epochVersion);
        if (!prevName) return [d.id, null] as const;
        if (!existingManifest || !Object.hasOwn(existingManifest, prevName)) {
          throw new Error(
            `${d.id}: predecessor MAJOR epoch '${prevName}' is not pinned in data/epochs/manifest.json for ${d.epochVersion}`,
          );
        }
        const prevPath = path.join(epochsDir, prevName);
        let prevRaw: string;
        try {
          prevRaw = await fs.readFile(prevPath, "utf8");
        } catch (err) {
          throw new Error(
            `${d.id}: predecessor MAJOR epoch '${prevName}' missing or unreadable for ${d.epochVersion}`,
            { cause: err },
          );
        }
        if (existingManifest[prevName] !== sha256Hex(prevRaw)) {
          throw new Error(`${d.id}: predecessor MAJOR epoch '${prevName}' failed manifest SHA-256`);
        }
        const parsedPrev = JSON.parse(prevRaw) as unknown;
        const archiveErrors = validateFrozenMajorEpochSnapshot(prevName, parsedPrev);
        if (archiveErrors.length > 0) {
          throw new Error(
            `${d.id}: predecessor MAJOR epoch '${prevName}' failed archive validation: ${archiveErrors.join("; ")}`,
          );
        }
        return [
          d.id,
          {
            name: prevName,
            snap: DomainSnapshotSchema.parse(parsedPrev),
          },
        ] as const;
      }),
    ),
  );

  const { domainsRecord, harnessLeaderboard, canonicalHash, unmapped, epochLinkNotes } =
    compileDomainsFromSources(results, frozenByDomain, prevMajorByDomain);

  // Refuse to freeze a new MAJOR epoch if any required active feed is unhealthy, any active benchmark is withheld, or any regime lacks calibrated anchors
  const subFeedStatusByBm = new Map<string, "ok" | "degraded">();
  for (const s of sources) {
    for (const sf of s.subFeeds) subFeedStatusByBm.set(sf.benchmarkId, sf.status);
  }

  const proposedFrozen = new Map<DomainId, DomainSnapshot | null>();
  let hasNewMajor = false;
  for (const d of DOMAINS) {
    const existing = frozenByDomain.get(d.id);
    if (existing) {
      proposedFrozen.set(d.id, existing);
    } else {
      hasNewMajor = true;
      const candidateDomain = domainsRecord[d.id];
      const regimes = getRegimesForDomain(d.id);
      for (const regime of regimes) {
        const activeBms = getActiveBenchmarksForRegime(d.id, regime);
        for (const bm of activeBms) {
          if (subFeedStatusByBm.get(bm.id) !== "ok") {
            throw new Error(
              `Refusing to freeze new MAJOR epoch ${d.epochVersion}: active benchmark '${bm.id}' feed is not healthy`,
            );
          }
        }
        // Refuse to freeze any regime where every active benchmark already triggers hard retirement on day 1
        const allDomainConfigs = [
          ...candidateDomain.configs,
          ...candidateDomain.provisionalConfigs,
        ];
        const regimeMeta = candidateDomain.regimeMeta[regime];
        const coverageFloor = regimeMeta?.coverageFloor ?? candidateDomain.coverageFloor;
        const regimeAudits = activeBms.map((bm) =>
          auditBenchmarkLifecycle({
            meta: bm,
            harnessRegime: regime,
            coverageFloor,
            domainConfigs: allDomainConfigs,
            anchorStats: candidateDomain.anchorStats,
            ...(regimeMeta
              ? {
                  activeBenchmarkIds: regimeMeta.activeBenchmarkIds,
                  withheldBenchmarkIds: regimeMeta.withheldBenchmarkIds,
                  calibrationTauResidSq: regimeMeta.calibrationTauResidSq,
                  priorMean: regimeMeta.priorMean,
                  tauModelSq: regimeMeta.tauModelSq,
                  ...(regimeMeta.linkJointCov ? { linkJointCov: regimeMeta.linkJointCov } : {}),
                }
              : {}),
            priorAudit: null,
            priorAuditedAt: null,
            nowIso,
          }),
        );
        if (
          regimeAudits.length > 0 &&
          regimeAudits.every((a) => a.consecutiveTriggerDays >= 1 || a.status === "insufficient")
        ) {
          throw new Error(
            `Refusing to freeze new MAJOR epoch ${d.epochVersion}/${regime}: all ${regimeAudits.length} active benchmark(s) already trigger hard lifecycle gates (${regimeAudits.map((a) => `${a.benchmarkId}: ${a.reasons.join("; ")}`).join(" | ")})`,
          );
        }
      }
      const epochErrors = validateFrozenMajorEpochSnapshot(
        majorEpochFilename(d.epochVersion),
        candidateDomain,
      );
      if (epochErrors.length > 0) {
        throw new Error(
          `Refusing to freeze new MAJOR epoch ${d.epochVersion}: ${epochErrors.join("; ")}`,
        );
      }
      proposedFrozen.set(d.id, candidateDomain);
    }
  }
  if (hasNewMajor) {
    const replay = compileDomainsFromSources(results, proposedFrozen, prevMajorByDomain);
    if (replay.canonicalHash !== canonicalHash) {
      throw new Error(
        `Proposed MAJOR epoch failed self-replay determinism check (${canonicalHash} !== ${replay.canonicalHash})`,
      );
    }
  }

  const snapshot: ProChoiceSnapshot = ProChoiceSnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: nowIso,
    snapshotHash: canonicalHash,
    sources,
    domains: domainsRecord,
    harnessLeaderboard,
  });

  // Stage proposed MAJOR epoch payloads and hashes before touching disk; validate replay before publishing snapshot.json
  const pendingNewEpochs: {
    filename: string;
    epochPath: string;
    serialized: string;
    sha: string;
  }[] = [];
  for (const d of DOMAINS) {
    if (frozenByDomain.get(d.id)) continue;
    const filename = majorEpochFilename(d.epochVersion);
    if (existingManifest && Object.hasOwn(existingManifest, filename)) {
      throw new Error(`Refusing to overwrite existing manifest entry '${filename}'`);
    }
    const serialized = `${JSON.stringify(domainsRecord[d.id], null, 2)}\n`;
    pendingNewEpochs.push({
      filename,
      epochPath: path.join(epochsDir, filename),
      serialized,
      sha: sha256Hex(serialized),
    });
  }

  // Stage and fsync all raw caches atomically before renaming so a mid-batch ENOSPC leaves existing caches untouched
  await writeAllSourceCachesAtomically(results, dataDir);

  const nextManifest: Record<string, string> = existingManifest ? { ...existingManifest } : {};
  let manifestDirty = existingManifest === null;
  let stagingDirPath: string | null = null;

  if (pendingNewEpochs.length > 0) {
    const stagingDirName = `.pending.${crypto.randomUUID()}`;
    stagingDirPath = path.join(epochsDir, stagingDirName);
    await fs.mkdir(stagingDirPath, { recursive: false });
    const pendingJournal: Record<string, string> = {};
    await awaitAllSettledOrThrow(
      pendingNewEpochs.map(async (item) => {
        const stagedPath = path.join(stagingDirPath!, item.filename);
        // Exclusive O_EXCL write-once staging file ensures no concurrent process can ever mutate a hard-linked archive inode
        await fs.writeFile(stagedPath, item.serialized, { encoding: "utf8", flag: "wx" });
        await fsyncFile(stagedPath);
        pendingJournal[item.filename] = item.sha;
      }),
    );
    await fsyncDir(stagingDirPath);
    await atomicWriteJson(pendingManifestPath, {
      stagingDir: stagingDirName,
      files: EpochManifestSchema.parse(pendingJournal),
    });

    await awaitAllSettledOrThrow(
      pendingNewEpochs.map(async (item) => {
        const stagedPath = path.join(stagingDirPath!, item.filename);
        await fs.link(stagedPath, item.epochPath);
        await fsyncFile(item.epochPath);
        nextManifest[item.filename] = item.sha;
        manifestDirty = true;
      }),
    );
    await fsyncDir(epochsDir);
  }

  if (manifestDirty) {
    const sortedManifest: Record<string, string> = {};
    for (const k of Object.keys(nextManifest).toSorted(compareAscii)) {
      sortedManifest[k] = nextManifest[k]!;
    }
    await atomicWriteJson(epochManifestPath, EpochManifestSchema.parse(sortedManifest));
  }
  if (stagingDirPath) {
    await fsyncDir(epochsDir);
    await fs.unlink(pendingManifestPath).catch(() => undefined);
    await fs.rm(stagingDirPath, { recursive: true, force: true }).catch(() => undefined);
  }

  await atomicWriteJson(path.join(dataDir, "snapshot.json"), snapshot);
  await atomicWriteJson(path.join(dataDir, "unmapped.json"), unmapped);

  const summaryLines = [
    `# ProChoice Daily Ingestion Summary`,
    ``,
    `- Generated at: ${nowIso}`,
    `- Snapshot hash: \`${canonicalHash}\``,
    `- Unmapped allowlisted records: ${unmapped.length}`,
    ``,
    `## Mandatory Source Health`,
    `| Source | Status | Rows | Stale Days | Note |`,
    `| :--- | :--- | ---: | ---: | :--- |`,
    ...sources.map(
      (s) =>
        `| ${s.label} | ${s.status.toUpperCase()} | ${s.rowCount} | ${s.staleDays} | ${s.message ?? "OK"} |`,
    ),
    ``,
    `## Domain Coverage`,
    `| Domain | Epoch | Eligible | Provisional | Frontier Curves |`,
    `| :--- | :--- | ---: | ---: | ---: |`,
    ...DOMAINS.map((d) => {
      const snap = domainsRecord[d.id];
      return `| ${d.label} | ${snap.epochVersion} | ${snap.configs.length} | ${snap.provisionalConfigs.length} | ${snap.frontiers.length} |`;
    }),
    ...(epochLinkNotes.length > 0
      ? [``, `## Longitudinal Epoch Linking`, ...epochLinkNotes.map((n) => `- ${n}`)]
      : []),
  ];

  const summaryPath = path.join(dataDir, "summary.md");
  const tmpSummary = `${summaryPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpSummary, `${summaryLines.join("\n")}\n`, "utf8");
  await fsyncFile(tmpSummary);
  await fs.rename(tmpSummary, summaryPath);
  await fsyncDir(dataDir);

  return snapshot;
}

if (import.meta.main) {
  runIngestion()
    .then((snap) => {
      console.log(
        `ProChoice snapshot compiled cleanly (${snap.snapshotHash}) across ${snap.sources.length} mandatory sources.`,
      );
    })
    .catch((err) => {
      console.error("ProChoice ingestion failed:", err);
      process.exit(1);
    });
}
