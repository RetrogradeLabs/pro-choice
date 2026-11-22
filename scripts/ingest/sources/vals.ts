import { BENCHMARK_BY_ID } from "../../../src/config/benchmarks.ts";
import {
  parseExplicitEffort,
  parseStrictEffortMetadata,
  resolveExplicitHarness,
  resolveModelSlugFromString,
} from "../../../src/lib/math/canonicalize.ts";
import type { DomainId, HarnessRegime, RawObservation } from "../../../src/lib/schema.ts";
import {
  fetchJson,
  fetchText,
  parseIsoDate,
  parseNumeric,
  parsePositive,
  parseStrictPositiveInt,
  unwrapAstroProps,
} from "../http.ts";
import type { PartitionStats, SourceAdapter } from "../types.ts";

interface ValsFeedSpec {
  slug: string;
  benchmarkId: string;
  refusalFallbackKey: string;
  version: string;
  domainId: DomainId;
  harnessRegime: HarnessRegime;
  defaultObservedHarness: string;
}

const VALS_FEEDS: readonly ValsFeedSpec[] = [
  {
    slug: "code-migration-v1-1",
    benchmarkId: "vals_code_migration",
    refusalFallbackKey: "code_migration_v1_1",
    version: "1.1",
    domainId: "coding",
    harnessRegime: "standardized",
    defaultObservedHarness: "Pi",
  },
  {
    slug: "legal_research",
    benchmarkId: "vals_legal_research",
    refusalFallbackKey: "legal_research",
    version: "1",
    domainId: "research",
    harnessRegime: "native",
    defaultObservedHarness: "Direct API",
  },
  {
    slug: "fabv2-1",
    benchmarkId: "vals_finance_agent",
    refusalFallbackKey: "finance_agent_v2_1",
    version: "2.1",
    domainId: "research",
    harnessRegime: "native",
    defaultObservedHarness: "Vals Finance Agent",
  },
  {
    slug: "emb-v1-1",
    benchmarkId: "vals_emb",
    refusalFallbackKey: "emb_v1_1",
    version: "1.1",
    domainId: "research",
    harnessRegime: "native",
    defaultObservedHarness: "Direct API",
  },
  {
    slug: "tax_agent_bench",
    benchmarkId: "vals_tax_agent",
    refusalFallbackKey: "tax_agent_bench",
    version: "1",
    domainId: "research",
    harnessRegime: "native",
    defaultObservedHarness: "Vals Tax Agent",
  },
  {
    slug: "mysterymechanism",
    benchmarkId: "vals_mystery_mechanism",
    refusalFallbackKey: "mysterymechanism",
    version: "1",
    domainId: "research",
    harnessRegime: "native",
    defaultObservedHarness: "Direct API",
  },
  {
    slug: "medcode",
    benchmarkId: "vals_medcode",
    refusalFallbackKey: "medcode",
    version: "1",
    domainId: "research",
    harnessRegime: "native",
    defaultObservedHarness: "Direct API",
  },
  {
    slug: "a2j",
    benchmarkId: "vals_a2j",
    refusalFallbackKey: "a2j",
    version: "1",
    domainId: "research",
    harnessRegime: "native",
    defaultObservedHarness: "Direct API",
  },
];

interface ValsRowMetrics {
  accuracy?: number;
  stderr?: number;
  cost_per_test?: number;
  token_tasks_measured?: number;
  harness?: string | null;
  fallbacks?: number | null;
  fallback_count?: number | null;
  fallbackCount?: number | null;
  has_fallback?: boolean | null;
  hasFallback?: boolean | null;
  score_delta_pct_points?: number | null;
  scoreDeltaPctPoints?: number | null;
  responding_models?: unknown;
  respondingModels?: unknown;
}

interface ValsRefusalFallbackRecord {
  status?: string;
  fallbacks?: number | null;
  scoreDeltaPctPoints?: number | null;
  respondingModels?: unknown;
  refusals?: number | null;
  totalTasks?: number | null;
  refusalRatePct?: number | null;
}

function extractValsRefusalRate(fbRecord: ValsRefusalFallbackRecord | undefined): number | null {
  if (!fbRecord) return null;
  const refusals = parseNumeric(fbRecord.refusals);
  const totalTasks = parsePositive(fbRecord.totalTasks);
  if (refusals !== null && refusals >= 0 && totalTasks !== null && refusals <= totalTasks) {
    return refusals > 0 ? Number((refusals / totalTasks).toFixed(6)) : null;
  }
  const pct = parseNumeric(fbRecord.refusalRatePct);
  if (pct !== null && pct >= 0 && pct <= 100) {
    return pct > 0 ? Number((pct / 100).toFixed(6)) : null;
  }
  return null;
}

type ValsRefusalFallbackModelsMap = Record<
  string,
  { benchmarks?: Record<string, ValsRefusalFallbackRecord> }
>;

function respondingListHasForeignModel(raw: unknown, allowedKeys: ReadonlySet<string>): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some(
    (item) => typeof item === "string" && !allowedKeys.has(item.trim().toLowerCase()),
  );
}

function ledgerRecordHasFallbackEvidence(
  fbRecord: ValsRefusalFallbackRecord | undefined,
  allowedKeys: ReadonlySet<string>,
): boolean {
  if (!fbRecord) return false;
  // Inspect fallback counts, score delta, and foreign responding models unconditionally regardless of status string
  const fbCount = parseNumeric(fbRecord.fallbacks);
  if (fbCount !== null && fbCount > 0) return true;
  const fbDelta = parseNumeric(fbRecord.scoreDeltaPctPoints);
  if (fbDelta !== null && Math.abs(fbDelta) > 1e-6) return true;
  return respondingListHasForeignModel(fbRecord.respondingModels, allowedKeys);
}

function hasFallbackIndicators(
  modelKey: string,
  canonicalSkuKey: string,
  metrics: ValsRowMetrics,
  fbRecord: ValsRefusalFallbackRecord | undefined,
): boolean {
  for (const rawCount of [metrics.fallbacks, metrics.fallback_count, metrics.fallbackCount]) {
    const n = parseNumeric(rawCount);
    if (n !== null && n > 0) return true;
  }
  if (metrics.has_fallback === true || metrics.hasFallback === true) return true;
  for (const rawDelta of [metrics.score_delta_pct_points, metrics.scoreDeltaPctPoints]) {
    const d = parseNumeric(rawDelta);
    if (d !== null && Math.abs(d) > 1e-6) return true;
  }

  const allowedKeys = new Set([modelKey.toLowerCase(), canonicalSkuKey.toLowerCase()]);
  if (
    respondingListHasForeignModel(metrics.responding_models, allowedKeys) ||
    respondingListHasForeignModel(metrics.respondingModels, allowedKeys)
  ) {
    return true;
  }

  return ledgerRecordHasFallbackEvidence(fbRecord, allowedKeys);
}

function extractRefusalFallbackModulePath(loaderJs: string, fbKey: string): string | null {
  const escaped = fbKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Bound match to this single object property (no comma or closing brace before import) so it cannot bleed across entries
  const rx = new RegExp(
    `"/src/data/${escaped}/refusal_fallback\\.json"\\s*:\\s*\\(\\)\\s*=>[^,}\\n]*import\\(\\s*["'\`]\\./([^"'\`]+)["'\`]`,
  );
  return loaderJs.match(rx)?.[1] ?? null;
}

// Extract balanced JS object literal and normalize unquoted keys + backtick strings to strict JSON without eval
function parseInlineJsObjectLiteral(src: string, openBraceIdx: number): unknown {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let endIdx = -1;
  for (let i = openBraceIdx; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) return null;

  const raw = src.slice(openBraceIdx, endIdx + 1);
  let jsonOut = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < raw.length && (raw[j] !== '"' || raw[j - 1] === "\\")) j++;
      jsonOut += raw.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "`" || ch === "'") {
      const q = ch;
      let j = i + 1;
      let inner = "";
      while (j < raw.length) {
        const c = raw[j]!;
        if (c === "\\" && j + 1 < raw.length) {
          const next = raw[j + 1]!;
          if (next === q || next === "$") {
            inner += next;
          } else {
            inner += `\\${next}`;
          }
          j += 2;
          continue;
        }
        if (c === q) break;
        inner += c;
        j++;
      }
      jsonOut += JSON.stringify(inner);
      i = j + 1;
      continue;
    }
    if (ch === "!" && (raw[i + 1] === "0" || raw[i + 1] === "1")) {
      jsonOut += raw[i + 1] === "0" ? "true" : "false";
      i += 2;
      continue;
    }
    if (ch === "." && i + 1 < raw.length && /[0-9]/.test(raw[i + 1]!)) {
      const prev = jsonOut.trimEnd().at(-1) ?? "";
      if (!/[0-9]/.test(prev)) {
        jsonOut += "0.";
        i++;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < raw.length && /[A-Za-z0-9_$]/.test(raw[j]!)) j++;
      const ident = raw.slice(i, j);
      let k = j;
      while (k < raw.length && /\s/.test(raw[k]!)) k++;
      if (raw[k] === ":") {
        jsonOut += JSON.stringify(ident);
      } else if (ident === "void" && raw[k] === "0") {
        jsonOut += "null";
        i = k + 1;
        continue;
      } else if (ident === "undefined") {
        jsonOut += "null";
      } else {
        jsonOut += ident;
      }
      i = j;
      continue;
    }
    jsonOut += ch;
    i++;
  }
  return JSON.parse(jsonOut) as unknown;
}

function parseRefusalFallbackModelsJs(
  js: string,
  expectedFbKey: string,
): ValsRefusalFallbackModelsMap {
  let parsed: unknown = null;
  const jsonParseMatch = js.match(/models\s*:\s*JSON\.parse\(`([\s\S]*?)`\)/);
  if (jsonParseMatch?.[1]) {
    const unescaped = jsonParseMatch[1]
      .replace(/\\`/g, "`")
      .replace(/\\\$/g, "$")
      .replace(/\\\\/g, "\\");
    parsed = JSON.parse(unescaped) as unknown;
  } else {
    const litMatch = js.match(/models\s*:\s*\{/);
    if (litMatch && litMatch.index !== undefined) {
      const braceIdx = js.indexOf("{", litMatch.index);
      parsed = parseInlineJsObjectLiteral(js, braceIdx);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Vals refusal_fallback module missing models payload");
  }
  const map = parsed as ValsRefusalFallbackModelsMap;
  const hasExpectedBenchmarkKey = Object.values(map).some(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      entry.benchmarks &&
      typeof entry.benchmarks === "object" &&
      Object.hasOwn(entry.benchmarks, expectedFbKey),
  );
  if (!hasExpectedBenchmarkKey) {
    throw new Error(
      `Vals refusal_fallback payload missing nested benchmarks['${expectedFbKey}'] entries`,
    );
  }
  return map;
}

interface ValsBenchmarkView {
  metadata?: { updated?: string; version?: string };
  tasks?: Record<string, Record<string, ValsRowMetrics>>;
}

interface ValsHtmlRowMeta {
  baseKey: string;
  displayName: string;
  harness: string | null;
  score: number | null;
}

function decodeHtmlAttr(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(html: string): string {
  return decodeHtmlAttr(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function slugifyToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseValsHtmlTableRows(html: string): ValsHtmlRowMeta[] {
  const trMatches = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
  if (trMatches.length === 0) return [];

  const headerCells = [...(trMatches[0]?.[1] ?? "").matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(
    (m) => stripTags(m[1] ?? "").toLowerCase(),
  );
  const hasHarnessCol = headerCells.includes("harness");

  const rows: ValsHtmlRowMeta[] = [];
  for (let i = 1; i < trMatches.length; i++) {
    const tr = trMatches[i]?.[1] ?? "";
    const linkMatch = tr.match(/<a[^>]*href="\/models\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch?.[1] || !linkMatch[2]) continue;

    const hrefSlug = linkMatch[1].trim();
    const sepIdx = hrefSlug.indexOf("_");
    const baseKey =
      sepIdx > 0 ? `${hrefSlug.slice(0, sepIdx)}/${hrefSlug.slice(sepIdx + 1)}` : hrefSlug;
    const displayName = stripTags(linkMatch[2]);

    const afterThIdx = tr.indexOf("</th>");
    const trailingCells =
      afterThIdx !== -1
        ? [...tr.slice(afterThIdx).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
            stripTags(m[1] ?? ""),
          )
        : [];

    const harness = hasHarnessCol ? trailingCells[0] || null : null;
    const scoreCell = hasHarnessCol ? trailingCells[1] : trailingCells[0];
    const score = parseNumeric(scoreCell);

    rows.push({ baseKey, displayName, harness, score });
  }
  return rows;
}

type ValsHtmlMatchResult =
  | { kind: "matched"; row: ValsHtmlRowMeta }
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "conflict" };

function canonicalValsHarness(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Normalize hyphen/underscore/space separators so "-open-hands" == "OpenHands" and "-direct-api" == "Direct"
  const spaced = trimmed.replace(/[-_\s]+/g, " ");
  if (/^direct(?:\s+api)?$/i.test(spaced)) return "direct";
  const resolved = resolveExplicitHarness(spaced, "native");
  if (resolved.ok) return resolved.harness;
  const directResolved = resolveExplicitHarness(trimmed, "native");
  if (directResolved.ok) return directResolved.harness;
  return slugifyToken(trimmed) || null;
}

function matchValsHtmlMeta(
  modelKey: string,
  accuracy: number,
  metricsHarness: string | null,
  htmlRows: readonly ValsHtmlRowMeta[],
  claimedBaseKeys: ReadonlySet<string>,
): ValsHtmlMatchResult {
  const normHarness = canonicalValsHarness(metricsHarness);
  const slash = modelKey.indexOf("/");
  const keyProvider = slash > 0 ? modelKey.slice(0, slash).trim() : null;
  const recognizedKeyModel = resolveModelSlugFromString(modelKey, keyProvider);

  let candidates = htmlRows.filter((row) => {
    if (row.baseKey === modelKey) return true;
    if (row.harness && modelKey.startsWith(`${row.baseKey}-`)) {
      const keySuffix = modelKey.slice(row.baseKey.length + 1);
      const rowCanon = canonicalValsHarness(row.harness);
      const suffixCanon = canonicalValsHarness(keySuffix);
      if (rowCanon !== null && suffixCanon === rowCanon) return true;
      const slugSuffix = slugifyToken(row.harness);
      if (slugSuffix && keySuffix === slugSuffix) return true;
    }
    return false;
  });

  // Enforce canonical harness compatibility even for a single candidate so contradicting HTML rows never overwrite structured metadata
  if (candidates.length > 0 && normHarness !== null) {
    const compatible = candidates.filter((row) => {
      const rowCanon = canonicalValsHarness(row.harness);
      return rowCanon === null || rowCanon === normHarness;
    });
    if (compatible.length === 0) return { kind: "conflict" };
    const exactHarness = compatible.filter(
      (row) => canonicalValsHarness(row.harness) === normHarness,
    );
    candidates = exactHarness.length > 0 ? exactHarness : compatible;
  }

  if (candidates.length === 1) {
    const only = candidates[0]!;
    if (only.score === null || Math.abs(only.score - accuracy) <= 0.1) {
      return { kind: "matched", row: only };
    }
    return { kind: "none" };
  }

  if (candidates.length > 1) {
    const scored = candidates
      .filter((cand) => cand.score !== null && Math.abs(cand.score - accuracy) <= 0.1)
      .map((cand) => ({ cand, diff: Math.abs(cand.score! - accuracy) }));
    if (scored.length === 0) return { kind: "none" };
    let minDiff = Number.POSITIVE_INFINITY;
    for (const s of scored) {
      if (s.diff < minDiff) minDiff = s.diff;
    }
    const tiedBest = scored.filter((s) => Math.abs(s.diff - minDiff) <= 1e-6);
    if (tiedBest.length === 1) return { kind: "matched", row: tiedBest[0]!.cand };
    return { kind: "ambiguous" };
  }

  // Never cross-assign a recognized canonical model key onto another model's HTML row via score proximity
  if (recognizedKeyModel !== null || slash <= 0) return { kind: "none" };

  // Fallback strictly for unrecognized internal Vals keys matching a date-stamped revision of the exact same stem (e.g. qwen3.8-max-internal -> qwen3.8-max-0902)
  const providerPrefix = modelKey.slice(0, slash + 1);
  const internalStem = modelKey.replace(/-(?:internal|preview|test|staging|rc\d+)$/i, "");
  if (internalStem === modelKey) return { kind: "none" };

  const scoreMatches = htmlRows.filter((row) => {
    const rowCanon = canonicalValsHarness(row.harness);
    const trailingRevision = row.baseKey.startsWith(`${internalStem}-`)
      ? row.baseKey.slice(internalStem.length + 1)
      : null;
    // Require an explicit date-stamped revision suffix so internal keys never credit undated public SKUs
    const isDateRevision =
      trailingRevision !== null &&
      /^(?:202\d-\d{2}-\d{2}|202\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/.test(
        trailingRevision,
      );
    return (
      row.baseKey.startsWith(providerPrefix) &&
      isDateRevision &&
      !claimedBaseKeys.has(row.baseKey) &&
      row.score !== null &&
      Math.abs(row.score - accuracy) <= 0.05 &&
      (normHarness === null || rowCanon === null || rowCanon === normHarness)
    );
  });
  if (scoreMatches.length === 1) return { kind: "matched", row: scoreMatches[0]! };
  return scoreMatches.length > 1 ? { kind: "ambiguous" } : { kind: "none" };
}

interface ValsIslandEffortRecord {
  effort: string | null;
  conflict: boolean;
}

function cleanValsEffortField(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed || null;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

function extractValsBenchmarkViewUrl(rawIslands: readonly string[]): string | null {
  for (const islandRaw of rawIslands) {
    const decoded = decodeHtmlAttr(islandRaw);
    if (!decoded.includes("benchmarkViewUrl")) continue;
    try {
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      const urlVal = unwrapAstroProps(parsed.benchmarkViewUrl);
      if (typeof urlVal === "string" && urlVal.trim().length > 0) {
        return urlVal.trim();
      }
    } catch {}
  }
  return null;
}

// Reconcile per-model reasoning_effort and compute_effort across external benchmarkView JSON and every inline Astro island
function extractValsIslandEfforts(
  primaryView: ValsBenchmarkView | undefined,
  rawIslands: readonly string[],
): Map<string, ValsIslandEffortRecord> {
  const out = new Map<string, ValsIslandEffortRecord>();
  const tables: Record<string, unknown>[] = [];
  if (primaryView?.tasks && typeof primaryView.tasks === "object") {
    for (const tbl of Object.values(primaryView.tasks)) {
      if (tbl && typeof tbl === "object") tables.push(tbl as Record<string, unknown>);
    }
  }

  for (const islandRaw of rawIslands) {
    const decoded = decodeHtmlAttr(islandRaw);
    if (!decoded.includes("reasoning_effort") && !decoded.includes("compute_effort")) continue;
    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(decoded);
    } catch {
      continue;
    }
    if (!rawParsed || typeof rawParsed !== "object" || Array.isArray(rawParsed)) continue;
    const rawRec = rawParsed as Record<string, unknown>;
    const bv = unwrapAstroProps(rawRec.benchmarkView) as
      | { tasks?: Record<string, unknown> }
      | undefined;
    const bp = unwrapAstroProps(rawRec.benchmarkPerformance) as Record<string, unknown> | undefined;
    if (bv?.tasks && typeof bv.tasks === "object") {
      for (const tbl of Object.values(bv.tasks)) {
        if (tbl && typeof tbl === "object") tables.push(tbl as Record<string, unknown>);
      }
    }
    if (bp && typeof bp === "object" && !Array.isArray(bp)) {
      tables.push(bp);
    }
  }

  for (const tbl of tables) {
    for (const [modelKey, rawRow] of Object.entries(tbl)) {
      if (!rawRow || typeof rawRow !== "object") continue;
      const row = rawRow as { reasoning_effort?: unknown; compute_effort?: unknown };
      const re = cleanValsEffortField(row.reasoning_effort);
      const ce = cleanValsEffortField(row.compute_effort);
      if (re === null && ce === null) continue;

      let rowEffort: string | null = null;
      let rowConflict = false;
      if (re !== null && ce !== null) {
        const reNorm = parseStrictEffortMetadata(re);
        const ceNorm = parseStrictEffortMetadata(ce);
        if (reNorm !== null && ceNorm !== null && reNorm === ceNorm) {
          rowEffort = reNorm;
        } else if (re.toLowerCase() === ce.toLowerCase()) {
          rowEffort = re;
        } else {
          rowConflict = true;
        }
      } else {
        const rawVal = re ?? ce!;
        rowEffort = parseStrictEffortMetadata(rawVal) ?? rawVal;
      }

      const prev = out.get(modelKey);
      if (!prev) {
        out.set(modelKey, { effort: rowEffort, conflict: rowConflict });
      } else if (prev.conflict || rowConflict || prev.effort !== rowEffort) {
        out.set(modelKey, { effort: null, conflict: true });
      }
    }
  }
  return out;
}

export const valsAdapter: SourceAdapter = {
  id: "vals",
  label: `Vals AI Frontier Suite (${VALS_FEEDS.length} Benchmarks)`,
  license: "Public Benchmarks / Attribution Required",
  sourceUrl: "https://www.vals.ai/benchmarks",
  expectedBenchmarks: VALS_FEEDS.map((f) => f.benchmarkId),
  expectsPricing: false,
  async fetchLive(nowIso) {
    const loaderCache = new Map<string, Promise<string>>();
    const fetchLoader = (loaderUrl: string): Promise<string> => {
      const existing = loaderCache.get(loaderUrl);
      if (existing) return existing;
      const promise = fetchText(loaderUrl);
      loaderCache.set(loaderUrl, promise);
      return promise;
    };

    const pages = await Promise.allSettled(
      VALS_FEEDS.map(async (spec) => {
        const url = `https://www.vals.ai/benchmarks/${spec.slug}`;
        const html = await fetchText(url);
        const rawIslands = [...html.matchAll(/<astro-island[^>]*props="([^"]*)"/g)].map(
          (m) => m[1] ?? "",
        );
        const bvRelUrl = extractValsBenchmarkViewUrl(rawIslands);
        if (!bvRelUrl) {
          throw new Error(`Vals BenchmarkViewLoader benchmarkViewUrl missing for ${spec.slug}`);
        }
        const bv = await fetchJson<ValsBenchmarkView>(
          new URL(bvRelUrl, "https://www.vals.ai").toString(),
        );
        const overall = bv?.tasks?.overall;
        if (!overall || typeof overall !== "object") {
          throw new Error(`Vals overall task table missing for ${spec.slug}`);
        }
        const islandEfforts = extractValsIslandEfforts(bv, rawIslands);
        const htmlRows = parseValsHtmlTableRows(html);

        // Always require Vals' per-benchmark refusal/fallback ledger so page restructuring fails closed instead of admitting fallback rows
        const loaderRel = html.match(
          /\/_astro\/BenchmarkViewLoader\.[^"&'\\\s]+\.js(?:\?[^"&'\\\s]+)?/,
        )?.[0];
        if (!loaderRel) {
          throw new Error(`Vals BenchmarkViewLoader script missing for ${spec.slug}`);
        }
        const loaderJs = await fetchLoader(`https://www.vals.ai${loaderRel}`);
        const fbMod = extractRefusalFallbackModulePath(loaderJs, spec.refusalFallbackKey);
        if (!fbMod) {
          throw new Error(
            `Vals refusal_fallback module path missing for ${spec.refusalFallbackKey}`,
          );
        }
        const fbJs = await fetchText(`https://www.vals.ai/_astro/${fbMod}`);
        const fallbackModels = parseRefusalFallbackModelsJs(fbJs, spec.refusalFallbackKey);

        return { spec, url, bv, overall, islandEfforts, htmlRows, fallbackModels };
      }),
    );

    const observations: RawObservation[] = [];
    const partitionStats: Record<string, PartitionStats> = {};
    const disqualifiedSourceRowIdsByBenchmark: Record<string, string[]> = {};

    for (let i = 0; i < VALS_FEEDS.length; i++) {
      const spec = VALS_FEEDS[i]!;
      const st: PartitionStats = { attempted: 0, rejected: 0, excluded: 0 };
      partitionStats[spec.benchmarkId] = st;

      const settled = pages[i]!;
      if (settled.status !== "fulfilled") {
        st.error =
          settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        continue;
      }

      const { url, bv, overall, islandEfforts, htmlRows, fallbackModels } = settled.value;
      const overallKeys = Object.keys(overall);
      const matchedEffortCount = overallKeys.filter((k) => {
        const rec = islandEfforts.get(k);
        return rec !== undefined && !rec.conflict && rec.effort !== null;
      }).length;
      // Fail closed per partition when effort annotations disappear from a live Vals benchmarkView payload
      if (overallKeys.length >= 20 && matchedEffortCount === 0) {
        st.error = `Vals effort metadata schema drift on ${spec.benchmarkId}: recovered 0 effort annotations across ${overallKeys.length} models`;
        continue;
      }
      const disqualifiedIds = new Set<string>();
      for (const [fbKey, entry] of Object.entries(fallbackModels)) {
        const fbRec = entry?.benchmarks?.[spec.refusalFallbackKey];
        if (ledgerRecordHasFallbackEvidence(fbRec, new Set([fbKey.toLowerCase()]))) {
          disqualifiedIds.add(`vals:${spec.slug}:${fbKey}`);
        }
      }
      const publishedDate = parseIsoDate(bv?.metadata?.updated, nowIso);
      const upstreamVersion =
        typeof bv?.metadata?.version === "string" ? bv.metadata.version.trim() || null : null;
      const expectedVersion = BENCHMARK_BY_ID[spec.benchmarkId]?.version ?? spec.version;
      if (upstreamVersion === null || upstreamVersion !== expectedVersion) {
        st.error = `Vals version drift for ${spec.benchmarkId}: upstream '${String(bv?.metadata?.version ?? "missing")}' !== registered '${expectedVersion}'`;
        if (disqualifiedIds.size > 0) {
          disqualifiedSourceRowIdsByBenchmark[spec.benchmarkId] = [...disqualifiedIds];
        }
        continue;
      }

      const claimedBaseKeys = new Set(Object.keys(overall));

      for (const [modelKey, metrics] of Object.entries(overall)) {
        st.attempted++;
        if (/(?:-range$|\bdaybreak\b)/i.test(modelKey.replace(/_/g, " "))) {
          disqualifiedIds.add(`vals:${spec.slug}:${modelKey}`);
          st.excluded++;
          continue;
        }
        if (!metrics || typeof metrics !== "object") {
          st.rejected++;
          continue;
        }
        try {
          if (
            metrics.harness !== undefined &&
            metrics.harness !== null &&
            typeof metrics.harness !== "string"
          ) {
            st.rejected++;
            continue;
          }
          const accuracy = parseNumeric(metrics.accuracy);
          const stderr = parsePositive(metrics.stderr);
          if (accuracy === null || accuracy < 0 || accuracy > 100) {
            st.rejected++;
            continue;
          }

          const seRaw = stderr !== null ? Number(stderr.toFixed(6)) : null;
          const ciHalfWidth = stderr !== null ? Number((stderr * 1.96).toFixed(4)) : null;
          const costPerTest = parsePositive(metrics.cost_per_test);
          const tasksMeasured = parseStrictPositiveInt(metrics.token_tasks_measured);

          const metricsHarness =
            typeof metrics.harness === "string" ? metrics.harness.trim() || null : null;
          const htmlMatch = matchValsHtmlMeta(
            modelKey,
            accuracy,
            metricsHarness,
            htmlRows,
            claimedBaseKeys,
          );
          if (htmlMatch.kind === "ambiguous" || htmlMatch.kind === "conflict") {
            st.rejected++;
            continue;
          }
          const htmlMeta = htmlMatch.kind === "matched" ? htmlMatch.row : null;
          if (
            htmlMeta &&
            /(?:-range\b|\bdaybreak\b)/i.test(htmlMeta.displayName.replace(/_/g, " "))
          ) {
            disqualifiedIds.add(`vals:${spec.slug}:${modelKey}`);
            disqualifiedIds.add(`vals:${spec.slug}:${htmlMeta.baseKey}`);
            st.excluded++;
            continue;
          }
          if (
            htmlMeta?.harness &&
            metricsHarness &&
            canonicalValsHarness(htmlMeta.harness) !== canonicalValsHarness(metricsHarness)
          ) {
            st.rejected++;
            continue;
          }
          // Reject unmatched keys that have compact/ISO dated siblings or lack an explicit effort token (preventing partial-HTML effort downgrades)
          const escapedKey = modelKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const hasDatedSibling = [...claimedBaseKeys].some(
            (k) =>
              k !== modelKey &&
              new RegExp(`^${escapedKey}-(?:202\\d-\\d{2}-\\d{2}|\\d{4,8})$`, "i").test(k),
          );
          const keyHasExplicitEffort = parseExplicitEffort(modelKey, true) !== null;
          if (htmlMeta === null && (hasDatedSibling || !keyHasExplicitEffort)) {
            st.rejected++;
            continue;
          }
          // Prefer verified SKU slug over (MM/YY) display labels; scope legacy DeepSeek Pro display override strictly to deepseek-v4-pro -> "DeepSeek V4"
          const canonicalSkuKey = htmlMeta?.baseKey ?? modelKey;
          const fbRecord =
            fallbackModels[modelKey]?.benchmarks?.[spec.refusalFallbackKey] ??
            fallbackModels[canonicalSkuKey]?.benchmarks?.[spec.refusalFallbackKey];
          if (hasFallbackIndicators(modelKey, canonicalSkuKey, metrics, fbRecord)) {
            disqualifiedIds.add(`vals:${spec.slug}:${modelKey}`);
            disqualifiedIds.add(`vals:${spec.slug}:${canonicalSkuKey}`);
            st.excluded++;
            continue;
          }
          const keySlash = canonicalSkuKey.indexOf("/");
          const keyProvider = keySlash > 0 ? canonicalSkuKey.slice(0, keySlash).trim() : null;
          const isDocumentedDeepSeekBaseOverride =
            htmlMeta !== null &&
            /^deepseek\/deepseek-v4-pro$/i.test(canonicalSkuKey) &&
            /^deepseek\s+v4$/i.test(htmlMeta.displayName.trim());
          const rawModelName = isDocumentedDeepSeekBaseOverride
            ? htmlMeta.displayName
            : canonicalSkuKey;

          // Reconcile explicit island reasoning_effort/compute_effort with SKU key and HTML display label
          const islandEffRec = islandEfforts.get(modelKey) ?? islandEfforts.get(canonicalSkuKey);
          if (islandEffRec?.conflict) {
            st.rejected++;
            continue;
          }
          const islandEffRaw = islandEffRec?.effort ?? null;
          const islandEffStrict = parseStrictEffortMetadata(islandEffRaw);

          const keySuffix = keySlash > 0 ? canonicalSkuKey.slice(keySlash + 1) : canonicalSkuKey;
          const displayEffort = parseExplicitEffort(htmlMeta?.displayName ?? "", true);
          const rawNameEffort = parseExplicitEffort(rawModelName, true);
          const keyEffortConcrete = rawNameEffort !== null && rawNameEffort !== "thinking";
          const displayEffortConcrete = displayEffort !== null && displayEffort !== "thinking";
          const islandEffortConcrete = islandEffStrict !== null && islandEffStrict !== "thinking";
          if (
            (keyEffortConcrete && displayEffortConcrete && rawNameEffort !== displayEffort) ||
            (rawNameEffort === "thinking" && displayEffort === "none") ||
            (rawNameEffort === "none" && displayEffort === "thinking") ||
            (keyEffortConcrete && islandEffortConcrete && rawNameEffort !== islandEffStrict) ||
            (displayEffortConcrete && islandEffortConcrete && displayEffort !== islandEffStrict) ||
            (rawNameEffort === "none" && islandEffortConcrete && islandEffStrict !== "none") ||
            (islandEffStrict === "none" &&
              (rawNameEffort === "thinking" || displayEffort === "thinking")) ||
            (islandEffStrict === "thinking" &&
              (rawNameEffort === "none" || displayEffort === "none"))
          ) {
            st.rejected++;
            continue;
          }
          const effortSources = [keySuffix, modelKey, htmlMeta?.displayName ?? ""];
          const manualBudgetMatch = (htmlMeta?.displayName ?? "").match(
            /(?:^|[\s_(,:;/+=-])(\d+k)(?=$|[\s_),:;/+=-])/i,
          );
          const manualBudgetToken = manualBudgetMatch?.[1] ?? null;
          let rawEffort: string | null = null;
          if (islandEffRaw !== null) {
            // Preserve unparseable upstream effort strings (e.g. numeric "0.99") so canonicalizer quarantines cleanly
            rawEffort = islandEffStrict ?? islandEffRaw;
          } else if (
            rawNameEffort === "thinking" &&
            displayEffort !== null &&
            displayEffort !== "thinking" &&
            displayEffort !== "none"
          ) {
            rawEffort = displayEffort;
          } else if (rawNameEffort === null) {
            for (const src of effortSources) {
              const parsedEff = parseExplicitEffort(src, true);
              if (parsedEff !== null) {
                rawEffort = parsedEff;
                break;
              }
            }
          }
          if (manualBudgetToken && !rawEffort?.includes(manualBudgetToken)) {
            rawEffort = rawEffort ? `${rawEffort} ${manualBudgetToken}` : manualBudgetToken;
          }

          const upstreamHarness = htmlMeta?.harness ?? metricsHarness;
          const canonicalUpstreamHarness = canonicalValsHarness(upstreamHarness);
          // Fold documented per-benchmark default harnesses while preserving observedHarness provenance
          const isDocumentedDefaultHarness =
            canonicalUpstreamHarness === null || canonicalUpstreamHarness === "direct";
          const observedHarness = upstreamHarness ?? spec.defaultObservedHarness;
          const emittedRawHarness = isDocumentedDefaultHarness ? null : canonicalUpstreamHarness;

          const refusalRate = extractValsRefusalRate(fbRecord);

          observations.push({
            sourceId: "vals",
            sourceRowId: `vals:${spec.slug}:${modelKey}`,
            benchmarkId: spec.benchmarkId,
            benchmarkVersion: upstreamVersion,
            domainId: spec.domainId,
            rawModelName,
            rawProvider: keyProvider,
            rawEffort,
            rawHarness: emittedRawHarness,
            observedHarness,
            harnessRegime: spec.harnessRegime,
            rawScore: Number(accuracy.toFixed(2)),
            seRaw,
            ciHalfWidth,
            ciLower: null,
            ciUpper: null,
            battleCount: tasksMeasured,
            measuredCostUsd: costPerTest !== null ? Number(costPerTest.toFixed(6)) : null,
            ...(refusalRate !== null ? { refusalRate } : {}),
            suiteCostUsd: null,
            measuredInputTokens: null,
            measuredOutputTokens: null,
            // Vals metadata.updated is the page update timestamp, not a per-model evaluation date
            evalDate: null,
            publishedDate,
            sourceUrl: url,
          });
        } catch {
          st.rejected++;
        }
      }

      if (disqualifiedIds.size > 0) {
        disqualifiedSourceRowIdsByBenchmark[spec.benchmarkId] = [...disqualifiedIds];
      }
    }

    return {
      observations,
      pricing: [],
      partitionStats,
      ...(Object.keys(disqualifiedSourceRowIdsByBenchmark).length > 0
        ? { disqualifiedSourceRowIdsByBenchmark }
        : {}),
    };
  },
};
