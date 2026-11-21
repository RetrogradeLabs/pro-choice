import rawAliases from "../../config/aliases.json" with { type: "json" };
import { HARNESSES } from "../../config/harnesses.ts";
import { PROVIDERS } from "../../config/providers.ts";
import type {
  HarnessId,
  HarnessRegime,
  ProviderId,
  RawObservation,
  ReasoningEffort,
} from "../schema.ts";

interface AliasEntry {
  provider: ProviderId;
  modelSlug: string;
  displayName: string;
  releaseDate: string | null;
  defaultEffort: ReasoningEffort;
  requireExplicitEffort?: boolean;
  revisionStamps?: readonly string[];
  patterns: readonly string[];
}

interface CompiledAlias {
  provider: ProviderId;
  modelSlug: string;
  displayName: string;
  releaseDate: string | null;
  defaultEffort: ReasoningEffort;
  requireExplicitEffort: boolean;
  revisionStamps: readonly string[];
  regexes: readonly RegExp[];
}

const ALIAS_ENTRIES: readonly AliasEntry[] = rawAliases as AliasEntry[];

// Exact full-string match on cleaned model base prevents prefix/version bleed (e.g. kimi-k3.2 -> kimi-k3)
const COMPILED_ALIASES: readonly CompiledAlias[] = ALIAS_ENTRIES.map((entry) => ({
  provider: entry.provider,
  modelSlug: entry.modelSlug,
  displayName: entry.displayName,
  releaseDate: entry.releaseDate,
  defaultEffort: entry.defaultEffort,
  requireExplicitEffort: Boolean(entry.requireExplicitEffort),
  revisionStamps: entry.revisionStamps ?? [],
  regexes: entry.patterns.map((p) => new RegExp(`^(?:${p})$`, "i")),
}));

const ALLOWLIST_PROVIDER_MAP = new Map<string, ProviderId>();
for (const p of PROVIDERS) {
  ALLOWLIST_PROVIDER_MAP.set(p.id, p.id);
  ALLOWLIST_PROVIDER_MAP.set(p.name.toLowerCase(), p.id);
  for (const a of p.aliases) {
    ALLOWLIST_PROVIDER_MAP.set(a.toLowerCase(), p.id);
  }
}

const NON_ALLOWLIST_PROVIDER_REGEX =
  /\b(mistral|cohere|amazon|nova|nvidia|nemotron|thinking\s*machines|inkling|reflection|beam|minimax|stepfun|xiaomi|mimo|bytedance|doubao|seed|tencent|hunyuan|baidu|ernie|perplexity|reka|ai21|ibm|granite|microsoft|mai-|phi-|upstage|solar|liquid|lg\s*ai|allenai|olmo|nous|inception|mercury|arcee|servicenow|openbmb|sarvam|naver|sk\s*telecom|tii|falcon|cursor[\s_-]+(?:small|fast|composer)|fireworks)\b/i;

const ALLOWLIST_NAME_HINT_REGEX =
  /^(?:claude|fable|opus|sonnet|haiku|gpt|o3|o4|astra|gemini|gemma|grok|muse|llama|deepseek|kimi|qwen|glm)(?=[\s\d._-]|$)/i;

// Manual token-budget suffixes (e.g. "Thinking 16K", "High+32K", "budget:32K", "budget=32K") are distinct API controls from adaptive effort tiers
const MANUAL_TOKEN_BUDGET_REGEX = /(?:^|[\s_(,:;/+=-])(\d+k)(?=$|[\s_),:;/+=-])/i;

export function resolveAllowlistedProvider(raw: string | null | undefined): ProviderId | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  const direct = ALLOWLIST_PROVIDER_MAP.get(cleaned);
  if (direct) return direct;
  for (const [alias, id] of ALLOWLIST_PROVIDER_MAP.entries()) {
    if (
      alias.length >= 3 &&
      new RegExp(
        `(?:^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`,
      ).test(cleaned)
    ) {
      return id;
    }
  }
  return null;
}

const STRICT_EFFORT_METADATA_MAP: Readonly<Record<string, ReasoningEffort>> = {
  none: "none",
  "no reasoning": "none",
  "non reasoning": "none",
  nonreasoning: "none",
  "no thinking": "none",
  "non thinking": "none",
  nonthinking: "none",
  "without reasoning": "none",
  "without thinking": "none",
  off: "none",
  disabled: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  xhigh: "xhigh",
  "x high": "xhigh",
  "extra high": "xhigh",
  max: "max",
  thinking: "thinking",
  reasoning: "thinking",
};

// Strict full-string parser for explicit upstream effort metadata (rejects ambiguous, compound, negated, or prototype keys)
export function parseStrictEffortMetadata(text: string | null | undefined): ReasoningEffort | null {
  if (typeof text !== "string") return null;
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+effort$/, "")
    .trim();
  if (!normalized || !Object.hasOwn(STRICT_EFFORT_METADATA_MAP, normalized)) return null;
  return STRICT_EFFORT_METADATA_MAP[normalized] ?? null;
}

const NEGATED_EFFORT_RX =
  /\b(?:not|no|without)\s+(?:minimal|low|medium|med|high|xhigh|x[\s_-]?high|extra[\s_-]?high|max)\b|\bnon[\s_-]+(?:minimal|low|medium|med|high|xhigh|x[\s_-]?high|extra[\s_-]?high|max)\b/i;
const UNKNOWN_TOKEN_RX = /(?:^|[\s_(,:;/-])unknown(?=$|[\s_),:;/+-])/i;

// Extract a single unambiguous reasoning tier from a model name or compound suffix; flag contradictions or negations
export function parseUniqueEffortFromText(
  text: string | null | undefined,
  guardModelMax = true,
): { effort: ReasoningEffort | null; ambiguous: boolean } {
  if (typeof text !== "string" || !text.trim()) return { effort: null, ambiguous: false };
  const lower = text.trim().toLowerCase().replace(/_/g, " ");
  if (UNKNOWN_TOKEN_RX.test(text) || NEGATED_EFFORT_RX.test(lower)) {
    return { effort: null, ambiguous: true };
  }
  const concrete = new Set<ReasoningEffort>();
  let hasNonThinking = false;
  let hasGenericThinking = false;

  const nonThinkRx =
    /\b(non[\s_-]?reasoning|no[\s_-]?reasoning|no[\s_-]?thinking|non[\s_-]?thinking|nonthinking|without[\s_-]+(?:reasoning|thinking)|none)\b/g;
  if (nonThinkRx.test(lower)) {
    hasNonThinking = true;
    concrete.add("none");
  }
  if (/\bminimal\b/.test(lower)) concrete.add("minimal");
  if (/\blow\b/.test(lower)) concrete.add("low");
  if (/\bmedium\b|\bmed\b/.test(lower)) concrete.add("medium");
  if (/\b(xhigh|x[\s_-]?high|extra[\s_-]?high)\b/.test(lower)) concrete.add("xhigh");
  // Strip xhigh/extra-high before checking standalone high so "extra high" never conflicts with "high"
  const withoutXhigh = lower.replace(/\b(xhigh|x[\s_-]?high|extra[\s_-]?high)\b/g, " ");
  if (/\bmax\b/.test(withoutXhigh)) {
    const hasExplicitParenMax = /\([^)]*\bmax\b[^)]*\)/.test(withoutXhigh);
    const strippedModelMax = withoutXhigh.replace(
      /(?:^|[^a-z0-9])(?:qwen[\s_-]*[34](?:[._-][0-9]+)?|codex)[\s_-]+max(?=$|[^a-z0-9])/g,
      " ",
    );
    if (!guardModelMax || hasExplicitParenMax || /\bmax\b/.test(strippedModelMax)) {
      concrete.add("max");
    }
  }
  if (/\bhigh\b/.test(withoutXhigh)) concrete.add("high");
  const withoutNonThink = withoutXhigh.replace(nonThinkRx, " ");
  if (/\breasoning\b|\bthinking\b/.test(withoutNonThink)) hasGenericThinking = true;

  if (concrete.size > 1 || (hasNonThinking && hasGenericThinking)) {
    return { effort: null, ambiguous: true };
  }
  if (concrete.size === 1) {
    return { effort: [...concrete][0]!, ambiguous: false };
  }
  if (hasGenericThinking) {
    return { effort: "thinking", ambiguous: false };
  }
  return { effort: null, ambiguous: false };
}

export function parseExplicitEffort(
  text: string | null | undefined,
  guardModelMax = true,
): ReasoningEffort | null {
  const parsed = parseUniqueEffortFromText(text, guardModelMax);
  return parsed.ambiguous ? null : parsed.effort;
}

export function extractEffort(
  rawModelName: string,
  rawEffort: string | null,
): ReasoningEffort | null {
  if (rawEffort?.trim()) {
    const fromMeta = parseStrictEffortMetadata(rawEffort);
    if (fromMeta) return fromMeta;
  }
  return parseExplicitEffort(rawModelName, true);
}

export function resolveExplicitHarness(
  rawHarness: string | null,
  defaultRegime: HarnessRegime,
): { ok: true; harness: HarnessId; regime: HarnessRegime } | { ok: false; rawHarness: string } {
  if (!rawHarness?.trim()) {
    return {
      ok: true,
      harness: defaultRegime === "standardized" ? "standardized-suite" : "direct",
      regime: defaultRegime,
    };
  }

  const normalized = rawHarness.trim().toLowerCase();
  for (const h of HARNESSES) {
    if (h.id === normalized) return { ok: true, harness: h.id, regime: h.regime };
    for (const a of h.aliases) {
      if (normalized === a) return { ok: true, harness: h.id, regime: h.regime };
    }
  }
  return { ok: false, rawHarness: rawHarness.trim() };
}

function isValidCalendarStamp(stamp: string): boolean {
  const iso = stamp.match(/^(202\d)-(\d{2})-(\d{2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const mo = Number(iso[2]);
    const d = Number(iso[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d;
  }
  const compact = stamp.match(/^(202\d)(\d{2})(\d{2})$/);
  if (compact) {
    const y = Number(compact[1]);
    const mo = Number(compact[2]);
    const d = Number(compact[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d;
  }
  const mmdd = stamp.match(/^(\d{2})(\d{2})$/);
  if (mmdd) {
    const mo = Number(mmdd[1]);
    const d = Number(mmdd[2]);
    const dt = new Date(Date.UTC(2024, mo - 1, d));
    return dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d;
  }
  return false;
}

function extractDateStamps(raw: string): string[] {
  const stamps: string[] = [];
  for (const m of raw.matchAll(
    /(?:^|[\s_(,:;/-])(202\d-\d{2}-\d{2}|202\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(?=$|[\s_),:;/+-])/g,
  )) {
    if (m[1] && isValidCalendarStamp(m[1])) stamps.push(m[1]);
  }
  return stamps;
}

function dateStampMatchesAlias(stamp: string, alias: CompiledAlias): boolean {
  if (alias.revisionStamps.includes(stamp)) return true;
  if (!alias.releaseDate) return false;
  const iso = alias.releaseDate.slice(0, 10);
  const compact = iso.replaceAll("-", "");
  const mmdd = compact.slice(4);
  return stamp === iso || stamp === compact || stamp === mmdd;
}

export function isRegisteredModelExact(rawName: string): boolean {
  const cleaned = rawName
    .trim()
    .replace(/^[a-z0-9._-]+\//i, "")
    .replace(/[*⁂§†‡¶^※]+/g, "")
    .trim();
  if (!cleaned) return false;
  return COMPILED_ALIASES.some((entry) => entry.regexes.some((rx) => rx.test(cleaned)));
}

// Strip trailing effort tokens iteratively right-to-left while preserving complete registered SKUs (e.g. Qwen3.7 Max)
function stripTrailingEffortTokens(input: string): string {
  let cur = input;
  const trailingEffortToken =
    /[\s_-]+(without[\s_-]+(?:reasoning|thinking)|non[\s_-]?reasoning|no[\s_-]?reasoning|non[\s_-]?thinking|no[\s_-]?thinking|nonthinking|none|thinking|minimal|low|medium|extra[\s_-]?high|x[\s_-]?high|xhigh|high|max|effort|reasoning|unknown)$/i;
  while (true) {
    if (COMPILED_ALIASES.some((entry) => entry.regexes.some((rx) => rx.test(cur)))) {
      break;
    }
    const m = cur.match(trailingEffortToken);
    if (!m || m.index === undefined) break;
    const before = cur.slice(0, m.index).trim();
    if (
      /^max$/i.test(m[1] ?? "") &&
      /(?:^|[^a-z0-9])(?:qwen[\s_-]*[34](?:[._-][0-9]+)?|codex)$/i.test(before)
    ) {
      break;
    }
    cur = before;
  }
  return cur;
}

function cleanModelNameForMatch(rawModelName: string): {
  preDateBase: string;
  reorderedPreDateBase: string | null;
  cleanedBase: string;
  strippedDateStamps: string[];
  manualBudgetToken: string | null;
} {
  let s = rawModelName.trim();
  s = s.replace(/^[a-z0-9._-]+\//i, "");
  // Strip decorative footnote glyphs (*, ⁂, §, †, ‡, ¶, ^, ※)
  s = s.replace(/[*⁂§†‡¶^※]+/g, "").trim();

  const budgetMatch = s.match(MANUAL_TOKEN_BUDGET_REGEX);
  const manualBudgetToken = budgetMatch?.[1] ?? null;

  const strippedDateStamps = extractDateStamps(s);
  // Strip effort/harness/routing tokens inside parentheticals while keeping date stamps for exact revision matching
  s = s
    .replace(/\(([^)]+)\)/g, (_full, inner: string) => {
      const kept = inner
        .split(/[,/]+/)
        .map((part) => part.trim())
        .filter(
          (part) =>
            part.length > 0 &&
            !/^(?:without[\s_-]+(?:reasoning|thinking)|non[\s_-]?reasoning|no[\s_-]?reasoning|reasoning|non[\s_-]?thinking|no[\s_-]?thinking|nonthinking|none|minimal|low|medium|med|high|xhigh|x[\s_-]?high|extra[\s_-]?high|max|thinking|unknown|default fallback|with fallback|openhands|mini[\s_-]?swe[\s_-]?agent|claude code|codex(?:\s+harness)?|antigravity|cursor|june 2026)$/i.test(
              part,
            ),
        );
      if (kept.length === 0) return "";
      if (
        kept.every((part) =>
          /^(?:202\d-\d{2}-\d{2}|202\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/.test(
            part,
          ),
        )
      ) {
        return ` ${kept.join(" ")}`;
      }
      return ` (${kept.join(", ")})`;
    })
    .replace(/\s+/g, " ")
    .trim();
  s = stripTrailingEffortTokens(s);

  const preDateBase = s;
  const trailingDateMatch = s.match(
    /[\s_-]+(202\d-\d{2}-\d{2}|202\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/,
  );
  // Strip trailing valid revision stamp and any effort token preceding it (e.g. "Qwen3.7 Max High 0517" -> "Qwen3.7 Max 0517")
  const hasTrailingValidDate = Boolean(
    trailingDateMatch?.[1] && isValidCalendarStamp(trailingDateMatch[1]),
  );
  const cleanedBase = hasTrailingValidDate
    ? stripTrailingEffortTokens(s.slice(0, trailingDateMatch!.index).trim())
    : s;
  const reorderedPreDateBase =
    hasTrailingValidDate && `${cleanedBase} ${trailingDateMatch![1]!}` !== preDateBase
      ? `${cleanedBase} ${trailingDateMatch![1]!}`
      : null;

  return { preDateBase, reorderedPreDateBase, cleanedBase, strippedDateStamps, manualBudgetToken };
}

function matchAlias(
  preDateBase: string,
  reorderedPreDateBase: string | null,
  cleanedBase: string,
): {
  alias: CompiledAlias;
  matchedExactDate: boolean;
} | null {
  // Prefer dedicated dated revision aliases (e.g. deepseek-v4.1-flash-1017, qwen3.7-max-0517) before stripping date stamps
  const exact = COMPILED_ALIASES.find((entry) => entry.regexes.some((rx) => rx.test(preDateBase)));
  if (exact) return { alias: exact, matchedExactDate: true };

  if (reorderedPreDateBase) {
    const reordered = COMPILED_ALIASES.find((entry) =>
      entry.regexes.some((rx) => rx.test(reorderedPreDateBase)),
    );
    if (reordered) return { alias: reordered, matchedExactDate: true };
  }

  if (cleanedBase !== preDateBase) {
    const stripped = COMPILED_ALIASES.find((entry) =>
      entry.regexes.some((rx) => rx.test(cleanedBase)),
    );
    if (stripped) return { alias: stripped, matchedExactDate: false };
  }
  return null;
}

export interface CanonicalConfigKey {
  configId: string;
  provider: ProviderId;
  modelSlug: string;
  displayName: string;
  releaseDate: string | null;
  effort: ReasoningEffort;
  harness: HarnessId;
  harnessRegime: HarnessRegime;
}

export type CanonicalizeOutcome =
  | { kind: "ok"; config: CanonicalConfigKey }
  | { kind: "rejected"; reason: string }
  | { kind: "unmapped"; reason: string };

function resolveAttributedProvider(
  rawModelName: string,
  rawProvider?: string | null,
):
  | { ok: true; provider: ProviderId | null }
  | { ok: false; kind: "rejected" | "unmapped"; reason: string } {
  const explicitProvider = resolveAllowlistedProvider(rawProvider);
  if (rawProvider?.trim() && !explicitProvider) {
    return { ok: false, kind: "rejected", reason: `non_allowlisted_provider:${rawProvider}` };
  }

  let prefixProvider: ProviderId | null = null;
  const prefixMatch = rawModelName.trim().match(/^([a-z0-9._-]+)\//i);
  if (prefixMatch?.[1]) {
    prefixProvider = resolveAllowlistedProvider(prefixMatch[1]);
    if (!prefixProvider) {
      return { ok: false, kind: "rejected", reason: `non_allowlisted_prefix:${prefixMatch[1]}` };
    }
    if (explicitProvider && explicitProvider !== prefixProvider) {
      return {
        ok: false,
        kind: "unmapped",
        reason: `provider_prefix_mismatch:${explicitProvider}!=${prefixProvider}`,
      };
    }
  }

  return { ok: true, provider: explicitProvider ?? prefixProvider };
}

export function canonicalizeObservation(obs: RawObservation): CanonicalizeOutcome {
  if (/\bdaybreak\b/i.test(`${obs.rawModelName} ${obs.rawEffort ?? ""}`.replace(/_/g, " "))) {
    return { kind: "rejected", reason: "gated_non_public_variant:daybreak" };
  }
  const attribution = resolveAttributedProvider(obs.rawModelName, obs.rawProvider);
  if (!attribution.ok) {
    return { kind: attribution.kind, reason: attribution.reason };
  }
  const attributedProvider = attribution.provider;

  const { preDateBase, reorderedPreDateBase, cleanedBase, strippedDateStamps, manualBudgetToken } =
    cleanModelNameForMatch(obs.rawModelName);
  if (!cleanedBase) {
    return { kind: "rejected", reason: "empty_model_name" };
  }

  if (NON_ALLOWLIST_PROVIDER_REGEX.test(cleanedBase)) {
    return { kind: "rejected", reason: "non_allowlisted_vendor_model" };
  }

  const effortBudgetToken = obs.rawEffort?.match(MANUAL_TOKEN_BUDGET_REGEX)?.[1] ?? null;
  const effectiveBudgetToken = manualBudgetToken ?? effortBudgetToken;
  if (effectiveBudgetToken) {
    if (attributedProvider || ALLOWLIST_NAME_HINT_REGEX.test(cleanedBase)) {
      return {
        kind: "unmapped",
        reason: `manual_token_budget_distinct_from_effort:${effectiveBudgetToken}`,
      };
    }
    return { kind: "rejected", reason: "non_allowlisted_model" };
  }

  const matched = matchAlias(preDateBase, reorderedPreDateBase, cleanedBase);

  if (!matched) {
    if (attributedProvider || ALLOWLIST_NAME_HINT_REGEX.test(cleanedBase)) {
      return { kind: "unmapped", reason: `unresolved_allowlisted_model:${cleanedBase}` };
    }
    return { kind: "rejected", reason: "non_allowlisted_model" };
  }

  const matchedAlias = matched.alias;
  if (attributedProvider && attributedProvider !== matchedAlias.provider) {
    return {
      kind: "unmapped",
      reason: `provider_attribution_mismatch:${attributedProvider}!=${matchedAlias.provider}`,
    };
  }

  // Validate every supplied date stamp against the matched alias releaseDate or revisionStamps unconditionally
  for (const stamp of strippedDateStamps) {
    if (!dateStampMatchesAlias(stamp, matchedAlias)) {
      return {
        kind: "unmapped",
        reason: `unverified_revision_date:${matchedAlias.modelSlug}@${stamp}`,
      };
    }
  }

  const harnessResult = resolveExplicitHarness(obs.rawHarness, obs.harnessRegime);
  if (!harnessResult.ok) {
    return { kind: "unmapped", reason: `unknown_harness:${harnessResult.rawHarness}` };
  }

  let effort: ReasoningEffort;
  const trimmedMetaEffort = obs.rawEffort?.trim() ?? "";
  if (UNKNOWN_TOKEN_RX.test(obs.rawModelName)) {
    return { kind: "unmapped", reason: "unsupported_or_unknown_effort:unknown" };
  }
  const nameEffortRes = parseUniqueEffortFromText(obs.rawModelName, true);
  if (nameEffortRes.ambiguous) {
    return { kind: "unmapped", reason: `ambiguous_effort_in_name:${obs.rawModelName}` };
  }
  const nameEffort = nameEffortRes.effort;
  if (trimmedMetaEffort) {
    const parsedMeta = parseStrictEffortMetadata(trimmedMetaEffort);
    if (!parsedMeta) {
      return { kind: "unmapped", reason: `unsupported_or_unknown_effort:${trimmedMetaEffort}` };
    }
    if (nameEffort !== null && nameEffort !== parsedMeta) {
      const nameIsGenericThinking = nameEffort === "thinking";
      const metaIsGenericThinking = parsedMeta === "thinking";
      const metaIsPositiveConcrete = !metaIsGenericThinking && parsedMeta !== "none";
      const nameIsPositiveConcrete = !nameIsGenericThinking && nameEffort !== "none";
      if (nameIsGenericThinking && metaIsPositiveConcrete) {
        effort = parsedMeta;
      } else if (metaIsGenericThinking && nameIsPositiveConcrete) {
        effort = nameEffort;
      } else {
        return {
          kind: "unmapped",
          reason: `conflicting_effort_metadata:${nameEffort}!=${parsedMeta}`,
        };
      }
    } else {
      effort = parsedMeta;
    }
  } else if (nameEffort !== null) {
    effort = nameEffort;
  } else if (matchedAlias.requireExplicitEffort) {
    return {
      kind: "unmapped",
      reason: `ambiguous_mode_requires_explicit_effort:${matchedAlias.modelSlug}`,
    };
  } else {
    effort = matchedAlias.defaultEffort;
  }
  const configId = `${matchedAlias.provider}:${matchedAlias.modelSlug}:${effort}:${harnessResult.harness}:${harnessResult.regime}`;

  return {
    kind: "ok",
    config: {
      configId,
      provider: matchedAlias.provider,
      modelSlug: matchedAlias.modelSlug,
      displayName: matchedAlias.displayName,
      releaseDate: matchedAlias.releaseDate,
      effort,
      harness: harnessResult.harness,
      harnessRegime: harnessResult.regime,
    },
  };
}

export function resolveModelSlugFromString(
  rawModelName: string,
  rawProvider?: string | null,
): {
  provider: ProviderId;
  modelSlug: string;
  displayName: string;
  releaseDate: string | null;
} | null {
  const attribution = resolveAttributedProvider(rawModelName, rawProvider);
  if (!attribution.ok) return null;
  const attributedProvider = attribution.provider;

  const { preDateBase, reorderedPreDateBase, cleanedBase, strippedDateStamps, manualBudgetToken } =
    cleanModelNameForMatch(rawModelName);
  if (!cleanedBase || manualBudgetToken) return null;
  if (!attributedProvider && NON_ALLOWLIST_PROVIDER_REGEX.test(cleanedBase)) return null;

  const matched = matchAlias(preDateBase, reorderedPreDateBase, cleanedBase);
  if (!matched) return null;
  if (attributedProvider && attributedProvider !== matched.alias.provider) return null;
  for (const stamp of strippedDateStamps) {
    if (!dateStampMatchesAlias(stamp, matched.alias)) return null;
  }

  return {
    provider: matched.alias.provider,
    modelSlug: matched.alias.modelSlug,
    displayName: matched.alias.displayName,
    releaseDate: matched.alias.releaseDate,
  };
}
