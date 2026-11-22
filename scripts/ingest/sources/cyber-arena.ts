import type { RawObservation } from "../../../src/lib/schema.ts";
import { fetchText, parseIsoDate, parseNumeric, parseStrictNonNegativeInt } from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const CYBER_ARENA_API_URL = "https://api.cyber-arena.ai/api/campaigns/mc-v1";
const CYBER_ARENA_PUBLIC_URL = "https://cyber-arena.ai/";
const MIN_GAMES = 15;
// Exact two-sided 90% normal quantile z_0.95 for converting CyberArena lo90/hi90 credible intervals to 1-SE
const Z_90 = 1.6448536269514722;

interface CyberArenaEntry {
  entrant?: {
    model?: unknown;
    harness?: unknown;
  };
  score?: unknown;
  provisional?: unknown;
  stats?: {
    games?: unknown;
    lo90?: unknown;
    hi90?: unknown;
  };
}

interface CyberArenaPayload {
  id?: unknown;
  ranked_at?: unknown;
  entries?: unknown;
}

function formatArenaHarness(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower === "claude" || lower === "claude-code") return "Claude Code";
  if (lower === "codex") return "Codex";
  if (lower === "opencode") return "OpenCode";
  return raw.trim();
}

export const cyberArenaAdapter: SourceAdapter = {
  id: "cyber-arena",
  label: "CyberArena Attack-Defense CTF (mc-v1)",
  license: "Public Research Leaderboard / Attribution Required",
  sourceUrl: CYBER_ARENA_PUBLIC_URL,
  expectedBenchmarks: ["cyberarena_mc_v1"],
  expectsPricing: false,
  async fetchLive(nowIso) {
    const rawText = await fetchText(CYBER_ARENA_API_URL, { timeoutMs: 20_000 });
    const parsed = JSON.parse(rawText) as CyberArenaPayload;
    const publishedDate = parseIsoDate(
      typeof parsed.ranked_at === "string" ? parsed.ranked_at : null,
      nowIso,
    );
    if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
      throw new Error("CyberArena mc-v1 payload missing entries array");
    }

    const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
    const observations: RawObservation[] = [];

    for (const entry of parsed.entries as CyberArenaEntry[]) {
      st.attempted++;
      if (!entry || typeof entry !== "object") {
        st.rejected++;
        continue;
      }
      if (entry.provisional === true) {
        st.excluded++;
        continue;
      }
      const model = typeof entry.entrant?.model === "string" ? entry.entrant.model.trim() : "";
      const harness =
        typeof entry.entrant?.harness === "string" ? entry.entrant.harness.trim() : "";
      const score = parseNumeric(entry.score);
      const games = parseStrictNonNegativeInt(entry.stats?.games);
      const lo90 = parseNumeric(entry.stats?.lo90);
      const hi90 = parseNumeric(entry.stats?.hi90);

      if (
        !model ||
        !harness ||
        score === null ||
        score < 0 ||
        score > 100 ||
        games === null ||
        lo90 === null ||
        hi90 === null ||
        hi90 <= lo90
      ) {
        st.rejected++;
        continue;
      }
      if (games < MIN_GAMES) {
        st.excluded++;
        continue;
      }

      const seRaw = (hi90 - lo90) / (2 * Z_90);
      const ciHalfWidth = seRaw * 1.96;

      observations.push({
        sourceId: "cyber-arena",
        sourceRowId: `cyber-arena:mc-v1:${model}:${harness}`,
        benchmarkId: "cyberarena_mc_v1",
        benchmarkVersion: "mc-v1",
        domainId: "cyber",
        rawModelName: model,
        rawProvider: null,
        rawEffort: null,
        // Fold vendor-native CTF harness so model-level Cyber scores link across CWE-bench and Aikido Arena
        rawHarness: null,
        observedHarness: formatArenaHarness(harness),
        harnessRegime: "native",
        rawScore: Number(score.toFixed(2)),
        seRaw: Number(seRaw.toFixed(6)),
        ciHalfWidth: Number(ciHalfWidth.toFixed(4)),
        ciLower: null,
        ciUpper: null,
        battleCount: games,
        measuredCostUsd: null,
        suiteCostUsd: null,
        measuredInputTokens: null,
        measuredOutputTokens: null,
        evalDate: null,
        publishedDate,
        sourceUrl: CYBER_ARENA_PUBLIC_URL,
      });
    }

    return {
      observations,
      pricing: [],
      partitionStats: { cyberarena_mc_v1: st },
    };
  },
};
