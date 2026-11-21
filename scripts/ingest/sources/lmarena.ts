import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { DomainId, RawObservation } from "../../../src/lib/schema.ts";
import {
  fetchArrayBufferWithSafeAuth,
  observationsMatchExact,
  parseIsoDate,
  parseNumeric,
  parseStrictNonNegativeInt,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const HF_RESOLVE_BASE =
  "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main";
const DATASET_URL = "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset";

const MIN_BATTLES = 300;
const MAX_CI_ELO = 25;

interface ArenaSplitSpec {
  splitDir: string;
  targetCategory: string;
  benchmarkId: string;
  domainId: DomainId;
}

// Strictly one non-overlapping split per LMArena crowd arena to prevent multi-label battle double-counting
const ARENA_SPLITS: readonly ArenaSplitSpec[] = [
  {
    splitDir: "text_style_control",
    targetCategory: "creative_writing",
    benchmarkId: "lmarena_creative_writing",
    domainId: "writing",
  },
  {
    splitDir: "document_style_control",
    targetCategory: "overall",
    benchmarkId: "lmarena_document",
    domainId: "research",
  },
  {
    splitDir: "webdev",
    targetCategory: "overall",
    benchmarkId: "lmarena_webdev",
    domainId: "design_code",
  },
  {
    splitDir: "text_factuality",
    targetCategory: "overall",
    benchmarkId: "lmarena_factuality",
    domainId: "research",
  },
];

const REQUIRED_COLUMNS = [
  "model_name",
  "rating",
  "rating_lower",
  "rating_upper",
  "vote_count",
  "category",
] as const;

export const lmarenaAdapter: SourceAdapter = {
  id: "lmarena",
  label: "LMArena Style-Controlled Parquet Leaderboards",
  license: "Apache-2.0 / CC-BY-4.0",
  sourceUrl: DATASET_URL,
  expectedBenchmarks: ARENA_SPLITS.map((s) => s.benchmarkId),
  expectsPricing: false,
  async fetchLive(nowIso) {
    const authHeader = process.env.HF_TOKEN ? `Bearer ${process.env.HF_TOKEN}` : undefined;
    const uniqueDirs = [...new Set(ARENA_SPLITS.map((s) => s.splitDir))];

    const splitResults = await Promise.allSettled(
      uniqueDirs.map(async (splitDir) => {
        const buf = await fetchArrayBufferWithSafeAuth(
          `${HF_RESOLVE_BASE}/${splitDir}/latest-00000-of-00001.parquet`,
          authHeader,
        );
        const rows = (await parquetReadObjects({
          file: buf,
          compressors,
        })) as Record<string, unknown>[];
        if (rows.length === 0) throw new Error(`LMArena split '${splitDir}' returned 0 rows`);
        const first = rows[0]!;
        for (const col of REQUIRED_COLUMNS) {
          if (!(col in first)) {
            throw new Error(`LMArena split '${splitDir}' missing required column '${col}'`);
          }
        }
        return { splitDir, rows };
      }),
    );

    const rowsByDir = new Map<string, Record<string, unknown>[]>();
    const errorByDir = new Map<string, string>();
    for (let i = 0; i < uniqueDirs.length; i++) {
      const dir = uniqueDirs[i]!;
      const res = splitResults[i]!;
      if (res.status === "fulfilled") {
        rowsByDir.set(dir, res.value.rows);
      } else {
        errorByDir.set(dir, res.reason instanceof Error ? res.reason.message : String(res.reason));
      }
    }

    const observations: RawObservation[] = [];
    const partitionStats: Record<string, PartitionStats> = {};
    const disqualifiedByBenchmark: Record<string, string[]> = {};

    for (const spec of ARENA_SPLITS) {
      const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
      partitionStats[spec.benchmarkId] = st;

      const err = errorByDir.get(spec.splitDir);
      if (err) {
        st.error = err;
        continue;
      }

      const rows = rowsByDir.get(spec.splitDir) ?? [];
      const candidatesByRowId = new Map<string, RawObservation[]>();
      for (const row of rows) {
        const category = String(row.category ?? "")
          .trim()
          .toLowerCase();
        if (category !== spec.targetCategory) continue;

        st.attempted++;
        const modelName = String(row.model_name ?? "").trim();
        const rating = parseNumeric(row.rating);
        const lower = parseNumeric(row.rating_lower);
        const upper = parseNumeric(row.rating_upper);
        const battles = parseStrictNonNegativeInt(row.vote_count);

        if (
          !modelName ||
          rating === null ||
          lower === null ||
          upper === null ||
          battles === null ||
          upper <= lower ||
          rating < lower - 0.01 ||
          rating > upper + 0.01
        ) {
          st.rejected++;
          continue;
        }

        // Apply precision gate before rounding so 25.004 never slips past the 25 Elo threshold
        const rawCiHalf = (upper - lower) / 2;
        if (battles < MIN_BATTLES || rawCiHalf > MAX_CI_ELO) {
          st.excluded++;
          continue;
        }

        const publishDate = parseIsoDate(row.leaderboard_publish_date, nowIso);
        const org =
          typeof row.organization === "string" && row.organization.trim()
            ? row.organization.trim()
            : null;

        // Detect explicit agent wrappers (e.g. "GPT-5.6 Sol (xHigh, Codex Harness)") instead of labeling them Direct API
        let cleanModelName = modelName;
        let explicitHarness: string | null = null;
        if (/\bcodex\s+harness\b/i.test(modelName)) {
          explicitHarness = "Codex";
          cleanModelName = modelName
            .replace(/,\s*codex\s+harness\b/gi, "")
            .replace(/\(\s*codex\s+harness\s*\)/gi, "")
            .replace(/\s+/g, " ")
            .trim();
        } else if (/\bclaude\s+code\s+harness\b/i.test(modelName)) {
          explicitHarness = "Claude Code";
          cleanModelName = modelName
            .replace(/,\s*claude\s+code\s+harness\b/gi, "")
            .replace(/\(\s*claude\s+code\s+harness\s*\)/gi, "")
            .replace(/\s+/g, " ")
            .trim();
        }

        const sourceRowId = `lmarena:${spec.splitDir}:${spec.targetCategory}:${modelName}`;
        const obs: RawObservation = {
          sourceId: "lmarena",
          sourceRowId,
          benchmarkId: spec.benchmarkId,
          benchmarkVersion: spec.splitDir,
          domainId: spec.domainId,
          rawModelName: cleanModelName,
          rawProvider: org,
          rawEffort: null,
          rawHarness: explicitHarness,
          observedHarness: explicitHarness ?? "Direct API",
          harnessRegime: "native",
          rawScore: Number(rating.toFixed(2)),
          ciHalfWidth: Number(rawCiHalf.toFixed(4)),
          ciLower: Number(lower.toFixed(4)),
          ciUpper: Number(upper.toFixed(4)),
          battleCount: battles,
          measuredCostUsd: null,
          suiteCostUsd: null,
          measuredInputTokens: null,
          measuredOutputTokens: null,
          // leaderboard_publish_date is a publication timestamp, not a per-model evaluation date
          evalDate: null,
          publishedDate: publishDate,
          sourceUrl: DATASET_URL,
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
