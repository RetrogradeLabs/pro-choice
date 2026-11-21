import Papa from "papaparse";
import { BENCHMARK_BY_ID } from "../../../src/config/benchmarks.ts";
import type { DomainId, HarnessRegime, RawObservation } from "../../../src/lib/schema.ts";
import {
  fetchText,
  parseIsoDate,
  parseNumeric,
  parsePositive,
  parseStrictPositiveInt,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const LIVEBENCH_URL = "https://livebench.ai/";

interface LiveBenchModelMeta {
  displayName: string | null;
  organization: string | null;
  effort: string | null;
}

interface LiveBenchCategorySpec {
  col: string;
  nqCol: string;
  outCol: string;
  benchmarkId: string;
  domainId: DomainId;
  harnessRegime: HarnessRegime;
  requireCostCsv: boolean;
}

const LIVEBENCH_SPECS: readonly LiveBenchCategorySpec[] = [
  {
    col: "coding",
    nqCol: "nq_coding",
    outCol: "out_coding",
    benchmarkId: "livebench_coding",
    domainId: "coding",
    harnessRegime: "standardized",
    requireCostCsv: false,
  },
  {
    col: "research",
    nqCol: "nq_research",
    outCol: "out_research",
    benchmarkId: "livebench_research",
    domainId: "research",
    harnessRegime: "native",
    requireCostCsv: false,
  },
  {
    col: "data_analysis",
    nqCol: "nq_data_analysis",
    outCol: "out_data_analysis",
    benchmarkId: "livebench_data_analysis",
    domainId: "research",
    harnessRegime: "native",
    requireCostCsv: false,
  },
];

function extractLiveBenchBundleMetadata(js: string): {
  latestReleaseId: string | null;
  modelsByKey: Map<string, LiveBenchModelMeta>;
} {
  const relMatch = js.match(/Yt=\[([^\]]+)\]/);
  const ids = relMatch?.[1] ? [...relMatch[1].matchAll(/"(\d{8})"/g)].map((m) => m[1]!) : [];
  const latestReleaseId = ids[ids.length - 1] ?? null;

  const modelsByKey = new Map<string, LiveBenchModelMeta>();
  const entryRe = /"([a-zA-Z0-9._:/-]+)":\{displayName:"([^"]+)"([^}]*)\}/g;
  for (const m of js.matchAll(entryRe)) {
    const key = m[1];
    const displayName = m[2] ?? null;
    const body = m[3] ?? "";
    if (!key) continue;
    const orgMatch = body.match(/organization:"([^"]+)"/);
    const effMatch = body.match(/effort:"([^"]+)"/);
    modelsByKey.set(key, {
      displayName,
      organization: orgMatch?.[1] ?? null,
      effort: effMatch?.[1] ?? null,
    });
  }
  return { latestReleaseId, modelsByKey };
}

async function fetchLiveBenchBundleMeta(): Promise<{
  latestReleaseId: string | null;
  modelsByKey: Map<string, LiveBenchModelMeta>;
}> {
  const html = await fetchText(LIVEBENCH_URL);
  const jsMatch = html.match(/src="([^"]+\.js)"/);
  if (!jsMatch?.[1]) throw new Error("LiveBench 2.0 bundle script not found");
  const jsUrl = new URL(jsMatch[1], LIVEBENCH_URL).toString();
  const js = await fetchText(jsUrl);
  const parsed = extractLiveBenchBundleMetadata(js);
  if (parsed.modelsByKey.size === 0) {
    throw new Error("LiveBench 2.0 model metadata map not found in bundle");
  }
  return parsed;
}

const LIVEBENCH_COST_COLUMNS = LIVEBENCH_SPECS.flatMap((s) => [s.col, s.nqCol, s.outCol]);

function livebenchCostRowsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  return LIVEBENCH_COST_COLUMNS.every((col) => {
    const av = parseNumeric(a[col]);
    const bv = parseNumeric(b[col]);
    if (av === null && bv === null) return true;
    return av !== null && bv !== null && Math.abs(av - bv) <= 1e-6;
  });
}

export const livebenchAdapter: SourceAdapter = {
  id: "livebench",
  label: "LiveBench 2.0 Coding, Research & Data Analysis",
  license: "Apache-2.0",
  sourceUrl: LIVEBENCH_URL,
  expectedBenchmarks: LIVEBENCH_SPECS.map((s) => s.benchmarkId),
  expectsPricing: false,
  async fetchLive(nowIso) {
    const pinnedReleaseId = BENCHMARK_BY_ID.livebench_coding?.version ?? "20261106";
    const publishedDate = parseIsoDate(
      `${pinnedReleaseId.slice(0, 4)}-${pinnedReleaseId.slice(4, 6)}-${pinnedReleaseId.slice(6, 8)}`,
      nowIso,
    );

    const [metaRes, tableRes, costRes] = await Promise.allSettled([
      fetchLiveBenchBundleMeta(),
      fetchText(`https://livebench.ai/data/${pinnedReleaseId}/table.csv`),
      fetchText(`https://livebench.ai/data/${pinnedReleaseId}/cost.csv`),
    ]);

    const partitionStats: Record<string, PartitionStats> = Object.fromEntries(
      LIVEBENCH_SPECS.map((s) => [s.benchmarkId, { attempted: 0, rejected: 0, excluded: 0 }]),
    );

    if (metaRes.status !== "fulfilled") {
      const msg = metaRes.reason instanceof Error ? metaRes.reason.message : String(metaRes.reason);
      for (const s of LIVEBENCH_SPECS) {
        partitionStats[s.benchmarkId]!.error = `LiveBench metadata unavailable: ${msg}`;
      }
      return { observations: [], pricing: [], partitionStats };
    }

    if (tableRes.status !== "fulfilled") {
      const msg =
        tableRes.reason instanceof Error ? tableRes.reason.message : String(tableRes.reason);
      for (const s of LIVEBENCH_SPECS) partitionStats[s.benchmarkId]!.error = msg;
      return { observations: [], pricing: [], partitionStats };
    }

    const { latestReleaseId, modelsByKey } = metaRes.value;
    const newerReleaseNote =
      latestReleaseId && latestReleaseId > pinnedReleaseId
        ? `Pinned to ${pinnedReleaseId}; newer upstream LiveBench release ${latestReleaseId} available`
        : null;

    const parsedTable = Papa.parse<Record<string, string>>(tableRes.value, {
      header: true,
      skipEmptyLines: true,
    });

    const costByModel = new Map<string, Record<string, string> | "conflict">();
    let costAvailable = false;
    if (costRes.status === "fulfilled") {
      const parsedCost = Papa.parse<Record<string, string>>(costRes.value, {
        header: true,
        skipEmptyLines: true,
      });
      const fields = new Set(parsedCost.meta.fields ?? []);
      const hasRequiredCostCols =
        fields.has("model") &&
        LIVEBENCH_SPECS.every((s) => fields.has(s.col) && fields.has(s.nqCol));
      if (!hasRequiredCostCols) {
        for (const s of LIVEBENCH_SPECS) {
          if (s.requireCostCsv) {
            partitionStats[s.benchmarkId]!.error =
              `LiveBench cost.csv missing required columns (model, ${s.col}, ${s.nqCol})`;
          }
        }
      } else {
        costAvailable = true;
        for (const row of parsedCost.data) {
          const m = row.model?.trim();
          if (!m) continue;
          const prev = costByModel.get(m);
          if (prev === undefined) {
            costByModel.set(m, row);
          } else if (prev !== "conflict" && !livebenchCostRowsEqual(prev, row)) {
            costByModel.set(m, "conflict");
          }
        }
      }
    }

    const observations: RawObservation[] = [];

    for (const row of parsedTable.data) {
      const modelKey = row.model?.trim();
      if (!modelKey) continue;
      const meta = modelsByKey.get(modelKey);
      const costEntry = costByModel.get(modelKey);
      const costConflict = costEntry === "conflict";
      const costRow = costConflict ? undefined : costEntry;

      for (const spec of LIVEBENCH_SPECS) {
        const rawCell = row[spec.col];
        const hasVal =
          (!spec.requireCostCsv || costAvailable) && rawCell !== undefined && rawCell.trim() !== "";
        if (!hasVal) continue;

        const st = partitionStats[spec.benchmarkId]!;
        st.attempted++;
        if (!meta) {
          st.rejected++;
          continue;
        }
        const scoreVal = parseNumeric(rawCell);
        if (costConflict || scoreVal === null || scoreVal < 0 || scoreVal > 100) {
          st.rejected++;
          continue;
        }

        const totalCost = parsePositive(costRow?.[spec.col]);
        const nq = parseStrictPositiveInt(costRow?.[spec.nqCol]);
        const totalOut = parsePositive(costRow?.[spec.outCol]);
        const perTaskCost =
          totalCost !== null && nq !== null ? Number((totalCost / nq).toFixed(6)) : null;

        observations.push({
          sourceId: "livebench",
          sourceRowId: `livebench:${pinnedReleaseId}:${spec.col}:${modelKey}`,
          benchmarkId: spec.benchmarkId,
          benchmarkVersion: pinnedReleaseId,
          domainId: spec.domainId,
          rawModelName: meta.displayName ?? modelKey,
          rawProvider: meta.organization,
          rawEffort: meta.effort,
          rawHarness: null,
          observedHarness: "Direct API",
          harnessRegime: spec.harnessRegime,
          rawScore: Number(scoreVal.toFixed(2)),
          ciHalfWidth: null,
          ciLower: null,
          ciUpper: null,
          battleCount: nq,
          measuredCostUsd: perTaskCost,
          suiteCostUsd: null,
          measuredInputTokens: null,
          measuredOutputTokens: totalOut !== null && nq !== null ? Math.round(totalOut / nq) : null,
          evalDate: null,
          publishedDate,
          sourceUrl: LIVEBENCH_URL,
        });
      }
    }

    if (newerReleaseNote) {
      for (const s of LIVEBENCH_SPECS) partitionStats[s.benchmarkId]!.note = newerReleaseNote;
    }

    return { observations, pricing: [], partitionStats };
  },
};
