import fs from "node:fs/promises";
import path from "node:path";
import { compareIsoInstants } from "@/lib/format";
import type { LifecycleReport, ProChoiceSnapshot } from "@/lib/schema";
import { LifecycleReportSchema, ProChoiceSnapshotSchema } from "@/lib/schema";

const DATA_DIR = path.join(process.cwd(), "data");
const CURRENT_GEN_POINTER = path.join(DATA_DIR, ".current-generation.json");
const SYNC_COMMIT_WAL = path.join(DATA_DIR, ".sync-commit.json");
const GENERATIONS_DIR = path.join(DATA_DIR, ".generations");
const MAX_CACHED_GENERATIONS = 2;

export interface PublishedRelease {
  snapshot: ProChoiceSnapshot;
  lifecycle: LifecycleReport;
}

const releaseCache = new Map<string, PublishedRelease>();
const inFlightLoads = new Map<string, Promise<PublishedRelease>>();

async function statOrNull(filePath: string) {
  try {
    return await fs.stat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function resolveActiveGeneration(): Promise<{
  releaseDir: string;
  cacheKey: string;
  liveCandidate: { releaseDir: string; cacheKey: string } | null;
}> {
  let rawPointer: string;
  try {
    rawPointer = await fs.readFile(CURRENT_GEN_POINTER, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const [snapStat, lifeStat] = await Promise.all([
        fs.stat(path.join(DATA_DIR, "snapshot.json")),
        fs.stat(path.join(DATA_DIR, "lifecycle.json")),
      ]);
      return {
        releaseDir: DATA_DIR,
        cacheKey: `live:${snapStat.mtimeMs}:${snapStat.size}:${lifeStat.mtimeMs}:${lifeStat.size}`,
        liveCandidate: null,
      };
    }
    throw new Error(`Failed to read release pointer ${CURRENT_GEN_POINTER}`, { cause: err });
  }

  const parsed = JSON.parse(rawPointer) as { generation?: unknown };
  if (typeof parsed.generation !== "string" || !/^[a-z0-9._-]+$/i.test(parsed.generation)) {
    throw new Error(`Malformed release pointer ${CURRENT_GEN_POINTER}`);
  }
  const releaseDir = path.join(GENERATIONS_DIR, parsed.generation);
  const cacheKey = `gen:${parsed.generation}`;

  // Never read flat live files while a sync commit WAL is in flight; outside a commit, detect fresher git-pulled flat pairs via inode divergence
  const walStat = await statOrNull(SYNC_COMMIT_WAL);
  if (walStat !== null) {
    return { releaseDir, cacheKey, liveCandidate: null };
  }

  const [genSnapStat, genLifeStat, liveSnapStat, liveLifeStat] = await Promise.all([
    statOrNull(path.join(releaseDir, "snapshot.json")),
    statOrNull(path.join(releaseDir, "lifecycle.json")),
    statOrNull(path.join(DATA_DIR, "snapshot.json")),
    statOrNull(path.join(DATA_DIR, "lifecycle.json")),
  ]);
  const sameHardLinkedPair =
    genSnapStat !== null &&
    genLifeStat !== null &&
    liveSnapStat !== null &&
    liveLifeStat !== null &&
    liveSnapStat.ino !== 0 &&
    liveSnapStat.ino === genSnapStat.ino &&
    liveLifeStat.ino === genLifeStat.ino;

  const liveCandidate =
    !sameHardLinkedPair && liveSnapStat !== null && liveLifeStat !== null
      ? {
          releaseDir: DATA_DIR,
          cacheKey: `live:${liveSnapStat.mtimeMs}:${liveSnapStat.size}:${liveLifeStat.mtimeMs}:${liveLifeStat.size}`,
        }
      : null;

  return { releaseDir, cacheKey, liveCandidate };
}

// Memoize immutable generations and coalesce concurrent cold loads while evicting rejections immediately for retries
async function loadReleaseForKey(releaseDir: string, cacheKey: string): Promise<PublishedRelease> {
  const cached = releaseCache.get(cacheKey);
  if (cached) return cached;

  const existingLoad = inFlightLoads.get(cacheKey);
  if (existingLoad) return existingLoad;

  const loadPromise = (async (): Promise<PublishedRelease> => {
    const [snapRaw, lifeRaw] = await Promise.all([
      fs.readFile(path.join(releaseDir, "snapshot.json"), "utf8"),
      fs.readFile(path.join(releaseDir, "lifecycle.json"), "utf8"),
    ]);
    const snapshot = ProChoiceSnapshotSchema.parse(JSON.parse(snapRaw));
    const lifecycle = LifecycleReportSchema.parse(JSON.parse(lifeRaw));
    if (snapshot.generatedAt !== lifecycle.auditedAt) {
      throw new Error(
        `Release mismatch in ${releaseDir}: snapshot.generatedAt (${snapshot.generatedAt}) !== lifecycle.auditedAt (${lifecycle.auditedAt})`,
      );
    }

    const release: PublishedRelease = { snapshot, lifecycle };
    if (releaseCache.size >= MAX_CACHED_GENERATIONS) {
      const oldestKey = releaseCache.keys().next().value;
      if (oldestKey !== undefined) releaseCache.delete(oldestKey);
    }
    releaseCache.set(cacheKey, release);
    return release;
  })().finally(() => {
    if (inFlightLoads.get(cacheKey) === loadPromise) {
      inFlightLoads.delete(cacheKey);
    }
  });

  inFlightLoads.set(cacheKey, loadPromise);
  return loadPromise;
}

async function loadReleaseAttempt(retriesLeft: number): Promise<PublishedRelease> {
  try {
    const { releaseDir, cacheKey, liveCandidate } = await resolveActiveGeneration();
    const genRelease = await loadReleaseForKey(releaseDir, cacheKey);
    if (liveCandidate) {
      const liveRelease = await loadReleaseForKey(
        liveCandidate.releaseDir,
        liveCandidate.cacheKey,
      ).catch(() => null);
      if (liveRelease) {
        const cmp = compareIsoInstants(
          liveRelease.snapshot.generatedAt,
          genRelease.snapshot.generatedAt,
        );
        if (
          cmp !== null &&
          (cmp > 0 ||
            (cmp === 0 && liveRelease.snapshot.snapshotHash !== genRelease.snapshot.snapshotHash))
        ) {
          return liveRelease;
        }
      }
    }
    return genRelease;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const isTransientRace =
      code === "ENOENT" || (err instanceof Error && err.message.startsWith("Release mismatch in "));
    if (isTransientRace && retriesLeft > 0) {
      return loadReleaseAttempt(retriesLeft - 1);
    }
    throw err;
  }
}

export async function loadRelease(): Promise<PublishedRelease> {
  return loadReleaseAttempt(2);
}

export async function loadSnapshot(): Promise<ProChoiceSnapshot> {
  const { snapshot } = await loadRelease();
  return snapshot;
}

export async function loadLifecycle(): Promise<LifecycleReport> {
  const { lifecycle } = await loadRelease();
  return lifecycle;
}
