import type { RawObservation } from "../../src/lib/schema.ts";

const USER_AGENT = "ProChoice-Benchmark-Bot/2.0 (+https://prochoice.industries)";
const MAX_FETCH_ATTEMPTS = 4;
const MAX_RETRY_AFTER_MS = 30_000;

export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  rejectRedirects?: boolean;
}

class RetryableHttpError extends Error {
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(headerVal: string | null): number | null {
  if (!headerVal) return null;
  const trimmed = headerVal.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(500, Number(trimmed) * 1000));
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return Math.min(MAX_RETRY_AFTER_MS, Math.max(500, delta));
  }
  return null;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function computeBackoffMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const base = 1000 * 2.5 ** attempt;
  const jitter = Math.floor(Math.random() * 400);
  return Math.min(MAX_RETRY_AFTER_MS, Math.round(base + jitter));
}

async function fetchOnce(url: string, opts: FetchOptions, timeoutMs: number): Promise<Response> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, text/html, */*",
      ...opts.headers,
    },
    redirect: opts.rejectRedirects ? "error" : "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
    await response.body?.cancel().catch(() => undefined);
    const msg = `HTTP ${response.status} for ${url}`;
    if (isRetryableStatus(response.status)) {
      throw new RetryableHttpError(msg, retryAfter);
    }
    throw new Error(msg);
  }
  return response;
}

async function withBackoffRetries<T>(
  fn: () => Promise<T>,
  isPermanentError: (err: unknown) => boolean,
  attempt = 0,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isPermanentError(err) || attempt + 1 >= MAX_FETCH_ATTEMPTS) throw err;
    const retryAfter = err instanceof RetryableHttpError ? err.retryAfterMs : null;
    await new Promise((r) => setTimeout(r, computeBackoffMs(attempt, retryAfter)));
    return withBackoffRetries(fn, isPermanentError, attempt + 1);
  }
}

function isPermanentFetchError(err: unknown): boolean {
  return (
    err instanceof Error &&
    !(err instanceof RetryableHttpError) &&
    /^HTTP 4\d\d\b/.test(err.message)
  );
}

export async function fetchWithTimeout(url: string, opts: FetchOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  return withBackoffRetries(() => fetchOnce(url, opts, timeoutMs), isPermanentFetchError);
}

export async function fetchText(url: string, opts?: FetchOptions): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 25_000;
  return withBackoffRetries(async () => {
    const res = await fetchOnce(url, opts ?? {}, timeoutMs);
    return res.text();
  }, isPermanentFetchError);
}

export async function fetchJson<T>(url: string, opts?: FetchOptions): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 25_000;
  return withBackoffRetries(async () => {
    const res = await fetchOnce(url, opts ?? {}, timeoutMs);
    return (await res.json()) as T;
  }, isPermanentFetchError);
}

export async function fetchArrayBuffer(url: string, opts?: FetchOptions): Promise<ArrayBuffer> {
  const timeoutMs = opts?.timeoutMs ?? 25_000;
  return withBackoffRetries(async () => {
    const res = await fetchOnce(url, opts ?? {}, timeoutMs);
    return res.arrayBuffer();
  }, isPermanentFetchError);
}

// Send Authorization only on hop 0; enforce https:// and strip credentials across up to 5 manual redirect hops
async function fetchSafeHop(
  currentUrl: URL,
  hop: number,
  authHeader: string | undefined,
  timeoutMs: number,
): Promise<ArrayBuffer> {
  const MAX_REDIRECTS = 5;
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "*/*",
  };
  if (hop === 0 && authHeader) headers.Authorization = authHeader;

  const res = await fetch(currentUrl.toString(), {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`Exceeded ${MAX_REDIRECTS} redirects for ${currentUrl.toString()}`);
    }
    if (!loc) throw new Error(`HTTP ${res.status} redirect without Location for ${currentUrl}`);
    const nextUrl = new URL(loc, currentUrl);
    if (nextUrl.protocol !== "https:") {
      throw new Error(`Refusing non-HTTPS redirect target ${nextUrl.toString()}`);
    }
    return fetchSafeHop(nextUrl, hop + 1, undefined, timeoutMs);
  }

  if (!res.ok) {
    const retryAfter = parseRetryAfterMs(res.headers.get("retry-after"));
    await res.body?.cancel().catch(() => undefined);
    const msg = `HTTP ${res.status} for ${currentUrl.toString()}`;
    if (isRetryableStatus(res.status)) {
      throw new RetryableHttpError(msg, retryAfter);
    }
    throw new Error(msg);
  }
  return res.arrayBuffer();
}

export async function fetchArrayBufferWithSafeAuth(
  url: string,
  authHeader?: string,
  timeoutMs = 25_000,
): Promise<ArrayBuffer> {
  const startUrl = new URL(url);
  if (startUrl.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS request ${startUrl.toString()}`);
  }
  return withBackoffRetries(
    () => fetchSafeHop(startUrl, 0, authHeader, timeoutMs),
    (err) =>
      err instanceof Error &&
      !(err instanceof RetryableHttpError) &&
      /^HTTP 4\d\d\b|^Refusing non-HTTPS|^Exceeded \d+ redirects/.test(err.message),
  );
}

export function extractRscText(html: string): string {
  const needle = 'self.__next_f.push([1,"';
  const parts: string[] = [];
  let pos = 0;

  // Linear O(n) string scanner avoids regex backtracking limits on multi-MB Flight payloads and concatenates verbatim
  while (pos < html.length) {
    const start = html.indexOf(needle, pos);
    if (start === -1) break;
    let i = start + needle.length;
    let esc = false;
    let closed = false;
    while (i < html.length) {
      const ch = html[i];
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        closed = true;
        break;
      }
      i++;
    }
    if (!closed || html.slice(i, i + 3) !== '"])') {
      throw new Error(`Unterminated Next.js Flight chunk at offset ${start}`);
    }
    const raw = html.slice(start + needle.length, i);
    try {
      parts.push(JSON.parse(`"${raw}"`) as string);
    } catch (err) {
      throw new Error(`Malformed Next.js Flight string chunk (${raw.slice(0, 80)})`, {
        cause: err,
      });
    }
    pos = i + 3;
  }
  return parts.join("");
}

export function parseBalancedJson(str: string, startIdx: number): unknown {
  if (startIdx < 0 || startIdx >= str.length) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "[" || ch === "{") {
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(str.slice(startIdx, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Parse React Flight stream rows (<hexId>:<json> and UTF-8 byte-framed <hexId>:T<hexLen>,<text>)
export function parseRscFlightChunks(rsc: string): Map<string, unknown> {
  const bytes = Buffer.from(rsc, "utf8");
  const chunks = new Map<string, unknown>();
  let pos = 0;

  while (pos < bytes.length) {
    while (pos < bytes.length && (bytes[pos] === 0x0a || bytes[pos] === 0x0d)) pos++;
    if (pos >= bytes.length) break;
    const colon = bytes.indexOf(0x3a, pos);
    if (colon === -1) break;
    const id = bytes.subarray(pos, colon).toString("utf8").trim();
    const nl = bytes.indexOf(0x0a, colon + 1);
    if (!/^[0-9a-f]+$/.test(id)) {
      pos = nl === -1 ? bytes.length : nl + 1;
      continue;
    }
    if (bytes[colon + 1] === 0x54) {
      const comma = bytes.indexOf(0x2c, colon + 2);
      if (comma !== -1 && (nl === -1 || comma < nl)) {
        const lenHex = bytes.subarray(colon + 2, comma).toString("utf8");
        if (/^[0-9a-f]+$/i.test(lenHex)) {
          const byteLen = Number.parseInt(lenHex, 16);
          const start = comma + 1;
          const end = Math.min(bytes.length, start + byteLen);
          chunks.set(id, bytes.subarray(start, end).toString("utf8"));
          pos = end;
          continue;
        }
      }
    }
    const end = nl === -1 ? bytes.length : nl;
    const payload = bytes.subarray(colon + 1, end).toString("utf8");
    const first = payload[0];
    if (
      first &&
      (first === "[" ||
        first === "{" ||
        first === '"' ||
        first === "-" ||
        first === "t" ||
        first === "f" ||
        first === "n" ||
        (first >= "0" && first <= "9"))
    ) {
      try {
        chunks.set(id, JSON.parse(payload));
      } catch {
        // Skip non-JSON Flight frames
      }
    }
    pos = nl === -1 ? bytes.length : nl + 1;
  }
  return chunks;
}

// Resolve React Flight $undefined, $$ escapes, and lowercase-hex $<chunkId>:<path> outline references
export function resolveRscFlightTree(root: unknown, chunks: ReadonlyMap<string, unknown>): unknown {
  const refMemo = new Map<string, unknown>();
  const activeRefs = new Set<string>();
  const objMemo = new WeakMap<object, unknown>();

  const resolveRefString = (ref: string): unknown => {
    if (ref === "$undefined") return undefined;
    if (ref.startsWith("$$")) return ref.slice(1);
    const match = ref.match(/^\$([0-9a-f]+)(?::(.*))?$/);
    if (!match?.[1]) return ref;
    if (refMemo.has(ref)) return refMemo.get(ref);
    if (activeRefs.has(ref)) return ref;
    const chunkId = match[1];
    if (!chunks.has(chunkId)) return ref;

    activeRefs.add(ref);
    try {
      let cur: unknown = chunks.get(chunkId);
      const segs = match[2] !== undefined && match[2].length > 0 ? match[2].split(":") : [];
      for (const seg of segs) {
        if (typeof cur === "string" && cur.startsWith("$")) {
          cur = resolveRefString(cur);
        }
        if (Array.isArray(cur)) {
          if (seg === "props" && cur.length >= 4 && cur[0] === "$") {
            cur = cur[3];
          } else if (/^\d+$/.test(seg)) {
            cur = cur[Number(seg)];
          } else {
            return ref;
          }
        } else if (cur !== null && typeof cur === "object" && Object.hasOwn(cur, seg)) {
          cur = (cur as Record<string, unknown>)[seg];
        } else {
          return ref;
        }
      }
      const resolved = walk(cur);
      refMemo.set(ref, resolved);
      return resolved;
    } finally {
      activeRefs.delete(ref);
    }
  };

  const walk = (val: unknown): unknown => {
    if (typeof val === "string") {
      return val.startsWith("$") ? resolveRefString(val) : val;
    }
    if (val === null || typeof val !== "object") return val;
    if (objMemo.has(val)) return objMemo.get(val);
    if (Array.isArray(val)) {
      const out: unknown[] = [];
      objMemo.set(val, out);
      for (const item of val) out.push(walk(item));
      return out;
    }
    const out: Record<string, unknown> = {};
    objMemo.set(val, out);
    for (const [k, v] of Object.entries(val)) {
      out[k] = walk(v);
    }
    return out;
  };

  return walk(root);
}

export function unwrapAstroProps(v: unknown): unknown {
  if (Array.isArray(v) && v.length === 2 && (v[0] === 0 || v[0] === 1)) {
    if (v[0] === 0) {
      const inner = v[1];
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(inner as Record<string, unknown>)) {
          out[k] = unwrapAstroProps(val);
        }
        return out;
      }
      return inner;
    }
    return Array.isArray(v[1]) ? v[1].map(unwrapAstroProps) : v[1];
  }
  return v;
}

export function extractMarkdownTableRows(markdown: string): Record<string, string>[] {
  const lines = markdown.split(/\r?\n/);
  const rows: Record<string, string>[] = [];
  let headers: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      headers = null;
      continue;
    }
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!headers) {
      headers = cells.map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
      continue;
    }
    if (cells.length >= headers.length) {
      const rec: Record<string, string> = {};
      for (let i = 0; i < headers.length; i++) {
        const key = headers[i];
        if (key) rec[key] = cells[i] ?? "";
      }
      rows.push(rec);
    }
  }
  return rows;
}

export function observationsMatchExact(a: RawObservation, b: RawObservation): boolean {
  return (
    a.sourceId === b.sourceId &&
    a.sourceRowId === b.sourceRowId &&
    a.benchmarkId === b.benchmarkId &&
    a.benchmarkVersion === b.benchmarkVersion &&
    a.domainId === b.domainId &&
    a.rawModelName === b.rawModelName &&
    a.rawProvider === b.rawProvider &&
    a.rawEffort === b.rawEffort &&
    a.rawHarness === b.rawHarness &&
    a.observedHarness === b.observedHarness &&
    a.harnessRegime === b.harnessRegime &&
    a.rawScore === b.rawScore &&
    (a.seRaw ?? null) === (b.seRaw ?? null) &&
    a.ciHalfWidth === b.ciHalfWidth &&
    a.ciLower === b.ciLower &&
    a.ciUpper === b.ciUpper &&
    a.battleCount === b.battleCount &&
    a.measuredCostUsd === b.measuredCostUsd &&
    (a.measuredCostEstimated ?? false) === (b.measuredCostEstimated ?? false) &&
    a.suiteCostUsd === b.suiteCostUsd &&
    a.measuredInputTokens === b.measuredInputTokens &&
    a.measuredOutputTokens === b.measuredOutputTokens &&
    (a.fallbackRouting ?? false) === (b.fallbackRouting ?? false) &&
    (a.refusalRate ?? null) === (b.refusalRate ?? null) &&
    a.evalDate === b.evalDate &&
    a.publishedDate === b.publishedDate &&
    a.sourceUrl === b.sourceUrl
  );
}

export function parseNumeric(val: unknown): number | null {
  if (typeof val === "bigint") {
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  if (typeof val === "string") {
    const cleaned = val.replace(/[$,%\s,]/g, "").trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parsePositive(val: unknown): number | null {
  const n = parseNumeric(val);
  return n !== null && n > 0 ? n : null;
}

export function parseNonNegative(val: unknown): number | null {
  const n = parseNumeric(val);
  return n !== null && n >= 0 ? n : null;
}

export function parseStrictNonNegativeInt(val: unknown): number | null {
  if (typeof val === "bigint") {
    const n = Number(val);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  if (typeof val === "number") {
    return Number.isSafeInteger(val) && val >= 0 ? val : null;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(trimmed)) return null;
    const n = Number(trimmed.replaceAll(",", ""));
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

export function parseStrictPositiveInt(val: unknown): number | null {
  const n = parseStrictNonNegativeInt(val);
  return n !== null && n > 0 ? n : null;
}

const MONTH_MAP: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function validateUtcYmd(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) {
    return null;
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseIsoDate(val: unknown, maxIsoDate?: string): string | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  if (!trimmed) return null;

  let candidate: string | null = null;
  const dateOnly = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly?.[1] && dateOnly[2] && dateOnly[3]) {
    candidate = validateUtcYmd(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
  } else {
    const fullIso = trimmed.match(
      /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/,
    );
    if (fullIso) {
      const y = Number(fullIso[1]);
      const m = Number(fullIso[2]);
      const d = Number(fullIso[3]);
      const hh = Number(fullIso[4]);
      const mm = Number(fullIso[5]);
      const ss = Number(fullIso[6]);
      if (validateUtcYmd(y, m, d) && hh <= 23 && mm <= 59 && ss <= 59) {
        let offsetMin = 0;
        const tz = fullIso[8]!;
        let tzValid = true;
        if (tz !== "Z") {
          const sign = tz[0] === "+" ? 1 : -1;
          const offH = Number(tz.slice(1, 3));
          const offM = Number(tz.slice(4, 6));
          if (offH > 23 || offM > 59) tzValid = false;
          else offsetMin = sign * (offH * 60 + offM);
        }
        if (tzValid) {
          const utcMs = Date.UTC(y, m - 1, d, hh, mm, ss) - offsetMin * 60_000;
          candidate = new Date(utcMs).toISOString().slice(0, 10);
        }
      }
    } else {
      const compactMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (compactMatch?.[1] && compactMatch[2] && compactMatch[3]) {
        candidate = validateUtcYmd(
          Number(compactMatch[1]),
          Number(compactMatch[2]),
          Number(compactMatch[3]),
        );
      } else {
        const mdyMatch = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
        if (mdyMatch?.[1] && mdyMatch[2] && mdyMatch[3]) {
          const month = MONTH_MAP[mdyMatch[1].toLowerCase()];
          if (month !== undefined) {
            candidate = validateUtcYmd(Number(mdyMatch[3]), month, Number(mdyMatch[2]));
          }
        }
      }
    }
  }

  if (!candidate) return null;
  const ceiling = (maxIsoDate ?? new Date().toISOString()).slice(0, 10);
  if (candidate > ceiling) return null;
  return candidate;
}
