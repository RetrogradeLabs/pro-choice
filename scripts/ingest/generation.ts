import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { compareIsoInstants } from "../../src/lib/format.ts";
import {
  EpochManifestSchema,
  LifecycleReportSchema,
  ProChoiceSnapshotSchema,
} from "../../src/lib/schema.ts";

export interface SyncCommitEntry {
  stageRel: string;
  liveRel: string;
  backupRel: string;
  existedBefore: boolean;
}

export interface SyncCommitEpochFile {
  filename: string;
  sha256: string;
  pendingRel: string;
  liveRel: string;
}

export interface SyncCommitJournal {
  generationId: string;
  generationRel: string;
  pointerTmpRel: string;
  backupRel: string;
  stageRel: string;
  pendingEpochRel: string | null;
  newEpochFiles: SyncCommitEpochFile[];
  entries: SyncCommitEntry[];
}

function sha256HexLocal(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// Open regular files read-write ("r+") so Windows FlushFileBuffers succeeds without silent EPERM skips
export async function fsyncFile(filePath: string): Promise<void> {
  const fh = await fs.open(filePath, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Skip directory fsync only on Windows where flushing a read-only dir handle fails with EPERM; stay unmasked on POSIX
export async function fsyncDir(dirPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const fh = await fs.open(dirPath, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function resolveCanonicalPath(
  targetPath: string,
  trailing: readonly string[] = [],
): Promise<string> {
  const resolved = path.resolve(targetPath);
  try {
    const real = await fs.realpath(resolved);
    return trailing.length > 0 ? path.join(real, ...trailing.toReversed()) : real;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const parent = path.dirname(resolved);
    if (parent === resolved) {
      return trailing.length > 0 ? path.join(resolved, ...trailing.toReversed()) : resolved;
    }
    return resolveCanonicalPath(parent, [...trailing, path.basename(resolved)]);
  }
}

export async function isSameDirectory(a: string, b: string): Promise<boolean> {
  const [realA, realB] = await Promise.all([resolveCanonicalPath(a), resolveCanonicalPath(b)]);
  return realA === realB;
}

export async function fileExistsStrict(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function readdirOrEmptyOnMissing(dirPath: string): Promise<string[]> {
  try {
    return await fs.readdir(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function readCurrentGenerationId(dataDir: string): Promise<string | null> {
  const ptrPath = path.join(dataDir, ".current-generation.json");
  let raw: string;
  try {
    raw = await fs.readFile(ptrPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Failed to read release pointer ${ptrPath}`, { cause: err });
  }
  let parsed: { generation?: unknown };
  try {
    parsed = JSON.parse(raw) as { generation?: unknown };
  } catch (err) {
    throw new Error(`Corrupt release pointer ${ptrPath}`, { cause: err });
  }
  if (typeof parsed.generation !== "string" || !/^[a-z0-9._-]+$/i.test(parsed.generation)) {
    throw new Error(`Malformed release pointer ${ptrPath}`);
  }
  return parsed.generation;
}

// Copy-fsync-rename restoration preserves every backup intact across repeated interrupted rollbacks
async function atomicCopyReplace(srcPath: string, dstPath: string): Promise<void> {
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

export async function restoreSwapEntries(
  dataDir: string,
  entries: readonly SyncCommitEntry[],
  newEpochFiles: readonly SyncCommitEpochFile[],
): Promise<string[]> {
  const errors: string[] = [];

  // 1. Restore all swapped files (including epochs/manifest.json) via idempotent copy-replace while preserving backups
  await Promise.allSettled(
    entries.toReversed().map(async (entry) => {
      const livePath = path.join(dataDir, entry.liveRel);
      const backupPath = path.join(dataDir, entry.backupRel);
      try {
        if (entry.existedBefore) {
          const backupExists = await fileExistsStrict(backupPath);
          if (!backupExists) {
            errors.push(`${livePath}: required backup '${entry.backupRel}' is missing`);
            return;
          }
          await atomicCopyReplace(backupPath, livePath);
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

  // 2. Only unlink newly linked epoch payloads AFTER confirming epochs/manifest.json no longer pins them
  if (newEpochFiles.length > 0) {
    const manifestPath = path.join(dataDir, "epochs", "manifest.json");
    let liveManifestAfterRestore: Record<string, string> = {};
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      liveManifestAfterRestore = EpochManifestSchema.parse(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        errors.push(
          `epochs/manifest.json: unreadable after restore, preserving epoch files (${err instanceof Error ? err.message : String(err)})`,
        );
        return errors;
      }
    }

    await Promise.allSettled(
      newEpochFiles.map(async (ef) => {
        if (Object.hasOwn(liveManifestAfterRestore, ef.filename)) {
          return;
        }
        const livePath = path.join(dataDir, ef.liveRel);
        try {
          const content = await fs.readFile(livePath, "utf8");
          if (sha256HexLocal(content) === ef.sha256) {
            await fs.unlink(livePath);
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            errors.push(`${livePath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }),
    );
  }

  return errors;
}

// Every live writer (sync, standalone ingest, standalone audit:lifecycle) resolves any outstanding sync WAL first
export async function recoverPendingSyncCommit(dataDir: string): Promise<void> {
  const journalPath = path.join(dataDir, ".sync-commit.json");
  const rawDir = path.join(dataDir, "raw");
  const epochsDir = path.join(dataDir, "epochs");

  let rawJournal: string;
  try {
    rawJournal = await fs.readFile(journalPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const dataEntries = await readdirOrEmptyOnMissing(dataDir);
      const orphans = dataEntries.filter(
        (name) =>
          name.startsWith(".sync-backup.") ||
          name.startsWith(".sync-stage.") ||
          name.startsWith(".sync-commit.json.") ||
          name.startsWith(".current-generation.json."),
      );
      if (orphans.length > 0) {
        // Flush dataDir BEFORE deleting orphaned backups so any prior un-flushed WAL unlink is durable first
        await fsyncDir(dataDir);
        await Promise.allSettled(
          orphans.map((name) => fs.rm(path.join(dataDir, name), { recursive: true, force: true })),
        );
      }
      return;
    }
    throw new Error(`Corrupt sync commit journal ${journalPath}`, { cause: err });
  }

  const journal = JSON.parse(rawJournal) as SyncCommitJournal;
  const activeGen = await readCurrentGenerationId(dataDir);
  const backupDir = path.join(dataDir, journal.backupRel);
  const stageDir = path.join(dataDir, journal.stageRel);
  const generationDir = path.join(dataDir, journal.generationRel);
  const pointerTmpPath = path.join(dataDir, journal.pointerTmpRel);
  const pendingEpochDir = journal.pendingEpochRel
    ? path.join(dataDir, journal.pendingEpochRel)
    : null;

  if (activeGen === journal.generationId) {
    // Ensure the committed pointer and journal deletion are durable BEFORE releasing backups
    await fsyncDir(dataDir);
    await fs.unlink(journalPath);
    await fsyncDir(dataDir);
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    if (pendingEpochDir) {
      await fs.rm(pendingEpochDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return;
  }

  const rollbackErrors = await restoreSwapEntries(dataDir, journal.entries, journal.newEpochFiles);
  if (rollbackErrors.length > 0) {
    throw new Error(
      `Failed to recover interrupted sync commit (backup retained at ${backupDir}): ${rollbackErrors.join("; ")}`,
    );
  }

  await Promise.all([fsyncDir(dataDir), fsyncDir(rawDir), fsyncDir(epochsDir)]);
  await fs.unlink(pointerTmpPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  await fs.rm(generationDir, { recursive: true, force: true });
  await fs.unlink(journalPath);
  await fsyncDir(dataDir);
  await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
  if (pendingEpochDir) {
    await fs.rm(pendingEpochDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Seed an immutable baseline generation from an existing schema-valid live pair (or refresh after a git pull advances live files)
export async function seedBaselineGenerationIfNeeded(dataDir: string): Promise<string | null> {
  const existingGen = await readCurrentGenerationId(dataDir);
  const liveSnapPath = path.join(dataDir, "snapshot.json");
  const liveLifePath = path.join(dataDir, "lifecycle.json");
  const [hasLiveSnap, hasLiveLife] = await Promise.all([
    fileExistsStrict(liveSnapPath),
    fileExistsStrict(liveLifePath),
  ]);
  if (!hasLiveSnap || !hasLiveLife) return existingGen;

  let snapRaw: string;
  let lifeRaw: string;
  try {
    [snapRaw, lifeRaw] = await Promise.all([
      fs.readFile(liveSnapPath, "utf8"),
      fs.readFile(liveLifePath, "utf8"),
    ]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return existingGen;
    throw new Error(`Failed to read live release pair while seeding baseline generation`, {
      cause: err,
    });
  }
  const snapParsed = ProChoiceSnapshotSchema.safeParse(JSON.parse(snapRaw));
  const lifeParsed = LifecycleReportSchema.safeParse(JSON.parse(lifeRaw));
  if (!snapParsed.success || !lifeParsed.success) {
    return existingGen;
  }
  if (snapParsed.data.generatedAt !== lifeParsed.data.auditedAt) {
    return existingGen;
  }

  if (existingGen !== null) {
    const genDir = path.join(dataDir, ".generations", existingGen);
    try {
      const [genSnapRaw, genLifeRaw] = await Promise.all([
        fs.readFile(path.join(genDir, "snapshot.json"), "utf8"),
        fs.readFile(path.join(genDir, "lifecycle.json"), "utf8"),
      ]);
      const genSnap = ProChoiceSnapshotSchema.safeParse(JSON.parse(genSnapRaw));
      const genLife = LifecycleReportSchema.safeParse(JSON.parse(genLifeRaw));
      if (genSnap.success && genLife.success) {
        const cmp = compareIsoInstants(snapParsed.data.generatedAt, genSnap.data.generatedAt);
        const liveIsFresher =
          cmp !== null &&
          (cmp > 0 || (cmp === 0 && snapParsed.data.snapshotHash !== genSnap.data.snapshotHash));
        if (!liveIsFresher) return existingGen;
      }
    } catch {
      // Fall through to re-seed from the validated live release pair when the stale generation is unreadable
    }
  }

  const generationsDir = path.join(dataDir, ".generations");
  const currentPtrPath = path.join(dataDir, ".current-generation.json");
  await fs.mkdir(generationsDir, { recursive: true });

  const runToken = `${process.pid}-${crypto.randomUUID()}`;
  const seedGenId = `seed-${runToken}`;
  const seedGenDir = path.join(generationsDir, seedGenId);
  const seedPtrTmp = `${currentPtrPath}.seed-${runToken}.tmp`;
  let pointerSwitched = false;

  try {
    await fs.mkdir(seedGenDir, { recursive: false });
    const results = await Promise.allSettled([
      fs.link(liveSnapPath, path.join(seedGenDir, "snapshot.json")),
      fs.link(liveLifePath, path.join(seedGenDir, "lifecycle.json")),
      fs.writeFile(seedPtrTmp, `${JSON.stringify({ generation: seedGenId })}\n`, "utf8"),
    ]);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected) throw rejected.reason;

    await Promise.all([
      fsyncFile(path.join(seedGenDir, "snapshot.json")),
      fsyncFile(path.join(seedGenDir, "lifecycle.json")),
      fsyncFile(seedPtrTmp),
    ]);
    await Promise.all([fsyncDir(seedGenDir), fsyncDir(generationsDir)]);
    await fs.rename(seedPtrTmp, currentPtrPath);
    pointerSwitched = true;
    await fsyncDir(dataDir);
    return seedGenId;
  } catch (err) {
    if (!pointerSwitched) {
      await fs.unlink(seedPtrTmp).catch(() => undefined);
      await fs.rm(seedGenDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  }
}

// Publish an immutable generation directory and atomic pointer for live data/
export async function publishLiveGenerationPointer(
  dataDir: string,
  snapshotHash: string,
): Promise<void> {
  const generationsDir = path.join(dataDir, ".generations");
  const currentPtrPath = path.join(dataDir, ".current-generation.json");
  await fs.mkdir(generationsDir, { recursive: true });

  const prevGenId = await readCurrentGenerationId(dataDir).catch(() => null);
  const runToken = `${process.pid}-${crypto.randomUUID()}`;
  const generationId = `${snapshotHash}-${runToken}`;
  const generationDir = path.join(generationsDir, generationId);
  const pointerTmpPath = `${currentPtrPath}.${runToken}.tmp`;
  let pointerSwitched = false;

  try {
    await fs.mkdir(generationDir, { recursive: false });
    const results = await Promise.allSettled([
      fs.link(path.join(dataDir, "snapshot.json"), path.join(generationDir, "snapshot.json")),
      fs.link(path.join(dataDir, "lifecycle.json"), path.join(generationDir, "lifecycle.json")),
      fs.writeFile(pointerTmpPath, `${JSON.stringify({ generation: generationId })}\n`, "utf8"),
    ]);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected) throw rejected.reason;

    await Promise.all([
      fsyncFile(path.join(generationDir, "snapshot.json")),
      fsyncFile(path.join(generationDir, "lifecycle.json")),
      fsyncFile(pointerTmpPath),
    ]);
    await Promise.all([fsyncDir(generationDir), fsyncDir(generationsDir)]);
    await fs.rename(pointerTmpPath, currentPtrPath);
    pointerSwitched = true;
    await fsyncDir(dataDir);
  } catch (err) {
    if (!pointerSwitched) {
      await fs.unlink(pointerTmpPath).catch(() => undefined);
      await fs.rm(generationDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  }

  const keep = new Set<string>([generationId]);
  if (prevGenId) keep.add(prevGenId);
  await fs
    .readdir(generationsDir)
    .then((entries) =>
      Promise.allSettled(
        entries
          .filter((name) => !keep.has(name))
          .map((name) => fs.rm(path.join(generationsDir, name), { recursive: true, force: true })),
      ),
    )
    .catch(() => undefined);
}
