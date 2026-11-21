import type { RawObservation } from "../../../src/lib/schema.ts";
import {
  fetchText,
  observationsMatchExact,
  parseIsoDate,
  parseNumeric,
  parsePositive,
  parseStrictPositiveInt,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const AIKIDO_URL = "https://www.aikido.dev/aikido-arena";

function readAttr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return m?.[1]?.trim() || null;
}

export const aikidoAdapter: SourceAdapter = {
  id: "aikido",
  label: "Aikido Arena Real-World CVE Detection",
  license: "Public Research Leaderboard / Attribution Required",
  sourceUrl: AIKIDO_URL,
  expectedBenchmarks: ["aikido_arena"],
  expectsPricing: false,
  async fetchLive(nowIso) {
    const html = await fetchText(AIKIDO_URL, { timeoutMs: 20_000 });
    const tags = [...html.matchAll(/<div[^>]*class="[^"]*cms-model-item[^"]*"[^>]*>/gi)].map(
      (m) => m[0],
    );
    if (tags.length === 0) {
      throw new Error("Aikido Arena HTML missing cms-model-item rows");
    }

    const observations: RawObservation[] = [];
    const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
    const candidatesByRowId = new Map<string, RawObservation[]>();

    for (const tag of tags) {
      const runCount = parseStrictPositiveInt(readAttr(tag, "data-run-count"));
      // Keep strictly single-run average rows so 2-run / 3-run unions are never mixed with pass@1
      if (runCount !== 1) continue;

      st.attempted++;
      const modelName = readAttr(tag, "data-model");
      const provider = readAttr(tag, "data-provider");
      const modelId = readAttr(tag, "data-model-id") ?? modelName;
      const tasks = parseStrictPositiveInt(readAttr(tag, "data-tasks"));
      const f1Frac = parseNumeric(readAttr(tag, "data-f1"));
      const totalCost = parsePositive(readAttr(tag, "data-total-cost-usd"));
      // Note upstream Webflow attribute typo "data-benchamark-date"
      const rawDate = readAttr(tag, "data-benchamark-date") ?? readAttr(tag, "data-benchmark-date");

      if (!modelName || !modelId || tasks === null || f1Frac === null || f1Frac < 0 || f1Frac > 1) {
        st.rejected++;
        continue;
      }

      const rowId = `aikido:arena:1run:${modelId}`;
      const f1Pct = Number((f1Frac * 100).toFixed(2));
      const measuredCostUsd = totalCost !== null ? Number((totalCost / tasks).toFixed(6)) : null;
      const evalDate = parseIsoDate(rawDate, nowIso);

      const obs: RawObservation = {
        sourceId: "aikido",
        sourceRowId: rowId,
        benchmarkId: "aikido_arena",
        benchmarkVersion: "1.0",
        domainId: "cyber",
        rawModelName: modelName,
        rawProvider: provider,
        rawEffort: null,
        rawHarness: null,
        observedHarness: "Aikido Security Harness",
        harnessRegime: "native",
        rawScore: f1Pct,
        seRaw: null,
        ciHalfWidth: null,
        ciLower: null,
        ciUpper: null,
        battleCount: tasks,
        measuredCostUsd,
        suiteCostUsd: null,
        measuredInputTokens: null,
        measuredOutputTokens: null,
        evalDate,
        publishedDate: evalDate,
        sourceUrl: AIKIDO_URL,
      };
      const grp = candidatesByRowId.get(rowId) ?? [];
      grp.push(obs);
      candidatesByRowId.set(rowId, grp);
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

    return {
      observations,
      pricing: [],
      partitionStats: { aikido_arena: st },
      ...(disqualified.length > 0
        ? { disqualifiedSourceRowIdsByBenchmark: { aikido_arena: disqualified } }
        : {}),
    };
  },
};
