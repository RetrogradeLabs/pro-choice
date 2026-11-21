import type { RawObservation } from "../../../src/lib/schema.ts";
import {
  fetchText,
  parseIsoDate,
  parseNumeric,
  parsePositive,
  parseStrictPositiveInt,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const WEIRDML_JSON_URL = "https://htihle.github.io/assets/data/weirdml_v3.json";
const WEIRDML_PUBLIC_URL = "https://htihle.github.io/weirdml.html";

interface WeirdMlModelRow {
  id?: unknown;
  name?: unknown;
  agent?: unknown;
  slug?: unknown;
  release_date?: unknown;
  reasoning_effort?: unknown;
  synthetic?: unknown;
  score?: unknown;
  interval?: unknown;
  mean_api_cost_usd?: unknown;
  mean_output_tokens?: unknown;
  runs?: unknown;
}

interface WeirdMlPayload {
  generated?: unknown;
  models?: unknown;
}

function mapWeirdMlHarness(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower === "claude_code") return "Claude Code";
  if (lower === "codex_cli") return "Codex";
  if (lower === "opencode") return "OpenCode";
  if (lower === "gemini_cli") return "Gemini CLI";
  if (lower === "kimi_code") return "Kimi Code";
  return raw.trim();
}

export const weirdmlAdapter: SourceAdapter = {
  id: "weirdml",
  label: "WeirdML v3 Coding Agent Stacks",
  license: "Public Research Benchmark / Attribution Required",
  sourceUrl: WEIRDML_PUBLIC_URL,
  expectedBenchmarks: ["weirdml_v3"],
  expectsPricing: false,
  async fetchLive(nowIso) {
    const rawText = await fetchText(WEIRDML_JSON_URL, { timeoutMs: 20_000 });
    const parsed = JSON.parse(rawText) as WeirdMlPayload;
    const publishedDate = parseIsoDate(
      typeof parsed.generated === "string" ? parsed.generated : null,
      nowIso,
    );
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) {
      throw new Error("WeirdML v3 payload missing models array");
    }

    const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
    const observations: RawObservation[] = [];

    for (const row of parsed.models as WeirdMlModelRow[]) {
      st.attempted++;
      if (!row || typeof row !== "object") {
        st.rejected++;
        continue;
      }
      if (row.synthetic === true) {
        st.excluded++;
        continue;
      }
      const slug = typeof row.slug === "string" ? row.slug.trim() : "";
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const agent = typeof row.agent === "string" ? row.agent.trim() : "";
      const effort =
        typeof row.reasoning_effort === "string" ? row.reasoning_effort.trim() || null : null;
      const score = parseNumeric(row.score);
      const costUsd = parsePositive(row.mean_api_cost_usd);

      if ((!slug && !name) || !agent || score === null || score < 0 || score > 1) {
        st.rejected++;
        continue;
      }

      let ciLower: number | null = null;
      let ciUpper: number | null = null;
      let ciHalfWidth: number | null = null;
      if (Array.isArray(row.interval) && row.interval.length === 2) {
        const lo = parseNumeric(row.interval[0]);
        const hi = parseNumeric(row.interval[1]);
        if (lo !== null && hi !== null && hi > lo) {
          ciLower = Number((lo * 100).toFixed(4));
          ciUpper = Number((hi * 100).toFixed(4));
          ciHalfWidth = Number((((hi - lo) / 2) * 100).toFixed(4));
        }
      }

      const mappedHarness = mapWeirdMlHarness(agent);
      const slash = slug.indexOf("/");
      const rawProvider = slash > 0 ? slug.slice(0, slash).trim() : null;
      const rawModelName = slug || name;
      const outTok = parsePositive(row.mean_output_tokens);
      const runs = parseStrictPositiveInt(row.runs);
      const rowId = typeof row.id === "string" && row.id.trim() ? row.id.trim() : rawModelName;

      observations.push({
        sourceId: "weirdml",
        sourceRowId: `weirdml:v3:${rowId}:${agent}:${effort ?? "default"}`,
        benchmarkId: "weirdml_v3",
        benchmarkVersion: "3.0",
        domainId: "harnesses",
        rawModelName,
        rawProvider,
        rawEffort: effort,
        rawHarness: mappedHarness,
        observedHarness: mappedHarness,
        harnessRegime: "native",
        rawScore: Number((score * 100).toFixed(2)),
        ciHalfWidth,
        ciLower,
        ciUpper,
        battleCount: runs,
        measuredCostUsd: costUsd !== null ? Number(costUsd.toFixed(6)) : null,
        suiteCostUsd: null,
        measuredInputTokens: null,
        measuredOutputTokens: outTok !== null ? Math.round(outTok) : null,
        evalDate: null,
        publishedDate,
        sourceUrl: WEIRDML_PUBLIC_URL,
      });
    }

    return {
      observations,
      pricing: [],
      partitionStats: { weirdml_v3: st },
    };
  },
};
