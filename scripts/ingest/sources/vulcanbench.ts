import Papa from "papaparse";
import type { RawObservation } from "../../../src/lib/schema.ts";
import { fetchText, parseNumeric, parsePositive, parseStrictPositiveInt } from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const VULCAN_CSV_URL = "https://vulcanbench.com/assets/data/swe-v4-board.csv";
const VULCAN_URL = "https://vulcanbench.com/";

function normalizeVulcanHarness(raw: string): string {
  const trimmed = raw.trim();
  // Strip trailing semver / rc tags (e.g. "DeepSeek Harness 0.2.1-rc.2" -> "DeepSeek Harness")
  return trimmed.replace(/\s+v?\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.]+)?$/i, "").trim();
}

function normalizeVulcanEffort(raw: string): string | null {
  const lower = raw.trim().toLowerCase();
  if (!lower) return null;
  if (lower === "extra-high" || lower === "extra high") return "xhigh";
  return lower;
}

export const vulcanbenchAdapter: SourceAdapter = {
  id: "vulcanbench",
  label: "VulcanBench SWE v4 Agent Stacks",
  license: "Public Research Leaderboard / Attribution Required",
  sourceUrl: VULCAN_URL,
  expectedBenchmarks: ["vulcanbench_swe_v4"],
  expectsPricing: false,
  async fetchLive() {
    const csv = await fetchText(VULCAN_CSV_URL, { timeoutMs: 20_000 });
    const parsed = Papa.parse<Record<string, string>>(csv, {
      header: true,
      skipEmptyLines: true,
    });
    const fields = parsed.meta.fields ?? [];
    for (const req of ["model", "lab", "harness", "effort", "combined_33", "combined_33_se"]) {
      if (!fields.includes(req)) {
        throw new Error(`VulcanBench CSV missing required column '${req}'`);
      }
    }

    const observations: RawObservation[] = [];
    const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
    const seen = new Set<string>();

    for (const row of parsed.data) {
      st.attempted++;
      const model = (row.model ?? "").trim();
      const lab = (row.lab ?? "").trim() || null;
      const rawHarness = (row.harness ?? "").trim();
      const score = parseNumeric(row.combined_33);
      if (!model || !rawHarness || score === null || score < 0 || score > 100) {
        st.rejected++;
        continue;
      }

      const se = parsePositive(row.combined_33_se);
      const meanUsd = parsePositive(row.mean_usd);
      const nTasks = parseStrictPositiveInt(row.n);
      const cleanHarness = normalizeVulcanHarness(rawHarness);
      const effort = normalizeVulcanEffort(row.effort ?? "");
      const rowKey = `${lab ?? ""}:${model}:${cleanHarness}:${effort ?? ""}`;
      if (seen.has(rowKey)) continue;
      seen.add(rowKey);

      observations.push({
        sourceId: "vulcanbench",
        sourceRowId: `vulcanbench:swe_v4:${rowKey}`,
        benchmarkId: "vulcanbench_swe_v4",
        benchmarkVersion: "4.0",
        domainId: "harnesses",
        rawModelName: model,
        rawProvider: lab,
        rawEffort: effort,
        rawHarness: cleanHarness,
        observedHarness: rawHarness,
        harnessRegime: "native",
        rawScore: Number(score.toFixed(2)),
        seRaw: se !== null ? Number(se.toFixed(6)) : null,
        ciHalfWidth: se !== null ? Number((se * 1.96).toFixed(4)) : null,
        ciLower: null,
        ciUpper: null,
        battleCount: nTasks,
        measuredCostUsd: meanUsd !== null ? Number(meanUsd.toFixed(6)) : null,
        suiteCostUsd: null,
        measuredInputTokens: null,
        measuredOutputTokens: parsePositive(row.mean_output_tokens),
        evalDate: null,
        publishedDate: null,
        sourceUrl: VULCAN_URL,
      });
    }

    return {
      observations,
      pricing: [],
      partitionStats: { vulcanbench_swe_v4: st },
    };
  },
};
