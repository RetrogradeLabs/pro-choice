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

const CWE_BENCH_JS_URL = "https://cwe-bench.com/assets/charts/data-v2.js?v=13";
const CWE_BENCH_PUBLIC_URL = "https://cwe-bench.com/";
const EXPECTED_CWE_PUBLIC_TASKS = 100;
const EXPECTED_CWE_PRIVATE_TASKS = 150;
const EXPECTED_CWE_TOTAL_TASKS = EXPECTED_CWE_PUBLIC_TASKS + EXPECTED_CWE_PRIVATE_TASKS;
const ROLLOUTS_PER_TASK = 4;

interface CweBenchCostPoint {
  model?: unknown;
  cost?: unknown;
  pass1?: unknown;
  ci95?: unknown;
  tasks?: unknown;
}

interface CweBenchV2Payload {
  nTasks?: unknown;
  nPrivate?: unknown;
  cost?: {
    points?: unknown;
  };
}

function slugToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function stripTags(html: string): string {
  return html
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface CweHtmlMeta {
  fullName: string;
  harness: string;
  conflicted: boolean;
  candidateFullNames: string[];
}

function parseCweBenchHtmlMetadata(html: string): Map<string, CweHtmlMeta> {
  const rowsByModel = new Map<string, { fullName: string; harness: string }[]>();
  const trMatches = html.matchAll(/<tr[^>]*data-model="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g);
  for (const m of trMatches) {
    const model = m[1]?.trim();
    const inner = m[2] ?? "";
    if (!model) continue;
    const tds = [...inner.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((td) =>
      stripTags(td[1] ?? ""),
    );
    const fullName = tds[1]?.trim() ?? "";
    const harness = tds[2]?.trim() ?? "";
    const list = rowsByModel.get(model) ?? [];
    list.push({ fullName, harness });
    rowsByModel.set(model, list);
  }
  const out = new Map<string, CweHtmlMeta>();
  for (const [model, list] of rowsByModel.entries()) {
    const first = list[0]!;
    const conflicted =
      !first.fullName ||
      !first.harness ||
      list.some(
        (r) =>
          !r.fullName || !r.harness || r.fullName !== first.fullName || r.harness !== first.harness,
      );
    out.set(model, {
      fullName: first.fullName,
      harness: first.harness || "Native Agent",
      conflicted,
      candidateFullNames: [...new Set([model, ...list.map((r) => r.fullName).filter(Boolean)])],
    });
  }
  return out;
}

function extractUniqueProtocolEffortKeyword(text: string): string | null {
  if (
    /\b(?:not|non|no|without)\s+(?:none|minimal|low|medium|high|xhigh|extra[\s-]+high|max)\s+reasoning\b/i.test(
      text,
    )
  ) {
    return null;
  }
  const found = new Set<string>();
  for (const m of text.matchAll(
    /\b(none|minimal|low|medium|high|xhigh|extra[\s-]+high|max)\s+reasoning\b/gi,
  )) {
    if (!m[1]) continue;
    const norm = m[1].toLowerCase().replace(/[\s-]+/g, "");
    found.add(norm === "extrahigh" ? "xhigh" : norm);
  }
  return found.size === 1 ? [...found][0]! : null;
}

// Extract reasoning effort strictly from an unambiguous, v2-only protocol statement (never matching v1 text)
function parseCweBenchV2ProtocolEffort(html: string): string {
  const ldMatches = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const m of ldMatches) {
    const raw = m[1]?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const queue: unknown[] = [parsed];
      while (queue.length > 0) {
        const cur = queue.shift();
        if (Array.isArray(cur)) {
          queue.push(...cur);
          continue;
        }
        if (!cur || typeof cur !== "object") continue;
        const obj = cur as Record<string, unknown>;
        const name = typeof obj.name === "string" ? obj.name : "";
        const desc = typeof obj.description === "string" ? obj.description : "";
        if (/cwe-bench\s+v2\s+leaderboard/i.test(name) && desc) {
          if (/\bv1\b/i.test(desc)) {
            const v2Only = desc
              .split(/(?<=[.!?])\s+/)
              .filter((s) => /\bv2\b/i.test(s) && !/\bv1\b/i.test(s))
              .join(" ");
            return extractUniqueProtocolEffortKeyword(v2Only) ?? "unknown";
          }
          return extractUniqueProtocolEffortKeyword(desc) ?? "unknown";
        }
        for (const v of Object.values(obj)) {
          if (v && typeof v === "object") queue.push(v);
        }
      }
    } catch {
      // Ignore unrelated malformed JSON-LD blocks
    }
  }
  const plain = stripTags(html);
  const v2Sentences = plain
    .split(/(?<=[.!?])\s+/)
    .filter((s) => /\bv2\b/i.test(s) && !/\bv1\b/i.test(s) && /\breasoning\b/i.test(s));
  const fallbackEfforts = new Set<string>();
  for (const s of v2Sentences) {
    const eff = extractUniqueProtocolEffortKeyword(s);
    if (eff) fallbackEfforts.add(eff);
  }
  return fallbackEfforts.size === 1 ? [...fallbackEfforts][0]! : "unknown";
}

function parseCweBenchPublishedDate(htmlText: string, nowIso: string): string | null {
  const attrMatch = htmlText.match(
    /<p[^>]*class=["'][^"']*lb-attribution[^"']*["'][^>]*>[\s\S]*?<time[^>]*datetime=["'](202\d-\d{2}-\d{2})["']/i,
  );
  const dateModMatch = htmlText.match(/"dateModified"\s*:\s*"(202\d-\d{2}-\d{2})"/i);
  return parseIsoDate(attrMatch?.[1] ?? dateModMatch?.[1] ?? null, nowIso);
}

export const cweBenchAdapter: SourceAdapter = {
  id: "cwe-bench",
  label: "Collinear CWE-bench v2 (250 Public + Held-Out)",
  license: "Apache-2.0",
  sourceUrl: CWE_BENCH_PUBLIC_URL,
  expectedBenchmarks: ["cwe_bench_v2"],
  expectsPricing: false,
  async fetchLive(nowIso) {
    const [jsText, htmlText] = await Promise.all([
      fetchText(CWE_BENCH_JS_URL, { timeoutMs: 20_000 }),
      fetchText(CWE_BENCH_PUBLIC_URL, { timeoutMs: 20_000 }),
    ]);

    const jsonMatch = jsText.match(/window\.CWEB_DATA_V2\s*=\s*(\{[\s\S]*\});?\s*$/);
    if (!jsonMatch?.[1]) {
      throw new Error("CWE-bench v2 JS payload missing window.CWEB_DATA_V2 object");
    }
    const parsed = JSON.parse(jsonMatch[1]) as CweBenchV2Payload;
    const publicTasks = parseStrictPositiveInt(parsed.nTasks) ?? 0;
    const privateTasks = parseStrictPositiveInt(parsed.nPrivate) ?? 0;
    const totalTasks = publicTasks + privateTasks;
    const points = parsed.cost?.points;

    const publishedDate = parseCweBenchPublishedDate(htmlText, nowIso);

    if (
      publicTasks !== EXPECTED_CWE_PUBLIC_TASKS ||
      privateTasks !== EXPECTED_CWE_PRIVATE_TASKS ||
      totalTasks !== EXPECTED_CWE_TOTAL_TASKS ||
      !Array.isArray(points) ||
      points.length === 0
    ) {
      throw new Error(
        `CWE-bench v2 payload cohort mismatch (expected ${EXPECTED_CWE_PUBLIC_TASKS} public + ${EXPECTED_CWE_PRIVATE_TASKS} held-out = ${EXPECTED_CWE_TOTAL_TASKS}, got ${publicTasks} + ${privateTasks})`,
      );
    }

    // Require an unambiguous v2 protocol effort before accepting a live refresh over healthy cache
    const protocolEffort = parseCweBenchV2ProtocolEffort(htmlText);
    if (protocolEffort === "unknown") {
      return {
        observations: [],
        pricing: [],
        partitionStats: {
          cwe_bench_v2: {
            attempted: points.length,
            rejected: points.length,
            excluded: 0,
            error: "CWE-bench v2 HTML missing unambiguous v2 reasoning effort statement",
          },
        },
      };
    }
    const metaByModel = parseCweBenchHtmlMetadata(htmlText);
    const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
    const candidatesByRowId = new Map<string, RawObservation[]>();
    const disqualifiedIds = new Set<string>();

    for (const pt of points as CweBenchCostPoint[]) {
      st.attempted++;
      if (!pt || typeof pt !== "object") {
        st.rejected++;
        continue;
      }
      const model = typeof pt.model === "string" ? pt.model.trim() : "";
      const pass1 = parseNumeric(pt.pass1);
      const ci95 = parsePositive(pt.ci95);
      const cost = parsePositive(pt.cost);
      const rowTasks = parseStrictPositiveInt(pt.tasks);
      const tableMeta = metaByModel.get(model);

      // Require a unique, non-conflicted HTML table row for revision-qualified model identity and harness
      if (!model || !tableMeta || tableMeta.conflicted) {
        st.rejected++;
        if (model) disqualifiedIds.add(`cwe-bench:v2:${slugToken(model)}`);
        for (const cand of tableMeta?.candidateFullNames ?? []) {
          disqualifiedIds.add(`cwe-bench:v2:${slugToken(cand)}`);
        }
        continue;
      }
      const resolvedModelName = tableMeta.fullName;
      const harness = tableMeta.harness;

      if (
        pass1 === null ||
        pass1 < 0 ||
        pass1 > 100 ||
        ci95 === null ||
        cost === null ||
        rowTasks === null ||
        rowTasks !== totalTasks
      ) {
        st.rejected++;
        disqualifiedIds.add(`cwe-bench:v2:${slugToken(model)}`);
        disqualifiedIds.add(`cwe-bench:v2:${slugToken(resolvedModelName)}`);
        continue;
      }

      const seRaw = ci95 / 1.96;
      // Key cache & disqualification rows stably on chart point identity so missing HTML metadata cannot evade eviction
      const sourceRowId = `cwe-bench:v2:${slugToken(model)}`;
      const obs: RawObservation = {
        sourceId: "cwe-bench",
        sourceRowId,
        benchmarkId: "cwe_bench_v2",
        benchmarkVersion: "2.0",
        domainId: "cyber",
        rawModelName: resolvedModelName,
        rawProvider: null,
        rawEffort: protocolEffort,
        // Fold documented native harness so CWE-bench v2 connects with Aikido Arena and CyberArena
        rawHarness: null,
        observedHarness: harness,
        harnessRegime: "native",
        rawScore: Number(pass1.toFixed(2)),
        seRaw: Number(seRaw.toFixed(6)),
        ciHalfWidth: Number(ci95.toFixed(4)),
        ciLower: null,
        ciUpper: null,
        battleCount: rowTasks * ROLLOUTS_PER_TASK,
        measuredCostUsd: Number(cost.toFixed(6)),
        suiteCostUsd: null,
        measuredInputTokens: null,
        measuredOutputTokens: null,
        evalDate: null,
        publishedDate,
        sourceUrl: CWE_BENCH_PUBLIC_URL,
      };
      const grp = candidatesByRowId.get(sourceRowId) ?? [];
      grp.push(obs);
      candidatesByRowId.set(sourceRowId, grp);
    }

    const observations: RawObservation[] = [];
    for (const grp of candidatesByRowId.values()) {
      const first = grp[0]!;
      const conflicts = grp.some((o) => !observationsMatchExact(o, first));
      if (conflicts) {
        st.rejected += grp.length;
        disqualifiedIds.add(first.sourceRowId);
        continue;
      }
      observations.push(first);
    }

    return {
      observations,
      pricing: [],
      partitionStats: { cwe_bench_v2: st },
      ...(disqualifiedIds.size > 0
        ? { disqualifiedSourceRowIdsByBenchmark: { cwe_bench_v2: [...disqualifiedIds] } }
        : {}),
    };
  },
};
