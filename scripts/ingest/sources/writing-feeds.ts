import Papa from "papaparse";
import type { RawObservation } from "../../../src/lib/schema.ts";
import { extractMarkdownTableRows, fetchText, parseIsoDate, parseNumeric } from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const LECH_MAZUR_URL = "https://raw.githubusercontent.com/lechmazur/writing/main/README.md";
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
): Promise<{ rows: RawObservation[]; stats: PartitionStats }> {
  const md = await fetchText(LECH_MAZUR_URL);
  const tableRows = extractMarkdownTableRows(md);
  const out: RawObservation[] = [];
  const stats: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
  const nameCounts = new Map<string, number>();
  for (const row of tableRows) {
    if (!("comparison_score" in row)) continue;
    const n = (row.model ?? "").replace(/\*\*/g, "").trim();
    if (n) nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
  }

  // Lech Mazur README changelog documents adding DeepSeek V4 Pro high on August 20, 2026 (0813 GA endpoint)
  const hasAug20DeepSeekV4Pro = /August\s+20,\s+2026:[^\n]*DeepSeek\s+V4\s+Pro\s+high/i.test(md);
  const latestPublishedDate = parseLatestLechMazurDate(md, nowIso);

  for (const row of tableRows) {
    if (!("comparison_score" in row)) continue;
    stats.attempted++;
    const modelName = (row.model ?? "").replace(/\*\*/g, "").trim();
    const score = parseNumeric(row.comparison_score);
    const ci = parseBootstrapInterval(row["95_bootstrap_interval"]);
    if (!modelName || score === null || ci === null) {
      stats.rejected++;
      continue;
    }

    const isPost0813DeepSeekV4Pro =
      hasAug20DeepSeekV4Pro && /^deepseek[\s_-]+v4[\s_-]+pro\s*\(high\)$/i.test(modelName);
    const resolvedModelName = isPost0813DeepSeekV4Pro
      ? "DeepSeek V4 Pro (high, 2026-08-13)"
      : modelName;

    const sourceRowId =
      (nameCounts.get(modelName) ?? 0) > 1
        ? `lechmazur:${modelName}@${score.toFixed(3)}:${ci.low.toFixed(4)}:${ci.high.toFixed(4)}`
        : `lechmazur:${modelName}`;
    out.push({
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
    });
  }

  return { rows: out, stats };
}

async function fetchEqBenchLongform(): Promise<{ rows: RawObservation[]; stats: PartitionStats }> {
  const js = await fetchText(EQBENCH_LONGFORM_JS);
  const csvMatch = js.match(/leaderboardDataLongformV3\s*=\s*`([\s\S]*?)`/);
  if (!csvMatch?.[1]) {
    throw new Error("EQ-Bench Longform v3 CSV payload not found");
  }

  const parsed = Papa.parse<Record<string, string>>(csvMatch[1].trim(), {
    header: true,
    skipEmptyLines: true,
  });

  const out: RawObservation[] = [];
  const stats: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
  const eqNameCounts = new Map<string, number>();
  for (const row of parsed.data) {
    const n = (row.model_name ?? "").replace(/^\*/, "").trim();
    if (n) eqNameCounts.set(n, (eqNameCounts.get(n) ?? 0) + 1);
  }

  for (const row of parsed.data) {
    stats.attempted++;
    const modelName = (row.model_name ?? "").replace(/^\*/, "").trim();
    const score = parseNumeric(row.overall_score_100);
    if (!modelName || score === null || score < 0 || score > 100) {
      stats.rejected++;
      continue;
    }

    const sourceRowId =
      (eqNameCounts.get(modelName) ?? 0) > 1
        ? `eqbench:longform:${modelName}@${score.toFixed(2)}`
        : `eqbench:longform:${modelName}`;
    out.push({
      sourceId: "writing-feeds",
      sourceRowId,
      benchmarkId: "eqbench_longform",
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
    });
  }

  return { rows: out, stats };
}

export const writingFeedsAdapter: SourceAdapter = {
  id: "writing-feeds",
  label: "Lech Mazur & EQ-Bench v3 Longform Writing Feeds",
  license: "MIT / Public Research",
  sourceUrl: "https://github.com/lechmazur/writing",
  expectedBenchmarks: ["lechmazur_writing", "eqbench_longform"],
  expectsPricing: false,
  async fetchLive(nowIso) {
    const [lech, eqLong] = await Promise.allSettled([
      fetchLechMazur(nowIso),
      fetchEqBenchLongform(),
    ]);
    const observations: RawObservation[] = [];
    const partitionStats: Record<string, PartitionStats> = {};

    const attach = (
      id: string,
      res: PromiseSettledResult<{ rows: RawObservation[]; stats: PartitionStats }>,
    ) => {
      if (res.status === "fulfilled") {
        observations.push(...res.value.rows);
        partitionStats[id] = res.value.stats;
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
    attach("eqbench_longform", eqLong);

    return { observations, pricing: [], partitionStats };
  },
};
