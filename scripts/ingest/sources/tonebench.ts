import { createHash } from "node:crypto";
import type { RawObservation } from "../../../src/lib/schema.ts";
import {
  fetchJson,
  observationsMatchExact,
  parseIsoDate,
  parseNumeric,
  parsePositive,
  parseStrictPositiveInt,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

const TONEBENCH_API_URL = "https://benchmark.towardsai.com/data/leaderboard.json";
const TONEBENCH_PAGE_URL = "https://benchmark.towardsai.com";
const EXPECTED_TASK_COUNT = 10;
const EXPECTED_RANKING_STATUS = "current_10_task_rank";
const EXPECTED_SCORE_SCOPE = "10_task_current";
const EXPECTED_JUDGES = ["glm53f", "gpt61", "jev", "published"] as const;
const MIN_BOARD_MODELS = 10;
const MAX_MEAN_DRIFT_PP = 0.15;

const MODEL_ID_PREFIX_TO_LAB: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  openai: "openai",
  "x-ai": "spacexai",
  xai: "spacexai",
  google: "google",
  meta: "meta",
  "meta-llama": "meta",
  deepseek: "deepseek",
  moonshotai: "moonshot",
  moonshot: "moonshot",
  qwen: "alibaba",
  alibaba: "alibaba",
  "z-ai": "zhipu",
  zhipu: "zhipu",
};

const SINGLE_LAB_ROUTES: Readonly<Record<string, string>> = {
  "claude-code": "anthropic",
  anthropic: "anthropic",
  codex: "openai",
  openai: "openai",
  google: "google",
  xai: "spacexai",
  cohere: "cohere",
};

const MULTI_VENDOR_ROUTERS = new Set(["openrouter", "together", "tinker"]);

interface ToneBenchProvenance {
  judge_rev?: unknown;
  generation_rev?: unknown;
  rubric_sha?: unknown;
  rubric_anchors_sha?: unknown;
  weights_sha?: unknown;
  contract_sha?: unknown;
  skills_sha?: unknown;
}

interface ToneBenchRouteOverride {
  model_id?: unknown;
  provider?: unknown;
}

interface ToneBenchModelProvenance {
  model_id?: unknown;
  provider?: unknown;
  reasoning_effort?: unknown;
  thinking?: unknown;
  last_run?: unknown;
  route_overrides?: unknown;
}

interface ToneBenchPanel {
  judges_used?: unknown;
  per_judge_overall?: Record<string, unknown>;
}

interface ToneBenchTaskCell {
  overall?: unknown;
}

interface ToneBenchModelRow {
  slug?: unknown;
  display?: unknown;
  overall?: unknown;
  rank?: unknown;
  current_complete?: unknown;
  ranking_status?: unknown;
  score_scope?: unknown;
  cost_usd?: unknown;
  cost_est?: unknown;
  avg_input_tokens?: unknown;
  avg_output_tokens?: unknown;
  provenance?: ToneBenchModelProvenance;
  panel?: ToneBenchPanel;
  tasks?: Record<string, ToneBenchTaskCell>;
}

interface ToneBenchPayload {
  generated_at?: unknown;
  provenance?: ToneBenchProvenance;
  tasks?: unknown;
  models?: unknown;
}

interface ValidatedToneBenchCandidate {
  obs: RawObservation;
  taskScores: readonly number[];
  judgeScores: readonly number[];
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseToneBenchTimestamp(raw: unknown, nowIso: string): string | null {
  const trimmed = readNonEmptyString(raw);
  if (!trimmed) return null;
  const utcStamp = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*UTC$/i);
  if (utcStamp?.[1] && utcStamp[2] && utcStamp[3]) {
    const sec = utcStamp[4] ?? "00";
    return parseIsoDate(`${utcStamp[1]}T${utcStamp[2]}:${utcStamp[3]}:${sec}Z`, nowIso);
  }
  return parseIsoDate(trimmed, nowIso);
}

// Map unambiguous ToneBench effort strings; preserve ambiguous tokens verbatim so canonicalizer quarantines them
function normalizeToneBenchEffort(raw: string | null): string | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!lower) return null;
  if (
    lower === "none" ||
    lower === "no thinking" ||
    lower === "no reasoning" ||
    lower === "non-thinking" ||
    lower === "non thinking" ||
    lower === "non-reasoning" ||
    lower === "non reasoning" ||
    lower === "without thinking" ||
    lower === "without reasoning" ||
    lower === "nonthinking"
  ) {
    return "none";
  }
  if (
    lower === "minimal" ||
    lower === "minimal thinking" ||
    lower === "minimal reasoning" ||
    lower === "minimal effort"
  ) {
    return "minimal";
  }
  if (
    lower === "low" ||
    lower === "low thinking" ||
    lower === "low reasoning" ||
    lower === "low effort"
  ) {
    return "low";
  }
  if (
    lower === "medium" ||
    lower === "medium thinking" ||
    lower === "medium reasoning" ||
    lower === "medium effort"
  ) {
    return "medium";
  }
  if (
    lower === "high" ||
    lower === "high thinking" ||
    lower === "high reasoning" ||
    lower === "high effort"
  ) {
    return "high";
  }
  if (
    lower === "xhigh" ||
    lower === "x-high" ||
    lower === "x high" ||
    lower === "extra high" ||
    lower === "xhigh thinking" ||
    lower === "xhigh reasoning" ||
    lower === "xhigh effort" ||
    lower === "x-high thinking" ||
    lower === "x-high reasoning" ||
    lower === "x-high effort" ||
    lower === "x high thinking" ||
    lower === "x high reasoning" ||
    lower === "x high effort" ||
    lower === "extra high thinking" ||
    lower === "extra high reasoning" ||
    lower === "extra high effort"
  ) {
    return "xhigh";
  }
  if (
    lower === "max" ||
    lower === "max thinking" ||
    lower === "max reasoning" ||
    lower === "max effort"
  ) {
    return "max";
  }
  return lower;
}

const PRESERVED_MODEL_PAREN_RE = /^(?:\d{2}-\d{4}|\d{4}-\d{2}-\d{2}|\d{4}|\d+k|preview)$/i;

function parseDisplayQualifier(display: string): {
  cleanName: string;
  displayEffort: string | null;
  fallbackRouting: boolean;
  crossModelFallback: boolean;
  conflict: boolean;
} {
  let cleanName = display.trim();
  let displayEffort: string | null = null;
  let fallbackRouting = false;
  let crossModelFallback = false;
  let conflict = false;

  while (true) {
    const m = cleanName.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    if (!m?.[1] || !m[2]) break;
    const inner = m[2].trim();
    if (PRESERVED_MODEL_PAREN_RE.test(inner)) break;

    cleanName = m[1].trim();
    const parts = inner
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === 0) {
      conflict = true;
      break;
    }

    for (const part of parts) {
      if (/^(?:default\s+fallback|with\s+fallback)$/i.test(part)) {
        fallbackRouting = true;
      } else if (/^(?:no|without)\s+fallback$/i.test(part)) {
        // Explicit non-fallback qualifier does not set fallbackRouting
      } else if (/\bfallback\b/i.test(part)) {
        crossModelFallback = true;
      } else {
        const norm = normalizeToneBenchEffort(part);
        if (norm) {
          if (displayEffort !== null && displayEffort !== norm) {
            conflict = true;
          } else {
            displayEffort = norm;
          }
        }
      }
    }
  }

  return { cleanName, displayEffort, fallbackRouting, crossModelFallback, conflict };
}

function stripRouterPrefix(modelId: string): string {
  const trimmed = modelId.trim();
  const slashIdx = trimmed.indexOf("/");
  return (slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed).trim().toLowerCase();
}

function inferProviderFromProvenance(
  modelId: string,
  routeProvider: string | null,
): { ok: true; provider: string | null } | { ok: false } {
  const slashIdx = modelId.indexOf("/");
  const prefixLab =
    slashIdx > 0
      ? (() => {
          const pfx = modelId.slice(0, slashIdx).trim().toLowerCase();
          return MODEL_ID_PREFIX_TO_LAB[pfx] ?? pfx;
        })()
      : null;

  const routeLower = routeProvider?.toLowerCase() ?? null;
  const routeLab =
    routeLower && !MULTI_VENDOR_ROUTERS.has(routeLower)
      ? (SINGLE_LAB_ROUTES[routeLower] ?? routeLower)
      : null;

  if (prefixLab && routeLab && prefixLab !== routeLab) {
    return { ok: false };
  }
  return { ok: true, provider: prefixLab ?? routeLab };
}

function arraysMatchExact(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const tonebenchAdapter: SourceAdapter = {
  id: "tonebench",
  label: "ToneBench Script Writing",
  license: "Public Research Leaderboard / Attribution Required",
  sourceUrl: TONEBENCH_PAGE_URL,
  expectedBenchmarks: ["tonebench_writing"],
  expectsPricing: false,
  async fetchLive(nowIso) {
    const payload = await fetchJson<ToneBenchPayload>(TONEBENCH_API_URL, { timeoutMs: 25_000 });
    if (!payload || typeof payload !== "object") {
      throw new Error("ToneBench JSON payload is not an object");
    }

    const rawTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    const taskIds = [
      ...new Set(
        rawTasks
          .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
          .map((t) => t.trim()),
      ),
    ];
    if (taskIds.length !== EXPECTED_TASK_COUNT || taskIds.length !== rawTasks.length) {
      throw new Error(
        `ToneBench tasks invalid: expected ${EXPECTED_TASK_COUNT} unique tasks, got ${rawTasks.length}`,
      );
    }

    const provTop = payload.provenance;
    const judgeRev = readNonEmptyString(provTop?.judge_rev);
    const generationRev = readNonEmptyString(provTop?.generation_rev);
    const rubricSha = readNonEmptyString(provTop?.rubric_sha);
    const rubricAnchorsSha = readNonEmptyString(provTop?.rubric_anchors_sha);
    const weightsSha = readNonEmptyString(provTop?.weights_sha);
    const contractSha = readNonEmptyString(provTop?.contract_sha);
    const skillsSha = readNonEmptyString(provTop?.skills_sha);
    if (
      !judgeRev ||
      !generationRev ||
      !rubricSha ||
      !rubricAnchorsSha ||
      !weightsSha ||
      !contractSha ||
      !skillsSha
    ) {
      throw new Error(
        "ToneBench JSON missing required provenance comparability fingerprint fields",
      );
    }

    // Lock comparability fingerprint (judge x generation x rubric x anchors x weights x contract x skills x tasks x judges)
    const sortedTaskIds = taskIds.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const fingerprintHash = createHash("sha256")
      .update(
        [
          judgeRev,
          generationRev,
          rubricSha,
          rubricAnchorsSha,
          weightsSha,
          contractSha,
          skillsSha,
          sortedTaskIds.join(","),
          EXPECTED_JUDGES.join(","),
        ].join("|"),
      )
      .digest("hex")
      .slice(0, 12);
    const benchmarkVersion = `${judgeRev}@${fingerprintHash}`;

    const publishedDate = parseToneBenchTimestamp(payload.generated_at, nowIso);
    if (!publishedDate) {
      throw new Error(`ToneBench JSON has invalid generated_at '${String(payload.generated_at)}'`);
    }

    if (!Array.isArray(payload.models) || payload.models.length === 0) {
      throw new Error("ToneBench JSON missing models array");
    }

    const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
    const candidatesByRowId = new Map<string, ValidatedToneBenchCandidate[]>();
    const disqualifiedIds = new Set<string>();

    const rejectRow = (rowId: string | null) => {
      st.rejected++;
      if (rowId) disqualifiedIds.add(rowId);
    };

    const excludeRow = (rowId: string | null) => {
      st.excluded++;
      if (rowId) disqualifiedIds.add(rowId);
    };

    for (const rawRow of payload.models as ToneBenchModelRow[]) {
      st.attempted++;
      if (!rawRow || typeof rawRow !== "object") {
        rejectRow(null);
        continue;
      }

      const slug = readNonEmptyString(rawRow.slug);
      const rowId = slug ? `tonebench:${slug}` : null;

      if (typeof rawRow.current_complete !== "boolean") {
        rejectRow(rowId);
        continue;
      }
      if (!rawRow.current_complete) {
        excludeRow(rowId);
        continue;
      }

      const display = readNonEmptyString(rawRow.display);
      const rank = parseStrictPositiveInt(rawRow.rank);
      const overall = parseNumeric(rawRow.overall);
      if (
        !slug ||
        !rowId ||
        !display ||
        rank === null ||
        overall === null ||
        overall < 0 ||
        overall > 100 ||
        rawRow.ranking_status !== EXPECTED_RANKING_STATUS ||
        rawRow.score_scope !== EXPECTED_SCORE_SCOPE
      ) {
        rejectRow(rowId);
        continue;
      }

      const taskMap = rawRow.tasks;
      if (!taskMap || typeof taskMap !== "object") {
        rejectRow(rowId);
        continue;
      }
      const taskScores: number[] = [];
      let tasksValid = true;
      for (const taskId of sortedTaskIds) {
        const score = parseNumeric(taskMap[taskId]?.overall);
        if (score === null || score < 0 || score > 100) {
          tasksValid = false;
          break;
        }
        taskScores.push(score);
      }
      if (!tasksValid || taskScores.length !== EXPECTED_TASK_COUNT) {
        rejectRow(rowId);
        continue;
      }
      const taskMean = taskScores.reduce((acc, v) => acc + v, 0) / taskScores.length;
      if (Math.abs(overall - taskMean) > MAX_MEAN_DRIFT_PP) {
        rejectRow(rowId);
        continue;
      }

      const panel = rawRow.panel;
      const judgesUsed = Array.isArray(panel?.judges_used)
        ? panel.judges_used
            .filter((j): j is string => typeof j === "string" && j.trim().length > 0)
            .map((j) => j.trim())
            .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        : [];
      const judgesMatch =
        judgesUsed.length === EXPECTED_JUDGES.length &&
        EXPECTED_JUDGES.every((j, idx) => judgesUsed[idx] === j);
      const perJudge = panel?.per_judge_overall;
      if (!judgesMatch || !perJudge || typeof perJudge !== "object") {
        rejectRow(rowId);
        continue;
      }
      const judgeScores: number[] = [];
      let judgesValid = true;
      for (const judgeId of EXPECTED_JUDGES) {
        const score = parseNumeric(perJudge[judgeId]);
        if (score === null || score < 0 || score > 100) {
          judgesValid = false;
          break;
        }
        judgeScores.push(score);
      }
      if (!judgesValid || judgeScores.length !== EXPECTED_JUDGES.length) {
        rejectRow(rowId);
        continue;
      }
      const judgeMean = judgeScores.reduce((acc, v) => acc + v, 0) / judgeScores.length;
      if (Math.abs(overall - judgeMean) > MAX_MEAN_DRIFT_PP) {
        rejectRow(rowId);
        continue;
      }

      const prov = rawRow.provenance;
      if (!prov || typeof prov !== "object") {
        rejectRow(rowId);
        continue;
      }
      const modelId = readNonEmptyString(prov.model_id);
      const routeProviderRaw = prov.provider;
      if (
        !modelId ||
        (routeProviderRaw !== undefined &&
          routeProviderRaw !== null &&
          typeof routeProviderRaw !== "string")
      ) {
        rejectRow(rowId);
        continue;
      }
      const routeProvider = readNonEmptyString(routeProviderRaw);
      const providerCheck = inferProviderFromProvenance(modelId, routeProvider);
      if (!providerCheck.ok) {
        rejectRow(rowId);
        continue;
      }

      if (prov.route_overrides !== undefined && prov.route_overrides !== null) {
        if (!Array.isArray(prov.route_overrides)) {
          rejectRow(rowId);
          continue;
        }
        const baseModel = stripRouterPrefix(modelId);
        let overrideInvalid = false;
        let crossModelRedirect = false;
        for (const ov of prov.route_overrides as ToneBenchRouteOverride[]) {
          const ovModelId = ov && typeof ov === "object" ? readNonEmptyString(ov.model_id) : null;
          if (!ovModelId) {
            overrideInvalid = true;
            break;
          }
          const ovProviderCheck = inferProviderFromProvenance(
            ovModelId,
            ov && typeof ov === "object" ? readNonEmptyString(ov.provider) : null,
          );
          if (!ovProviderCheck.ok) {
            overrideInvalid = true;
            break;
          }
          if (
            stripRouterPrefix(ovModelId) !== baseModel ||
            (providerCheck.provider &&
              ovProviderCheck.provider &&
              ovProviderCheck.provider !== providerCheck.provider)
          ) {
            crossModelRedirect = true;
            break;
          }
        }
        if (overrideInvalid) {
          rejectRow(rowId);
          continue;
        }
        if (crossModelRedirect) {
          excludeRow(rowId);
          continue;
        }
      }

      const rawReasoningEffort = prov.reasoning_effort;
      const rawThinking = prov.thinking;
      if (
        (rawReasoningEffort !== undefined &&
          rawReasoningEffort !== null &&
          typeof rawReasoningEffort !== "string") ||
        (rawThinking !== undefined && rawThinking !== null && typeof rawThinking !== "string")
      ) {
        rejectRow(rowId);
        continue;
      }
      const reEffort = normalizeToneBenchEffort(readNonEmptyString(rawReasoningEffort));
      const thEffort = normalizeToneBenchEffort(readNonEmptyString(rawThinking));
      if (reEffort !== null && thEffort !== null && reEffort !== thEffort) {
        rejectRow(rowId);
        continue;
      }
      const provEffort = reEffort ?? thEffort;

      const { cleanName, displayEffort, fallbackRouting, crossModelFallback, conflict } =
        parseDisplayQualifier(display);
      if (crossModelFallback) {
        excludeRow(rowId);
        continue;
      }
      if (!cleanName || conflict) {
        rejectRow(rowId);
        continue;
      }
      if (provEffort !== null && displayEffort !== null && provEffort !== displayEffort) {
        rejectRow(rowId);
        continue;
      }
      const resolvedEffort = provEffort ?? displayEffort;

      let evalDate: string | null = null;
      if (prov.last_run !== undefined && prov.last_run !== null) {
        const parsedEvalDate = parseToneBenchTimestamp(prov.last_run, nowIso);
        if (!parsedEvalDate) {
          rejectRow(rowId);
          continue;
        }
        evalDate = parsedEvalDate;
      }

      const costEstimated = rawRow.cost_est === true;
      const rawCostUsd = parsePositive(rawRow.cost_usd);
      const measuredCostUsd =
        !costEstimated && rawCostUsd !== null ? Number(rawCostUsd.toFixed(6)) : null;
      const measuredInputTokens = parsePositive(rawRow.avg_input_tokens);
      const measuredOutputTokens = parsePositive(rawRow.avg_output_tokens);

      const obs: RawObservation = {
        sourceId: "tonebench",
        sourceRowId: rowId,
        benchmarkId: "tonebench_writing",
        benchmarkVersion,
        domainId: "writing",
        rawModelName: cleanName,
        rawProvider: providerCheck.provider,
        rawEffort: resolvedEffort,
        rawHarness: null,
        observedHarness: "Direct API",
        harnessRegime: "native",
        rawScore: Number(overall.toFixed(2)),
        seRaw: null,
        ciHalfWidth: null,
        ciLower: null,
        ciUpper: null,
        battleCount: taskScores.length,
        measuredCostUsd,
        suiteCostUsd: null,
        measuredInputTokens: measuredInputTokens !== null ? Math.round(measuredInputTokens) : null,
        measuredOutputTokens:
          measuredOutputTokens !== null ? Math.round(measuredOutputTokens) : null,
        ...(fallbackRouting ? { fallbackRouting: true } : {}),
        evalDate,
        publishedDate,
        sourceUrl: TONEBENCH_PAGE_URL,
      };

      const grp = candidatesByRowId.get(rowId) ?? [];
      grp.push({ obs, taskScores, judgeScores });
      candidatesByRowId.set(rowId, grp);
    }

    const cleanCandidates: ValidatedToneBenchCandidate[] = [];
    for (const [rowId, grp] of candidatesByRowId.entries()) {
      const first = grp[0]!;
      const hasPeerConflict =
        disqualifiedIds.has(rowId) ||
        grp.some(
          (c) =>
            !observationsMatchExact(c.obs, first.obs) ||
            !arraysMatchExact(c.taskScores, first.taskScores) ||
            !arraysMatchExact(c.judgeScores, first.judgeScores),
        );
      if (hasPeerConflict) {
        st.rejected += grp.length;
        disqualifiedIds.add(rowId);
        continue;
      }
      cleanCandidates.push(first);
    }

    if (cleanCandidates.length < MIN_BOARD_MODELS) {
      throw new Error(
        `ToneBench produced insufficient valid rows for G-theory SE (${cleanCandidates.length} < ${MIN_BOARD_MODELS})`,
      );
    }

    // Two-facet Brennan (2001) crossed Model x Task (10) x Judge (4) G-theory relative SE with pooled MS floor
    const M = cleanCandidates.length;
    const T = EXPECTED_TASK_COUNT;
    const J = EXPECTED_JUDGES.length;
    const taskMeans = Array.from({ length: T }, () => 0);
    const judgeMeans = Array.from({ length: J }, () => 0);
    const rowTaskMeans = Array.from({ length: M }, () => 0);
    const rowJudgeMeans = Array.from({ length: M }, () => 0);

    let grandTaskMean = 0;
    let grandJudgeMean = 0;
    for (let i = 0; i < M; i++) {
      const cand = cleanCandidates[i]!;
      let tSum = 0;
      for (let t = 0; t < T; t++) {
        const val = cand.taskScores[t]!;
        tSum += val;
        taskMeans[t] = taskMeans[t]! + val;
      }
      rowTaskMeans[i] = tSum / T;
      grandTaskMean += rowTaskMeans[i]!;

      let jSum = 0;
      for (let j = 0; j < J; j++) {
        const val = cand.judgeScores[j]!;
        jSum += val;
        judgeMeans[j] = judgeMeans[j]! + val;
      }
      rowJudgeMeans[i] = jSum / J;
      grandJudgeMean += rowJudgeMeans[i]!;
    }
    grandTaskMean /= M;
    grandJudgeMean /= M;
    for (let t = 0; t < T; t++) taskMeans[t] = taskMeans[t]! / M;
    for (let j = 0; j < J; j++) judgeMeans[j] = judgeMeans[j]! / M;

    const rowTaskVar = Array.from({ length: M }, () => 0);
    const rowJudgeVar = Array.from({ length: M }, () => 0);
    let ssMT = 0;
    let ssMJ = 0;
    const finiteCorrection = M / (M - 1);

    for (let i = 0; i < M; i++) {
      const cand = cleanCandidates[i]!;
      let sT = 0;
      for (let t = 0; t < T; t++) {
        const resid = cand.taskScores[t]! - rowTaskMeans[i]! - (taskMeans[t]! - grandTaskMean);
        sT += resid * resid;
      }
      ssMT += sT;
      rowTaskVar[i] = (finiteCorrection * sT) / ((T - 1) * T);

      let sJ = 0;
      for (let j = 0; j < J; j++) {
        const resid = cand.judgeScores[j]! - rowJudgeMeans[i]! - (judgeMeans[j]! - grandJudgeMean);
        sJ += resid * resid;
      }
      ssMJ += sJ;
      rowJudgeVar[i] = (finiteCorrection * sJ) / ((J - 1) * J);
    }

    const pooledVT = ssMT / ((M - 1) * (T - 1) * T);
    const pooledVJ = ssMJ / ((M - 1) * (J - 1) * J);
    if (!Number.isFinite(pooledVT) || !Number.isFinite(pooledVJ) || pooledVT + pooledVJ <= 0) {
      throw new Error("ToneBench G-theory variance components degenerate");
    }

    const observations: RawObservation[] = cleanCandidates.map((cand, i) => ({
      ...cand.obs,
      seRaw: Number(
        Math.sqrt(Math.max(rowTaskVar[i]!, pooledVT) + Math.max(rowJudgeVar[i]!, pooledVJ)).toFixed(
          4,
        ),
      ),
    }));

    return {
      observations,
      pricing: [],
      partitionStats: { tonebench_writing: st },
      ...(disqualifiedIds.size > 0
        ? { disqualifiedSourceRowIdsByBenchmark: { tonebench_writing: [...disqualifiedIds] } }
        : {}),
    };
  },
};
