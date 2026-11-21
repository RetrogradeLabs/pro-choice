import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { compareIsoInstants } from "../../src/lib/format.ts";
import {
  FRONTIER_HARNESS_BENCHMARK_IDS,
  HARNESS_LB_BENCHMARK_IDS,
  validateHarnessSourceBenchmarks,
} from "../../src/lib/math/harness-pareto.ts";
import { parseStrictUtcDateMs, utcCalendarDayDiff } from "../../src/lib/math/lifecycle.ts";
import {
  type HarnessLeaderboardSnapshot,
  HarnessLeaderboardSnapshotSchema,
  type PricingRecord,
  PricingRecordSchema,
  type RawObservation,
  RawObservationSchema,
  SourceHealthSchema,
  type SubFeedHealth,
} from "../../src/lib/schema.ts";
import { fsyncDir, fsyncFile } from "./generation.ts";
import type { CachedSourceFile, ShrinkStateEntry, ShrinkStateMap, SourceAdapter } from "./types.ts";

const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");
const MAX_SCHEMA_REJECT_RATE = 0.1;
const MIN_RETENTION_RATIO = 0.5;
const SHRINK_CONFIRMATION_DAYS = 3;

const ShrinkStateEntrySchema = z
  .object({
    consecutiveDropDays: z.number().int().min(1),
    lastLowCountDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((d) => parseStrictUtcDateMs(d) !== null, "Expected valid UTC calendar date"),
    confirmed: z.boolean().optional(),
    baselineRowCount: z.number().int().nonnegative().optional(),
  })
  .refine(
    (entry) => !entry.confirmed || entry.consecutiveDropDays >= SHRINK_CONFIRMATION_DAYS,
    `Confirmed shrink checkpoint requires consecutiveDropDays >= ${SHRINK_CONFIRMATION_DAYS}`,
  );
const ShrinkStateFileSchema = z.record(z.string(), ShrinkStateEntrySchema);

function resolveRawDir(dataDir?: string): string {
  return path.join(dataDir ?? DEFAULT_DATA_DIR, "raw");
}

function resolveShrinkStatePath(shrinkStatePath?: string, dataDir?: string): string {
  return shrinkStatePath ?? path.join(resolveRawDir(dataDir), ".shrink-state.json");
}

// Return empty shrink state ONLY on ENOENT so corrupt recovery checkpoints fail loudly rather than resetting streaks silently
async function readShrinkState(
  shrinkStatePath?: string,
  dataDir?: string,
): Promise<ShrinkStateMap> {
  const targetPath = resolveShrinkStatePath(shrinkStatePath, dataDir);
  let raw: string;
  try {
    raw = await fs.readFile(targetPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Failed to read shrink state ${targetPath}`, { cause: err });
  }
  const parsed = ShrinkStateFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Corrupt shrink state ${targetPath}: ${parsed.error.message}`);
  }
  const out: ShrinkStateMap = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    out[k] = {
      consecutiveDropDays: v.consecutiveDropDays,
      lastLowCountDate: v.lastLowCountDate,
      ...(v.confirmed !== undefined ? { confirmed: v.confirmed } : {}),
      ...(v.baselineRowCount !== undefined ? { baselineRowCount: v.baselineRowCount } : {}),
    };
  }
  return out;
}

export async function writeShrinkState(
  sources: readonly CachedSourceFile[],
  options: { dataDir?: string; shrinkStatePath?: string } = {},
): Promise<void> {
  const targetPath = resolveShrinkStatePath(options.shrinkStatePath, options.dataDir);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const state: ShrinkStateMap = {};
  for (const s of sources) {
    if (s.shrinkCheckpoints) {
      for (const [key, entry] of Object.entries(s.shrinkCheckpoints)) {
        state[key] = entry;
      }
      continue;
    }
    for (const sf of s.health.subFeeds) {
      if (sf.consecutiveDropDays > 0 && sf.lastLowCountDate) {
        state[`${s.health.sourceId}::${sf.benchmarkId}`] = {
          consecutiveDropDays: sf.consecutiveDropDays,
          lastLowCountDate: sf.lastLowCountDate,
          baselineRowCount: sf.rowCount,
        };
      }
    }
    if (
      s.health.pricingHealth &&
      s.health.pricingHealth.consecutiveDropDays > 0 &&
      s.health.pricingHealth.lastLowCountDate
    ) {
      state[`${s.health.sourceId}::__pricing__`] = {
        consecutiveDropDays: s.health.pricingHealth.consecutiveDropDays,
        lastLowCountDate: s.health.pricingHealth.lastLowCountDate,
        baselineRowCount: s.health.pricingHealth.rowCount,
      };
    }
  }
  const tmpPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fsyncFile(tmpPath);
    await fs.rename(tmpPath, targetPath);
    await fsyncDir(path.dirname(targetPath));
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export async function ensureRawDir(dataDir?: string): Promise<void> {
  await fs.mkdir(resolveRawDir(dataDir), { recursive: true });
}

// Strict cache reader for CI and validation: fails on any malformed persisted row or schema drift
export async function readSourceCacheStrict(
  sourceId: string,
  dataDir?: string,
): Promise<CachedSourceFile> {
  const filePath = path.join(resolveRawDir(dataDir), `${sourceId}.json`);
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as {
    health?: unknown;
    payload?: { observations?: unknown; pricing?: unknown; harnessLeaderboard?: unknown };
  };
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.payload ||
    typeof parsed.payload !== "object"
  ) {
    throw new Error(`Cache ${sourceId} missing payload object`);
  }
  if (!Array.isArray(parsed.payload.observations) || !Array.isArray(parsed.payload.pricing)) {
    throw new Error(`Cache ${sourceId} observations/pricing must be arrays`);
  }
  const health = SourceHealthSchema.parse(parsed.health);
  if (health.sourceId !== sourceId) {
    throw new Error(`Cache ${sourceId} health.sourceId '${health.sourceId}' !== '${sourceId}'`);
  }
  const observations = parsed.payload.observations.map((o, idx) => {
    const res = RawObservationSchema.safeParse(o);
    if (!res.success) {
      throw new Error(`Cache ${sourceId} observation[${idx}] invalid: ${res.error.message}`);
    }
    if (res.data.sourceId !== sourceId) {
      throw new Error(
        `Cache ${sourceId} observation[${idx}] sourceId '${res.data.sourceId}' does not belong to '${sourceId}'`,
      );
    }
    return res.data;
  });
  const pricing = parsed.payload.pricing.map((p, idx) => {
    const res = PricingRecordSchema.safeParse(p);
    if (!res.success) {
      throw new Error(`Cache ${sourceId} pricing[${idx}] invalid: ${res.error.message}`);
    }
    return res.data;
  });
  let harnessLeaderboard: HarnessLeaderboardSnapshot | undefined;
  if (parsed.payload.harnessLeaderboard !== undefined) {
    const res = HarnessLeaderboardSnapshotSchema.safeParse(parsed.payload.harnessLeaderboard);
    if (!res.success) {
      throw new Error(`Cache ${sourceId} harnessLeaderboard invalid: ${res.error.message}`);
    }
    if (sourceId === "frontier-harness") {
      validateHarnessSourceBenchmarks(
        res.data,
        FRONTIER_HARNESS_BENCHMARK_IDS,
        `Cache ${sourceId}`,
      );
    } else if (sourceId === "harness-leaderboard") {
      validateHarnessSourceBenchmarks(res.data, HARNESS_LB_BENCHMARK_IDS, `Cache ${sourceId}`);
    }
    harnessLeaderboard = res.data;
  }
  return {
    health,
    payload: {
      observations,
      pricing,
      ...(harnessLeaderboard !== undefined ? { harnessLeaderboard } : {}),
    },
  };
}

export async function writeSourceCache(
  sourceId: string,
  file: CachedSourceFile,
  dataDir?: string,
): Promise<void> {
  await ensureRawDir(dataDir);
  const rawDir = resolveRawDir(dataDir);
  const filePath = path.join(rawDir, `${sourceId}.json`);
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const persisted = { health: file.health, payload: file.payload };
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    await fsyncFile(tmpPath);
    await fs.rename(tmpPath, filePath);
    await fsyncDir(rawDir);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

interface RawCacheSwapEntry {
  sourceId: string;
  tmpName: string;
  liveName: string;
  backupName: string;
  existedBefore: boolean;
}

interface RawCacheSwapJournal {
  runToken: string;
  entries: RawCacheSwapEntry[];
}

async function copyReplaceFile(srcPath: string, dstPath: string): Promise<void> {
  const tmpPath = `${dstPath}.${process.pid}.${crypto.randomUUID()}.restore.tmp`;
  try {
    await fs.copyFile(srcPath, tmpPath);
    await fsyncFile(tmpPath);
    await fs.rename(tmpPath, dstPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

async function restoreRawCacheSwap(
  rawDir: string,
  entries: readonly RawCacheSwapEntry[],
): Promise<string[]> {
  const errors: string[] = [];
  await Promise.allSettled(
    entries.toReversed().map(async (entry) => {
      const livePath = path.join(rawDir, entry.liveName);
      const backupPath = path.join(rawDir, entry.backupName);
      try {
        if (entry.existedBefore) {
          await copyReplaceFile(backupPath, livePath);
        } else {
          await fs.unlink(livePath).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") throw err;
          });
        }
      } catch (err) {
        errors.push(`${livePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
  return errors;
}

export async function recoverPendingRawCacheSwap(dataDir?: string): Promise<void> {
  const rawDir = resolveRawDir(dataDir);
  const walPath = path.join(rawDir, ".raw-swap.json");
  let rawWal: string;
  try {
    rawWal = await fs.readFile(walPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      let names: string[] = [];
      try {
        names = await fs.readdir(rawDir);
      } catch (dirErr) {
        if ((dirErr as NodeJS.ErrnoException).code === "ENOENT") return;
        throw dirErr;
      }
      const orphans = names.filter(
        (n) => n.endsWith(".tmp") || n.endsWith(".bak") || n.startsWith(".raw-swap.json."),
      );
      if (orphans.length > 0) {
        // Flush directory before deleting orphaned backups so any prior WAL unlink is durable first
        await fsyncDir(rawDir);
        await Promise.allSettled(
          orphans.map((n) => fs.unlink(path.join(rawDir, n)).catch(() => undefined)),
        );
      }
      return;
    }
    throw new Error(`Corrupt raw cache swap journal ${walPath}`, { cause: err });
  }

  const journal = JSON.parse(rawWal) as RawCacheSwapJournal;
  const restoreErrors = await restoreRawCacheSwap(rawDir, journal.entries);
  if (restoreErrors.length > 0) {
    throw new Error(
      `Failed to recover interrupted raw cache swap (backups retained in ${rawDir}): ${restoreErrors.join("; ")}`,
    );
  }
  await fsyncDir(rawDir);
  await fs.unlink(walPath);
  await fsyncDir(rawDir);
  await Promise.allSettled(
    journal.entries.flatMap((entry) => [
      fs.unlink(path.join(rawDir, entry.tmpName)).catch(() => undefined),
      fs.unlink(path.join(rawDir, entry.backupName)).catch(() => undefined),
    ]),
  );
}

// Stage, WAL-journal, and fsync every raw cache before renaming so interruption or EIO recovers the whole batch cleanly
export async function writeAllSourceCachesAtomically(
  files: readonly CachedSourceFile[],
  dataDir?: string,
): Promise<void> {
  await ensureRawDir(dataDir);
  const rawDir = resolveRawDir(dataDir);
  const walPath = path.join(rawDir, ".raw-swap.json");
  const runToken = `${process.pid}.${crypto.randomUUID()}`;
  const walTmpPath = `${walPath}.${runToken}.tmp`;
  const staged = files.map((file) => {
    const liveName = `${file.health.sourceId}.json`;
    const tmpName = `${liveName}.${runToken}.tmp`;
    const backupName = `${liveName}.${runToken}.bak`;
    return {
      sourceId: file.health.sourceId,
      liveName,
      tmpName,
      backupName,
      filePath: path.join(rawDir, liveName),
      tmpPath: path.join(rawDir, tmpName),
      backupPath: path.join(rawDir, backupName),
      content: `${JSON.stringify({ health: file.health, payload: file.payload }, null, 2)}\n`,
      existedBefore: false,
    };
  });

  const stageResults = await Promise.allSettled(
    staged.map(async (item) => {
      await fs.writeFile(item.tmpPath, item.content, "utf8");
      await fsyncFile(item.tmpPath);
      try {
        await fsyncFile(item.filePath);
        await fs.link(item.filePath, item.backupPath);
        item.existedBefore = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }),
  );
  const stageFailed = stageResults.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (stageFailed) {
    await Promise.allSettled(
      staged.flatMap((item) => [
        fs.unlink(item.tmpPath).catch(() => undefined),
        fs.unlink(item.backupPath).catch(() => undefined),
      ]),
    );
    throw stageFailed.reason;
  }

  const journalEntries: RawCacheSwapEntry[] = staged.map((item) => ({
    sourceId: item.sourceId,
    tmpName: item.tmpName,
    liveName: item.liveName,
    backupName: item.backupName,
    existedBefore: item.existedBefore,
  }));
  let walInstalled = false;
  try {
    const journal: RawCacheSwapJournal = { runToken, entries: journalEntries };
    await fs.writeFile(walTmpPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    await fsyncFile(walTmpPath);
    await fs.rename(walTmpPath, walPath);
    walInstalled = true;
    await fsyncDir(rawDir);
  } catch (walErr) {
    if (!walInstalled) {
      await fs.unlink(walTmpPath).catch(() => undefined);
      await Promise.allSettled(
        staged.flatMap((item) => [
          fs.unlink(item.tmpPath).catch(() => undefined),
          fs.unlink(item.backupPath).catch(() => undefined),
        ]),
      );
    }
    throw walErr;
  }

  try {
    await staged.reduce(async (chain, item) => {
      await chain;
      await fs.rename(item.tmpPath, item.filePath);
    }, Promise.resolve());
    await fsyncDir(rawDir);
  } catch (renameErr) {
    const restoreErrors = await restoreRawCacheSwap(rawDir, journalEntries);
    if (restoreErrors.length > 0) {
      const origMsg = renameErr instanceof Error ? renameErr.message : String(renameErr);
      throw new Error(
        `Raw cache promotion failed (${origMsg}); rollback also failed and backups were retained: ${restoreErrors.join("; ")}`,
        { cause: renameErr },
      );
    }
    try {
      await fsyncDir(rawDir);
      await fs.unlink(walPath);
      await fsyncDir(rawDir);
    } catch (finalizeErr) {
      const origMsg = renameErr instanceof Error ? renameErr.message : String(renameErr);
      const finMsg = finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr);
      throw new Error(
        `Raw cache promotion failed (${origMsg}); rollback WAL finalization failed (${finMsg}) and backups were retained`,
        { cause: finalizeErr },
      );
    }
    await Promise.allSettled(
      staged.flatMap((item) => [
        fs.unlink(item.tmpPath).catch(() => undefined),
        fs.unlink(item.backupPath).catch(() => undefined),
      ]),
    );
    throw renameErr;
  }

  // Delete backups only after WAL removal is durably flushed
  await fs.unlink(walPath);
  await fsyncDir(rawDir);
  await Promise.allSettled(staged.map((item) => fs.unlink(item.backupPath).catch(() => undefined)));
}

function groupByBenchmark(rows: readonly RawObservation[]): Map<string, RawObservation[]> {
  const map = new Map<string, RawObservation[]>();
  for (const row of rows) {
    const list = map.get(row.benchmarkId) ?? [];
    list.push(row);
    map.set(row.benchmarkId, list);
  }
  return map;
}

// Track consecutive low-count confirmations using the partition's own lastLowCountDate so outages reset cleanly
function advanceShrinkStreak(
  prevSub: Pick<SubFeedHealth, "consecutiveDropDays" | "lastLowCountDate"> | undefined | null,
  todayUtc: string,
): { consecutiveDropDays: number; lastLowCountDate: string } {
  const prevCount = prevSub?.consecutiveDropDays ?? 0;
  const prevLowDate = prevSub?.lastLowCountDate ?? null;
  if (prevCount <= 0 || !prevLowDate) {
    return { consecutiveDropDays: 1, lastLowCountDate: todayUtc };
  }
  const diff = utcCalendarDayDiff(prevLowDate, todayUtc);
  if (diff === 0) return { consecutiveDropDays: prevCount, lastLowCountDate: prevLowDate };
  if (diff === 1) return { consecutiveDropDays: prevCount + 1, lastLowCountDate: todayUtc };
  return { consecutiveDropDays: 1, lastLowCountDate: todayUtc };
}

export interface RefreshSourceOptions {
  writeToDisk?: boolean;
  dataDir?: string;
  shrinkStatePath?: string;
}

// Strict existing-cache loader: returns null ONLY on ENOENT, throwing loudly on corrupt JSON or schema drift
async function readExistingCacheOrNullOnMissing(
  sourceId: string,
  dataDir?: string,
): Promise<CachedSourceFile | null> {
  try {
    return await readSourceCacheStrict(sourceId, dataDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Corrupt persisted raw cache data/raw/${sourceId}.json`, { cause: err });
  }
}

export async function refreshMandatorySource(
  adapter: SourceAdapter,
  nowIso: string,
  options: RefreshSourceOptions = {},
): Promise<CachedSourceFile> {
  const writeToDisk = options.writeToDisk ?? true;
  const existing = await readExistingCacheOrNullOnMissing(adapter.id, options.dataDir);
  const shrinkState = await readShrinkState(options.shrinkStatePath, options.dataDir);
  const nowDateMs = parseStrictUtcDateMs(nowIso);
  if (nowDateMs === null) {
    throw new Error(`Invalid ingestion timestamp '${nowIso}'`);
  }
  const todayUtc = new Date(nowDateMs).toISOString().slice(0, 10);

  const shrinkCheckpoints: ShrinkStateMap = {};
  const prevStreakFor = (
    key: string,
    prevSub: SubFeedHealth | undefined | null,
    currentBaselineCount: number,
  ): ShrinkStateEntry | undefined => {
    const ext = shrinkState[key];
    // Discard checkpoints that were already confirmed or recorded against a different published baseline
    const validExt =
      ext && !ext.confirmed && ext.baselineRowCount === currentBaselineCount ? ext : undefined;
    if (
      validExt &&
      (!prevSub?.lastLowCountDate || validExt.lastLowCountDate > prevSub.lastLowCountDate)
    ) {
      return validExt;
    }
    if (prevSub && prevSub.consecutiveDropDays > 0 && prevSub.lastLowCountDate) {
      return {
        consecutiveDropDays: prevSub.consecutiveDropDays,
        lastLowCountDate: prevSub.lastLowCountDate,
        baselineRowCount: currentBaselineCount,
      };
    }
    return undefined;
  };

  try {
    const live = await adapter.fetchLive(nowIso);

    const validObs: RawObservation[] = [];
    const zodRejectedByBm = new Map<string, number>();
    const zodSeenByBm = new Map<string, number>();

    for (const rawObs of live.observations) {
      const bmKey =
        rawObs && typeof rawObs.benchmarkId === "string" && rawObs.benchmarkId
          ? rawObs.benchmarkId
          : "unknown";
      zodSeenByBm.set(bmKey, (zodSeenByBm.get(bmKey) ?? 0) + 1);
      const parsed = RawObservationSchema.safeParse(rawObs);
      if (parsed.success && parsed.data.sourceId === adapter.id) {
        validObs.push(parsed.data);
      } else {
        zodRejectedByBm.set(bmKey, (zodRejectedByBm.get(bmKey) ?? 0) + 1);
      }
    }

    const validPricing: PricingRecord[] = [];
    let zodRejectedPricing = 0;
    for (const rawPr of live.pricing) {
      const parsed = PricingRecordSchema.safeParse(rawPr);
      if (parsed.success) validPricing.push(parsed.data);
      else zodRejectedPricing++;
    }

    const liveByBm = groupByBenchmark(validObs);
    const prevByBm = groupByBenchmark(existing?.payload.observations ?? []);
    const prevSubHealth = new Map(
      (existing?.health.subFeeds ?? []).map((sf) => [sf.benchmarkId, sf]),
    );

    // Iterate strictly adapter.expectedBenchmarks so retired/renamed benchmarks never stick degraded
    const targetBenchmarks = [...adapter.expectedBenchmarks].toSorted();
    const mergedObs: RawObservation[] = [];
    const subFeeds: SubFeedHealth[] = [];
    const degradedReasons: string[] = [];

    for (const bmId of targetBenchmarks) {
      const liveRows = liveByBm.get(bmId) ?? [];
      const prevRows = prevByBm.get(bmId) ?? [];
      const prevSub = prevSubHealth.get(bmId);
      const adapterStat = live.partitionStats?.[bmId];

      const totalRejected = (adapterStat?.rejected ?? 0) + (zodRejectedByBm.get(bmId) ?? 0);
      const eligibleAttempted = adapterStat
        ? Math.max(zodSeenByBm.get(bmId) ?? 0, adapterStat.attempted - adapterStat.excluded)
        : (zodSeenByBm.get(bmId) ?? 0);
      const rejectRate = eligibleAttempted > 0 ? totalRejected / eligibleAttempted : 0;

      const endpointErrored = Boolean(adapterStat?.error);
      const schemaFailed = eligibleAttempted > 0 && rejectRate > MAX_SCHEMA_REJECT_RATE;
      const droppedBelowHalf =
        prevRows.length >= 4 && liveRows.length < Math.ceil(prevRows.length * MIN_RETENTION_RATIO);

      let confirmedShrink = false;
      let consecutiveDropDays = 0;
      let lastLowCountDate: string | null = null;
      const bmShrinkKey = `${adapter.id}::${bmId}`;
      const existingBmShrink = shrinkState[bmShrinkKey];
      if (!endpointErrored && !schemaFailed && liveRows.length > 0 && droppedBelowHalf) {
        // Retain a confirmed shrink across failed multi-feed publication runs until the smaller baseline is published
        if (existingBmShrink?.confirmed && existingBmShrink.baselineRowCount === prevRows.length) {
          confirmedShrink = true;
          shrinkCheckpoints[bmShrinkKey] = {
            consecutiveDropDays: SHRINK_CONFIRMATION_DAYS,
            lastLowCountDate: todayUtc,
            confirmed: true,
            baselineRowCount: prevRows.length,
          };
        } else {
          const streak = advanceShrinkStreak(
            prevStreakFor(bmShrinkKey, prevSub, prevRows.length),
            todayUtc,
          );
          if (streak.consecutiveDropDays >= SHRINK_CONFIRMATION_DAYS) {
            confirmedShrink = true;
            shrinkCheckpoints[bmShrinkKey] = {
              consecutiveDropDays: SHRINK_CONFIRMATION_DAYS,
              lastLowCountDate: todayUtc,
              confirmed: true,
              baselineRowCount: prevRows.length,
            };
          } else {
            consecutiveDropDays = streak.consecutiveDropDays;
            lastLowCountDate = streak.lastLowCountDate;
            shrinkCheckpoints[bmShrinkKey] = {
              consecutiveDropDays,
              lastLowCountDate,
              baselineRowCount: prevRows.length,
            };
          }
        }
      } else if (
        existingBmShrink?.confirmed &&
        existingBmShrink.baselineRowCount === prevRows.length &&
        (endpointErrored || liveRows.length === 0 || schemaFailed)
      ) {
        shrinkCheckpoints[bmShrinkKey] = existingBmShrink;
      }

      const partitionFailed =
        endpointErrored ||
        liveRows.length === 0 ||
        schemaFailed ||
        (droppedBelowHalf && !confirmedShrink);

      if (partitionFailed) {
        const reason = endpointErrored
          ? `endpoint error for ${bmId}: ${adapterStat?.error}`
          : liveRows.length === 0
            ? `0 live rows for ${bmId}`
            : schemaFailed
              ? `schema rejection ${(rejectRate * 100).toFixed(0)}% for ${bmId}`
              : `row count dropped from ${prevRows.length} to ${liveRows.length} for ${bmId} (day ${consecutiveDropDays}/${SHRINK_CONFIRMATION_DAYS})`;

        // Never republish cached observations whose sourceRowId was explicitly disqualified by live fallback/gate evidence
        const disqualifiedIds = new Set(live.disqualifiedSourceRowIdsByBenchmark?.[bmId] ?? []);
        const retainedRows = prevRows.filter((row) => !disqualifiedIds.has(row.sourceRowId));
        const strippedDisqualified = prevRows.length - retainedRows.length;
        const disqualifiedNote =
          strippedDisqualified > 0
            ? `; excluded ${strippedDisqualified} live-disqualified cached rows`
            : "";
        const persistedDropDays = strippedDisqualified > 0 ? 0 : consecutiveDropDays;
        const persistedLowDate = strippedDisqualified > 0 ? null : lastLowCountDate;

        if (retainedRows.length > 0) {
          mergedObs.push(...retainedRows);
          degradedReasons.push(
            `${reason}; retained ${retainedRows.length} cached rows${disqualifiedNote}`,
          );
          subFeeds.push({
            benchmarkId: bmId,
            status: "degraded",
            rowCount: retainedRows.length,
            rejectedCount: totalRejected,
            consecutiveDropDays: persistedDropDays,
            lastLowCountDate: persistedLowDate,
            lastHealthyAt: prevSub?.lastHealthyAt ?? existing?.health.lastHealthyAt ?? null,
            message: `${reason}${disqualifiedNote}`,
          });
        } else {
          degradedReasons.push(`${reason}; no prior cache${disqualifiedNote}`);
          subFeeds.push({
            benchmarkId: bmId,
            status: "degraded",
            rowCount: 0,
            rejectedCount: totalRejected,
            consecutiveDropDays: persistedDropDays,
            lastLowCountDate: persistedLowDate,
            lastHealthyAt: null,
            message: `${reason}${disqualifiedNote}`,
          });
        }
      } else {
        mergedObs.push(...liveRows);
        const notes: string[] = [];
        if (confirmedShrink) {
          notes.push(
            `Accepted confirmed upstream shrink (${prevRows.length} -> ${liveRows.length})`,
          );
        }
        if (adapterStat?.note) notes.push(adapterStat.note);
        subFeeds.push({
          benchmarkId: bmId,
          status: "ok",
          rowCount: liveRows.length,
          rejectedCount: totalRejected,
          consecutiveDropDays: 0,
          lastLowCountDate: null,
          lastHealthyAt: nowIso,
          message: notes.length > 0 ? notes.join("; ") : null,
        });
      }
    }

    let mergedPricing = validPricing;
    let pricingHealth: SubFeedHealth | null = null;
    if (adapter.expectsPricing) {
      const prevPricing = existing?.payload.pricing ?? [];
      const prevPricingHealth = existing?.health.pricingHealth ?? null;
      const pStat = live.pricingStats;
      const totalPricingRejected = (pStat?.rejected ?? 0) + zodRejectedPricing;
      const pricingEligible = pStat
        ? Math.max(live.pricing.length, pStat.attempted - pStat.excluded)
        : live.pricing.length;
      const pricingRejectRate = pricingEligible > 0 ? totalPricingRejected / pricingEligible : 0;

      const pricingErrored = Boolean(pStat?.error);
      const pricingSchemaFailed = pricingEligible > 0 && pricingRejectRate > MAX_SCHEMA_REJECT_RATE;
      const pricingDropped =
        prevPricing.length >= 4 &&
        validPricing.length < Math.ceil(prevPricing.length * MIN_RETENTION_RATIO);

      const conflictingSkus = new Set(live.conflictingPricingApiSkus ?? []);
      const conflictingSlugs = new Set(live.conflictingPricingModelSlugs ?? []);
      const pricingShrinkKey = `${adapter.id}::__pricing__`;
      const existingPricingShrink = shrinkState[pricingShrinkKey];

      let confirmedPricingShrink = false;
      let pricingDropDays = 0;
      let pricingLowDate: string | null = null;
      if (!pricingErrored && !pricingSchemaFailed && validPricing.length > 0 && pricingDropped) {
        if (
          existingPricingShrink?.confirmed &&
          existingPricingShrink.baselineRowCount === prevPricing.length
        ) {
          confirmedPricingShrink = true;
          shrinkCheckpoints[pricingShrinkKey] = {
            consecutiveDropDays: SHRINK_CONFIRMATION_DAYS,
            lastLowCountDate: todayUtc,
            confirmed: true,
            baselineRowCount: prevPricing.length,
          };
        } else {
          const streak = advanceShrinkStreak(
            prevStreakFor(pricingShrinkKey, prevPricingHealth, prevPricing.length),
            todayUtc,
          );
          if (streak.consecutiveDropDays >= SHRINK_CONFIRMATION_DAYS) {
            confirmedPricingShrink = true;
            shrinkCheckpoints[pricingShrinkKey] = {
              consecutiveDropDays: SHRINK_CONFIRMATION_DAYS,
              lastLowCountDate: todayUtc,
              confirmed: true,
              baselineRowCount: prevPricing.length,
            };
          } else {
            pricingDropDays = streak.consecutiveDropDays;
            pricingLowDate = streak.lastLowCountDate;
            shrinkCheckpoints[pricingShrinkKey] = {
              consecutiveDropDays: pricingDropDays,
              lastLowCountDate: pricingLowDate,
              baselineRowCount: prevPricing.length,
            };
          }
        }
      } else if (
        existingPricingShrink?.confirmed &&
        existingPricingShrink.baselineRowCount === prevPricing.length &&
        (pricingErrored || validPricing.length === 0 || pricingSchemaFailed)
      ) {
        shrinkCheckpoints[pricingShrinkKey] = existingPricingShrink;
      }

      const pricingFailed =
        pricingErrored ||
        validPricing.length === 0 ||
        pricingSchemaFailed ||
        (pricingDropped && !confirmedPricingShrink);

      if (pricingFailed) {
        const reason = pricingErrored
          ? `pricing error: ${pStat?.error}`
          : validPricing.length === 0
            ? "0 live pricing rows"
            : pricingSchemaFailed
              ? `pricing schema rejection ${(pricingRejectRate * 100).toFixed(0)}%`
              : `pricing count dropped from ${prevPricing.length} to ${validPricing.length} (day ${pricingDropDays}/${SHRINK_CONFIRMATION_DAYS})`;

        // Never restore cached tariffs for SKUs/slugs that live ingestion explicitly flagged as contradictory
        const retainedPricing = prevPricing.filter(
          (p) =>
            !(p.apiSku !== null && conflictingSkus.has(p.apiSku)) &&
            !conflictingSlugs.has(p.modelSlug),
        );
        const strippedConflictCount = prevPricing.length - retainedPricing.length;
        const conflictNote =
          strippedConflictCount > 0
            ? `; excluded ${strippedConflictCount} conflicting cached prices`
            : "";

        // Reset cache-embedded streak when conflict filtering changes retained baseline, while keeping .shrink-state keyed to prevPricing.length so blocked >7d runs still advance
        const persistedDropDays = strippedConflictCount > 0 ? 0 : pricingDropDays;
        const persistedLowDate = strippedConflictCount > 0 ? null : pricingLowDate;

        if (retainedPricing.length > 0) {
          mergedPricing = retainedPricing;
          degradedReasons.push(
            `${reason}; retained ${retainedPricing.length} cached prices${conflictNote}`,
          );
          pricingHealth = {
            benchmarkId: "__pricing__",
            status: "degraded",
            rowCount: retainedPricing.length,
            rejectedCount: totalPricingRejected,
            consecutiveDropDays: persistedDropDays,
            lastLowCountDate: persistedLowDate,
            lastHealthyAt:
              prevPricingHealth?.lastHealthyAt ?? existing?.health.lastHealthyAt ?? null,
            message: `${reason}${conflictNote}`,
          };
        } else {
          mergedPricing = [];
          degradedReasons.push(`${reason}${conflictNote}`);
          pricingHealth = {
            benchmarkId: "__pricing__",
            status: "degraded",
            rowCount: 0,
            rejectedCount: totalPricingRejected,
            consecutiveDropDays: persistedDropDays,
            lastLowCountDate: persistedLowDate,
            lastHealthyAt: null,
            message: `${reason}${conflictNote}`,
          };
        }
      } else {
        pricingHealth = {
          benchmarkId: "__pricing__",
          status: "ok",
          rowCount: validPricing.length,
          rejectedCount: totalPricingRejected,
          consecutiveDropDays: 0,
          lastLowCountDate: null,
          lastHealthyAt: nowIso,
          message: confirmedPricingShrink
            ? `Accepted confirmed pricing shrink (${prevPricing.length} -> ${validPricing.length})`
            : null,
        };
      }
    }

    let mergedHarnessLeaderboard: HarnessLeaderboardSnapshot | undefined;
    if (adapter.expectsHarnessLeaderboard) {
      const hlbKey = `${adapter.id}::__harness_leaderboard__`;
      const prevHlb = existing?.payload.harnessLeaderboard;
      const prevHlbSub = prevSubHealth.get("__harness_leaderboard__");
      const prevHlbRows = prevHlb
        ? prevHlb.slices.reduce((acc, s) => acc + s.entries.length, 0)
        : 0;
      const hlbStats = live.harnessLeaderboardStats;
      const hlbAttempted = hlbStats?.attempted ?? 0;
      const hlbRejected = hlbStats?.rejected ?? 0;
      const hlbRejectRate = hlbAttempted > 0 ? hlbRejected / hlbAttempted : 0;
      const hlbEndpointErrored = Boolean(hlbStats?.error);
      const hlbSchemaFailed = hlbAttempted > 0 && hlbRejectRate > MAX_SCHEMA_REJECT_RATE;

      const parsedHlb =
        !hlbEndpointErrored && live.harnessLeaderboard !== undefined
          ? HarnessLeaderboardSnapshotSchema.safeParse(live.harnessLeaderboard)
          : null;
      let liveHlb = parsedHlb?.success ? parsedHlb.data : null;
      let hlbRosterError: string | null = null;
      if (liveHlb !== null) {
        const expectedBenchmarks =
          adapter.id === "frontier-harness"
            ? FRONTIER_HARNESS_BENCHMARK_IDS
            : adapter.id === "harness-leaderboard"
              ? HARNESS_LB_BENCHMARK_IDS
              : null;
        if (expectedBenchmarks) {
          try {
            validateHarnessSourceBenchmarks(
              liveHlb,
              expectedBenchmarks,
              adapter.id === "frontier-harness" ? "FrontierHarness" : "Harness Leaderboard",
            );
          } catch (err) {
            liveHlb = null;
            hlbRosterError = err instanceof Error ? err.message : String(err);
          }
        }
      }
      const liveHlbRows = liveHlb
        ? liveHlb.slices.reduce((acc, s) => acc + s.entries.length, 0)
        : 0;

      // Reject upstream timestamp rollbacks or future timestamps; completed periodic studies stay valid once live HTTP succeeds
      const upstreamRollback =
        liveHlb !== null &&
        prevHlb !== undefined &&
        (() => {
          const cmp = compareIsoInstants(liveHlb.upstreamGeneratedAt, prevHlb.upstreamGeneratedAt);
          return cmp === null || cmp < 0;
        })();
      const upstreamFutureOrInvalid =
        liveHlb !== null &&
        (() => {
          if (parseStrictUtcDateMs(liveHlb.upstreamGeneratedAt) === null) return true;
          const upExactMs = Date.parse(liveHlb.upstreamGeneratedAt);
          const nowExactMs = Date.parse(nowIso);
          return (
            !Number.isFinite(upExactMs) ||
            !Number.isFinite(nowExactMs) ||
            upExactMs > nowExactMs + 60_000
          );
        })();

      const hlbShrunk =
        liveHlb !== null &&
        prevHlb !== undefined &&
        ((prevHlbRows >= 8 && liveHlbRows < Math.ceil(prevHlbRows * MIN_RETENTION_RATIO)) ||
          liveHlb.slices.length < prevHlb.slices.length);

      let confirmedHlbShrink = false;
      let hlbDropDays = 0;
      let hlbLowDate: string | null = null;
      const existingHlbShrink = shrinkState[hlbKey];
      if (
        !hlbEndpointErrored &&
        !hlbSchemaFailed &&
        !upstreamRollback &&
        !upstreamFutureOrInvalid &&
        hlbShrunk
      ) {
        if (existingHlbShrink?.confirmed && existingHlbShrink.baselineRowCount === prevHlbRows) {
          confirmedHlbShrink = true;
          shrinkCheckpoints[hlbKey] = {
            consecutiveDropDays: SHRINK_CONFIRMATION_DAYS,
            lastLowCountDate: todayUtc,
            confirmed: true,
            baselineRowCount: prevHlbRows,
          };
        } else {
          const streak = advanceShrinkStreak(
            prevStreakFor(hlbKey, prevHlbSub, prevHlbRows),
            todayUtc,
          );
          if (streak.consecutiveDropDays >= SHRINK_CONFIRMATION_DAYS) {
            confirmedHlbShrink = true;
            shrinkCheckpoints[hlbKey] = {
              consecutiveDropDays: SHRINK_CONFIRMATION_DAYS,
              lastLowCountDate: todayUtc,
              confirmed: true,
              baselineRowCount: prevHlbRows,
            };
          } else {
            hlbDropDays = streak.consecutiveDropDays;
            hlbLowDate = streak.lastLowCountDate;
            shrinkCheckpoints[hlbKey] = {
              consecutiveDropDays: hlbDropDays,
              lastLowCountDate: hlbLowDate,
              baselineRowCount: prevHlbRows,
            };
          }
        }
      } else if (
        existingHlbShrink?.confirmed &&
        existingHlbShrink.baselineRowCount === prevHlbRows &&
        (hlbEndpointErrored ||
          liveHlb === null ||
          hlbSchemaFailed ||
          upstreamRollback ||
          upstreamFutureOrInvalid)
      ) {
        shrinkCheckpoints[hlbKey] = existingHlbShrink;
      }

      const hlbFailed =
        hlbEndpointErrored ||
        liveHlb === null ||
        hlbSchemaFailed ||
        upstreamRollback ||
        upstreamFutureOrInvalid ||
        (hlbShrunk && !confirmedHlbShrink);

      if (hlbFailed || liveHlb === null) {
        const reason = hlbEndpointErrored
          ? `harness board error: ${hlbStats?.error}`
          : hlbRosterError
            ? `harness roster validation failed: ${hlbRosterError}`
            : liveHlb === null
              ? "harness leaderboard schema validation failed"
              : hlbSchemaFailed
                ? `harness board rejection ${(hlbRejectRate * 100).toFixed(0)}%`
                : upstreamRollback
                  ? `upstream timestamp rolled back (${liveHlb.upstreamGeneratedAt} < ${prevHlb?.upstreamGeneratedAt})`
                  : upstreamFutureOrInvalid
                    ? `upstream timestamp invalid or future (${liveHlb.upstreamGeneratedAt})`
                    : `harness board shrunk from ${prevHlbRows} rows (${prevHlb?.slices.length} slices) to ${liveHlbRows} rows (${liveHlb.slices.length} slices) (day ${hlbDropDays}/${SHRINK_CONFIRMATION_DAYS})`;

        if (prevHlb) {
          mergedHarnessLeaderboard = prevHlb;
          degradedReasons.push(`${reason}; retained ${prevHlb.slices.length} cached slices`);
          subFeeds.push({
            benchmarkId: "__harness_leaderboard__",
            status: "degraded",
            rowCount: prevHlbRows,
            rejectedCount: hlbRejected,
            consecutiveDropDays: hlbDropDays,
            lastLowCountDate: hlbLowDate,
            lastHealthyAt: prevHlbSub?.lastHealthyAt ?? existing?.health.lastHealthyAt ?? null,
            message: reason,
          });
        } else {
          throw new Error(`Adapter '${adapter.id}' failed without cached fallback: ${reason}`);
        }
      } else {
        mergedHarnessLeaderboard = liveHlb;
        subFeeds.push({
          benchmarkId: "__harness_leaderboard__",
          status: "ok",
          rowCount: liveHlbRows,
          rejectedCount: hlbRejected,
          consecutiveDropDays: 0,
          lastLowCountDate: null,
          lastHealthyAt: nowIso,
          message: confirmedHlbShrink
            ? `Accepted confirmed harness board shrink (${prevHlbRows} -> ${liveHlbRows})`
            : null,
        });
      }
    }

    const harnessRowsCount = mergedHarnessLeaderboard
      ? mergedHarnessLeaderboard.slices.reduce((acc, s) => acc + s.entries.length, 0)
      : 0;

    if (
      !existing &&
      mergedObs.length === 0 &&
      mergedPricing.length === 0 &&
      harnessRowsCount === 0
    ) {
      throw new Error(`Adapter '${adapter.id}' returned 0 valid rows and has no verified cache`);
    }

    const isDegraded = degradedReasons.length > 0;
    const lastHealthyAt = isDegraded ? (existing?.health.lastHealthyAt ?? null) : nowIso;
    const lastMs = lastHealthyAt ? Date.parse(lastHealthyAt) : Number.NaN;
    const nowMs = Date.parse(nowIso);
    const staleDays =
      isDegraded && Number.isFinite(lastMs)
        ? Math.max(0, Math.floor((nowMs - lastMs) / (1000 * 60 * 60 * 24)))
        : isDegraded
          ? 1
          : 0;

    const advisoryNotes = subFeeds
      .filter((sf) => sf.status === "ok" && sf.message)
      .map((sf) => `${sf.benchmarkId}: ${sf.message}`);

    const result: CachedSourceFile = {
      health: {
        sourceId: adapter.id,
        label: adapter.label,
        status: isDegraded ? "degraded" : "ok",
        fetchedAt: nowIso,
        lastHealthyAt,
        staleDays,
        rowCount: mergedObs.length + mergedPricing.length + harnessRowsCount,
        license: adapter.license,
        sourceUrl: adapter.sourceUrl,
        message: isDegraded
          ? degradedReasons.join("; ")
          : advisoryNotes.length > 0
            ? advisoryNotes.join("; ")
            : null,
        subFeeds,
        pricingHealth,
      },
      payload: {
        observations: mergedObs,
        pricing: mergedPricing,
        ...(mergedHarnessLeaderboard !== undefined
          ? { harnessLeaderboard: mergedHarnessLeaderboard }
          : {}),
      },
      shrinkCheckpoints,
    };

    if (writeToDisk) {
      await writeSourceCache(adapter.id, result, options.dataDir);
    }
    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (existing) {
      const lastMs = existing.health.lastHealthyAt
        ? Date.parse(existing.health.lastHealthyAt)
        : Number.NaN;
      const nowMs = Date.parse(nowIso);
      const staleDays = Number.isFinite(lastMs)
        ? Math.max(0, Math.floor((nowMs - lastMs) / (1000 * 60 * 60 * 24)))
        : existing.health.staleDays + 1;

      const degradedSubFeeds: SubFeedHealth[] = existing.health.subFeeds.map((sf) => ({
        ...sf,
        status: "degraded",
        consecutiveDropDays: 0,
        lastLowCountDate: null,
        message: `Live refresh failed (${errorMsg})`,
      }));
      const degradedPricingHealth: SubFeedHealth | null = existing.health.pricingHealth
        ? {
            ...existing.health.pricingHealth,
            status: "degraded",
            consecutiveDropDays: 0,
            lastLowCountDate: null,
            message: `Live refresh failed (${errorMsg})`,
          }
        : null;

      const preservedCheckpoints: ShrinkStateMap = {};
      for (const sf of existing.health.subFeeds) {
        const key = `${adapter.id}::${sf.benchmarkId}`;
        const prevEntry = shrinkState[key];
        if (prevEntry?.confirmed && prevEntry.baselineRowCount === sf.rowCount) {
          preservedCheckpoints[key] = prevEntry;
        }
      }
      if (existing.health.pricingHealth) {
        const pKey = `${adapter.id}::__pricing__`;
        const prevEntry = shrinkState[pKey];
        if (
          prevEntry?.confirmed &&
          prevEntry.baselineRowCount === existing.health.pricingHealth.rowCount
        ) {
          preservedCheckpoints[pKey] = prevEntry;
        }
      }

      const degraded: CachedSourceFile = {
        health: {
          ...existing.health,
          status: "degraded",
          fetchedAt: nowIso,
          staleDays,
          message: `Live refresh failed (${errorMsg}); serving cached snapshot from ${existing.health.lastHealthyAt ?? "unknown"}`,
          subFeeds: degradedSubFeeds,
          pricingHealth: degradedPricingHealth,
        },
        payload: existing.payload,
        shrinkCheckpoints: preservedCheckpoints,
      };

      if (writeToDisk) {
        await writeSourceCache(adapter.id, degraded, options.dataDir);
      }
      return degraded;
    }

    throw new Error(
      `Mandatory adapter '${adapter.id}' failed with no verified cache: ${errorMsg}`,
      { cause: err },
    );
  }
}
