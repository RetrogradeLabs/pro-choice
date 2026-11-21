import { inflateRawSync } from "node:zlib";
import Papa from "papaparse";
import {
  isRegisteredModelExact,
  parseStrictEffortMetadata,
  resolveExplicitHarness,
} from "../../../src/lib/math/canonicalize.ts";
import type { DomainId, HarnessRegime, RawObservation } from "../../../src/lib/schema.ts";
import {
  fetchArrayBufferWithSafeAuth,
  observationsMatchExact,
  parseIsoDate,
  parseNumeric,
  parsePositive,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const EPOCH_ZIP_URL = "https://epoch.ai/data/benchmark_data.zip";
const EPOCH_HUB_URL = "https://epoch.ai/data/ai-benchmarking-dashboard";

// Minimal PKZIP reader via built-in node:zlib so Bun 1.4.x and Node.js 26 LTS need zero external zip packages
function extractZipFiles(buf: ArrayBuffer, wanted: ReadonlySet<string>): Map<string, string> {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const decoder = new TextDecoder("utf-8");

  let eocdOffset = -1;
  const minOffset = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("Epoch ZIP end-of-central-directory signature not found");

  const cdEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const out = new Map<string, string>();

  let pos = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50) {
      throw new Error("Epoch ZIP central directory header corrupt");
    }
    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    if (!wanted.has(name)) continue;
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`Epoch ZIP local header corrupt for ${name}`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compSlice = bytes.subarray(dataStart, dataStart + compSize);

    if (method === 0) {
      out.set(name, decoder.decode(compSlice));
    } else if (method === 8) {
      out.set(name, decoder.decode(inflateRawSync(compSlice)));
    } else {
      throw new Error(`Epoch ZIP unsupported compression method ${method} for ${name}`);
    }
  }
  return out;
}

const INFERENCE_HOST_SUFFIX_REGEX = /-(?:together|fireworks|deepinfra|openrouter|novita|nebius)$/i;

function splitEpochModelVersion(raw: string): {
  modelName: string;
  effort: string | null;
} {
  let trimmed = raw.trim();
  // Strip inference host suffix before and after effort extraction (e.g. kimi-k3.1-pro-together_max)
  trimmed = trimmed.replace(INFERENCE_HOST_SUFFIX_REGEX, "");
  let effort: string | null = null;
  if (/_unknown$/i.test(trimmed)) {
    effort = "unknown";
    trimmed = trimmed.replace(/_unknown$/i, "");
  } else if (!isRegisteredModelExact(trimmed)) {
    const effMatch = trimmed.match(/[_-](none|minimal|low|medium|high|xhigh|max|thinking)$/i);
    if (effMatch?.[1]) {
      const candidateBase = trimmed
        .slice(0, trimmed.length - effMatch[0].length)
        .replace(INFERENCE_HOST_SUFFIX_REGEX, "");
      const isModelMax =
        /^max$/i.test(effMatch[1]) &&
        /(?:^|[^a-z0-9])(?:qwen[\s_-]*[34](?:[._-][0-9]+)?|codex)$/i.test(candidateBase);
      if (!isModelMax) {
        effort = effMatch[1].toLowerCase();
        trimmed = candidateBase;
      }
    }
  }
  trimmed = trimmed.replace(INFERENCE_HOST_SUFFIX_REGEX, "");
  return { modelName: trimmed, effort };
}

interface EpochFeedSpec {
  csvFile: string;
  benchmarkId: string;
  domainId: DomainId;
  harnessRegime: HarnessRegime;
  observedHarness: string;
  scoreCol: string;
  scaleFactor: number;
  maxScore: number | null;
  stderrCol: string | null;
  stderrScaleFactor?: number;
  effortCol?: string | null;
  harnessCol?: string | null;
  costCol: string | null;
  dateCol: string | null;
  sourceUrl: string;
}

const EPOCH_FEEDS: readonly EpochFeedSpec[] = [
  {
    csvFile: "mirrorcode.csv",
    benchmarkId: "epoch_mirrorcode",
    domainId: "coding",
    harnessRegime: "standardized",
    observedHarness: "Epoch MirrorCode Scaffold",
    scoreCol: "mean_score",
    scaleFactor: 100,
    maxScore: 100,
    stderrCol: "stderr",
    costCol: null,
    dateCol: "Started at",
    sourceUrl: "https://epoch.ai/benchmarks/mirrorcode",
  },
  {
    csvFile: "ale_bench_external.csv",
    benchmarkId: "epoch_ale_bench",
    domainId: "coding",
    harnessRegime: "standardized",
    observedHarness: "ALE-Agent",
    scoreCol: "Performance",
    scaleFactor: 1,
    maxScore: null,
    stderrCol: null,
    costCol: "Cost",
    dateCol: null,
    sourceUrl: "https://github.com/SakanaAI/ALE-Bench",
  },
  {
    csvFile: "frontierswe_external.csv",
    benchmarkId: "epoch_frontierswe",
    domainId: "coding",
    harnessRegime: "standardized",
    observedHarness: "Proximus",
    scoreCol: "Score",
    scaleFactor: 100,
    maxScore: 100,
    stderrCol: null,
    costCol: "Average cost (USD)",
    dateCol: null,
    sourceUrl: "https://www.frontierswe.com/",
  },
  {
    csvFile: "posttrainbench_external.csv",
    benchmarkId: "epoch_posttrainbench",
    domainId: "harnesses",
    harnessRegime: "native",
    observedHarness: "PostTrainBench",
    scoreCol: "Average (%)",
    scaleFactor: 100,
    maxScore: 100,
    stderrCol: null,
    harnessCol: "Scaffold",
    costCol: null,
    dateCol: null,
    sourceUrl: "https://posttrainbench.com/",
  },
  {
    csvFile: "simpleqa_verified.csv",
    benchmarkId: "epoch_simpleqa_verified",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Direct API",
    scoreCol: "mean_score",
    scaleFactor: 100,
    maxScore: 100,
    stderrCol: "stderr",
    costCol: null,
    dateCol: "Started at",
    sourceUrl: "https://epoch.ai/benchmarks/simpleqa-verified",
  },
  {
    csvFile: "frontiermath_tiers_1_3_v2.csv",
    benchmarkId: "epoch_frontiermath_t1_3",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Direct API",
    scoreCol: "mean_score",
    scaleFactor: 100,
    maxScore: 100,
    stderrCol: "stderr",
    costCol: null,
    dateCol: "Started at",
    sourceUrl: "https://epoch.ai/frontiermath",
  },
  {
    csvFile: "frontiermath_tier_4_v2.csv",
    benchmarkId: "epoch_frontiermath_t4",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Direct API",
    scoreCol: "mean_score",
    scaleFactor: 100,
    maxScore: 100,
    stderrCol: "stderr",
    costCol: null,
    dateCol: "Started at",
    sourceUrl: "https://epoch.ai/frontiermath/tier-4",
  },
  {
    csvFile: "proofbench_external.csv",
    benchmarkId: "epoch_proofbench",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "Direct API",
    scoreCol: "Accuracy",
    scaleFactor: 100,
    maxScore: 100,
    stderrCol: "Accuracy Standard Error",
    effortCol: "Reasoning effort",
    costCol: "Cost per test (USD)",
    dateCol: null,
    sourceUrl: "https://www.vals.ai/benchmarks/proof_bench",
  },
  {
    csvFile: "apex_agents_external.csv",
    benchmarkId: "epoch_apex_agents",
    domainId: "research",
    harnessRegime: "native",
    observedHarness: "APEX-Agents Harness",
    scoreCol: "Pass@1 score",
    scaleFactor: 100,
    maxScore: 100,
    stderrCol: "Pass@1 Standard Error",
    // Epoch's apex_agents_external.csv stores Pass@1 Standard Error already in percentage points (0..100)
    stderrScaleFactor: 1,
    costCol: null,
    dateCol: null,
    sourceUrl: "https://www.mercor.com/apex-agents",
  },
];

export const epochAdapter: SourceAdapter = {
  id: "epoch",
  label: "Epoch AI Benchmark Hub",
  license: "CC-BY-4.0",
  sourceUrl: EPOCH_HUB_URL,
  expectedBenchmarks: EPOCH_FEEDS.map((f) => f.benchmarkId),
  expectsPricing: false,
  async fetchLive(nowIso) {
    const zipBuf = await fetchArrayBufferWithSafeAuth(EPOCH_ZIP_URL, undefined, 35_000);
    const wanted = new Set(EPOCH_FEEDS.map((f) => f.csvFile));
    wanted.add("benchmark_metadata.csv");
    const files = extractZipFiles(zipBuf, wanted);
    const metadata = Papa.parse<Record<string, string>>(files.get("benchmark_metadata.csv") ?? "", {
      header: true,
      skipEmptyLines: true,
    });
    if (
      metadata.errors.length ||
      !["source_file", "superseded_by"].every((field) => metadata.meta.fields?.includes(field))
    ) {
      throw new Error("Epoch benchmark catalog is missing or malformed");
    }

    const observations: RawObservation[] = [];
    const partitionStats: Record<string, PartitionStats> = {};
    const disqualifiedByBenchmark: Record<string, string[]> = {};

    for (const spec of EPOCH_FEEDS) {
      const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
      partitionStats[spec.benchmarkId] = st;
      const replacements = metadata.data
        .filter((row) => row.source_file === spec.csvFile)
        .map((row) => row.superseded_by?.trim())
        .filter(Boolean);
      if (replacements.length) {
        st.note = `Epoch lists ${[...new Set(replacements)].toSorted().join(", ")} as a successor to ${spec.csvFile}. Review for the next MAJOR epoch.`;
      }

      const csvText = files.get(spec.csvFile);
      if (!csvText) {
        st.error = `Epoch ZIP missing expected file '${spec.csvFile}'`;
        continue;
      }

      const parsed = Papa.parse<Record<string, string>>(csvText, {
        header: true,
        skipEmptyLines: true,
      });

      const candidatesByRowId = new Map<string, RawObservation[]>();
      for (const row of parsed.data) {
        st.attempted++;
        const rawVersion = (row["Model version"] ?? "").trim();
        const rawScoreVal = parseNumeric(row[spec.scoreCol]);
        if (!rawVersion || rawScoreVal === null) {
          st.rejected++;
          continue;
        }
        const scaledScore = rawScoreVal * spec.scaleFactor;
        if (
          !Number.isFinite(scaledScore) ||
          scaledScore < 0 ||
          (spec.maxScore !== null && scaledScore > spec.maxScore)
        ) {
          st.rejected++;
          continue;
        }

        const { modelName, effort: versionEffort } = splitEpochModelVersion(rawVersion);
        if (!modelName) {
          st.rejected++;
          continue;
        }
        const colEffort = spec.effortCol ? (row[spec.effortCol] ?? "").trim() || null : null;
        // Override _unknown strictly with verified effort column; quarantine any contradiction between version and column effort
        let effort: string | null;
        if (versionEffort === "unknown") {
          effort = colEffort ?? "unknown";
        } else if (versionEffort !== null && colEffort !== null) {
          const vNorm = parseStrictEffortMetadata(versionEffort);
          const cNorm = parseStrictEffortMetadata(colEffort);
          effort =
            vNorm !== null && cNorm !== null && vNorm === cNorm
              ? vNorm
              : `conflict:${versionEffort}!=${colEffort}`;
        } else {
          effort = versionEffort ?? colEffort;
        }

        let rawHarness: string | null = null;
        let observedHarness = spec.observedHarness;
        if (spec.harnessCol) {
          const scaffold = (row[spec.harnessCol] ?? "").trim();
          if (!scaffold) {
            st.excluded++;
            continue;
          }
          const resolved = resolveExplicitHarness(scaffold, spec.harnessRegime);
          if (!resolved.ok) {
            st.excluded++;
            continue;
          }
          rawHarness = scaffold;
          observedHarness = scaffold;
        }

        let seRaw: number | null = null;
        let ciHalfWidth: number | null = null;
        if (spec.stderrCol) {
          const parsedSe = parsePositive(row[spec.stderrCol]);
          if (parsedSe !== null) {
            const seFactor = spec.stderrScaleFactor ?? spec.scaleFactor;
            const scaledSe = parsedSe * seFactor;
            if (Number.isFinite(scaledSe) && scaledSe > 0) {
              seRaw = Number(scaledSe.toFixed(6));
              ciHalfWidth = Number((scaledSe * 1.96).toFixed(4));
            }
          }
        }

        const measuredCostUsd = spec.costCol ? parsePositive(row[spec.costCol]) : null;
        const evalDate = spec.dateCol ? parseIsoDate(row[spec.dateCol], nowIso) : null;
        const org = (row.Organization ?? "").trim() || null;
        const explicitId = (row.id ?? "").trim();
        // Include resolved effort in generated keys for ID-less rows so distinct verified efforts never collide
        const rowUid = explicitId || `${rawVersion}:${effort ?? ""}:${rawHarness ?? ""}`;
        const sourceRowId = `epoch:${spec.benchmarkId}:${rowUid}`;

        const obs: RawObservation = {
          sourceId: "epoch",
          sourceRowId,
          benchmarkId: spec.benchmarkId,
          benchmarkVersion: "2026.11",
          domainId: spec.domainId,
          rawModelName: modelName,
          rawProvider: org,
          rawEffort: effort,
          rawHarness,
          observedHarness,
          harnessRegime: spec.harnessRegime,
          rawScore: Number(scaledScore.toFixed(2)),
          seRaw,
          ciHalfWidth,
          ciLower: null,
          ciUpper: null,
          battleCount: null,
          measuredCostUsd: measuredCostUsd !== null ? Number(measuredCostUsd.toFixed(6)) : null,
          suiteCostUsd: null,
          measuredInputTokens: null,
          measuredOutputTokens: null,
          evalDate,
          publishedDate: evalDate,
          sourceUrl: spec.sourceUrl,
        };
        const grp = candidatesByRowId.get(sourceRowId) ?? [];
        grp.push(obs);
        candidatesByRowId.set(sourceRowId, grp);
      }

      const disqualified: string[] = [];
      for (const grp of candidatesByRowId.values()) {
        const first = grp[0]!;
        const conflicts = grp.some((o) => !observationsMatchExact(o, first));
        if (conflicts) {
          st.rejected += grp.length;
          disqualified.push(first.sourceRowId);
          continue;
        }
        observations.push(first);
      }
      if (disqualified.length > 0) {
        disqualifiedByBenchmark[spec.benchmarkId] = disqualified;
      }
    }

    return {
      observations,
      pricing: [],
      partitionStats,
      ...(Object.keys(disqualifiedByBenchmark).length > 0
        ? { disqualifiedSourceRowIdsByBenchmark: disqualifiedByBenchmark }
        : {}),
    };
  },
};
