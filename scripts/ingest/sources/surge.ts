import { parseUniqueEffortFromText } from "../../../src/lib/math/canonicalize.ts";
import type { DomainId, HarnessRegime, RawObservation } from "../../../src/lib/schema.ts";
import { fetchText, observationsMatchExact, parseNumeric } from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const SURGE_BASE_URL = "https://www.surgehq.ai/benchmarks";

interface SurgeFeedSpec {
  slug: string;
  benchmarkId: string;
  version: string;
  domainId: DomainId;
  harnessRegime: HarnessRegime;
  isElo: boolean;
}

const SURGE_FEEDS: readonly SurgeFeedSpec[] = [
  {
    slug: "sudo-l7",
    benchmarkId: "surge_sudo_l7",
    version: "1.0",
    domainId: "coding",
    harnessRegime: "standardized",
    isElo: false,
  },
  {
    slug: "gdp-xlsx",
    benchmarkId: "surge_gdp_xlsx",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    isElo: false,
  },
  {
    slug: "dayjob-finance",
    benchmarkId: "surge_dayjob_finance",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    isElo: false,
  },
  {
    slug: "dayjob-law",
    benchmarkId: "surge_dayjob_law",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    isElo: false,
  },
  {
    slug: "dayjob-healthcare",
    benchmarkId: "surge_dayjob_healthcare",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    isElo: false,
  },
  {
    slug: "enterprisebench-corecraft",
    benchmarkId: "surge_corecraft",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    isElo: false,
  },
  {
    slug: "riemann-bench",
    benchmarkId: "surge_riemann",
    version: "1.0",
    domainId: "research",
    harnessRegime: "native",
    isElo: false,
  },
];

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function parseSurgeProvider(rowHtml: string): string | null {
  const alt = rowHtml.match(/alt="([^"]+)"/i)?.[1];
  if (!alt) return null;
  const cleaned = decodeHtmlEntities(alt)
    .replace(/\s+logo$/i, "")
    .trim();
  return cleaned || null;
}

const MAX_RUBRIC_ELO_CI = 30;

// Parse Surge parenthetical qualifiers without collapsing ambiguous or negated modes onto generic thinking
function parseSurgeModelAndEffort(rawModel: string): {
  modelName: string;
  rawEffort: string | null;
  conflict: boolean;
} {
  let detectedEffort: string | null = null;
  let conflict = false;

  const setEffort = (val: string): void => {
    if (detectedEffort !== null && detectedEffort !== val) {
      conflict = true;
      return;
    }
    detectedEffort = val;
  };

  const cleanedModel = rawModel
    .replace(/\(([^)]+)\)/g, (full, inner: string) => {
      const trimmed = inner.trim();
      if (!trimmed) return "";
      if (/\d+k\b/i.test(trimmed)) return full;
      const lower = trimmed.toLowerCase();
      // Preserve ambiguous mode labels as explicit unmapped tokens so canonicalizer quarantines them cleanly
      if (/^(?:auto[\s_-]+reasoning|default|adaptive)$/.test(lower)) {
        setEffort(lower.replace(/\s+/g, "-"));
        return "";
      }
      if (/^adaptive\s*\/\s*default\b/i.test(trimmed)) {
        setEffort(lower.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
        return "";
      }
      const adaptiveSingle = trimmed.match(/^adaptive\s*\/\s*([^/]+)$/i);
      const parseTarget = adaptiveSingle?.[1]?.trim() ?? trimmed;
      const parsed = parseUniqueEffortFromText(parseTarget, false);
      if (parsed.ambiguous) {
        conflict = true;
        return full;
      }
      if (parsed.effort !== null) {
        setEffort(parsed.effort);
        return "";
      }
      return full;
    })
    .replace(/\s+/g, " ")
    .trim();

  return { modelName: cleanedModel, rawEffort: detectedEffort, conflict };
}

// Extract strictly the balanced element containing role="list" and data-leaderboard-row="" so trailing HTML never bleeds
function extractPrimaryLeaderboardList(html: string): string | null {
  const openRx = /<div\b[^>]*\brole="list"[^>]*>/gi;
  let match: RegExpExecArray | null = openRx.exec(html);
  while (match !== null) {
    const startIdx = match.index;
    let depth = 0;
    const tagRx = /<\/?div\b[^>]*>/gi;
    tagRx.lastIndex = startIdx;
    let tag: RegExpExecArray | null = tagRx.exec(html);
    let endIdx = -1;
    while (tag !== null) {
      if (tag[0].startsWith("</")) {
        depth--;
        if (depth === 0) {
          endIdx = tag.index + tag[0].length;
          break;
        }
      } else if (!tag[0].endsWith("/>")) {
        depth++;
      }
      tag = tagRx.exec(html);
    }
    if (endIdx <= startIdx) return null;
    const candidate = html.slice(startIdx, endIdx);
    if (candidate.includes('data-leaderboard-row=""')) return candidate;
    match = openRx.exec(html);
  }
  return null;
}

export const surgeAdapter: SourceAdapter = {
  id: "surge",
  label: `Surge AI Frontier Benchmarks (${SURGE_FEEDS.length} Benchmarks)`,
  license: "Public Research Leaderboards / Attribution Required",
  sourceUrl: SURGE_BASE_URL,
  expectedBenchmarks: SURGE_FEEDS.map((f) => f.benchmarkId),
  expectsPricing: false,
  async fetchLive() {
    const pages = await Promise.allSettled(
      SURGE_FEEDS.map(async (spec) => {
        const url = `${SURGE_BASE_URL}/${spec.slug}`;
        const html = await fetchText(url, { timeoutMs: 25_000 });
        const listHtml = extractPrimaryLeaderboardList(html);
        if (!listHtml) {
          throw new Error(`Surge leaderboard list missing for ${spec.slug}`);
        }
        return { spec, url, listHtml };
      }),
    );

    const observations: RawObservation[] = [];
    const partitionStats: Record<string, PartitionStats> = {};
    const disqualifiedByBenchmark: Record<string, string[]> = {};

    for (let i = 0; i < SURGE_FEEDS.length; i++) {
      const spec = SURGE_FEEDS[i]!;
      const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
      partitionStats[spec.benchmarkId] = st;

      const res = pages[i]!;
      if (res.status !== "fulfilled") {
        st.error = res.reason instanceof Error ? res.reason.message : String(res.reason);
        continue;
      }

      const { url, listHtml } = res.value;
      const rawRows = listHtml.split(/data-leaderboard-row=""/).slice(1);
      const candidatesByRowId = new Map<string, RawObservation[]>();

      for (const rawPart of rawRows) {
        st.attempted++;
        const endIdx = rawPart.indexOf('role="listitem"');
        const rowHtml = endIdx > 0 ? rawPart.slice(0, endIdx) : rawPart;
        const provider = parseSurgeProvider(rowHtml);
        const stripped = rowHtml
          .replace(/<style[\s\S]*?<\/style>/g, "")
          .replace(/<script[\s\S]*?<\/script>/g, "");
        const leaves = [...stripped.matchAll(/>([^<>]{1,160})</g)]
          .map((m) => decodeHtmlEntities((m[1] ?? "").replace(/\s+/g, " ")))
          .filter(Boolean);

        const dataScoreMatches = [...rowHtml.matchAll(/data-score=""[^>]*>([^<]+)</g)]
          .map((m) => decodeHtmlEntities(m[1] ?? ""))
          .filter(Boolean);

        let score: number | null = null;
        for (const ds of dataScoreMatches) {
          const parsed = parseNumeric(ds);
          if (parsed !== null) {
            score = parsed;
            break;
          }
        }
        if (score === null) {
          const pctIdx = leaves.indexOf("%");
          if (pctIdx > 0) score = parseNumeric(leaves[pctIdx - 1]);
        }

        const ciLower = parseNumeric(
          rowHtml.match(/data-leaderboard-ci-lower="([^"]+)"/)?.[1] ?? null,
        );
        const ciUpper = parseNumeric(
          rowHtml.match(/data-leaderboard-ci-upper="([^"]+)"/)?.[1] ?? null,
        );

        // Extract model tokens sitting strictly between rank (leaves[0]) and the score cell
        const nameTokens: string[] = [];
        const startIdx = leaves[0] && /^\d+$/.test(leaves[0]) ? 1 : 0;
        for (let k = startIdx; k < leaves.length; k++) {
          const tok = leaves[k]!;
          if (tok === "%" || tok === "-") break;
          if (/^-?\d+(?:\.\d+)?%?$/.test(tok)) {
            const numTok = parseNumeric(tok);
            if (score !== null && numTok !== null && Math.abs(numTok - score) <= 0.01) break;
          }
          nameTokens.push(tok);
          if (nameTokens.length >= 3) break;
        }
        const combinedModel = nameTokens.join(" ").replace(/\s+/g, " ").trim();

        if (!combinedModel || score === null) {
          st.rejected++;
          continue;
        }
        if (!spec.isElo && (score < 0 || score > 100)) {
          st.rejected++;
          continue;
        }
        const hasAnyCi = ciLower !== null || ciUpper !== null;
        if (spec.isElo && !hasAnyCi) {
          st.rejected++;
          continue;
        }
        let ciHalfWidth: number | null = null;
        if (hasAnyCi) {
          if (
            ciLower === null ||
            ciUpper === null ||
            ciUpper <= ciLower ||
            score < ciLower - 0.01 ||
            score > ciUpper + 0.01
          ) {
            st.rejected++;
            continue;
          }
          const rawCiHalf = (ciUpper - ciLower) / 2;
          if (spec.isElo && rawCiHalf > MAX_RUBRIC_ELO_CI) {
            st.excluded++;
            continue;
          }
          const roundedHalf = Number(rawCiHalf.toFixed(4));
          if (!(roundedHalf > 0)) {
            st.rejected++;
            continue;
          }
          ciHalfWidth = roundedHalf;
        }

        const parsedModel = parseSurgeModelAndEffort(combinedModel);
        if (!parsedModel.modelName || parsedModel.conflict) {
          st.rejected++;
          continue;
        }

        const sourceRowId = `surge:${spec.slug}:${combinedModel}`;
        const obs: RawObservation = {
          sourceId: "surge",
          sourceRowId,
          benchmarkId: spec.benchmarkId,
          benchmarkVersion: spec.version,
          domainId: spec.domainId,
          rawModelName: parsedModel.modelName,
          rawProvider: provider,
          rawEffort: parsedModel.rawEffort,
          rawHarness: null,
          observedHarness: "Direct API",
          harnessRegime: spec.harnessRegime,
          rawScore: Number(score.toFixed(2)),
          ciHalfWidth,
          ciLower: ciLower !== null ? Number(ciLower.toFixed(4)) : null,
          ciUpper: ciUpper !== null ? Number(ciUpper.toFixed(4)) : null,
          battleCount: null,
          measuredCostUsd: null,
          suiteCostUsd: null,
          measuredInputTokens: null,
          measuredOutputTokens: null,
          evalDate: null,
          publishedDate: null,
          sourceUrl: url,
        };
        const grp = candidatesByRowId.get(sourceRowId) ?? [];
        grp.push(obs);
        candidatesByRowId.set(sourceRowId, grp);
      }

      const disqualified: string[] = [];
      for (const grp of candidatesByRowId.values()) {
        const first = grp[0]!;
        if (grp.some((o) => !observationsMatchExact(o, first))) {
          st.rejected += grp.length;
          disqualified.push(first.sourceRowId);
          continue;
        }
        observations.push(first);
      }
      if (disqualified.length > 0) disqualifiedByBenchmark[spec.benchmarkId] = disqualified;
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
