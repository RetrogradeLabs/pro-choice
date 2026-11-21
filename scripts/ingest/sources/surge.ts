import type { BenchmarkMeta } from "../../../src/config/benchmarks.ts";
import { BENCHMARK_BY_ID } from "../../../src/config/benchmarks.ts";
import type { RawObservation } from "../../../src/lib/schema.ts";
import { fetchText, observationsMatchExact, parseNumeric } from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const benchmarks = Object.values(BENCHMARK_BY_ID).filter((b) => b.sourceId === "surge");

function readBoard(html: string, bm: BenchmarkMeta) {
  const tableStart = html.indexOf('data-leaderboard-table="" class="lead-rank-table-list-body"');
  const tableEnd = html.indexOf("</section>", tableStart);
  if (!html.includes(`<h1 class="heading h1">${bm.name}</h1>`) || tableStart < 0 || tableEnd < 0)
    throw new Error(`Cannot identify ${bm.name} leaderboard`);

  const rows = html.slice(tableStart, tableEnd).split('<div data-leaderboard-row=""').slice(1);
  if (!rows.length) throw new Error(`No published rows for ${bm.name}`);
  const stats: PartitionStats = { attempted: rows.length, rejected: 0, excluded: 0 };
  const observations = new Map<string, RawObservation>();
  const conflicts = new Set<string>();

  for (const row of rows) {
    const brand = row.match(/class="head-rank-table-brand"><div[^>]*>([^<]+)<\/div>/)?.[1];
    const model = row.match(/class="head-rank-table-name"><div[^>]*>([^<]+)<\/div>/)?.[1];
    const score = parseNumeric(
      row.match(/data-score="[^"]*" fs-list-field="foundational-score"[^>]*>([^<]+)</)?.[1],
    );
    const percent = /fs-list-field="foundational-score"[^>]*>%</.test(row);
    if (
      !brand ||
      !model ||
      score === null ||
      score < 0 ||
      percent !== (bm.scale === "percent") ||
      (percent && score > 100)
    ) {
      stats.rejected++;
      continue;
    }
    const ciLower = parseNumeric(row.match(/data-leaderboard-ci-lower="([\d.]+)"/)?.[1]);
    const ciUpper = parseNumeric(row.match(/data-leaderboard-ci-upper="([\d.]+)"/)?.[1]);
    if (
      bm.scale === "elo" &&
      (ciLower === null ||
        ciUpper === null ||
        ciLower > score ||
        ciUpper < score ||
        ciLower >= ciUpper)
    ) {
      stats.rejected++;
      continue;
    }
    const effort = model.match(
      / \((?:Adaptive\/(?:Default\/)?)?(Max|xHigh|High|Medium|Low|Minimal|No reasoning|Thinking on|Thinking off)(?: reasoning)?\)$/i,
    );
    const base = (effort ? model.slice(0, effort.index) : model).replace(
      / \(preview\)$/i,
      " preview",
    );
    // The board lists both preview and undated V4 names without the evaluation date needed to resolve the latter.
    if (brand === "DeepSeek" && /^V4 (Pro|Flash)$/i.test(base)) {
      stats.excluded++;
      continue;
    }
    const rawModelName = `${brand} ${base}`;
    const level = effort?.[1]?.toLowerCase();
    const sourceRowId = `${brand} ${model}`;
    const observation: RawObservation = {
      sourceId: "surge",
      sourceRowId,
      benchmarkId: bm.id,
      benchmarkVersion: bm.version,
      domainId: bm.domainId,
      rawModelName,
      rawProvider: row.match(/alt="([^"]+) logo"/)?.[1] ?? null,
      rawEffort:
        level === "thinking on"
          ? "thinking"
          : level === "thinking off" || level === "no reasoning"
            ? "none"
            : (level ?? null),
      rawHarness: null,
      observedHarness: "Surge AI evaluation",
      harnessRegime: "native",
      rawScore: score,
      ciHalfWidth: null,
      ciLower: bm.scale === "elo" ? ciLower : null,
      ciUpper: bm.scale === "elo" ? ciUpper : null,
      battleCount: null,
      measuredCostUsd: null,
      measuredInputTokens: null,
      measuredOutputTokens: null,
      suiteCostUsd: null,
      evalDate: null,
      publishedDate: null,
      sourceUrl: bm.sourceUrl,
    };
    const existing = observations.get(sourceRowId);
    if (existing && !observationsMatchExact(existing, observation)) conflicts.add(sourceRowId);
    else observations.set(sourceRowId, observation);
  }

  stats.rejected += conflicts.size;
  for (const id of conflicts) observations.delete(id);
  return { observations: [...observations.values()], stats, conflicts: [...conflicts] };
}

export const surgeAdapter: SourceAdapter = {
  id: "surge",
  label: "Surge AI expert evaluations",
  sourceUrl: "https://surgehq.ai/benchmarks",
  license: "Surge AI terms apply",
  expectedBenchmarks: benchmarks.map((b) => b.id),
  expectsPricing: false,
  async fetchLive() {
    const boards = await Promise.allSettled(
      benchmarks.map(async (bm) => readBoard(await fetchText(bm.sourceUrl), bm)),
    );
    const observations: RawObservation[] = [];
    const partitionStats: Record<string, PartitionStats> = {};
    const disqualifiedSourceRowIdsByBenchmark: Record<string, string[]> = {};
    for (const [i, board] of boards.entries()) {
      const id = benchmarks[i]!.id;
      if (board.status === "rejected") {
        partitionStats[id] = {
          attempted: 0,
          rejected: 0,
          excluded: 0,
          error: String(board.reason),
        };
        continue;
      }
      observations.push(...board.value.observations);
      partitionStats[id] = board.value.stats;
      disqualifiedSourceRowIdsByBenchmark[id] = board.value.conflicts;
    }
    return { observations, partitionStats, disqualifiedSourceRowIdsByBenchmark, pricing: [] };
  },
};
