import type { Metadata } from "next";
import { BENCHMARKS, DOMAIN_BY_ID, DOMAINS } from "@/config/benchmarks";
import { PROVIDER_BY_ID, WESTERN_PROVIDER_IDS } from "@/config/providers";
import { formatCost, formatEffort, formatScore } from "@/lib/format";
import type { HomeDomainSummary } from "@/lib/home-summaries";
import { buildWeightMapFromAnchors } from "@/lib/math/aggregate";
import { normalizeHarnessVersion, selectControlledHarnessPicks } from "@/lib/math/harness-pareto";
import { computeProviderFrontier, extractVerdictPicks } from "@/lib/math/pareto";
import type {
  DomainId,
  DomainSnapshot,
  EvaluatedConfig,
  LifecycleReport,
  ProChoiceSnapshot,
} from "@/lib/schema";

export const SITE_URL = "https://prochoice.industries";
export const SITE_NAME = "ProChoice";
export const SITE_TITLE = "ProChoice | No Nonsense LLM Leaderboards & Rankings";
export const SITE_DESCRIPTION =
  "Compare frontier LLMs and coding agent harnesses by composite benchmark score and real dollar cost across six domains. Built by Retrograde Labs.";
export const ORG_NAME = "Retrograde Labs";
export const ORG_URL = "https://inretrograde.io";
export const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";

export type DomainSlug = "coding" | "writing" | "design" | "research" | "cyber" | "harnesses";

export const DOMAIN_SLUG_BY_ID: Readonly<Record<DomainId, DomainSlug>> = {
  coding: "coding",
  writing: "writing",
  design_code: "design",
  research: "research",
  cyber: "cyber",
  harnesses: "harnesses",
};

export const DOMAIN_ID_BY_SLUG: Readonly<Record<DomainSlug, DomainId>> = {
  coding: "coding",
  writing: "writing",
  design: "design_code",
  research: "research",
  cyber: "cyber",
  harnesses: "harnesses",
};

export const DOMAIN_SLUGS: readonly DomainSlug[] = [
  "coding",
  "writing",
  "design",
  "research",
  "cyber",
  "harnesses",
];

const DOMAIN_KEYWORDS: Readonly<Record<DomainId, readonly string[]>> = {
  coding: [
    "LLM coding leaderboard",
    "best coding LLM",
    "AI coding benchmarks",
    "FrontierCode",
    "Terminal-Bench",
    "DeepSWE",
    "SWE-bench Pro",
    "coding model cost comparison",
  ],
  writing: [
    "LLM writing leaderboard",
    "best writing LLM",
    "creative writing AI benchmarks",
    "EQ-Bench",
    "LMArena creative writing",
    "LLM writing cost comparison",
  ],
  design_code: [
    "LLM design leaderboard",
    "best frontend coding LLM",
    "web design AI benchmarks",
    "DesignArena",
    "WebDev Arena",
    "Vals Vibe Code",
  ],
  research: [
    "LLM research leaderboard",
    "best reasoning LLM",
    "AI research benchmarks",
    "GDPval-AA",
    "GPQA",
    "HLE",
    "FrontierMath",
    "research LLM cost comparison",
  ],
  cyber: [
    "LLM cybersecurity leaderboard",
    "best cyber AI model",
    "CWE-bench",
    "CyberArena",
    "AI vulnerability detection benchmarks",
  ],
  harnesses: [
    "coding agent harness leaderboard",
    "best AI coding agent",
    "FrontierHarness",
    "Terminal-Bench",
    "Claude Code vs Codex vs OpenCode",
    "coding agent cost comparison",
  ],
};

export function domainToSlug(domainId: DomainId): DomainSlug {
  return DOMAIN_SLUG_BY_ID[domainId];
}

export function domainToPathname(domainId: DomainId): `/${DomainSlug}` {
  return `/${DOMAIN_SLUG_BY_ID[domainId]}`;
}

export function domainToCanonicalUrl(domainId: DomainId): string {
  return `${SITE_URL}${domainToPathname(domainId)}`;
}

export function parseDomainSlug(raw: string | null | undefined): DomainId | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === "design_code") return "design_code";
  if (Object.hasOwn(DOMAIN_ID_BY_SLUG, cleaned)) {
    return DOMAIN_ID_BY_SLUG[cleaned as DomainSlug];
  }
  return null;
}

export function formatUtcDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso.slice(0, 10);
  return new Date(ms).toISOString().slice(0, 10);
}

export function serializeJsonLd(payload: unknown): string {
  return JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function getActiveBenchmarkNames(domainId: DomainId): string[] {
  return BENCHMARKS.filter(
    (b) => b.domainId === domainId && b.lifecycleState !== "CANDIDATE" && b.weight > 0,
  ).map((b) => b.name);
}

interface DomainHeadlineStats {
  topLabel: string | null;
  valueLabel: string | null;
  budgetLabel: string | null;
  evaluatedCount: number;
  frontierCount: number;
  benchmarkCount: number;
  frontierEntries: readonly {
    id: string;
    name: string;
    vendor: string;
    metric: string;
    cost: string;
    effort: string | null;
    anchorPrefix: "config" | "harness";
  }[];
}

export function computeDomainHeadlineStats(
  domainId: DomainId,
  snapshot: ProChoiceSnapshot,
): DomainHeadlineStats {
  const meta = DOMAIN_BY_ID[domainId];
  const benchmarkCount = getActiveBenchmarkNames(domainId).length;

  if (domainId === "harnesses") {
    const pooled =
      snapshot.harnessLeaderboard.slices.find((s) => s.sliceId === "_all") ??
      snapshot.harnessLeaderboard.slices[0];
    const entries = pooled?.entries ?? [];
    const frontier = entries
      .filter((e) => e.onFrontier)
      .toSorted((a, b) => b.passRate - a.passRate);
    const picks = selectControlledHarnessPicks(entries);
    const top = picks.find((p) => p.tag === "Top score" || p.tag === "Top pick")?.entry ?? null;
    const value = picks.find((p) => p.tag === "Best value")?.entry ?? null;
    const budget = picks.find((p) => p.tag === "Budget")?.entry ?? null;
    const fmt = (e: NonNullable<typeof top>) =>
      `${e.name} at ${e.passRate.toFixed(1)}% and ${formatCost(e.costPerTrialUsd, "usd_per_task")}`;

    return {
      topLabel: top ? fmt(top) : null,
      valueLabel: value ? fmt(value) : null,
      budgetLabel: budget ? fmt(budget) : null,
      evaluatedCount: entries.length,
      frontierCount: frontier.length,
      benchmarkCount: 3,
      frontierEntries: frontier.map((e) => {
        const v = normalizeHarnessVersion(e.version);
        return {
          id: e.harnessId,
          name: e.name,
          vendor: e.vendor,
          metric: `${e.passRate.toFixed(1)}%`,
          cost: formatCost(e.costPerTrialUsd, "usd_per_task"),
          effort: v
            ? v
                .split(" / ")
                .map((p) => `v${p.replace(/^v/i, "")}`)
                .join(" / ")
            : null,
          anchorPrefix: "harness",
        };
      }),
    };
  }

  const dom: DomainSnapshot = snapshot.domains[domainId];
  const defaultLabs = new Set<string>(WESTERN_PROVIDER_IDS);
  const eligible = dom.configs.filter(
    (c) =>
      defaultLabs.has(c.provider) &&
      c.harnessRegime === meta.defaultRegime &&
      c.eligibleForFrontier &&
      c.effectiveCostUsd !== null,
  );
  const byId = new Map<string, EvaluatedConfig>(eligible.map((c) => [c.id, c]));
  const weights = buildWeightMapFromAnchors(dom.anchorStats, meta.defaultRegime);
  const linkJointCov = dom.regimeMeta[meta.defaultRegime]?.linkJointCov;
  const env = computeProviderFrontier(
    eligible,
    undefined,
    undefined,
    weights,
    dom.anchorStats,
    linkJointCov,
  ).frontier;
  const verdicts = extractVerdictPicks(env, byId, {
    preferDistinctModelSlug: true,
    weightByBenchmark: weights,
    anchorStats: dom.anchorStats,
    linkJointCov,
  });

  const fmtCfg = (id: string | null) => {
    if (!id) return null;
    const cfg = byId.get(id);
    if (!cfg) return null;
    return `${cfg.displayName} at ${formatScore(cfg.score)} and ${formatCost(cfg.effectiveCostUsd, dom.costUnit)}`;
  };

  const frontierSorted = env
    .map((pt) => byId.get(pt.configId))
    .filter((c): c is EvaluatedConfig => c !== undefined && c.effectiveCostUsd !== null)
    .toSorted((a, b) => b.score - a.score);

  return {
    topLabel: fmtCfg(verdicts.maxId),
    valueLabel: fmtCfg(verdicts.defaultId),
    budgetLabel: fmtCfg(verdicts.budgetId),
    evaluatedCount: eligible.length,
    frontierCount: frontierSorted.length,
    benchmarkCount,
    frontierEntries: frontierSorted.map((cfg) => ({
      id: cfg.id,
      name: cfg.displayName,
      vendor: PROVIDER_BY_ID[cfg.provider].shortName,
      metric: formatScore(cfg.score),
      cost: formatCost(cfg.effectiveCostUsd, dom.costUnit),
      effort: formatEffort(cfg.effort),
      anchorPrefix: "config",
    })),
  };
}

export function buildDomainMetadata(domainId: DomainId, snapshot: ProChoiceSnapshot): Metadata {
  const meta = DOMAIN_BY_ID[domainId];
  const slug = domainToSlug(domainId);
  const canonicalUrl = domainToCanonicalUrl(domainId);
  const stats = computeDomainHeadlineStats(domainId, snapshot);
  const updated = formatUtcDate(snapshot.generatedAt);

  const summaryBits: string[] = [];
  if (stats.topLabel) summaryBits.push(`Top score: ${stats.topLabel}.`);
  if (stats.valueLabel && stats.valueLabel !== stats.topLabel) {
    summaryBits.push(`Best value: ${stats.valueLabel}.`);
  }
  const leadSentence =
    domainId === "harnesses"
      ? `Compare ${stats.evaluatedCount} coding agent harnesses across 8 open control models by pass rate and dollar cost.`
      : `Compare ${stats.evaluatedCount} LLM configurations across ${stats.benchmarkCount} benchmarks by score and real dollar cost.`;
  const description = [leadSentence, ...summaryBits, `Updated ${updated}.`].join(" ").slice(0, 160);

  const ogImageUrl = `${canonicalUrl}/opengraph-image`;

  return {
    title: meta.indexTitle,
    description,
    keywords: [...DOMAIN_KEYWORDS[domainId], "ProChoice", "Retrograde Labs", "Pareto frontier"],
    alternates: {
      canonical: canonicalUrl,
      types: {
        "text/markdown": `${SITE_URL}/${slug}.md`,
        "application/json": `${SITE_URL}/api/snapshot`,
      },
    },
    openGraph: {
      title: `${meta.indexTitle} | ${SITE_NAME}`,
      description,
      url: canonicalUrl,
      siteName: SITE_NAME,
      type: "website",
      locale: "en_US",
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: `${meta.indexTitle} score and dollar cost Pareto frontier`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${meta.indexTitle} | ${SITE_NAME}`,
      description,
      images: [ogImageUrl],
    },
  };
}

export function buildHomeMetadata(snapshot: ProChoiceSnapshot): Metadata {
  const updated = formatUtcDate(snapshot.generatedAt);
  const description = `Compare frontier LLMs and 25 coding agent harnesses across 6 composite indices and 45 live benchmarks by score and real dollar cost. Updated ${updated}.`;
  const ogImageUrl = `${SITE_URL}/opengraph-image`;

  return {
    title: { absolute: SITE_TITLE },
    description,
    alternates: {
      canonical: SITE_URL,
      types: {
        "text/markdown": `${SITE_URL}/index.md`,
        "application/json": `${SITE_URL}/api/snapshot`,
      },
    },
    openGraph: {
      title: SITE_TITLE,
      description,
      url: SITE_URL,
      siteName: SITE_NAME,
      type: "website",
      locale: "en_US",
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: "ProChoice LLM and coding agent harness leaderboards across six composite indices",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: SITE_TITLE,
      description,
      images: [ogImageUrl],
    },
  };
}

export function buildHomeJsonLd(
  snapshot: ProChoiceSnapshot,
  homeSummaries: readonly HomeDomainSummary[],
): Record<string, unknown> {
  const summaryById = new Map(homeSummaries.map((s) => [s.domainId, s]));
  const orgId = `${ORG_URL}/#organization`;
  const siteId = `${SITE_URL}/#website`;

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": orgId,
        name: ORG_NAME,
        url: ORG_URL,
      },
      {
        "@type": "WebSite",
        "@id": siteId,
        name: SITE_NAME,
        alternateName: "ProChoice LLM Leaderboards",
        url: SITE_URL,
        description: SITE_DESCRIPTION,
        inLanguage: "en-US",
        publisher: { "@id": orgId },
      },
      {
        "@type": "DataCatalog",
        "@id": `${SITE_URL}/#catalog`,
        name: "ProChoice Composite LLM and Harness Indices",
        description:
          "Daily benchmark composites comparing frontier language models and coding agent harnesses by score and real dollar cost.",
        url: SITE_URL,
        dateModified: snapshot.generatedAt,
        license: LICENSE_URL,
        creator: { "@id": orgId },
        publisher: { "@id": orgId },
        dataset: DOMAINS.map((meta) => {
          const sum = summaryById.get(meta.id);
          return {
            "@type": "Dataset",
            name: meta.indexTitle,
            description: sum?.tagline ?? meta.description,
            url: domainToCanonicalUrl(meta.id),
            version: meta.epochVersion,
            dateModified: snapshot.generatedAt,
            license: LICENSE_URL,
            isAccessibleForFree: true,
          };
        }),
      },
      {
        "@type": "ItemList",
        name: "ProChoice Composite Indices",
        numberOfItems: DOMAINS.length,
        itemListElement: DOMAINS.map((meta, idx) => ({
          "@type": "ListItem",
          position: idx + 1,
          name: meta.indexTitle,
          url: domainToCanonicalUrl(meta.id),
        })),
      },
    ],
  };
}

export function buildDomainJsonLd(
  domainId: DomainId,
  snapshot: ProChoiceSnapshot,
): Record<string, unknown> {
  const meta = DOMAIN_BY_ID[domainId];
  const slug = domainToSlug(domainId);
  const canonicalUrl = domainToCanonicalUrl(domainId);
  const stats = computeDomainHeadlineStats(domainId, snapshot);
  const benchmarkNames = getActiveBenchmarkNames(domainId);
  const orgId = `${ORG_URL}/#organization`;

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": orgId,
        name: ORG_NAME,
        url: ORG_URL,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: SITE_NAME,
            item: SITE_URL,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: meta.indexTitle,
            item: canonicalUrl,
          },
        ],
      },
      {
        "@type": "Dataset",
        "@id": `${canonicalUrl}#dataset`,
        name: `ProChoice ${meta.indexTitle}`,
        description: `${meta.description} Evaluates ${stats.evaluatedCount} ${domainId === "harnesses" ? "coding harnesses" : "model configurations"} on a shared score and dollar cost Pareto frontier.`,
        url: canonicalUrl,
        identifier: `${meta.epochVersion}:${snapshot.snapshotHash}`,
        version: meta.epochVersion,
        dateModified: snapshot.generatedAt,
        inLanguage: "en-US",
        isAccessibleForFree: true,
        license: LICENSE_URL,
        creator: { "@id": orgId },
        publisher: { "@id": orgId },
        measurementTechnique:
          domainId === "harnesses"
            ? "Controlled multi-benchmark pass rate and dollar cost per run merged across FrontierHarness v1.1 and Harness Leaderboard."
            : "Equal-1.0 anchor standardization with connected heteroscedastic REML Empirical Bayes pooling and bootstrap Pareto frontier analysis.",
        variableMeasured: [
          domainId === "harnesses" ? "Controlled pass rate (%)" : "Composite benchmark score",
          meta.costAxisLabel,
          ...benchmarkNames,
        ],
        distribution: [
          {
            "@type": "DataDownload",
            encodingFormat: "application/json",
            contentUrl: `${SITE_URL}/api/snapshot`,
          },
          {
            "@type": "DataDownload",
            encodingFormat: "text/markdown",
            contentUrl: `${SITE_URL}/${slug}.md`,
          },
        ],
      },
      {
        "@type": "ItemList",
        name: `${meta.indexTitle} Pareto Frontier Leaders`,
        itemListOrder: "https://schema.org/ItemListOrderDescending",
        numberOfItems: stats.frontierEntries.length,
        itemListElement: stats.frontierEntries.slice(0, 15).map((entry, idx) => ({
          "@type": "ListItem",
          position: idx + 1,
          name: entry.effort ? `${entry.name} (${entry.effort})` : entry.name,
          description: `${entry.vendor}: ${entry.metric} at ${entry.cost}`,
          url: `${canonicalUrl}#${entry.anchorPrefix}-${encodeURIComponent(entry.id)}`,
        })),
      },
    ],
  };
}

export function renderHomeMarkdown(
  snapshot: ProChoiceSnapshot,
  homeSummaries: readonly HomeDomainSummary[],
): string {
  const updated = formatUtcDate(snapshot.generatedAt);
  const summaryById = new Map(homeSummaries.map((s) => [s.domainId, s]));
  const lines: string[] = [
    `# ${SITE_TITLE}`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    `- Canonical URL: ${SITE_URL}`,
    `- Snapshot hash: \`${snapshot.snapshotHash}\``,
    `- Updated: ${updated}`,
    `- Machine-readable JSON: ${SITE_URL}/api/snapshot`,
    `- Full Markdown compendium: ${SITE_URL}/llms-full.txt`,
    "",
    "## Composite indices",
    "",
    "| Index | Top score | Secondary pick | URL | Markdown |",
    "| :--- | :--- | :--- | :--- | :--- |",
  ];

  for (const meta of DOMAINS) {
    const sum = summaryById.get(meta.id);
    const slug = domainToSlug(meta.id);
    const top = sum?.topPick
      ? `${sum.topPick.name}${sum.topPick.effort ? ` (${sum.topPick.effort})` : ""} ${sum.topPick.metricText} @ ${sum.topPick.costText}`
      : "N/A";
    const sec = sum?.secondaryPick
      ? `${sum.secondaryTag}: ${sum.secondaryPick.name}${sum.secondaryPick.effort ? ` (${sum.secondaryPick.effort})` : ""} ${sum.secondaryPick.metricText} @ ${sum.secondaryPick.costText}`
      : "N/A";
    lines.push(
      `| ${meta.indexTitle} | ${top} | ${sec} | ${SITE_URL}/${slug} | ${SITE_URL}/${slug}.md |`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

export function renderDomainMarkdown(
  domainId: DomainId,
  snapshot: ProChoiceSnapshot,
  lifecycle: LifecycleReport,
): string {
  const meta = DOMAIN_BY_ID[domainId];
  const slug = domainToSlug(domainId);
  const updated = formatUtcDate(snapshot.generatedAt);
  const stats = computeDomainHeadlineStats(domainId, snapshot);
  const benchmarks = BENCHMARKS.filter(
    (b) => b.domainId === domainId && b.lifecycleState !== "CANDIDATE" && b.weight > 0,
  );

  const lines: string[] = [
    `# ${meta.indexTitle}`,
    "",
    `> ${meta.description}`,
    "",
    `- Canonical URL: ${SITE_URL}/${slug}`,
    `- Epoch version: \`${meta.epochVersion}\``,
    `- Snapshot hash: \`${snapshot.snapshotHash}\``,
    `- Updated: ${updated}`,
    `- Cost axis: ${meta.costAxisLabel}`,
    `- Evaluated entries: ${stats.evaluatedCount}`,
    "",
    "## Headline picks",
    "",
  ];

  if (stats.budgetLabel) lines.push(`- Budget: ${stats.budgetLabel}`);
  if (stats.valueLabel) lines.push(`- Best value: ${stats.valueLabel}`);
  if (stats.topLabel) lines.push(`- Top score: ${stats.topLabel}`);

  lines.push(
    "",
    "## Pareto frontier",
    "",
    domainId === "harnesses"
      ? "| Rank | Harness | Version | Vendor | Pass rate | Cost / run |"
      : "| Rank | Model | Effort | Provider | Score | Cost / task |",
    "| :--- | :--- | :--- | :--- | :--- | :--- |",
  );

  stats.frontierEntries.forEach((entry, idx) => {
    lines.push(
      `| ${idx + 1} | ${entry.name} | ${entry.effort ?? "-"} | ${entry.vendor} | ${entry.metric} | ${entry.cost} |`,
    );
  });

  if (domainId !== "harnesses" && benchmarks.length > 0) {
    lines.push("", "## Active benchmarks", "");
    const auditByBm = new Map(
      lifecycle.audits
        .filter((a) => a.domainId === domainId)
        .map((a) => [a.benchmarkId, a.lifecycleState]),
    );
    for (const bm of benchmarks) {
      const state = auditByBm.get(bm.id) ?? bm.lifecycleState;
      lines.push(`- ${bm.name} (${bm.version}, ${state}): ${bm.sourceUrl}`);
    }
  } else if (domainId === "harnesses") {
    lines.push(
      "",
      "## Controlled benchmark sources",
      "",
      "- FrontierHarness Eval v1.1 (22 harnesses across 5 open control models): https://frontierharness.org/",
      "- Harness Leaderboard (12 harnesses across 4 open control models): https://joelniklaus-harness-leaderboard.hf.space/",
    );
  }

  lines.push("", `Full JSON dataset: ${SITE_URL}/api/snapshot`, "");
  return lines.join("\n");
}

export function renderLlmsTxt(
  snapshot: ProChoiceSnapshot,
  homeSummaries: readonly HomeDomainSummary[],
): string {
  const updated = formatUtcDate(snapshot.generatedAt);
  const summaryById = new Map(homeSummaries.map((s) => [s.domainId, s]));
  const lines: string[] = [
    `# ${SITE_NAME}`,
    "",
    `> ${SITE_DESCRIPTION} Updated daily from 18 public benchmark and pricing sources.`,
    "",
    `Current snapshot \`${snapshot.snapshotHash}\` was published on ${updated}. Models that cost more while scoring lower are pruned from the default frontier so readers see only Pareto-optimal picks.`,
    "",
    "## Composite indices",
    "",
  ];

  for (const meta of DOMAINS) {
    const slug = domainToSlug(meta.id);
    const sum = summaryById.get(meta.id);
    const leader = sum?.topPick
      ? ` Top score: ${sum.topPick.name} at ${sum.topPick.metricText} (${sum.topPick.costText}).`
      : "";
    lines.push(`- [${meta.indexTitle}](${SITE_URL}/${slug}.md): ${meta.description}${leader}`);
  }

  lines.push(
    "",
    "## Machine-readable endpoints",
    "",
    `- [Full leaderboard compendium](${SITE_URL}/llms-full.txt): All six indices, headline picks, Pareto frontiers, and benchmark citations in one Markdown file.`,
    `- [Live snapshot JSON API](${SITE_URL}/api/snapshot): Complete typed benchmark snapshot and lifecycle audit payload with strong ETag caching.`,
    `- [OpenAPI 3.1 specification](${SITE_URL}/openapi.json): Endpoint documentation for the public read-only JSON and Markdown interfaces.`,
    `- [RFC 9727 API catalog](${SITE_URL}/.well-known/api-catalog): Linkset index for automated API discovery.`,
    `- [XML sitemap](${SITE_URL}/sitemap.xml): Canonical page index across all six domains.`,
    "",
    "## Content negotiation",
    "",
    "Send `Accept: text/markdown` to `/` or any domain path (`/coding`, `/writing`, `/design`, `/research`, `/cyber`, `/harnesses`) to receive clean Markdown directly without HTML boilerplate.",
    "",
  );

  return lines.join("\n");
}

export function renderLlmsFullTxt(
  snapshot: ProChoiceSnapshot,
  homeSummaries: readonly HomeDomainSummary[],
  lifecycle: LifecycleReport,
): string {
  const sections: string[] = [renderHomeMarkdown(snapshot, homeSummaries)];
  for (const meta of DOMAINS) {
    sections.push(`---\n\n${renderDomainMarkdown(meta.id, snapshot, lifecycle)}`);
  }
  return sections.join("\n");
}

export function buildOpenApiSpec(snapshot: ProChoiceSnapshot): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "ProChoice Public Benchmark API",
      version: `1.0.0+${snapshot.snapshotHash.slice(0, 8)}`,
      description:
        "Public, unauthenticated, read-only JSON and Markdown endpoints for ProChoice LLM and coding agent harness Pareto leaderboards.",
      contact: {
        name: ORG_NAME,
        url: ORG_URL,
      },
      license: {
        name: "CC BY 4.0",
        url: LICENSE_URL,
      },
    },
    servers: [{ url: SITE_URL, description: "Production" }],
    paths: {
      "/api/snapshot": {
        get: {
          operationId: "getLatestSnapshot",
          summary: "Get the complete ProChoice benchmark snapshot and lifecycle audit report",
          responses: {
            "200": {
              description: "Validated snapshot and lifecycle JSON payload",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["snapshot", "lifecycle"],
                    properties: {
                      snapshot: { type: "object" },
                      lifecycle: { type: "object" },
                    },
                  },
                },
              },
            },
            "304": { description: "Not Modified when ETag matches If-None-Match" },
          },
        },
      },
      "/api/markdown": {
        get: {
          operationId: "getLeaderboardMarkdown",
          summary: "Get a Markdown summary for the home page or one composite domain index",
          parameters: [
            {
              name: "d",
              in: "query",
              required: false,
              description: "Optional domain slug",
              schema: {
                type: "string",
                enum: [...DOMAIN_SLUGS],
              },
            },
          ],
          responses: {
            "200": {
              description: "Markdown representation of the requested leaderboard",
              content: {
                "text/markdown": {
                  schema: { type: "string" },
                },
              },
            },
            "404": { description: "Unknown domain slug" },
          },
        },
      },
    },
  };
}

export function buildApiCatalog(): Record<string, unknown> {
  return {
    linkset: [
      {
        anchor: `${SITE_URL}/api/snapshot`,
        "service-desc": [
          {
            href: `${SITE_URL}/openapi.json`,
            type: "application/openapi+json",
          },
        ],
        "service-doc": [
          {
            href: `${SITE_URL}/llms.txt`,
            type: "text/markdown",
          },
        ],
      },
    ],
  };
}
