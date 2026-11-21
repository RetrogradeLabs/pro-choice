import Papa from "papaparse";
import type { RawObservation } from "../../../src/lib/schema.ts";
import {
  extractMarkdownTableRows,
  fetchJson,
  fetchText,
  parseIsoDate,
  parseNumeric,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const LECH_MAZUR_URL = "https://raw.githubusercontent.com/lechmazur/writing/main/README.md";
const EQBENCH_LONGFORM_JS = "https://eqbench.com/creative_writing_longform.js";
const EQBENCH_LONGFORM_PAGE = "https://eqbench.com/creative_writing_longform.html";
const WRITINGBENCH_URL = "https://writingbench-writingbench.hf.space";

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
  const [page, js] = await Promise.all([
    fetchText(EQBENCH_LONGFORM_PAGE),
    fetchText(EQBENCH_LONGFORM_JS),
  ]);
  const version = page.match(/\bv([\d.]+)\s+\d{4}-\d{2}-\d{2}\s+Updates\b/)?.[1];
  if (
    version !== "1.11" ||
    !page.includes("Outputs are evaluated with a scoring rubric by Claude Sonnet 4.6")
  ) {
    throw new Error("EQ-Bench Longform protocol or judge changed");
  }
  const csvMatch = js.match(/leaderboardDataLongformV3\s*=\s*`([\s\S]*?)`/);
  if (!csvMatch?.[1]) {
    throw new Error("EQ-Bench Longform CSV payload not found");
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
      benchmarkVersion: version,
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
      sourceUrl: EQBENCH_LONGFORM_PAGE,
    });
  }

  return { rows: out, stats };
}

interface GradioComponent {
  type?: string;
  props?: { value?: string | { headers?: string[]; data?: unknown[][] } };
}

async function fetchWritingBench(
  nowIso: string,
): Promise<{ rows: RawObservation[]; stats: PartitionStats }> {
  const page = await fetchJson<{ components: GradioComponent[] }>(`${WRITINGBENCH_URL}/config`);
  const metadata = page.components
    .filter((c) => c.type === "markdown")
    .map((c) => c.props?.value)
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  const judge = metadata.match(/Scored by:\s*([\w.-]+)/i)?.[1];
  const date = parseIsoDate(metadata.match(/Last Updated:\s*(\d{4}-\d{2}-\d{2})/i)?.[1], nowIso);
  if (judge !== "Claude-Sonnet-4-5" || !date || !metadata.includes("1,000 real-world queries")) {
    throw new Error("WritingBench judge, release date or task set changed");
  }
  const tables = page.components.filter((c) => c.type === "dataframe").map((c) => c.props?.value);
  function tableWithHeaders(signature: string): unknown[][] {
    const matches = tables.filter(
      (t) => typeof t === "object" && t.headers?.join("|") === signature,
    );
    const table = matches[0];
    if (
      matches.length !== 1 ||
      typeof table !== "object" ||
      !Array.isArray(table.data) ||
      !table.data.length
    ) {
      throw new Error(`Missing or ambiguous WritingBench table: ${signature}`);
    }
    return table.data;
  }

  const roster = tableWithHeaders("Rank|Model|Organization|Overall|Bar");
  const domains = tableWithHeaders(
    "Rank|Model|Overall|Academic & Engineering|Finance & Business|Politics & Law|Literature & Arts|Education|Advertising & Marketing",
  );
  const byModel = new Map<string, { provider: string; overall: unknown }>();
  for (const [, model, org, overall] of roster) {
    if (
      typeof model !== "string" ||
      !model.trim() ||
      typeof org !== "string" ||
      !org.trim() ||
      byModel.has(model.trim())
    )
      throw new Error("Ambiguous WritingBench model identity");
    byModel.set(model.trim(), { provider: org.trim(), overall });
  }

  const rows: RawObservation[] = [];
  const stats: PartitionStats = { attempted: domains.length, rejected: 0, excluded: 0 };
  const seen = new Set<string>();
  for (const [, model, overall, academic] of domains) {
    if (typeof model !== "string" || seen.has(model.trim()))
      throw new Error("Invalid or duplicate WritingBench domain row");
    const name = model.trim();
    seen.add(name);
    const identity = byModel.get(name);
    if (
      !identity ||
      typeof overall !== "string" ||
      !/^\d+(?:\.\d+)?$/.test(overall) ||
      overall !== identity.overall
    )
      throw new Error(`WritingBench domain identity mismatch for ${name}`);
    const score =
      typeof academic === "string" && /^\d+(?:\.\d+)?$/.test(academic) ? Number(academic) : null;
    if (score === null || score > 100) {
      stats.rejected++;
      continue;
    }
    const provider = identity.provider;
    const id = `writingbench_academic_engineering:${provider}:${name}`;
    rows.push({
      sourceId: "writing-feeds",
      sourceRowId: id,
      benchmarkId: "writingbench_academic_engineering",
      benchmarkVersion: "academic-engineering-sonnet-4.5",
      domainId: "writing",
      rawModelName: name.trim(),
      rawProvider: provider.trim(),
      rawEffort: null,
      rawHarness: null,
      observedHarness: "Direct API",
      harnessRegime: "native",
      rawScore: score,
      ciHalfWidth: null,
      ciLower: null,
      ciUpper: null,
      battleCount: null,
      measuredCostUsd: null,
      suiteCostUsd: null,
      measuredInputTokens: null,
      measuredOutputTokens: null,
      evalDate: null,
      publishedDate: date,
      sourceUrl: WRITINGBENCH_URL,
    });
  }
  if (seen.size !== byModel.size)
    throw new Error("WritingBench overall and domain model panels differ");
  return { rows, stats };
}

export const writingFeedsAdapter: SourceAdapter = {
  id: "writing-feeds",
  label: "Lech Mazur, EQ-Bench Longform and WritingBench Academic & Engineering",
  license: "MIT / Public Research",
  sourceUrl: "https://github.com/lechmazur/writing",
  expectedBenchmarks: [
    "lechmazur_writing",
    "eqbench_longform",
    "writingbench_academic_engineering",
  ],
  expectsPricing: false,
  async fetchLive(nowIso) {
    const [lech, eqLong, writingBench] = await Promise.allSettled([
      fetchLechMazur(nowIso),
      fetchEqBenchLongform(),
      fetchWritingBench(nowIso),
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
    attach("writingbench_academic_engineering", writingBench);

    return { observations, pricing: [], partitionStats };
  },
};
