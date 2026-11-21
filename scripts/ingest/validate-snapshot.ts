import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  BENCHMARK_BY_ID,
  BENCHMARKS,
  DOMAINS,
  getActiveBenchmarksForRegime,
  getCoverageFloorForDomain,
  getRegimesForDomain,
} from "../../src/config/benchmarks.ts";
import { ALL_PROVIDER_IDS } from "../../src/config/providers.ts";
import {
  clampZScore,
  computeConfigPosterior,
  DISPLAY_BASE,
  DISPLAY_SPREAD,
  MIN_FRONTIER_SHRINKAGE,
} from "../../src/lib/math/aggregate.ts";
import { recomputeHarnessLeaderboard } from "../../src/lib/math/harness-pareto.ts";
import {
  parseStrictUtcDateMs,
  SUSTAINED_RETIRE_DAYS,
  utcCalendarDayDiff,
} from "../../src/lib/math/lifecycle.ts";
import {
  type DomainId,
  type DomainSnapshot,
  DomainSnapshotSchema,
  HarnessLeaderboardSnapshotSchema,
  type LifecycleReport,
  LifecycleReportSchema,
  ProChoiceSnapshotSchema,
  type ProviderId,
  UnmappedRecordSchema,
} from "../../src/lib/schema.ts";
import { computeLifecycleReport } from "./audit-lifecycle.ts";
import { readSourceCacheStrict } from "./cache.ts";
import {
  compileDomainsFromSources,
  MANDATORY_ADAPTERS,
  majorEpochFilename,
  previousMajorEpochFilename,
  readEpochManifest,
  sha256Hex,
  validateFrozenMajorEpochSnapshot,
} from "./run.ts";
import { MIN_TBENCH_4_1_TRIALS } from "./sources/tbench.ts";
import type { CachedSourceFile } from "./types.ts";

const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");
const ALLOWLIST = new Set<ProviderId>(ALL_PROVIDER_IDS);
const MAX_STALE_DAYS = 7;
const FUTURE_CLOCK_SKEW_MS = 60_000;

export interface ValidateSnapshotOptions {
  dataDir?: string;
  lifecycleOverride?: LifecycleReport;
  priorLifecycleOverride?: LifecycleReport | null;
}

export async function validateSnapshot(options: ValidateSnapshotOptions = {}): Promise<void> {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const epochsDir = path.join(dataDir, "epochs");
  const epochManifestPath = path.join(epochsDir, "manifest.json");
  const [snapRaw, lifeRaw, unmappedRaw] = await Promise.all([
    fs.readFile(path.join(dataDir, "snapshot.json"), "utf8"),
    options.lifecycleOverride
      ? Promise.resolve(null)
      : fs.readFile(path.join(dataDir, "lifecycle.json"), "utf8"),
    fs.readFile(path.join(dataDir, "unmapped.json"), "utf8"),
  ]);

  const snapshot = ProChoiceSnapshotSchema.parse(JSON.parse(snapRaw));
  const lifecycle = options.lifecycleOverride
    ? LifecycleReportSchema.parse(options.lifecycleOverride)
    : LifecycleReportSchema.parse(JSON.parse(lifeRaw!));
  const publishedUnmappedRaw = JSON.parse(unmappedRaw) as unknown;
  if (!Array.isArray(publishedUnmappedRaw)) {
    throw new Error("data/unmapped.json must be a JSON array");
  }
  const publishedUnmapped = publishedUnmappedRaw.map((entry) => UnmappedRecordSchema.parse(entry));

  const failures: string[] = [];

  // 1. Canonical snapshotHash verification
  const expectedHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        domains: snapshot.domains,
        harnessLeaderboard: snapshot.harnessLeaderboard,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  if (snapshot.snapshotHash !== expectedHash) {
    failures.push(
      `snapshotHash mismatch: declared ${snapshot.snapshotHash}, computed ${expectedHash}`,
    );
  }

  // 2. Exact one-per-key mandatory source roster, strict raw cache reconciliation, and freshness gate
  const expectedSourceIds = new Set(MANDATORY_ADAPTERS.map((a) => a.id));
  const seenSources = new Set<string>();
  for (const src of snapshot.sources) {
    if (seenSources.has(src.sourceId)) {
      failures.push(`Duplicate source adapter '${src.sourceId}' in snapshot.sources`);
    }
    seenSources.add(src.sourceId);
    if (!expectedSourceIds.has(src.sourceId)) {
      failures.push(`Unregistered source adapter '${src.sourceId}'`);
    }
  }
  for (const id of expectedSourceIds) {
    if (!seenSources.has(id)) failures.push(`Missing mandatory source adapter '${id}'`);
  }
  if (snapshot.sources.length !== MANDATORY_ADAPTERS.length) {
    failures.push(
      `snapshot.sources count ${snapshot.sources.length} !== ${MANDATORY_ADAPTERS.length}`,
    );
  }

  const strictFreshness = process.env.STRICT_FRESHNESS === "1";
  const nowMs = Date.now();
  const generatedMs = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generatedMs)) {
    failures.push(`Invalid snapshot.generatedAt '${snapshot.generatedAt}'`);
  } else if (generatedMs > nowMs + FUTURE_CLOCK_SKEW_MS) {
    failures.push(`Future snapshot.generatedAt '${snapshot.generatedAt}'`);
  }

  const rawCaches = await Promise.all(
    MANDATORY_ADAPTERS.map(async (adapter) => {
      try {
        return { adapter, cache: await readSourceCacheStrict(adapter.id, dataDir), error: null };
      } catch (err) {
        return {
          adapter,
          cache: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const validCachedFiles: CachedSourceFile[] = [];
  const sourceById = new Map(snapshot.sources.map((s) => [s.sourceId, s]));

  for (const { adapter, cache, error } of rawCaches) {
    if (!cache) {
      failures.push(`Missing or corrupt raw source cache data/raw/${adapter.id}.json: ${error}`);
      continue;
    }
    validCachedFiles.push(cache);

    const harnessRows = cache.payload.harnessLeaderboard
      ? cache.payload.harnessLeaderboard.slices.reduce((acc, s) => acc + s.entries.length, 0)
      : 0;
    const actualRows =
      cache.payload.observations.length + cache.payload.pricing.length + harnessRows;
    if (cache.health.rowCount !== actualRows) {
      failures.push(
        `Cache ${adapter.id}: declared rowCount ${cache.health.rowCount} !== actual ${actualRows}`,
      );
    }
    if (adapter.expectsHarnessLeaderboard && !cache.payload.harnessLeaderboard) {
      failures.push(`Cache ${adapter.id}: expected harnessLeaderboard missing from raw cache`);
    }

    // Reconcile subFeeds 1:1 against adapter.expectedBenchmarks (+ __harness_leaderboard__ when applicable) and exact cached counts
    const expectedBmsSorted = [
      ...adapter.expectedBenchmarks,
      ...(adapter.expectsHarnessLeaderboard ? ["__harness_leaderboard__"] : []),
    ].toSorted();
    const subFeedIds = cache.health.subFeeds.map((sf) => sf.benchmarkId).toSorted();
    if (JSON.stringify(subFeedIds) !== JSON.stringify(expectedBmsSorted)) {
      failures.push(
        `Cache ${adapter.id}: subFeeds roster [${subFeedIds.join(",")}] !== expected [${expectedBmsSorted.join(",")}]`,
      );
    }
    const obsCountByBm = new Map<string, number>();
    if (cache.health.sourceId !== adapter.id) {
      failures.push(
        `Cache ${adapter.id}: health.sourceId '${cache.health.sourceId}' !== '${adapter.id}'`,
      );
    }
    for (const obs of cache.payload.observations) {
      if (obs.sourceId !== adapter.id) {
        failures.push(
          `Cache ${adapter.id}: observation '${obs.sourceRowId}' sourceId '${obs.sourceId}' !== '${adapter.id}'`,
        );
      }
      obsCountByBm.set(obs.benchmarkId, (obsCountByBm.get(obs.benchmarkId) ?? 0) + 1);
      if (
        obs.benchmarkId === "tbench_4_1" &&
        (obs.battleCount === null ||
          !Number.isInteger(obs.battleCount) ||
          obs.battleCount < MIN_TBENCH_4_1_TRIALS ||
          obs.measuredCostUsd === null ||
          obs.measuredCostUsd <= 0)
      ) {
        failures.push(
          `Cache ${adapter.id}: persisted tbench_4_1 row '${obs.sourceRowId}' failed minimum ${MIN_TBENCH_4_1_TRIALS}-trial or positive-cost gate`,
        );
      }
    }
    for (const sf of cache.health.subFeeds) {
      const actualCount =
        sf.benchmarkId === "__harness_leaderboard__"
          ? (cache.payload.harnessLeaderboard?.slices.reduce(
              (acc, s) => acc + s.entries.length,
              0,
            ) ?? 0)
          : (obsCountByBm.get(sf.benchmarkId) ?? 0);
      if (sf.rowCount !== actualCount) {
        failures.push(
          `Cache ${adapter.id}/${sf.benchmarkId}: subFeed rowCount ${sf.rowCount} !== actual ${actualCount}`,
        );
      }
      if (sf.lastHealthyAt !== null) {
        const sfMs = Date.parse(sf.lastHealthyAt);
        if (!Number.isFinite(sfMs) || sfMs > nowMs + FUTURE_CLOCK_SKEW_MS) {
          failures.push(`Cache ${adapter.id}/${sf.benchmarkId}: invalid or future lastHealthyAt`);
        }
      }
    }

    if (adapter.expectsPricing) {
      if (!cache.health.pricingHealth) {
        failures.push(`Cache ${adapter.id}: missing pricingHealth on pricing-bearing adapter`);
      } else {
        if (cache.health.pricingHealth.rowCount !== cache.payload.pricing.length) {
          failures.push(
            `Cache ${adapter.id}: pricingHealth rowCount ${cache.health.pricingHealth.rowCount} !== actual ${cache.payload.pricing.length}`,
          );
        }
        if (cache.health.pricingHealth.lastHealthyAt !== null) {
          const phMs = Date.parse(cache.health.pricingHealth.lastHealthyAt);
          if (!Number.isFinite(phMs) || phMs > nowMs + FUTURE_CLOCK_SKEW_MS) {
            failures.push(`Cache ${adapter.id}: pricingHealth has invalid or future lastHealthyAt`);
          }
        }
      }
    } else if (cache.health.pricingHealth !== null) {
      failures.push(`Cache ${adapter.id}: unexpected pricingHealth on non-pricing adapter`);
    }

    const snapSrc = sourceById.get(adapter.id);
    if (snapSrc) {
      if (snapSrc.rowCount !== actualRows) {
        failures.push(
          `Source ${adapter.id}: snapshot rowCount ${snapSrc.rowCount} !== cache rows ${actualRows}`,
        );
      }
      if (JSON.stringify(snapSrc) !== JSON.stringify(cache.health)) {
        failures.push(
          `Source ${adapter.id}: snapshot source health diverges from data/raw/${adapter.id}.json`,
        );
      }
      if (adapter.expectsPricing && cache.payload.pricing.length === 0) {
        failures.push(`Source ${adapter.id}: expected pricing records missing from raw cache`);
      }
      if (adapter.expectsHarnessLeaderboard) {
        const parsedRawHlb = HarnessLeaderboardSnapshotSchema.safeParse(
          cache.payload.harnessLeaderboard,
        );
        if (!parsedRawHlb.success) {
          failures.push(
            `Source ${adapter.id}: invalid or empty harnessLeaderboard in raw cache (${parsedRawHlb.error.issues[0]?.message ?? "schema error"})`,
          );
        } else {
          const upMs = Date.parse(parsedRawHlb.data.upstreamGeneratedAt);
          if (!Number.isFinite(upMs) || upMs > nowMs + FUTURE_CLOCK_SKEW_MS) {
            failures.push(
              `Source ${adapter.id}: invalid or future upstreamGeneratedAt '${parsedRawHlb.data.upstreamGeneratedAt}'`,
            );
          } else if (strictFreshness) {
            const upAgeDays = Math.max(0, Math.floor((nowMs - upMs) / (1000 * 60 * 60 * 24)));
            if (upAgeDays > 14) {
              failures.push(
                `Source ${adapter.id}: upstream harness board stale (${upAgeDays}d since ${parsedRawHlb.data.upstreamGeneratedAt}, limit 14d)`,
              );
            }
          }
        }
      }
      const obsBms = new Set(cache.payload.observations.map((o) => o.benchmarkId));
      for (const bmId of adapter.expectedBenchmarks) {
        if (!obsBms.has(bmId)) {
          failures.push(
            `Source ${adapter.id}: expected benchmark '${bmId}' missing from raw cache`,
          );
        }
      }

      const fetchedMs = Date.parse(snapSrc.fetchedAt);
      if (!Number.isFinite(fetchedMs) || fetchedMs > nowMs + FUTURE_CLOCK_SKEW_MS) {
        failures.push(
          `Source ${adapter.id} has invalid or future fetchedAt '${snapSrc.fetchedAt}'`,
        );
      }

      if (snapSrc.lastHealthyAt === null) {
        if (strictFreshness) {
          failures.push(`Source ${adapter.id} has never succeeded (lastHealthyAt is null)`);
        }
      } else {
        const healthyMs = Date.parse(snapSrc.lastHealthyAt);
        if (!Number.isFinite(healthyMs)) {
          failures.push(
            `Source ${adapter.id} has invalid lastHealthyAt '${snapSrc.lastHealthyAt}'`,
          );
        } else if (healthyMs > nowMs + FUTURE_CLOCK_SKEW_MS) {
          failures.push(`Source ${adapter.id} has future lastHealthyAt '${snapSrc.lastHealthyAt}'`);
        } else {
          const derivedStaleDays = Math.max(
            0,
            Math.floor((nowMs - healthyMs) / (1000 * 60 * 60 * 24)),
          );
          if (
            strictFreshness &&
            (snapSrc.staleDays > MAX_STALE_DAYS || derivedStaleDays > MAX_STALE_DAYS)
          ) {
            failures.push(
              `Source ${adapter.id} stale (${derivedStaleDays}d since ${snapSrc.lastHealthyAt}, limit ${MAX_STALE_DAYS}d)`,
            );
          }
        }
      }
    }
  }

  // 3. Verify cryptographic epoch manifest SHA-256 pins, load immutable MAJOR epochs, and run full recompute
  const publishedEpochByDomain = new Map<DomainId, string>();
  for (const meta of DOMAINS) {
    const dom = snapshot.domains[meta.id];
    if (dom) publishedEpochByDomain.set(meta.id, dom.epochVersion);
  }

  const manifest = await readEpochManifest(dataDir).catch((err) => {
    failures.push(
      `Epoch manifest invalid (${epochManifestPath}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  });
  if (!manifest) {
    failures.push(`Missing cryptographic epoch manifest ${epochManifestPath}`);
  } else {
    let epochEntries: string[] = [];
    try {
      epochEntries = await fs.readdir(epochsDir);
    } catch (err) {
      failures.push(
        `Failed to enumerate epoch directory ${epochsDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const diskEpochFiles = epochEntries.filter((f) => f.endsWith(".json") && f !== "manifest.json");
    for (const file of diskEpochFiles) {
      if (!Object.hasOwn(manifest, file)) {
        failures.push(`Epoch file data/epochs/${file} is not pinned in data/epochs/manifest.json`);
      }
    }
    await Promise.all(
      Object.entries(manifest).map(async ([file, expectedSha]) => {
        try {
          const raw = await fs.readFile(path.join(epochsDir, file), "utf8");
          const actualSha = sha256Hex(raw);
          if (actualSha !== expectedSha) {
            failures.push(
              `Archived epoch data/epochs/${file} SHA-256 mismatch (manifest ${expectedSha}, disk ${actualSha})`,
            );
          }
          // Parse and verify every manifest-pinned archive's schema, filename identity, MAJOR bound, arithmetic, and calibration health
          const archiveErrors = validateFrozenMajorEpochSnapshot(
            file,
            JSON.parse(raw),
            publishedEpochByDomain,
          );
          for (const errMsg of archiveErrors) {
            failures.push(`Manifest-pinned archive ${errMsg}`);
          }
        } catch (err) {
          failures.push(
            `Manifest-pinned epoch data/epochs/${file} missing or unreadable: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
  }

  const frozenByDomain = new Map<DomainId, DomainSnapshot | null>();
  const prevMajorByDomain = new Map<DomainId, { name: string; snap: DomainSnapshot } | null>();

  await Promise.all(
    DOMAINS.map(async (meta) => {
      const domain = snapshot.domains[meta.id];
      if (!domain) {
        failures.push(`Missing domain '${meta.id}' in snapshot`);
        frozenByDomain.set(meta.id, null);
        prevMajorByDomain.set(meta.id, null);
        return;
      }

      const currentEpochName = majorEpochFilename(domain.epochVersion);
      if (manifest && !Object.hasOwn(manifest, currentEpochName)) {
        failures.push(
          `${meta.id}: current MAJOR epoch '${currentEpochName}' is not pinned in ${epochManifestPath}`,
        );
      }
      const epochPath = path.join(epochsDir, currentEpochName);
      try {
        const epochRaw = await fs.readFile(epochPath, "utf8");
        frozenByDomain.set(meta.id, DomainSnapshotSchema.parse(JSON.parse(epochRaw)));
      } catch (err) {
        failures.push(
          `${meta.id}: missing or invalid MAJOR epoch file ${epochPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        frozenByDomain.set(meta.id, null);
      }

      const prevName = previousMajorEpochFilename(domain.epochVersion);
      if (prevName) {
        if (manifest && !Object.hasOwn(manifest, prevName)) {
          failures.push(
            `${meta.id}: predecessor MAJOR epoch '${prevName}' is not pinned in ${epochManifestPath}`,
          );
        }
        const prevPath = path.join(epochsDir, prevName);
        try {
          const prevRaw = await fs.readFile(prevPath, "utf8");
          prevMajorByDomain.set(meta.id, {
            name: prevName,
            snap: DomainSnapshotSchema.parse(JSON.parse(prevRaw)),
          });
        } catch (err) {
          failures.push(
            `${meta.id}: missing or invalid predecessor MAJOR epoch ${prevPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
          prevMajorByDomain.set(meta.id, null);
        }
      } else {
        prevMajorByDomain.set(meta.id, null);
      }
    }),
  );

  // Full end-to-end deterministic recompute from strict raw caches + frozen MAJOR epochs
  if (validCachedFiles.length === MANDATORY_ADAPTERS.length) {
    try {
      const recomputed = compileDomainsFromSources(
        validCachedFiles,
        frozenByDomain,
        prevMajorByDomain,
      );

      if (recomputed.canonicalHash !== snapshot.snapshotHash) {
        failures.push(
          `Full raw-cache recompute hash mismatch: published ${snapshot.snapshotHash}, recomputed ${recomputed.canonicalHash}`,
        );
      }

      for (const meta of DOMAINS) {
        const publishedDomain = snapshot.domains[meta.id];
        const expectedDomain = recomputed.domainsRecord[meta.id];
        if (JSON.stringify(publishedDomain) !== JSON.stringify(expectedDomain)) {
          failures.push(
            `${meta.id}: published domain snapshot does not match deterministic raw-cache recomputation`,
          );
        }
      }

      if (
        JSON.stringify(snapshot.harnessLeaderboard) !==
        JSON.stringify(recomputed.harnessLeaderboard)
      ) {
        failures.push(
          "Published harnessLeaderboard does not match deterministic raw-cache recomputation",
        );
      }

      const recomputedHlbFromPublished = recomputeHarnessLeaderboard(snapshot.harnessLeaderboard);
      if (
        JSON.stringify(snapshot.harnessLeaderboard) !== JSON.stringify(recomputedHlbFromPublished)
      ) {
        failures.push(
          "Published harnessLeaderboard frontier/dominance annotations disagree with independent Pareto recomputation",
        );
      }

      if (JSON.stringify(publishedUnmapped) !== JSON.stringify(recomputed.unmapped)) {
        failures.push(
          `data/unmapped.json (${publishedUnmapped.length} rows) does not match deterministic recompute (${recomputed.unmapped.length} rows)`,
        );
      }
    } catch (err) {
      failures.push(
        `Full raw-cache recompute failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 4. Defense-in-depth domain, epoch-lock, arithmetic, and monotonicity invariants
  for (const meta of DOMAINS) {
    const domain = snapshot.domains[meta.id];
    if (!domain) continue;

    const frozenSnap = frozenByDomain.get(meta.id);
    if (frozenSnap) {
      const frozenKeys = Object.keys(frozenSnap.anchorStats).toSorted();
      const currentKeys = Object.keys(domain.anchorStats).toSorted();
      if (JSON.stringify(frozenKeys) !== JSON.stringify(currentKeys)) {
        failures.push(
          `${meta.id}: anchorStats key set drifted from frozen MAJOR epoch ${frozenSnap.epochVersion}`,
        );
      }
      for (const [k, frozenStat] of Object.entries(frozenSnap.anchorStats)) {
        const currentStat = domain.anchorStats[k];
        if (
          !currentStat ||
          Math.abs(currentStat.mean - frozenStat.mean) > 1e-6 ||
          Math.abs(currentStat.sd - frozenStat.sd) > 1e-6 ||
          Math.abs(currentStat.raschDelta - frozenStat.raschDelta) > 1e-6
        ) {
          failures.push(
            `${meta.id}: frozen anchor '${k}' mutated relative to ${majorEpochFilename(domain.epochVersion)}`,
          );
        }
      }
      if (
        JSON.stringify(domain.activeBenchmarkIds) !==
          JSON.stringify(frozenSnap.activeBenchmarkIds) ||
        JSON.stringify(domain.benchmarkVersions) !== JSON.stringify(frozenSnap.benchmarkVersions)
      ) {
        failures.push(
          `${meta.id}: active roster or benchmark versions changed without bumping MAJOR epoch`,
        );
      }
    }

    const regimes = getRegimesForDomain(meta.id);
    for (const regime of regimes) {
      const expectedActiveBms = getActiveBenchmarksForRegime(meta.id, regime);
      const expectedActive = expectedActiveBms.map((b) => b.id);
      const rMeta = domain.regimeMeta[regime];
      if (!rMeta) {
        failures.push(`${meta.id}: missing regimeMeta for '${regime}'`);
        continue;
      }
      if (JSON.stringify(rMeta.activeBenchmarkIds) !== JSON.stringify(expectedActive)) {
        failures.push(`${meta.id}/${regime}: activeBenchmarkIds drift from registry`);
      }
      const expectedMeasuredIds = expectedActiveBms
        .filter((b) => b.providesMeasuredCost && !rMeta.withheldBenchmarkIds.includes(b.id))
        .map((b) => b.id);
      const expectedCostSource =
        meta.id === "writing" ? "list" : expectedMeasuredIds.length > 0 ? "measured" : "suite";
      if (rMeta.costSource !== expectedCostSource) {
        failures.push(
          `${meta.id}/${regime}: costSource '${rMeta.costSource}' !== registry '${expectedCostSource}'`,
        );
      }
      if (JSON.stringify(rMeta.measuredCostBenchmarkIds) !== JSON.stringify(expectedMeasuredIds)) {
        failures.push(
          `${meta.id}/${regime}: measuredCostBenchmarkIds drift from registry (${rMeta.measuredCostBenchmarkIds.join(",")} !== ${expectedMeasuredIds.join(",")})`,
        );
      }
      if (frozenSnap) {
        const frozenRm = frozenSnap.regimeMeta[regime];
        if (
          frozenRm &&
          (frozenRm.costSource !== rMeta.costSource ||
            Math.abs(frozenRm.priorMean - rMeta.priorMean) > 1e-6 ||
            Math.abs(frozenRm.tauModelSq - rMeta.tauModelSq) > 1e-6 ||
            JSON.stringify(frozenRm.measuredCostBenchmarkIds) !==
              JSON.stringify(rMeta.measuredCostBenchmarkIds) ||
            JSON.stringify(frozenRm.linkJointCov ?? null) !==
              JSON.stringify(rMeta.linkJointCov ?? null))
        ) {
          failures.push(
            `${meta.id}/${regime}: cost axis, priorMean, tauModelSq, or measured-cost basket changed without bumping MAJOR epoch`,
          );
        }
      }
      // Diagnose empty upstream price columns explicitly rather than surfacing only "0 eligible configurations"
      for (const bmId of expectedMeasuredIds) {
        const hasPricedRow = validCachedFiles.some((f) =>
          f.payload.observations.some(
            (o) =>
              o.benchmarkId === bmId &&
              o.measuredCostUsd !== null &&
              Number.isFinite(o.measuredCostUsd) &&
              o.measuredCostUsd > 0,
          ),
        );
        if (!hasPricedRow) {
          failures.push(
            `${meta.id}/${regime}: measured-cost benchmark '${bmId}' has 0 priced rows in raw cache`,
          );
        }
      }
      const expectedFloor = getCoverageFloorForDomain(meta.id, expectedActive.length);
      if (rMeta.coverageFloor !== expectedFloor) {
        failures.push(
          `${meta.id}/${regime}: coverageFloor ${rMeta.coverageFloor} !== ${expectedFloor}`,
        );
      }
      const withheldSet = new Set(rMeta.withheldBenchmarkIds);
      let weightedDeltaSum = 0;
      let totalAnchorW = 0;
      for (const bmId of rMeta.activeBenchmarkIds) {
        if (withheldSet.has(bmId)) continue;
        const key = regime === "standardized" ? `${bmId}::standardized` : bmId;
        const anchor = domain.anchorStats[key];
        if (anchor) {
          weightedDeltaSum += anchor.effectiveWeight * anchor.raschDelta;
          totalAnchorW += anchor.effectiveWeight;
        }
      }
      if (totalAnchorW > 0 && Math.abs(weightedDeltaSum) > 1e-3) {
        failures.push(
          `${meta.id}/${regime}: Rasch delta gauge drift sum(w*delta)=${weightedDeltaSum.toFixed(6)} !== 0`,
        );
      }
    }

    for (const cfg of domain.configs) {
      if (cfg.inputPer1mUsd === null || cfg.outputPer1mUsd === null) {
        failures.push(
          `${meta.id}: eligible config '${cfg.id}' missing verified public API pricing`,
        );
      }
      if (cfg.shrinkageFactor < MIN_FRONTIER_SHRINKAGE - 1e-6) {
        failures.push(
          `${meta.id}: eligible config '${cfg.id}' shrinkageFactor ${cfg.shrinkageFactor} < ${MIN_FRONTIER_SHRINKAGE}`,
        );
      }
    }

    for (const cfg of [...domain.configs, ...domain.provisionalConfigs]) {
      if (!ALLOWLIST.has(cfg.provider)) {
        failures.push(`${meta.id}: forbidden provider '${cfg.provider}' on ${cfg.id}`);
      }
      if (cfg.coverageCount !== cfg.benchmarks.length) {
        failures.push(`${meta.id}: ${cfg.id} coverageCount !== benchmarks.length`);
      }

      const expectedScore = Number((DISPLAY_BASE + DISPLAY_SPREAD * cfg.theta).toFixed(2));
      if (Math.abs(cfg.score - expectedScore) > 0.02) {
        failures.push(
          `${meta.id}: ${cfg.id} score ${cfg.score} !== 50 + 15*theta (${expectedScore})`,
        );
      }

      let sumWeightedAdj = 0;
      let sumWeights = 0;
      for (const bm of cfg.benchmarks) {
        const key =
          cfg.harnessRegime === "standardized" ? `${bm.benchmarkId}::standardized` : bm.benchmarkId;
        const anchor = domain.anchorStats[key];
        const bMeta = BENCHMARK_BY_ID[bm.benchmarkId];
        if (!anchor || !bMeta) {
          failures.push(`${meta.id}: ${cfg.id} missing anchor for ${key}`);
          continue;
        }
        const oriented = bMeta.invertScore ? -bm.rawScore : bm.rawScore;
        const expectedZ = clampZScore((oriented - anchor.mean) / anchor.sd);
        if (Math.abs(bm.zScore - expectedZ) > 0.002) {
          failures.push(
            `${meta.id}: ${cfg.id}/${bm.benchmarkId} zScore ${bm.zScore} !== ${expectedZ.toFixed(4)}`,
          );
        }
        sumWeightedAdj += anchor.effectiveWeight * (expectedZ - anchor.raschDelta);
        sumWeights += anchor.effectiveWeight;
      }
      const rmForCfg = domain.regimeMeta[cfg.harnessRegime];
      if (sumWeights > 0 && rmForCfg) {
        const expectedTheta =
          rmForCfg.priorMean +
          cfg.shrinkageFactor * (sumWeightedAdj / sumWeights - rmForCfg.priorMean);
        if (Math.abs(cfg.theta - expectedTheta) > 1e-3) {
          failures.push(
            `${meta.id}: ${cfg.id} theta ${cfg.theta} !== priorMean + shrinkage * (thetaMle - priorMean) (${expectedTheta.toFixed(6)})`,
          );
        }
        const post = computeConfigPosterior(
          cfg.benchmarks,
          domain.anchorStats,
          cfg.harnessRegime,
          rmForCfg.activeBenchmarkIds,
          rmForCfg.withheldBenchmarkIds,
          rmForCfg.calibrationTauResidSq,
          rmForCfg.priorMean,
          rmForCfg.tauModelSq,
          undefined,
          rmForCfg.linkJointCov,
        );
        if (!post?.exactSeRecomputable) {
          failures.push(
            `${meta.id}: ${cfg.id} posterior uncertainty cannot be recomputed from persisted SE metadata`,
          );
        } else {
          if (Math.abs(cfg.shrinkageFactor - post.shrinkageFactor) > 1e-3) {
            failures.push(
              `${meta.id}: ${cfg.id} shrinkageFactor ${cfg.shrinkageFactor} !== recomputed ${post.shrinkageFactor}`,
            );
          }
          if (Math.abs(cfg.se - post.se) > 0.03) {
            failures.push(`${meta.id}: ${cfg.id} se ${cfg.se} !== recomputed ${post.se}`);
          }
          if (Math.abs(cfg.samplingSe - post.samplingSe) > 0.02) {
            failures.push(
              `${meta.id}: ${cfg.id} samplingSe ${cfg.samplingSe} !== recomputed ${post.samplingSe}`,
            );
          }
          if (Math.abs(cfg.residualSe - post.residualSe) > 0.02) {
            failures.push(
              `${meta.id}: ${cfg.id} residualSe ${cfg.residualSe} !== recomputed ${post.residualSe}`,
            );
          }
        }
      }
    }

    const expectedRegimes = getRegimesForDomain(meta.id);
    for (const regime of expectedRegimes) {
      const rm = domain.regimeMeta[regime];
      if (!rm) {
        failures.push(`${meta.id}/${regime}: missing regimeMeta`);
        continue;
      }
      if (rm.withheldBenchmarkIds.length >= rm.activeBenchmarkIds.length) {
        failures.push(`${meta.id}/${regime}: all active benchmarks withheld (empty epoch)`);
      }
      if (rm.anchorLabs < meta.minLabsForSaturation) {
        failures.push(
          `${meta.id}/${regime}: anchorLabs ${rm.anchorLabs} < minLabsForSaturation ${meta.minLabsForSaturation}`,
        );
      }
      const regimeEligibleCount = domain.configs.filter((c) => c.harnessRegime === regime).length;
      if (regimeEligibleCount === 0) {
        failures.push(`${meta.id}/${regime}: 0 eligible configurations`);
      }
    }

    const eligibleById = new Map(domain.configs.map((c) => [c.id, c]));
    for (const pf of domain.frontiers) {
      for (let i = 1; i < pf.frontier.length; i++) {
        const prev = eligibleById.get(pf.frontier[i - 1]!.configId);
        const cur = eligibleById.get(pf.frontier[i]!.configId);
        if (!prev || !cur || prev.effectiveCostUsd === null || cur.effectiveCostUsd === null) {
          failures.push(`${meta.id}/${pf.provider}: missing or unpriced frontier point`);
          continue;
        }
        if (!(prev.effectiveCostUsd < cur.effectiveCostUsd)) {
          failures.push(`${meta.id}/${pf.provider}: non-strict cost monotonicity`);
        }
        if (!(prev.score < cur.score)) {
          failures.push(`${meta.id}/${pf.provider}: non-strict score monotonicity`);
        }
      }
    }
  }

  // 5. Exact one-per-key lifecycle audit & independent prior-day streak verification (never self-validating)
  const expectedAuditKeys = new Set<string>();
  for (const bm of BENCHMARKS) {
    for (const r of bm.regimes) expectedAuditKeys.add(`${bm.id}::${r}`);
  }
  const seenAudits = new Set<string>();
  for (const a of lifecycle.audits) {
    const key = `${a.benchmarkId}::${a.harnessRegime}`;
    if (seenAudits.has(key)) failures.push(`Duplicate lifecycle audit key '${key}'`);
    seenAudits.add(key);
    if (!expectedAuditKeys.has(key)) failures.push(`Unexpected lifecycle audit key '${key}'`);
  }
  for (const k of expectedAuditKeys) {
    if (!seenAudits.has(k)) failures.push(`Missing lifecycle audit for '${k}'`);
  }
  if (lifecycle.audits.length !== expectedAuditKeys.size) {
    failures.push(
      `lifecycle.audits count ${lifecycle.audits.length} !== expected ${expectedAuditKeys.size}`,
    );
  }
  if (lifecycle.auditedAt !== snapshot.generatedAt) {
    failures.push(
      `lifecycle.auditedAt (${lifecycle.auditedAt}) !== snapshot.generatedAt (${snapshot.generatedAt})`,
    );
  }

  const auditedDateMs = parseStrictUtcDateMs(lifecycle.auditedAt);
  const auditedDate =
    auditedDateMs !== null ? new Date(auditedDateMs).toISOString().slice(0, 10) : "";
  if (auditedDateMs === null) {
    failures.push(`Invalid lifecycle.auditedAt UTC date '${lifecycle.auditedAt}'`);
  }

  // Load independent prior-day lifecycle baseline and verify its own streak fields before trusting continuity
  let independentPrior: LifecycleReport | null = null;
  const ignoreLocalPrior = process.env.IGNORE_LOCAL_PRIOR_LIFECYCLE === "1";
  const requirePrior = process.env.REQUIRE_PRIOR_LIFECYCLE === "1";
  const priorPath = process.env.PRIOR_LIFECYCLE_PATH ?? path.join(dataDir, "lifecycle.prev.json");
  if (ignoreLocalPrior) {
    // Enforce expected absence of persisted lifecycle.prev.json when Git base has no prior history
    const persistedPrevPath = path.join(dataDir, "lifecycle.prev.json");
    try {
      await fs.access(persistedPrevPath);
      failures.push(
        "Unexpected data/lifecycle.prev.json present when base commit has no prior lifecycle history",
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        failures.push(
          `Failed to verify absence of data/lifecycle.prev.json: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else {
    try {
      const parsedPrior =
        !process.env.PRIOR_LIFECYCLE_PATH && options.priorLifecycleOverride !== undefined
          ? options.priorLifecycleOverride === null
            ? null
            : LifecycleReportSchema.parse(options.priorLifecycleOverride)
          : LifecycleReportSchema.parse(JSON.parse(await fs.readFile(priorPath, "utf8")));
      if (parsedPrior === null) {
        if (requirePrior) {
          failures.push(`Required prior lifecycle baseline ${priorPath} is missing`);
        }
      } else {
        const priorDiff = utcCalendarDayDiff(parsedPrior.auditedAt, lifecycle.auditedAt);
        const priorDateMs = parseStrictUtcDateMs(parsedPrior.auditedAt);
        if (priorDiff === null || priorDiff < 1 || priorDateMs === null) {
          failures.push(
            `Prior lifecycle baseline ${priorPath} must precede ${lifecycle.auditedAt} by >= 1 UTC day`,
          );
        } else {
          const priorDateUtc = new Date(priorDateMs).toISOString().slice(0, 10);
          let priorInternalOk = true;
          for (const pa of parsedPrior.audits) {
            if (pa.triggerSince === null) {
              if (pa.consecutiveTriggerDays !== 0) {
                failures.push(
                  `Prior baseline ${priorPath}: ${pa.benchmarkId} has days > 0 with triggerSince=null`,
                );
                priorInternalOk = false;
              }
            } else {
              const span = utcCalendarDayDiff(pa.triggerSince, priorDateUtc);
              if (span === null || span < 0 || pa.consecutiveTriggerDays !== span + 1) {
                failures.push(
                  `Prior baseline ${priorPath}: ${pa.benchmarkId} has inconsistent streak (triggerSince=${pa.triggerSince}, audited=${priorDateUtc}, days=${pa.consecutiveTriggerDays})`,
                );
                priorInternalOk = false;
              }
            }
          }
          if (priorInternalOk) independentPrior = parsedPrior;
          if (
            process.env.VERIFY_PERSISTED_PRIOR_MATCHES === "1" &&
            process.env.PRIOR_LIFECYCLE_PATH
          ) {
            const persistedPrevPath = path.join(dataDir, "lifecycle.prev.json");
            try {
              const persistedPrev = LifecycleReportSchema.parse(
                JSON.parse(await fs.readFile(persistedPrevPath, "utf8")),
              );
              if (JSON.stringify(persistedPrev) !== JSON.stringify(parsedPrior)) {
                failures.push(
                  `Persisted data/lifecycle.prev.json does not match trusted Git prior baseline ${priorPath}`,
                );
              }
            } catch (prevErr) {
              failures.push(
                `Missing or invalid data/lifecycle.prev.json required to match ${priorPath}: ${
                  prevErr instanceof Error ? prevErr.message : String(prevErr)
                }`,
              );
            }
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (requirePrior) {
          failures.push(`Required prior lifecycle baseline ${priorPath} is missing`);
        }
      } else {
        failures.push(
          `Invalid prior lifecycle baseline ${priorPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const recomputedLifecycle = await computeLifecycleReport(
    snapshot,
    independentPrior,
    validCachedFiles.length === MANDATORY_ADAPTERS.length ? validCachedFiles : undefined,
    dataDir,
  );
  const recomputedByKey = new Map(
    recomputedLifecycle.audits.map((a) => [`${a.benchmarkId}::${a.harnessRegime}`, a]),
  );

  for (const actual of lifecycle.audits) {
    const key = `${actual.benchmarkId}::${actual.harnessRegime}`;
    const expected = recomputedByKey.get(key);
    if (!expected) continue;

    if (actual.triggerSince === null) {
      if (actual.consecutiveTriggerDays !== 0) {
        failures.push(`${key}: consecutiveTriggerDays > 0 with triggerSince=null`);
      }
    } else {
      const span = utcCalendarDayDiff(actual.triggerSince, auditedDate);
      if (span === null || span < 0 || actual.consecutiveTriggerDays !== span + 1) {
        failures.push(
          `${key}: invalid calendar trigger streak (triggerSince=${actual.triggerSince}, audited=${auditedDate}, days=${actual.consecutiveTriggerDays})`,
        );
      }
      if (
        actual.status === "retire_trigger" &&
        actual.consecutiveTriggerDays < SUSTAINED_RETIRE_DAYS
      ) {
        failures.push(`${key}: retire_trigger below ${SUSTAINED_RETIRE_DAYS} calendar days`);
      }
    }

    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(
        `Lifecycle audit field mismatch on '${key}' relative to independent recomputation`,
      );
    }
  }

  if (
    JSON.stringify(lifecycle.crossDomainTau) !== JSON.stringify(recomputedLifecycle.crossDomainTau)
  ) {
    failures.push("Lifecycle crossDomainTau does not match recomputed domain correlations");
  }

  if (failures.length > 0) {
    const errText = `ProChoice snapshot validation FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`;
    throw new Error(errText);
  }

  console.log(
    `Snapshot invariants PASSED (${snapshot.snapshotHash}, ${DOMAINS.length} domains, ${lifecycle.audits.length} lifecycle audits, full raw-to-release recompute verified).`,
  );
}

if (import.meta.main) {
  validateSnapshot().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
