import type { RawObservation } from "../../../src/lib/schema.ts";
import {
  extractRscText,
  fetchText,
  parseBalancedJson,
  parseNonNegative,
  parseNumeric,
  parsePositive,
  parseStrictPositiveInt,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const TBENCH_URL = "https://www.tbench.ai/";

const EXPECTED_TBENCH_VERSION = "4.1";
export const MIN_TBENCH_4_1_TRIALS = 330;

interface TBenchRawEntry {
  agent_org?: { label?: string };
  model_org?: { label?: string };
  display_date?: string;
  declared_versions?: string[];
  benchmark_version?: string | number | null;
  version?: string | number | null;
  dataset_version?: string | number | null;
  agent_display?: { label?: string };
  model_display?: { label?: string };
  reasoning_effort?: string | null;
  metrics?: {
    accuracy?: number | null;
    accuracy_ci95_half_width?: number | null;
    n_trials?: number | null;
    total_cost_usd?: number | null;
    total_tokens?: number | null;
    output_tokens?: number | null;
    uncached_input_tokens?: number | null;
  };
}

function cleanStr(v: unknown): string | null {
  return typeof v === "string" ? v.trim() || null : null;
}

function hasMalformedOptionalString(v: unknown): boolean {
  return v !== undefined && v !== null && typeof v !== "string";
}

function hasMalformedLabelContainer(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== "object" || Array.isArray(v)) return true;
  return hasMalformedOptionalString((v as { label?: unknown }).label);
}

function collectVersionTokens(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["benchmark_version", "version", "dataset_version"] as const) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) out.push(val.trim());
    else if (typeof val === "number" && Number.isFinite(val)) out.push(String(val));
  }
  return out;
}

function extractTbenchEntries(rsc: string): TBenchRawEntry[] {
  const results: TBenchRawEntry[] = [];
  const seen = new Set<string>();
  let pos = 0;

  while (pos < rsc.length) {
    const idx = rsc.indexOf('"accuracy_ci95_half_width":', pos);
    if (idx === -1) break;

    // Walk back to the enclosing entry object that has model_display
    const modelIdx = rsc.lastIndexOf('"model_display":', idx);
    if (modelIdx !== -1 && idx - modelIdx < 1200) {
      const objStart = rsc.lastIndexOf('{"', modelIdx - 1);
      // Find the parent object wrapping both display metadata and metrics
      let cursor = modelIdx;
      let parsedEntry: TBenchRawEntry | null = null;
      for (let hops = 0; hops < 6 && cursor > 0; hops++) {
        cursor = rsc.lastIndexOf("{", cursor - 1);
        if (cursor === -1 || idx - cursor > 2000) break;
        const candidate = parseBalancedJson(rsc, cursor);
        if (
          candidate &&
          typeof candidate === "object" &&
          !Array.isArray(candidate) &&
          "metrics" in candidate
        ) {
          const rec = candidate as Record<string, unknown>;
          const metaObj =
            rec.metadata && typeof rec.metadata === "object"
              ? (rec.metadata as Record<string, unknown>)
              : rec;
          const metrics = rec.metrics as TBenchRawEntry["metrics"];
          const declaredVersions = [
            ...new Set([
              ...collectVersionTokens(rec),
              ...(metaObj !== rec ? collectVersionTokens(metaObj) : []),
            ]),
          ];
          parsedEntry = {
            ...(metaObj as TBenchRawEntry),
            declared_versions: declaredVersions,
            ...(metrics !== undefined ? { metrics } : {}),
          };
          break;
        }
      }

      if (!parsedEntry && objStart !== -1) {
        const direct = parseBalancedJson(rsc, objStart);
        if (direct && typeof direct === "object" && !Array.isArray(direct)) {
          const directRec = direct as Record<string, unknown>;
          parsedEntry = {
            ...(direct as TBenchRawEntry),
            declared_versions: collectVersionTokens(directRec),
          };
        }
      }

      if (parsedEntry?.model_display?.label && parsedEntry.metrics) {
        // Deduplicate only byte-equivalent RSC echoes; preserve conflicting org, spend, trial count, tokens, or version declarations
        const verSig = (parsedEntry.declared_versions ?? []).join(",");
        const dedupeKey = `${String(parsedEntry.model_display.label)}::${String(parsedEntry.model_org?.label ?? "")}::${String(parsedEntry.agent_display?.label ?? "")}::${String(parsedEntry.agent_org?.label ?? "")}::${String(parsedEntry.reasoning_effort ?? "")}::${parsedEntry.metrics.accuracy ?? ""}::${parsedEntry.metrics.total_cost_usd ?? ""}::${parsedEntry.metrics.n_trials ?? ""}::${parsedEntry.metrics.accuracy_ci95_half_width ?? ""}::${parsedEntry.metrics.uncached_input_tokens ?? ""}::${parsedEntry.metrics.output_tokens ?? ""}::${verSig}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          results.push(parsedEntry);
        }
      }
    }

    pos = idx + 26;
  }

  return results;
}

export const tbenchAdapter: SourceAdapter = {
  id: "tbench",
  label: "Terminal-Bench 4.1 Live Harness Board",
  license: "Apache-2.0",
  sourceUrl: TBENCH_URL,
  expectedBenchmarks: ["tbench_4_1"],
  expectsPricing: false,
  async fetchLive() {
    const html = await fetchText(TBENCH_URL);
    const rsc = extractRscText(html);
    const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };

    // Verify the live page explicitly serves Terminal-Bench 4.1 before accepting rows under the frozen 66-task calibration
    const pageVersionMatch =
      html.match(/Terminal-Bench\s+(\d+\.\d+)/i) ?? rsc.match(/Terminal-Bench\s+(\d+\.\d+)/i);
    const detectedVersion = pageVersionMatch?.[1]?.trim() ?? null;
    if (detectedVersion !== EXPECTED_TBENCH_VERSION) {
      st.error = `Terminal-Bench version mismatch: detected '${detectedVersion ?? "missing"}', expected '${EXPECTED_TBENCH_VERSION}'`;
      return { observations: [], pricing: [], partitionStats: { tbench_4_1: st } };
    }

    const entries = extractTbenchEntries(rsc);
    const observations: RawObservation[] = [];

    const baseRowCount = new Map<string, number>();
    const tokenSigByMetricKey = new Map<string, string | "conflict">();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (
        hasMalformedLabelContainer(entry.model_display) ||
        hasMalformedLabelContainer(entry.agent_display) ||
        hasMalformedLabelContainer(entry.agent_org) ||
        hasMalformedLabelContainer(entry.model_org) ||
        hasMalformedOptionalString(entry.reasoning_effort)
      ) {
        continue;
      }
      const m = cleanStr(entry.model_display?.label);
      const a = cleanStr(entry.agent_display?.label);
      const e = cleanStr(entry.reasoning_effort);
      if (!m || !a) continue;
      const k = `tbench:4.1:${m}:${e ?? "default"}:${a}`;
      baseRowCount.set(k, (baseRowCount.get(k) ?? 0) + 1);

      const accuracy = parseNumeric(entry.metrics?.accuracy);
      const nTrials = parseStrictPositiveInt(entry.metrics?.n_trials);
      const totalCost = parsePositive(entry.metrics?.total_cost_usd);
      const provider = cleanStr(entry.model_org?.label);
      if (accuracy !== null && nTrials !== null && totalCost !== null) {
        const metricKey = `${k}@${accuracy.toFixed(2)}:${(totalCost / nTrials).toFixed(6)}:${nTrials}:${provider ?? ""}`;
        const rawIn = parsePositive(entry.metrics?.uncached_input_tokens);
        const rawOut = parsePositive(entry.metrics?.output_tokens);
        const tokSig = `${rawIn !== null ? Math.round(rawIn / nTrials) : "na"}:${rawOut !== null ? Math.round(rawOut / nTrials) : "na"}`;
        const prevSig = tokenSigByMetricKey.get(metricKey);
        if (prevSig === undefined) tokenSigByMetricKey.set(metricKey, tokSig);
        else if (prevSig !== tokSig) tokenSigByMetricKey.set(metricKey, "conflict");
      }
    }

    for (const entry of entries) {
      st.attempted++;
      if (!entry || typeof entry !== "object") {
        st.rejected++;
        continue;
      }
      try {
        if (
          hasMalformedLabelContainer(entry.model_display) ||
          hasMalformedLabelContainer(entry.agent_display) ||
          hasMalformedLabelContainer(entry.agent_org) ||
          hasMalformedLabelContainer(entry.model_org) ||
          hasMalformedOptionalString(entry.reasoning_effort)
        ) {
          st.rejected++;
          continue;
        }
        const declaredVersions = entry.declared_versions ?? [];
        if (declaredVersions.some((v) => v !== EXPECTED_TBENCH_VERSION)) {
          st.rejected++;
          continue;
        }

        const modelName = cleanStr(entry.model_display?.label);
        const agentName = cleanStr(entry.agent_display?.label);
        const accuracy = parseNumeric(entry.metrics?.accuracy);
        // Allow 0 repeat-trial CI width (valid at 0% or 100% accuracy) since scoring uses the 66-task Popoviciu bound
        const ciHalf = parseNonNegative(entry.metrics?.accuracy_ci95_half_width);
        const nTrials = parseStrictPositiveInt(entry.metrics?.n_trials);
        const totalCost = parsePositive(entry.metrics?.total_cost_usd);

        if (!modelName || !agentName || accuracy === null || accuracy < 0 || accuracy > 100) {
          st.rejected++;
          continue;
        }
        if (
          ciHalf === null ||
          nTrials === null ||
          nTrials < MIN_TBENCH_4_1_TRIALS ||
          totalCost === null
        ) {
          st.rejected++;
          continue;
        }

        // Exact per-trial cost and per-trial token counts divided by documented trial count
        const perTrialCost = Number((totalCost / nTrials).toFixed(6));
        const rawInTokens = parsePositive(entry.metrics?.uncached_input_tokens);
        const rawOutTokens = parsePositive(entry.metrics?.output_tokens);
        const isMiniSwe = /mini[\s_-]?swe/i.test(agentName);
        if (isMiniSwe) {
          st.excluded++;
          continue;
        }

        const effort = cleanStr(entry.reasoning_effort);
        const provider = cleanStr(entry.model_org?.label);
        if (!effort) {
          st.rejected++;
          continue;
        }
        const baseId = `tbench:4.1:${modelName}:${effort}:${agentName}`;
        const metricKey = `${baseId}@${accuracy.toFixed(2)}:${(totalCost / nTrials).toFixed(6)}:${nTrials}:${provider ?? ""}`;
        if (tokenSigByMetricKey.get(metricKey) === "conflict") {
          st.rejected++;
          continue;
        }
        const perTrialIn = rawInTokens !== null ? Math.round(rawInTokens / nTrials) : null;
        const perTrialOut = rawOutTokens !== null ? Math.round(rawOutTokens / nTrials) : null;
        // Order-independent content-derived suffix only when duplicate base keys exist so upstream reordering never changes snapshotHash
        const sourceRowId =
          (baseRowCount.get(baseId) ?? 0) > 1
            ? `${baseId}@${accuracy.toFixed(2)}:${perTrialCost.toFixed(6)}:${nTrials}:${provider ?? ""}:${perTrialIn ?? "na"}:${perTrialOut ?? "na"}`
            : baseId;

        observations.push({
          sourceId: "tbench",
          sourceRowId,
          benchmarkId: "tbench_4_1",
          benchmarkVersion: EXPECTED_TBENCH_VERSION,
          domainId: "harnesses",
          rawModelName: modelName,
          rawProvider: provider,
          rawEffort: effort,
          rawHarness: agentName,
          observedHarness: agentName,
          harnessRegime: "native",
          rawScore: Number(accuracy.toFixed(2)),
          // Upstream accuracy_ci95_half_width reflects 5-repeat trial variance, narrower than 66-task population SE; defer to Popoviciu bound
          seRaw: null,
          ciHalfWidth: null,
          ciLower: null,
          ciUpper: null,
          battleCount: nTrials,
          measuredCostUsd: perTrialCost,
          suiteCostUsd: null,
          measuredInputTokens: perTrialIn,
          measuredOutputTokens: perTrialOut,
          // TBench display_date is model release date, not evaluation timestamp
          evalDate: null,
          publishedDate: null,
          sourceUrl: TBENCH_URL,
        });
      } catch {
        st.rejected++;
      }
    }

    return { observations, pricing: [], partitionStats: { tbench_4_1: st } };
  },
};
