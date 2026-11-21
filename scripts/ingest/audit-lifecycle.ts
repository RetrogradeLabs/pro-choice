import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BENCHMARKS } from "../../src/config/benchmarks.ts";
import { compareIsoInstants } from "../../src/lib/format.ts";
import {
  auditBenchmarkLifecycle,
  computeCrossDomainCorrelations,
  utcCalendarDayDiff,
} from "../../src/lib/math/lifecycle.ts";
import {
  type BenchmarkAudit,
  type HarnessRegime,
  type LifecycleReport,
  LifecycleReportSchema,
  type ProChoiceSnapshot,
  ProChoiceSnapshotSchema,
  type ProviderId,
} from "../../src/lib/schema.ts";
import { readSourceCacheStrict, recoverPendingRawCacheSwap } from "./cache.ts";
import {
  fsyncDir,
  fsyncFile,
  isSameDirectory,
  publishLiveGenerationPointer,
  recoverPendingSyncCommit,
  seedBaselineGenerationIfNeeded,
} from "./generation.ts";
import { withPublishLock } from "./lock.ts";
import { extractAcceptedCellsFromSources } from "./run.ts";
import type { CachedSourceFile } from "./types.ts";

const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");

export async function computeLifecycleReport(
  snapshot: ProChoiceSnapshot,
  priorReport: LifecycleReport | null,
  cachedSourcesOverride?: readonly CachedSourceFile[],
  dataDir?: string,
): Promise<LifecycleReport> {
  const nowIso = snapshot.generatedAt;
  const priorByKey = new Map<string, BenchmarkAudit>();
  if (priorReport) {
    for (const a of priorReport.audits) {
      priorByKey.set(`${a.benchmarkId}::${a.harnessRegime}::${a.benchmarkVersion}`, a);
    }
  }

  const cachedSources =
    cachedSourcesOverride ??
    (await Promise.all(
      snapshot.sources.map((src) => readSourceCacheStrict(src.sourceId, dataDir)),
    ));

  // Build candidate raw audits strictly from the compiler's accepted, version-locked, deduplicated cells
  const { cellsByDomain } = extractAcceptedCellsFromSources(cachedSources);
  const candidateScoresByBm = new Map<
    string,
    {
      configId: string;
      provider: ProviderId;
      modelSlug: string;
      effort: string;
      harness: string;
      rawScore: number;
      seRaw: number | null;
      ciHalfWidth: number | null;
      ciLower: number | null;
      ciUpper: number | null;
      evalDate: string | null;
    }[]
  >();

  for (const cells of cellsByDomain.values()) {
    for (const cell of cells) {
      const key = `${cell.benchmarkId}::${cell.harnessRegime}`;
      const list = candidateScoresByBm.get(key) ?? [];
      list.push({
        configId: cell.configId,
        provider: cell.provider,
        modelSlug: cell.modelSlug,
        effort: cell.effort,
        harness: cell.harness,
        rawScore: cell.rawScore,
        seRaw: cell.seRaw,
        ciHalfWidth: cell.ciHalfWidth,
        ciLower: cell.ciLower,
        ciUpper: cell.ciUpper,
        evalDate: cell.evalDate,
      });
      candidateScoresByBm.set(key, list);
    }
  }

  const audits: BenchmarkAudit[] = [];

  for (const meta of BENCHMARKS) {
    const domain = snapshot.domains[meta.domainId];
    const allConfigs = [...domain.configs, ...domain.provisionalConfigs];

    for (const regime of meta.regimes as readonly HarnessRegime[]) {
      const key = `${meta.id}::${regime}`;
      const candidateRaw =
        meta.lifecycleState === "CANDIDATE" ? candidateScoresByBm.get(key) : undefined;
      const priorAudit = priorByKey.get(`${key}::${meta.version}`) ?? null;
      const regimeMeta = domain.regimeMeta[regime];
      const coverageFloor = regimeMeta?.coverageFloor ?? domain.coverageFloor;

      const audit = auditBenchmarkLifecycle({
        meta,
        harnessRegime: regime,
        coverageFloor,
        domainConfigs: allConfigs,
        anchorStats: domain.anchorStats,
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
        ...(candidateRaw ? { candidateRawScores: candidateRaw } : {}),
        priorAudit,
        priorAuditedAt: priorReport?.auditedAt ?? null,
        nowIso,
      });
      audits.push(audit);
    }
  }

  const crossDomainTau = computeCrossDomainCorrelations(snapshot.domains);

  return LifecycleReportSchema.parse({
    auditedAt: nowIso,
    audits,
    crossDomainTau,
  });
}

// Return null ONLY on ENOENT so transient EIO or corrupt JSON never silently resets retirement streaks
async function readLifecycleOrNullOnMissing(filePath: string): Promise<LifecycleReport | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return LifecycleReportSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Failed to read or parse lifecycle report ${filePath}`, { cause: err });
  }
}

async function atomicWriteJson(targetPath: string, data: unknown): Promise<void> {
  const tmpPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fsyncFile(tmpPath);
  await fs.rename(tmpPath, targetPath);
  await fsyncDir(path.dirname(targetPath));
}

export async function runLifecycleAudit(
  options: { dataDir?: string } = {},
): Promise<LifecycleReport> {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const isLiveDataDir = await isSameDirectory(dataDir, DEFAULT_DATA_DIR);
  const lifecyclePath = path.join(dataDir, "lifecycle.json");
  const priorLifecyclePath = path.join(dataDir, "lifecycle.prev.json");

  return withPublishLock(async () => {
    if (isLiveDataDir) {
      await recoverPendingSyncCommit(dataDir);
      await recoverPendingRawCacheSwap(dataDir);
      await seedBaselineGenerationIfNeeded(dataDir);
    }
    const rawSnapshot = await fs.readFile(path.join(dataDir, "snapshot.json"), "utf8");
    const snapshot = ProChoiceSnapshotSchema.parse(JSON.parse(rawSnapshot));

    const currentLifecycle = await readLifecycleOrNullOnMissing(lifecyclePath);
    const persistedPrior = await readLifecycleOrNullOnMissing(priorLifecyclePath);

    // Preserve the prior UTC day's report across same-day reruns and rebuild missing lifecycle.json from valid persisted prior
    let priorForStreak: LifecycleReport | null = null;
    let nextPriorToPersist: LifecycleReport | null = persistedPrior;

    if (currentLifecycle) {
      const dayDiff = utcCalendarDayDiff(currentLifecycle.auditedAt, snapshot.generatedAt);
      const instantOrder = compareIsoInstants(currentLifecycle.auditedAt, snapshot.generatedAt);
      if (dayDiff === null || dayDiff < 0 || instantOrder === null || instantOrder > 0) {
        throw new Error(
          `Invalid lifecycle date progression: prior auditedAt '${currentLifecycle.auditedAt}' vs snapshot '${snapshot.generatedAt}'`,
        );
      }
      if (dayDiff > 0) {
        priorForStreak = currentLifecycle;
        nextPriorToPersist = currentLifecycle;
      } else {
        priorForStreak = persistedPrior;
      }
    } else if (persistedPrior) {
      const dayDiff = utcCalendarDayDiff(persistedPrior.auditedAt, snapshot.generatedAt);
      const instantOrder = compareIsoInstants(persistedPrior.auditedAt, snapshot.generatedAt);
      if (dayDiff === null || dayDiff < 1 || instantOrder === null || instantOrder >= 0) {
        throw new Error(
          `Invalid persisted prior lifecycle date '${persistedPrior.auditedAt}' vs snapshot '${snapshot.generatedAt}'`,
        );
      }
      priorForStreak = persistedPrior;
      nextPriorToPersist = persistedPrior;
    }

    const report = await computeLifecycleReport(snapshot, priorForStreak, undefined, dataDir);

    // Validate proposed report in memory BEFORE mutating any live file on disk
    if (isLiveDataDir) {
      const { validateSnapshot } = await import("./validate-snapshot.ts");
      await validateSnapshot({
        dataDir,
        lifecycleOverride: report,
        priorLifecycleOverride: nextPriorToPersist,
      });
    }

    if (nextPriorToPersist) {
      await atomicWriteJson(priorLifecyclePath, nextPriorToPersist);
    }
    await atomicWriteJson(lifecyclePath, report);

    const retireCount = report.audits.filter((a) => a.status === "retire_trigger").length;
    const warnCount = report.audits.filter((a) => a.status === "warning").length;
    const readyCount = report.audits.filter((a) => a.status === "probation_ready").length;

    const summaryAppend = [
      ``,
      `## Daily Saturation & Lifecycle Audit`,
      `- Active benchmarks at sustained retirement trigger: ${retireCount}`,
      `- Active benchmarks in warning state: ${warnCount}`,
      `- Candidate benchmarks ready for next MAJOR cutover: ${readyCount}`,
      ``,
      `| Benchmark | Domain | State | Top Labs | S_index | Sep | LOO Tau | Status |`,
      `| :--- | :--- | :--- | ---: | ---: | ---: | ---: | :--- |`,
      ...report.audits.map(
        (a) =>
          `| ${a.benchmarkId} | ${a.domainId} | ${a.lifecycleState} | ${a.coveredLabsCount} | ${
            a.saturationIndex !== null ? a.saturationIndex.toFixed(2) : "N/A"
          } | ${a.separability !== null ? `${Math.round(a.separability * 100)}%` : "N/A"} | ${
            a.looKendallTau !== null ? a.looKendallTau.toFixed(2) : "N/A"
          } | ${a.status.toUpperCase()} |`,
      ),
    ];

    const summaryPath = path.join(dataDir, "summary.md");
    let existingSummary = "";
    try {
      existingSummary = await fs.readFile(summaryPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Failed to read existing summary ${summaryPath}`, { cause: err });
      }
    }
    const stripped = existingSummary
      .replace(/\n## Daily Saturation & Lifecycle Audit[\s\S]*$/m, "")
      .trimEnd();
    const tmpSummary = `${summaryPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmpSummary, `${stripped}\n${summaryAppend.join("\n")}\n`, "utf8");
    await fsyncFile(tmpSummary);
    await fs.rename(tmpSummary, summaryPath);
    await fsyncDir(dataDir);

    if (isLiveDataDir) {
      await publishLiveGenerationPointer(dataDir, snapshot.snapshotHash);
    }

    return report;
  });
}

if (import.meta.main) {
  runLifecycleAudit()
    .then((report) => {
      console.log(
        `Lifecycle audit written for ${report.audits.length} benchmarks (${
          report.audits.filter((a) => a.status === "retire_trigger").length
        } sustained retirement triggers).`,
      );
    })
    .catch((err) => {
      console.error("Lifecycle audit failed:", err);
      process.exit(1);
    });
}
