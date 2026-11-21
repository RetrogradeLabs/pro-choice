import type { RawObservation } from "../../../src/lib/schema.ts";
import {
  fetchJson,
  observationsMatchExact,
  parseNumeric,
  parsePositive,
  parseStrictNonNegativeInt,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const DESIGNARENA_URL = "https://designarena.ai/leaderboard";
const MIN_BATTLES = 300;
const MIN_UNREPORTED_SE_BATTLES = 1000;
const MAX_CI_ELO = 25;

interface DesignArenaFeedSpec {
  benchmarkId: string;
  arenaType: "agents" | "models";
  category: string;
  observedHarness: string;
}

const DESIGNARENA_FEEDS: readonly DesignArenaFeedSpec[] = [
  {
    benchmarkId: "designarena_svg",
    arenaType: "models",
    category: "svg",
    observedHarness: "Direct API",
  },
  {
    benchmarkId: "designarena_website",
    arenaType: "models",
    category: "website",
    observedHarness: "Direct API",
  },
];

interface DesignArenaRow {
  modelId?: string;
  elo?: number | null;
  btStdErr?: number | null;
  battles?: number | null;
  avgCostUsd?: number | null;
}

interface DesignArenaApiResponse {
  success?: boolean;
  arenaType?: string;
  category?: string;
  data?: DesignArenaRow[];
}

function parseStrictPositiveSe(val: unknown): number | null {
  if (typeof val === "number") return Number.isFinite(val) && val > 0 ? val : null;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

export const designarenaAdapter: SourceAdapter = {
  id: "designarena",
  label: "DesignArena Website and SVG Arenas",
  license: "Public Leaderboard / Attribution Required",
  sourceUrl: DESIGNARENA_URL,
  expectedBenchmarks: DESIGNARENA_FEEDS.map((f) => f.benchmarkId),
  expectsPricing: false,
  async fetchLive() {
    const settled = await Promise.allSettled(
      DESIGNARENA_FEEDS.map(async (spec) => {
        const url = `https://www.designarena.ai/api/leaderboard?arenaType=${spec.arenaType}&category=${spec.category}`;
        const json = await fetchJson<DesignArenaApiResponse>(url, { timeoutMs: 20_000 });
        if (
          json.success !== true ||
          json.arenaType !== spec.arenaType ||
          json.category !== spec.category
        ) {
          throw new Error(`DesignArena returned the wrong partition for ${spec.category}`);
        }
        if (!Array.isArray(json.data) || json.data.length === 0) {
          throw new Error(`DesignArena ${spec.category} returned 0 rows`);
        }
        return { spec, rows: json.data };
      }),
    );

    const observations: RawObservation[] = [];
    const partitionStats: Record<string, PartitionStats> = {};
    const disqualifiedByBenchmark: Record<string, string[]> = {};

    for (let i = 0; i < DESIGNARENA_FEEDS.length; i++) {
      const spec = DESIGNARENA_FEEDS[i]!;
      const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
      partitionStats[spec.benchmarkId] = st;

      const res = settled[i]!;
      if (res.status !== "fulfilled") {
        st.error = res.reason instanceof Error ? res.reason.message : String(res.reason);
        continue;
      }

      let missingCiCount = 0;
      const candidatesByRowId = new Map<string, RawObservation[]>();

      for (const raw of res.value.rows) {
        st.attempted++;
        if (!raw || typeof raw !== "object") {
          st.rejected++;
          continue;
        }
        try {
          const modelId = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
          const elo = parseNumeric(raw.elo);
          const battles = parseStrictNonNegativeInt(raw.battles);
          const btSeSupplied = raw.btStdErr !== null && raw.btStdErr !== undefined;
          const upstreamBtSe = parseStrictPositiveSe(raw.btStdErr);

          if (
            !modelId ||
            elo === null ||
            battles === null ||
            (btSeSupplied && upstreamBtSe === null)
          ) {
            st.rejected++;
            continue;
          }

          if (battles < MIN_BATTLES) {
            st.excluded++;
            continue;
          }

          let seRaw: number | null = null;
          let ciHalfWidth: number | null = null;
          if (upstreamBtSe !== null) {
            const rawCiHalf = upstreamBtSe * 1.96;
            if (rawCiHalf > MAX_CI_ELO) {
              st.excluded++;
              continue;
            }
            seRaw = Number(upstreamBtSe.toFixed(6));
            ciHalfWidth = Number(rawCiHalf.toFixed(4));
          } else {
            // Require >= 1,000 battles when upstream omits btStdErr and leave SE unreported (never invent Elo SE)
            if (battles < MIN_UNREPORTED_SE_BATTLES) {
              st.excluded++;
              continue;
            }
            missingCiCount++;
          }

          const rowId = `designarena:${spec.category}:${modelId}`;
          const obs: RawObservation = {
            sourceId: "designarena",
            sourceRowId: rowId,
            benchmarkId: spec.benchmarkId,
            benchmarkVersion: "public",
            domainId: "design_code",
            rawModelName: modelId,
            rawProvider: null,
            rawEffort: null,
            rawHarness: null,
            observedHarness: spec.observedHarness,
            harnessRegime: "native",
            rawScore: Number(elo.toFixed(2)),
            seRaw,
            ciHalfWidth,
            ciLower: null,
            ciUpper: null,
            battleCount: battles,
            measuredCostUsd: parsePositive(raw.avgCostUsd),
            suiteCostUsd: null,
            measuredInputTokens: null,
            measuredOutputTokens: null,
            evalDate: null,
            publishedDate: null,
            sourceUrl: `https://www.designarena.ai/api/leaderboard?arenaType=${spec.arenaType}&category=${spec.category}`,
          };
          const grp = candidatesByRowId.get(rowId) ?? [];
          grp.push(obs);
          candidatesByRowId.set(rowId, grp);
        } catch {
          st.rejected++;
        }
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
      if (disqualified.length > 0) disqualifiedByBenchmark[spec.benchmarkId] = disqualified;

      if (missingCiCount > 0) {
        st.note = `Upstream btStdErr null on ${missingCiCount} rows; conservatively down-weighted by reliability model`;
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
