import type { RawObservation } from "../../../src/lib/schema.ts";
import {
  fetchText,
  parseIsoDate,
  parseNumeric,
  parsePositive,
  parseStrictPositiveInt,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const DEEPSWE_JSON_URL = "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json";
const DEEPSWE_PUBLIC_URL = "https://deepswe.datacurve.ai/";

interface DeepSweRow {
  model?: unknown;
  harness?: unknown;
  provider?: unknown;
  reasoning_effort?: unknown;
  config?: unknown;
  pass_rate?: unknown;
  ci_lo?: unknown;
  ci_hi?: unknown;
  ci_half?: unknown;
  n_attempted?: unknown;
  n_tasks_attempted?: unknown;
  mean_cost_usd?: unknown;
  mean_input_tokens?: unknown;
  mean_output_tokens?: unknown;
}

interface DeepSwePayload {
  generated_at?: unknown;
  n_tasks_in_set?: unknown;
  rows?: unknown;
}

export const deepsweAdapter: SourceAdapter = {
  id: "deepswe",
  label: "Datacurve DeepSWE v1.1",
  license: "Apache-2.0",
  sourceUrl: DEEPSWE_PUBLIC_URL,
  expectedBenchmarks: ["deepswe_v1_1"],
  expectsPricing: false,
  async fetchLive(nowIso) {
    const rawText = await fetchText(DEEPSWE_JSON_URL, { timeoutMs: 20_000 });
    const parsed = JSON.parse(rawText) as DeepSwePayload;
    const expectedTasks = parseStrictPositiveInt(parsed.n_tasks_in_set) ?? 113;
    const publishedDate = parseIsoDate(
      typeof parsed.generated_at === "string" ? parsed.generated_at : null,
      nowIso,
    );
    if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
      throw new Error("DeepSWE v1.1 payload missing rows array");
    }

    const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
    const observations: RawObservation[] = [];

    for (const row of parsed.rows as DeepSweRow[]) {
      st.attempted++;
      if (!row || typeof row !== "object") {
        st.rejected++;
        continue;
      }
      const model = typeof row.model === "string" ? row.model.trim() : "";
      const harness = typeof row.harness === "string" ? row.harness.trim() : "mini-swe-agent";
      const provider = typeof row.provider === "string" ? row.provider.trim() || null : null;
      const effort =
        typeof row.reasoning_effort === "string" ? row.reasoning_effort.trim() || null : null;
      const passRate = parseNumeric(row.pass_rate);
      const tasksAttempted = parseStrictPositiveInt(row.n_tasks_attempted);
      if (
        !model ||
        passRate === null ||
        passRate < 0 ||
        passRate > 1 ||
        tasksAttempted === null ||
        tasksAttempted < expectedTasks
      ) {
        st.rejected++;
        continue;
      }

      const ciLoRaw = parseNumeric(row.ci_lo);
      const ciHiRaw = parseNumeric(row.ci_hi);
      const ciHalfRaw = parsePositive(row.ci_half);
      const hasBounds = ciLoRaw !== null && ciHiRaw !== null && ciHiRaw > ciLoRaw;
      const ciLower = hasBounds ? Number((ciLoRaw * 100).toFixed(4)) : null;
      const ciUpper = hasBounds ? Number((ciHiRaw * 100).toFixed(4)) : null;
      const ciHalfWidth = hasBounds
        ? Number((((ciHiRaw - ciLoRaw) / 2) * 100).toFixed(4))
        : ciHalfRaw !== null
          ? Number((ciHalfRaw * 100).toFixed(4))
          : null;
      const costUsd = parsePositive(row.mean_cost_usd);
      const inTok = parsePositive(row.mean_input_tokens);
      const outTok = parsePositive(row.mean_output_tokens);
      const nAttempted = parseStrictPositiveInt(row.n_attempted);
      const configKey =
        typeof row.config === "string" && row.config.trim()
          ? row.config.trim()
          : `${harness}:${model}:${effort ?? "default"}`;

      observations.push({
        sourceId: "deepswe",
        sourceRowId: `deepswe:v1.1:${configKey}`,
        benchmarkId: "deepswe_v1_1",
        benchmarkVersion: "1.1",
        domainId: "coding",
        rawModelName: model,
        rawProvider: provider,
        rawEffort: effort,
        rawHarness: null,
        observedHarness: harness,
        harnessRegime: "standardized",
        rawScore: Number((passRate * 100).toFixed(2)),
        ciHalfWidth,
        ciLower,
        ciUpper,
        battleCount: nAttempted,
        measuredCostUsd: costUsd !== null ? Number(costUsd.toFixed(6)) : null,
        suiteCostUsd: null,
        measuredInputTokens: inTok !== null ? Math.round(inTok) : null,
        measuredOutputTokens: outTok !== null ? Math.round(outTok) : null,
        evalDate: null,
        publishedDate,
        sourceUrl: DEEPSWE_PUBLIC_URL,
      });
    }

    return {
      observations,
      pricing: [],
      partitionStats: { deepswe_v1_1: st },
    };
  },
};
