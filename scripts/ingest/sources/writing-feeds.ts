import Papa from "papaparse";
import type { RawObservation } from "../../../src/lib/schema.ts";
import {
  extractMarkdownTableRows,
  fetchText,
  observationsMatchExact,
  parseIsoDate,
  parseNumeric,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const LECH_MAZUR_URL = "https://raw.githubusercontent.com/lechmazur/writing/main/README.md";
const EQBENCH_CREATIVE_JS = "https://eqbench.com/creative_writing.js";
const EQBENCH_LONGFORM_JS = "https://eqbench.com/creative_writing_longform.js";

function parseLatestLechMazurDate(md: string, nowIso: string): string | null {
  const idx = md.search(/##?\s*Recent\s+Updates/i);
  const section = idx >= 0 ? md.slice(idx, idx + 4000) : md.slice(0, 4000);
  const rx =
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),\s+(202\d)\b/gi;
  let latest: string | null = null;
  for (const m of section.matchAll(rx)) {
    const iso = parseIsoDate(`${m[1]} ${m[2]}, ${m[3]}`, nowIso);
    if (iso && (!latest || iso > latest)) latest = iso;
  }
  return latest;
}

function parseBootstrapInterval(
  text: string | undefined,
): { low: number; high: number; halfWidth: number } | null {
  if (!text) return null;
  const m = text.match(/(-?\d+(?:\.\d+)?)\s+to\s+(-?\d+(?:\.\d+)?)/i);
  if (!m?.[1] || !m[2]) return null;
  const low = Number(m[1]);
  const high = Number(m[2]);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return null;
  return {
    low: Number(low.toFixed(4)),
    high: Number(high.toFixed(4)),
    halfWidth: Number(((high - low) / 2).toFixed(4)),
  };
}

async function fetchLechMazur(
  nowIso: string,
): Promise<{ rows: RawObservation[]; stats: PartitionStats; disqualifiedIds: string[] }> {
  const md = await fetchText(LECH_MAZUR_URL);
  const tableRows = extractMarkdownTableRows(md);
  const out: RawObservation[] = [];
  const stats: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };

  // Lech Mazur README changelog documents adding DeepSeek V4 Pro high on August 20, 2026 (0813 GA endpoint)
  const hasAug20DeepSeekV4Pro = /August\s+20,\s+2026:[^\n]*DeepSeek\s+V4\s+Pro\s+high/i.test(md);
  const latestPublishedDate = parseLatestLechMazurDate(md, nowIso);
  const candidatesByRowId = new Map<string, RawObservation[]>();

  for (const row of tableRows) {
    if (!("comparison_score" in row)) continue;
    stats.attempted++;
    const modelName = (row.model ?? "").replace(/\*\*/g, "").trim();
    const score = parseNumeric(row.comparison_score);
    const ci = parseBootstrapInterval(row["95_bootstrap_interval"]);
    if (
      !modelName ||
      score === null ||
      ci === null ||
      score < ci.low - 0.01 ||
      score > ci.high + 0.01
    ) {
      stats.rejected++;
      continue;
    }

    const isPost0813DeepSeekV4Pro =
      hasAug20DeepSeekV4Pro && /^deepseek[\s_-]+v4[\s_-]+pro\s*\(high\)$/i.test(modelName);
    const resolvedModelName = isPost0813DeepSeekV4Pro
      ? "DeepSeek V4 Pro (high, 2026-08-13)"
      : modelName;

    const sourceRowId = `lechmazur:${modelName}`;
    const obs: RawObservation = {
      sourceId: "writing-feeds",
      sourceRowId,
      benchmarkId: "lechmazur_writing",
      benchmarkVersion: "2026.11",
      domainId: "writing",
      rawModelName: resolvedModelName,
      rawProvider: null,
      rawEffort: null,
      rawHarness: null,
      observedHarness: "Direct API",
      harnessRegime: "native",
      rawScore: Number(score.toFixed(3)),
      ciHalfWidth: ci.halfWidth,
      ciLower: ci.low,
      ciUpper: ci.high,
      battleCount: null,
      measuredCostUsd: null,
      suiteCostUsd: null,
      measuredInputTokens: null,
      measuredOutputTokens: null,
      evalDate: null,
      publishedDate: latestPublishedDate,
      sourceUrl: "https://github.com/lechmazur/writing",
    };
    const list = candidatesByRowId.get(sourceRowId) ?? [];
    list.push(obs);
    candidatesByRowId.set(sourceRowId, list);
  }

  const disqualifiedIds: string[] = [];
  for (const [rowId, list] of candidatesByRowId.entries()) {
    const first = list[0]!;
    if (list.length > 1 && !list.every((cand) => observationsMatchExact(first, cand))) {
      stats.rejected += list.length;
      disqualifiedIds.push(rowId);
      continue;
    }
    out.push(first);
  }

  return { rows: out, stats, disqualifiedIds };
}

async function fetchEqBenchCreativeWriting(): Promise<{
  rows: RawObservation[];
  stats: PartitionStats;
  disqualifiedIds: string[];
}> {
  const js = await fetchText(EQBENCH_CREATIVE_JS);
  const csvMatch = js.match(/leaderboardDataCreativeWritingV3\s*=\s*`([\s\S]*?)`/);
  if (!csvMatch?.[1]) {
    throw new Error("EQ-Bench Creative Writing v3 CSV payload not found");
  }

  const parsed = Papa.parse<Record<string, string>>(csvMatch[1].trim(), {
    header: true,
    skipEmptyLines: true,
  });

  const out: RawObservation[] = [];
  const stats: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
  const candidatesByRowId = new Map<string, RawObservation[]>();

  for (const row of parsed.data) {
    stats.attempted++;
    const modelName = (row.model_name ?? "").replace(/^\*/, "").trim();
    // Ingest EQ-Bench's 0-20 creative writing rubric score (not the un-intervaled Elo column)
    const score = parseNumeric(row.creative_writing_score);
    if (!modelName || score === null || score < 0 || score > 20) {
      stats.rejected++;
      continue;
    }

    const sourceRowId = `eqbench:creative:${modelName}`;
    const obs: RawObservation = {
      sourceId: "writing-feeds",
      sourceRowId,
      benchmarkId: "eqbench_creative_writing",
      benchmarkVersion: "3.0",
      domainId: "writing",
      rawModelName: modelName,
      rawProvider: null,
      rawEffort: null,
      rawHarness: null,
      observedHarness: "Direct API",
      harnessRegime: "native",
      rawScore: Number(score.toFixed(2)),
      ciHalfWidth: null,
      ciLower: null,
      ciUpper: null,
      battleCount: null,
      measuredCostUsd: null,
      suiteCostUsd: null,
      measuredInputTokens: null,
      measuredOutputTokens: null,
      evalDate: null,
      publishedDate: null,
      sourceUrl: "https://eqbench.com/creative_writing.html",
    };
    const list = candidatesByRowId.get(sourceRowId) ?? [];
    list.push(obs);
    candidatesByRowId.set(sourceRowId, list);
  }

  const disqualifiedIds: string[] = [];
  for (const [rowId, list] of candidatesByRowId.entries()) {
    const first = list[0]!;
    if (list.length > 1 && !list.every((cand) => observationsMatchExact(first, cand))) {
      stats.rejected += list.length;
      disqualifiedIds.push(rowId);
      continue;
    }
    out.push(first);
  }

  return { rows: out, stats, disqualifiedIds };
}

async function fetchEqBenchLongformWriting(): Promise<{
  rows: RawObservation[];
  stats: PartitionStats;
  disqualifiedIds: string[];
}> {
  const js = await fetchText(EQBENCH_LONGFORM_JS);
  const csvMatch = js.match(/leaderboardDataLongformV3\s*=\s*`([\s\S]*?)`/);
  if (!csvMatch?.[1]) {
    throw new Error("EQ-Bench Longform Writing v3 CSV payload not found");
  }

  const parsed = Papa.parse<Record<string, string>>(csvMatch[1].trim(), {
    header: true,
    skipEmptyLines: true,
  });

  const out: RawObservation[] = [];
  const stats: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
  const candidatesByRowId = new Map<string, RawObservation[]>();

  for (const row of parsed.data) {
    stats.attempted++;
    const modelName = (row.model_name ?? "").replace(/^\*/, "").trim();
    const score = parseNumeric(row.overall_score_100);
    if (!modelName || score === null || score < 0 || score > 100) {
      stats.rejected++;
      continue;
    }

    const sourceRowId = `eqbench:longform:${modelName}`;
    const obs: RawObservation = {
      sourceId: "writing-feeds",
      sourceRowId,
      benchmarkId: "eqbench_longform_writing",
      benchmarkVersion: "3.0",
      domainId: "writing",
      rawModelName: modelName,
      rawProvider: null,
      rawEffort: null,
      rawHarness: null,
      observedHarness: "Direct API",
      harnessRegime: "native",
      rawScore: Number(score.toFixed(2)),
      ciHalfWidth: null,
      ciLower: null,
      ciUpper: null,
      battleCount: null,
      measuredCostUsd: null,
      suiteCostUsd: null,
      measuredInputTokens: null,
      measuredOutputTokens: null,
      evalDate: null,
      publishedDate: null,
      sourceUrl: "https://eqbench.com/creative_writing_longform.html",
    };
    const list = candidatesByRowId.get(sourceRowId) ?? [];
    list.push(obs);
    candidatesByRowId.set(sourceRowId, list);
  }

  const disqualifiedIds: string[] = [];
  for (const [rowId, list] of candidatesByRowId.entries()) {
    const first = list[0]!;
    if (list.length > 1 && !list.every((cand) => observationsMatchExact(first, cand))) {
      stats.rejected += list.length;
      disqualifiedIds.push(rowId);
      continue;
    }
    out.push(first);
  }

  return { rows: out, stats, disqualifiedIds };
}

export const writingFeedsAdapter: SourceAdapter = {
  id: "writing-feeds",
  label: "Lech Mazur & EQ-Bench v3 Creative and Longform Writing Feeds",
  license: "MIT / Public Research",
  sourceUrl: "https://github.com/lechmazur/writing",
  expectedBenchmarks: ["lechmazur_writing", "eqbench_creative_writing", "eqbench_longform_writing"],
  expectsPricing: false,
  async fetchLive(nowIso) {
    const [lech, eqCreative, eqLongform] = await Promise.allSettled([
      fetchLechMazur(nowIso),
      fetchEqBenchCreativeWriting(),
      fetchEqBenchLongformWriting(),
    ]);
    const observations: RawObservation[] = [];
    const partitionStats: Record<string, PartitionStats> = {};
    const disqualifiedByBenchmark: Record<string, string[]> = {};

    const attach = (
      id: string,
      res: PromiseSettledResult<{
        rows: RawObservation[];
        stats: PartitionStats;
        disqualifiedIds?: string[];
      }>,
    ) => {
      if (res.status === "fulfilled") {
        observations.push(...res.value.rows);
        partitionStats[id] = res.value.stats;
        if (res.value.disqualifiedIds && res.value.disqualifiedIds.length > 0) {
          disqualifiedByBenchmark[id] = res.value.disqualifiedIds;
        }
      } else {
        partitionStats[id] = {
          attempted: 0,
          rejected: 0,
          excluded: 0,
          error: res.reason instanceof Error ? res.reason.message : String(res.reason),
        };
      }
    };

    attach("lechmazur_writing", lech);
    attach("eqbench_creative_writing", eqCreative);
    attach("eqbench_longform_writing", eqLongform);

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
