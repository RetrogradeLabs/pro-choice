import {
  parseStrictEffortMetadata,
  parseUniqueEffortFromText,
} from "../../../src/lib/math/canonicalize.ts";
import type { RawObservation } from "../../../src/lib/schema.ts";
import { extractRscText, fetchText, observationsMatchExact, parseBalancedJson } from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const ARCPRIZE_URL = "https://arcprize.org/leaderboard";
const ARC_V3_DATASET_ID = "v3_Semi_Private";
const ARC_V3_TASK_COUNT = 55;

const ARC_PROVIDER_MAP: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  xai: "spacexai",
  "meta ai": "meta",
  meta: "meta",
  deepseek: "deepseek",
  moonshot: "moonshot",
  "moonshot ai": "moonshot",
  alibaba: "alibaba",
  qwen: "alibaba",
  zhipu: "zhipu",
  "z.ai": "zhipu",
};

const NON_STANDARD_HARNESS_NOTE_RE =
  /\b(?:custom\s+harness|provider\s+adapter|program\s+synthesis|refinement|test[\s-]time\s+training|ttt|ensemble|agentic\s+scaffold)\b/i;

const PARTIAL_COST_NOTE_RE =
  /\b(?:partial\s+dataset\s+coverage|unrecorded\s+attempts|lower\s+bounds?|not\s+verified\s+full[\s-]run\s+costs?)\b/i;

interface ArcEvaluationCell {
  datasetId?: unknown;
  score?: unknown;
  cost?: unknown;
  display?: unknown;
}

interface ArcModelMeta {
  id?: unknown;
  displayName?: unknown;
  providerId?: unknown;
  modelType?: unknown;
  notes?: unknown;
}

interface ArcRow {
  modelId?: unknown;
  name?: unknown;
  effort?: unknown;
  model?: ArcModelMeta;
  evaluations?: Record<string, unknown>;
}

interface ArcGroup {
  rows?: unknown;
}

function isFlightRef(value: unknown): boolean {
  return typeof value === "string" && value.trim().startsWith("$") && value.trim() !== "$undefined";
}

function readOptionalCleanString(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null || value === "$undefined") {
    return { ok: true, value: null };
  }
  if (typeof value !== "string" || isFlightRef(value)) {
    return { ok: false };
  }
  const trimmed = value.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

function readStrictFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export const arcprizeAdapter: SourceAdapter = {
  id: "arcprize",
  label: "ARC Prize (ARC-AGI-3 Semi-Private)",
  license: "Public Research Leaderboard / Attribution Required",
  sourceUrl: ARCPRIZE_URL,
  expectedBenchmarks: ["arc_agi_3"],
  expectsPricing: false,
  async fetchLive() {
    const html = await fetchText(ARCPRIZE_URL, {
      timeoutMs: 25_000,
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    const rsc = extractRscText(html);
    const marker = rsc.indexOf('"groups":[{"');
    if (marker === -1) {
      throw new Error("ARC Prize RSC payload missing groups array");
    }
    const parsed = parseBalancedJson(rsc, marker + '"groups":'.length);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("ARC Prize groups array is empty or malformed");
    }

    const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
    const candidatesByRowId = new Map<string, RawObservation[]>();
    const disqualifiedIds = new Set<string>();

    const rejectRow = (rowId: string | null) => {
      st.rejected++;
      if (rowId) disqualifiedIds.add(rowId);
    };

    const excludeRow = (rowId: string | null) => {
      st.excluded++;
      if (rowId) disqualifiedIds.add(rowId);
    };

    for (const group of parsed as ArcGroup[]) {
      if (!group || typeof group !== "object" || !Array.isArray(group.rows)) continue;
      for (const rawRow of group.rows as ArcRow[]) {
        if (!rawRow || typeof rawRow !== "object") continue;

        const rawEval = rawRow.evaluations?.[ARC_V3_DATASET_ID];
        if (rawEval === undefined || rawEval === null || rawEval === "$undefined") continue;

        st.attempted++;
        const rawModelIdRes = readOptionalCleanString(rawRow.modelId);
        const metaIdRes = readOptionalCleanString(rawRow.model?.id);
        const provisionalModelId =
          (rawModelIdRes.ok ? rawModelIdRes.value : null) ??
          (metaIdRes.ok ? metaIdRes.value : null);
        const rowId = provisionalModelId ? `arcprize:v3_semi_private:${provisionalModelId}` : null;

        if (
          isFlightRef(rawEval) ||
          typeof rawEval !== "object" ||
          !rawModelIdRes.ok ||
          !metaIdRes.ok
        ) {
          rejectRow(rowId);
          continue;
        }
        const evalCell = rawEval as ArcEvaluationCell;
        if (evalCell.score === undefined || evalCell.score === null) {
          // Row carried an empty evaluation stub; not a valid v3 score
          st.attempted--;
          continue;
        }

        if (evalCell.display !== true) {
          excludeRow(rowId);
          continue;
        }

        const datasetIdRes = readOptionalCleanString(evalCell.datasetId);
        const nameRes = readOptionalCleanString(rawRow.name);
        const providerRes = readOptionalCleanString(rawRow.model?.providerId);
        const displayNameRes = readOptionalCleanString(rawRow.model?.displayName);
        const notesRes = readOptionalCleanString(rawRow.model?.notes);
        const effortRes = readOptionalCleanString(rawRow.effort);
        const modelTypeRes = readOptionalCleanString(rawRow.model?.modelType);
        const scoreFrac = readStrictFiniteNumber(evalCell.score);

        if (
          !provisionalModelId ||
          !rowId ||
          !datasetIdRes.ok ||
          datasetIdRes.value !== ARC_V3_DATASET_ID ||
          !nameRes.ok ||
          !nameRes.value ||
          !providerRes.ok ||
          !providerRes.value ||
          !displayNameRes.ok ||
          !notesRes.ok ||
          !effortRes.ok ||
          !modelTypeRes.ok ||
          scoreFrac === null ||
          scoreFrac < 0 ||
          scoreFrac > 1
        ) {
          rejectRow(rowId);
          continue;
        }

        // Exclude non-standard harnesses or custom synthesis/refinement systems from the standard model panel
        const notesText = notesRes.value ?? "";
        const modelTypeLower = (modelTypeRes.value ?? "").toLowerCase();
        if (
          NON_STANDARD_HARNESS_NOTE_RE.test(notesText) ||
          modelTypeLower.includes("synthesis") ||
          modelTypeLower.includes("refinement") ||
          modelTypeLower.includes("custom")
        ) {
          excludeRow(rowId);
          continue;
        }

        const effortRaw = effortRes.value;
        let rawEffort: string | null =
          effortRaw && effortRaw !== "—" && effortRaw !== "-" ? effortRaw.toLowerCase() : null;

        if (displayNameRes.value) {
          const dispEff = parseUniqueEffortFromText(displayNameRes.value, true);
          if (dispEff.ambiguous) {
            rejectRow(rowId);
            continue;
          }
          if (dispEff.effort !== null) {
            if (rawEffort === null) {
              rawEffort = dispEff.effort;
            } else {
              const normRow = parseStrictEffortMetadata(rawEffort);
              if (normRow !== null && normRow !== dispEff.effort) {
                rejectRow(rowId);
                continue;
              }
            }
          }
        }

        // Withhold per-game measured cost when upstream notes disclose partial-coverage lower bounds
        const hasPartialCost = PARTIAL_COST_NOTE_RE.test(notesText);
        const rawCost =
          evalCell.cost === undefined || evalCell.cost === null || evalCell.cost === "$undefined"
            ? null
            : readStrictFiniteNumber(evalCell.cost);
        if (
          evalCell.cost !== undefined &&
          evalCell.cost !== null &&
          evalCell.cost !== "$undefined" &&
          rawCost === null
        ) {
          rejectRow(rowId);
          continue;
        }
        const perGameCost =
          !hasPartialCost && rawCost !== null && rawCost > 0
            ? Number((rawCost / ARC_V3_TASK_COUNT).toFixed(6))
            : null;

        const provider = ARC_PROVIDER_MAP[providerRes.value.toLowerCase()] ?? providerRes.value;

        const obs: RawObservation = {
          sourceId: "arcprize",
          sourceRowId: rowId,
          benchmarkId: "arc_agi_3",
          benchmarkVersion: "v3-semi-private",
          domainId: "research",
          rawModelName: nameRes.value,
          rawProvider: provider,
          rawEffort,
          rawHarness: null,
          observedHarness: "ARC-AGI-3 Standard",
          harnessRegime: "native",
          rawScore: Number((scoreFrac * 100).toFixed(2)),
          seRaw: null,
          ciHalfWidth: null,
          ciLower: null,
          ciUpper: null,
          battleCount: ARC_V3_TASK_COUNT,
          measuredCostUsd: perGameCost,
          // Never emit suiteCostUsd on non-AA sources (reserved strictly for AA Intelligence/Agent Suite axes)
          suiteCostUsd: null,
          measuredInputTokens: null,
          measuredOutputTokens: null,
          evalDate: null,
          publishedDate: null,
          sourceUrl: ARCPRIZE_URL,
        };

        const grp = candidatesByRowId.get(rowId) ?? [];
        grp.push(obs);
        candidatesByRowId.set(rowId, grp);
      }
    }

    const observations: RawObservation[] = [];
    for (const [rowId, grp] of candidatesByRowId.entries()) {
      const first = grp[0]!;
      const conflicts =
        disqualifiedIds.has(rowId) || grp.some((o) => !observationsMatchExact(o, first));
      if (conflicts) {
        st.rejected += grp.length;
        disqualifiedIds.add(rowId);
        continue;
      }
      observations.push(first);
    }

    if (observations.length === 0) {
      throw new Error("ARC Prize ARC-AGI-3 produced zero valid observations");
    }

    return {
      observations,
      pricing: [],
      partitionStats: { arc_agi_3: st },
      ...(disqualifiedIds.size > 0
        ? { disqualifiedSourceRowIdsByBenchmark: { arc_agi_3: [...disqualifiedIds] } }
        : {}),
    };
  },
};
