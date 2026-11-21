import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { compareAscii } from "../../src/lib/math/aggregate.ts";
import { EpochManifestSchema } from "../../src/lib/schema.ts";
import { runLifecycleAudit } from "./audit-lifecycle.ts";
import { recoverPendingRawCacheSwap } from "./cache.ts";
import {
  fileExistsStrict,
  fsyncDir,
  fsyncFile,
  readdirOrEmptyOnMissing,
  recoverPendingSyncCommit,
  restoreSwapEntries,
  type SyncCommitEntry,
  type SyncCommitEpochFile,
  type SyncCommitJournal,
  seedBaselineGenerationIfNeeded,
} from "./generation.ts";
import { withPublishLock } from "./lock.ts";
import {
  awaitAllSettledOrThrow,
  MANDATORY_ADAPTERS,
  readEpochManifest,
  recoverPendingEpochManifest,
  runIngestion,
  sha256Hex,
} from "./run.ts";
import { validateSnapshot } from "./validate-snapshot.ts";

const LIVE_DATA_DIR = path.join(process.cwd(), "data");
const LIVE_RAW_DIR = path.join(LIVE_DATA_DIR, "raw");
const LIVE_EPOCHS_DIR = path.join(LIVE_DATA_DIR, "epochs");
const LIVE_GENERATIONS_DIR = path.join(LIVE_DATA_DIR, ".generations");
const LIVE_CURRENT_GEN_PATH = path.join(LIVE_DATA_DIR, ".current-generation.json");
const LIVE_COMMIT_JOURNAL_PATH = path.join(LIVE_DATA_DIR, ".sync-commit.json");
const LIVE_SHRINK_STATE_PATH = path.join(LIVE_RAW_DIR, ".shrink-state.json");

const MANDATORY_RELEASE_FILES = [
  "unmapped.json",
  "lifecycle.json",
  "snapshot.json",
  "summary.md",
] as const;

function toRel(absPath: string): string {
  return path.relative(LIVE_DATA_DIR, absPath);
}

function fromRel(relPath: string): string {
  return path.join(LIVE_DATA_DIR, relPath);
}

async function copyFileIfExists(src: string, dst: string): Promise<void> {
  try {
    await fs.copyFile(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function pruneOldGenerations(keepIds: ReadonlySet<string>): Promise<void> {
  const entries = await readdirOrEmptyOnMissing(LIVE_GENERATIONS_DIR);
  await Promise.allSettled(
    entries
      .filter((name) => !keepIds.has(name))
      .map((name) =>
        fs.rm(path.join(LIVE_GENERATIONS_DIR, name), { recursive: true, force: true }),
      ),
  );
}

async function seedStageDir(stageDir: string): Promise<void> {
  const stageRawDir = path.join(stageDir, "raw");
  const stageEpochsDir = path.join(stageDir, "epochs");
  await Promise.all([
    fs.mkdir(stageRawDir, { recursive: true }),
    fs.mkdir(stageEpochsDir, { recursive: true }),
  ]);

  const [rawEntries, epochEntries] = await Promise.all([
    readdirOrEmptyOnMissing(LIVE_RAW_DIR),
    readdirOrEmptyOnMissing(LIVE_EPOCHS_DIR),
  ]);

  await awaitAllSettledOrThrow([
    ...rawEntries
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .map((f) => fs.copyFile(path.join(LIVE_RAW_DIR, f), path.join(stageRawDir, f))),
    ...epochEntries
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .map((f) => fs.copyFile(path.join(LIVE_EPOCHS_DIR, f), path.join(stageEpochsDir, f))),
    copyFileIfExists(
      path.join(LIVE_DATA_DIR, "snapshot.json"),
      path.join(stageDir, "snapshot.json"),
    ),
    copyFileIfExists(
      path.join(LIVE_DATA_DIR, "lifecycle.json"),
      path.join(stageDir, "lifecycle.json"),
    ),
    copyFileIfExists(
      path.join(LIVE_DATA_DIR, "lifecycle.prev.json"),
      path.join(stageDir, "lifecycle.prev.json"),
    ),
  ]);
}

async function promoteValidatedStage(stageDir: string, snapshotHash: string): Promise<void> {
  await Promise.all([
    fs.mkdir(LIVE_RAW_DIR, { recursive: true }),
    fs.mkdir(LIVE_EPOCHS_DIR, { recursive: true }),
    fs.mkdir(LIVE_GENERATIONS_DIR, { recursive: true }),
  ]);

  // 1. Pre-verify every mandatory staged raw cache, release output, and epoch delta BEFORE mutating any live file
  const stageRawDir = path.join(stageDir, "raw");
  const stageEpochsDir = path.join(stageDir, "epochs");
  const expectedRawFiles = MANDATORY_ADAPTERS.map((a) => `${a.id}.json`);
  const hasOptionalPrior = await fileExistsStrict(path.join(stageDir, "lifecycle.prev.json"));
  await awaitAllSettledOrThrow([
    ...expectedRawFiles.map((f) => fs.access(path.join(stageRawDir, f))),
    ...MANDATORY_RELEASE_FILES.map((f) => fs.access(path.join(stageDir, f))),
  ]);

  const liveManifest = (await readEpochManifest(LIVE_DATA_DIR)) ?? {};
  const stageManifest = await readEpochManifest(stageDir);
  const newEpochSpecs: { filename: string; sha256: string; content: string }[] = [];
  let nextManifestStagedPath: string | null = null;

  if (stageManifest) {
    for (const [file, liveSha] of Object.entries(liveManifest)) {
      const stagedSha = stageManifest[file];
      if (stagedSha !== liveSha) {
        throw new Error(
          `Refusing promotion: staged epoch manifest altered immutable pin '${file}' (${liveSha} !== ${stagedSha ?? "missing"})`,
        );
      }
    }

    const newEntries = Object.entries(stageManifest).filter(
      ([file]) => !Object.hasOwn(liveManifest, file),
    );
    if (newEntries.length > 0) {
      const nextManifest: Record<string, string> = { ...liveManifest };
      await awaitAllSettledOrThrow(
        newEntries.map(async ([filename, expectedSha]) => {
          const content = await fs.readFile(path.join(stageEpochsDir, filename), "utf8");
          if (sha256Hex(content) !== expectedSha) {
            throw new Error(`Staged epoch '${filename}' SHA-256 drifted before promotion`);
          }
          newEpochSpecs.push({ filename, sha256: expectedSha, content });
          nextManifest[filename] = expectedSha;
        }),
      );

      const sortedManifest: Record<string, string> = {};
      for (const k of Object.keys(nextManifest).toSorted(compareAscii)) {
        sortedManifest[k] = nextManifest[k]!;
      }
      nextManifestStagedPath = path.join(stageEpochsDir, ".manifest.promote.json");
      await fs.writeFile(
        nextManifestStagedPath,
        `${JSON.stringify(EpochManifestSchema.parse(sortedManifest), null, 2)}\n`,
        "utf8",
      );
    }
  }

  // 2. Seed baseline immutable generation if absent, then stage new generation, backups, and WAL durably
  const prevGenerationId = await seedBaselineGenerationIfNeeded(LIVE_DATA_DIR);

  const runToken = `${process.pid}-${crypto.randomUUID()}`;
  const generationId = `${snapshotHash}-${runToken}`;
  const generationDir = path.join(LIVE_GENERATIONS_DIR, generationId);
  const pointerTmpPath = `${LIVE_CURRENT_GEN_PATH}.${runToken}.tmp`;
  const tmpJournalPath = `${LIVE_COMMIT_JOURNAL_PATH}.${runToken}.tmp`;
  const backupDir = path.join(LIVE_DATA_DIR, `.sync-backup.${runToken}`);
  const backupRawDir = path.join(backupDir, "raw");
  const backupEpochsDir = path.join(backupDir, "epochs");
  const pendingEpochDir =
    newEpochSpecs.length > 0 ? path.join(LIVE_EPOCHS_DIR, `.pending.${runToken}`) : null;
  const newEpochFiles: SyncCommitEpochFile[] = [];

  const swapPlan: { stagePath: string; livePath: string; backupPath: string }[] = [
    ...expectedRawFiles.map((f) => ({
      stagePath: path.join(stageRawDir, f),
      livePath: path.join(LIVE_RAW_DIR, f),
      backupPath: path.join(backupRawDir, f),
    })),
    ...(hasOptionalPrior
      ? [
          {
            stagePath: path.join(stageDir, "lifecycle.prev.json"),
            livePath: path.join(LIVE_DATA_DIR, "lifecycle.prev.json"),
            backupPath: path.join(backupDir, "lifecycle.prev.json"),
          },
        ]
      : []),
    ...MANDATORY_RELEASE_FILES.map((f) => ({
      stagePath: path.join(stageDir, f),
      livePath: path.join(LIVE_DATA_DIR, f),
      backupPath: path.join(backupDir, f),
    })),
    ...(nextManifestStagedPath
      ? [
          {
            stagePath: nextManifestStagedPath,
            livePath: path.join(LIVE_EPOCHS_DIR, "manifest.json"),
            backupPath: path.join(backupEpochsDir, "manifest.json"),
          },
        ]
      : []),
  ];

  const journalEntries: SyncCommitEntry[] = [];
  let walInstalled = false;

  try {
    await Promise.all([
      fs.mkdir(generationDir, { recursive: false }),
      fs.mkdir(backupRawDir, { recursive: true }),
      fs.mkdir(backupEpochsDir, { recursive: true }),
    ]);

    await awaitAllSettledOrThrow([
      fs.link(path.join(stageDir, "snapshot.json"), path.join(generationDir, "snapshot.json")),
      fs.link(path.join(stageDir, "lifecycle.json"), path.join(generationDir, "lifecycle.json")),
      fs.writeFile(pointerTmpPath, `${JSON.stringify({ generation: generationId })}\n`, "utf8"),
    ]);

    if (pendingEpochDir) {
      await fs.mkdir(pendingEpochDir, { recursive: false });
      await awaitAllSettledOrThrow(
        newEpochSpecs.map(async (spec) => {
          const pendingPath = path.join(pendingEpochDir, spec.filename);
          await fs.writeFile(pendingPath, spec.content, { encoding: "utf8", flag: "wx" });
          await fsyncFile(pendingPath);
          newEpochFiles.push({
            filename: spec.filename,
            sha256: spec.sha256,
            pendingRel: toRel(pendingPath),
            liveRel: toRel(path.join(LIVE_EPOCHS_DIR, spec.filename)),
          });
        }),
      );
      await fsyncDir(pendingEpochDir);
    }

    await awaitAllSettledOrThrow(
      swapPlan.map(async (entry) => {
        await fsyncFile(entry.stagePath);
        let existedBefore = false;
        try {
          await fsyncFile(entry.livePath);
          await fs.link(entry.livePath, entry.backupPath);
          existedBefore = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        journalEntries.push({
          stageRel: toRel(entry.stagePath),
          liveRel: toRel(entry.livePath),
          backupRel: toRel(entry.backupPath),
          existedBefore,
        });
      }),
    );

    await Promise.all([
      fsyncFile(pointerTmpPath),
      fsyncDir(generationDir),
      fsyncDir(LIVE_GENERATIONS_DIR),
      fsyncDir(backupDir),
      fsyncDir(backupRawDir),
      fsyncDir(backupEpochsDir),
    ]);

    const journal: SyncCommitJournal = {
      generationId,
      generationRel: toRel(generationDir),
      pointerTmpRel: toRel(pointerTmpPath),
      backupRel: toRel(backupDir),
      stageRel: toRel(stageDir),
      pendingEpochRel: pendingEpochDir ? toRel(pendingEpochDir) : null,
      newEpochFiles,
      entries: journalEntries,
    };
    await fs.writeFile(tmpJournalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    await fsyncFile(tmpJournalPath);
    await fs.rename(tmpJournalPath, LIVE_COMMIT_JOURNAL_PATH);
    walInstalled = true;
    await fsyncDir(LIVE_DATA_DIR);
  } catch (prepareErr) {
    // Never delete backup/generation artifacts once the canonical WAL rename has succeeded
    if (!walInstalled) {
      await fs.unlink(tmpJournalPath).catch(() => undefined);
      await fs.unlink(pointerTmpPath).catch(() => undefined);
      await fs.rm(generationDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
      if (pendingEpochDir) {
        await fs.rm(pendingEpochDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    throw prepareErr;
  }

  // 3. Commit phase: link write-once epochs, swap live release files, fsync dirs, then flip the single atomic reader pointer last
  const promoted: SyncCommitEntry[] = [];
  const linkedEpochs: SyncCommitEpochFile[] = [];
  let pointerSwitched = false;

  try {
    await awaitAllSettledOrThrow(
      newEpochFiles.map(async (ef) => {
        await fs.link(fromRel(ef.pendingRel), fromRel(ef.liveRel));
        linkedEpochs.push(ef);
      }),
    );

    await journalEntries.reduce(async (chain, entry) => {
      await chain;
      await fs.rename(fromRel(entry.stageRel), fromRel(entry.liveRel));
      promoted.push(entry);
    }, Promise.resolve());

    await Promise.all([fsyncDir(LIVE_RAW_DIR), fsyncDir(LIVE_EPOCHS_DIR), fsyncDir(LIVE_DATA_DIR)]);
    await fs.rename(pointerTmpPath, LIVE_CURRENT_GEN_PATH);
    pointerSwitched = true;
    await fsyncDir(LIVE_DATA_DIR);
  } catch (promoteErr) {
    // Once the live pointer has atomically switched, never roll back or delete the newly selected generation
    if (pointerSwitched) {
      throw promoteErr;
    }

    const rollbackErrors = await restoreSwapEntries(LIVE_DATA_DIR, promoted, linkedEpochs);
    await fs.unlink(pointerTmpPath).catch(() => undefined);
    await fs.rm(generationDir, { recursive: true, force: true }).catch(() => undefined);

    if (rollbackErrors.length > 0) {
      const origMsg = promoteErr instanceof Error ? promoteErr.message : String(promoteErr);
      throw new Error(
        `Sync promotion failed (${origMsg}); rollback also failed on ${rollbackErrors.length} file(s) and backups were retained at ${backupDir}: ${rollbackErrors.join("; ")}`,
        { cause: promoteErr },
      );
    }

    try {
      await Promise.all([
        fsyncDir(LIVE_RAW_DIR),
        fsyncDir(LIVE_EPOCHS_DIR),
        fsyncDir(LIVE_DATA_DIR),
      ]);
      await fs.unlink(LIVE_COMMIT_JOURNAL_PATH);
      await fsyncDir(LIVE_DATA_DIR);
    } catch (finalizeErr) {
      const origMsg = promoteErr instanceof Error ? promoteErr.message : String(promoteErr);
      const finMsg = finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr);
      throw new Error(
        `Sync promotion failed (${origMsg}); rollback journal finalization failed (${finMsg}) and backups were retained at ${backupDir}`,
        { cause: finalizeErr },
      );
    }
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    if (pendingEpochDir) {
      await fs.rm(pendingEpochDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw promoteErr;
  }

  // Post-commit cleanup never releases backups until the WAL unlink is durably flushed
  try {
    await fs.unlink(LIVE_COMMIT_JOURNAL_PATH);
    await fsyncDir(LIVE_DATA_DIR);
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    if (pendingEpochDir) {
      await fs.rm(pendingEpochDir, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch {
    // Committed generation pointer is already durable; retain backups alongside surviving WAL for next recovery
  }
  const keepGenerations = new Set<string>([generationId]);
  if (prevGenerationId) keepGenerations.add(prevGenerationId);
  await pruneOldGenerations(keepGenerations).catch(() => undefined);
}

// Transactional staged sync: recover any interrupted commit/epoch journal, validate in isolation, then atomically publish
export async function runSync(): Promise<void> {
  await withPublishLock(async () => {
    await fs.mkdir(LIVE_EPOCHS_DIR, { recursive: true });
    await recoverPendingSyncCommit(LIVE_DATA_DIR);
    await recoverPendingRawCacheSwap(LIVE_DATA_DIR);
    await recoverPendingEpochManifest(await readEpochManifest(LIVE_DATA_DIR), LIVE_EPOCHS_DIR);

    const stageDir = path.join(LIVE_DATA_DIR, `.sync-stage.${process.pid}.${crypto.randomUUID()}`);
    try {
      await seedStageDir(stageDir);
      const snap = await runIngestion({
        dataDir: stageDir,
        shrinkStatePath: LIVE_SHRINK_STATE_PATH,
      });
      const report = await runLifecycleAudit({ dataDir: stageDir });
      await validateSnapshot({ dataDir: stageDir });
      await promoteValidatedStage(stageDir, snap.snapshotHash);

      console.log(
        `ProChoice snapshot compiled cleanly (${snap.snapshotHash}) across ${snap.sources.length} mandatory sources.`,
      );
      console.log(
        `Lifecycle audit written for ${report.audits.length} benchmarks (${
          report.audits.filter((a) => a.status === "retire_trigger").length
        } sustained retirement triggers).`,
      );
    } finally {
      const journalPending = await fileExistsStrict(LIVE_COMMIT_JOURNAL_PATH).catch(() => true);
      if (!journalPending) {
        await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });
}

if (import.meta.main) {
  runSync().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
