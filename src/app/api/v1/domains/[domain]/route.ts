import crypto from "node:crypto";
import { DOMAIN_BY_ID } from "@/config/benchmarks";
import { API_COMMON_HEADERS, methodNotAllowedProblem, problemJson } from "@/lib/api-response";
import { loadRelease } from "@/lib/data";
import { computeDomainHeadlineStats, DOMAIN_SLUGS, domainToSlug, parseDomainSlug } from "@/lib/seo";

function matchesIfNoneMatch(header: string | null, strongEtag: string): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  return trimmed
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .some((tag) => tag === strongEtag);
}

export async function GET(request: Request, context: { params: Promise<{ domain: string }> }) {
  const ifNoneMatch = request.headers.get("if-none-match");
  const { domain: rawSlug } = await context.params;
  const domainId = parseDomainSlug(rawSlug);

  if (!domainId) {
    return problemJson({
      status: 404,
      code: "unknown_domain",
      title: "Unknown Domain",
      detail: `Domain "${rawSlug}" does not exist.`,
      resolution: `Use one of the canonical domain slugs: ${DOMAIN_SLUGS.join(", ")}.`,
      instance: `/api/v1/domains/${encodeURIComponent(rawSlug)}`,
    });
  }

  try {
    const { snapshot } = await loadRelease();
    const meta = DOMAIN_BY_ID[domainId];
    const stats = computeDomainHeadlineStats(domainId, snapshot);
    const payload = {
      domainId,
      slug: domainToSlug(domainId),
      indexTitle: meta.indexTitle,
      epochVersion: meta.epochVersion,
      generatedAt: snapshot.generatedAt,
      snapshotHash: snapshot.snapshotHash,
      evaluatedCount: stats.evaluatedCount,
      frontierCount: stats.frontierCount,
      headlines: {
        budget: stats.budgetLabel,
        bestValue: stats.valueLabel,
        topScore: stats.topLabel,
      },
      frontier: stats.frontierEntries.map((e) => ({
        id: e.id,
        name: e.name,
        vendor: e.vendor,
        metric: e.metric,
        cost: e.cost,
        effort: e.effort,
      })),
    };

    const body = JSON.stringify(payload);
    const etag = `"${crypto.createHash("sha256").update(body).digest("hex").slice(0, 24)}"`;
    const cacheControl = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
    const cdnCacheControl = "public, s-maxage=3600, stale-while-revalidate=86400";

    if (matchesIfNoneMatch(ifNoneMatch, etag)) {
      return new Response(null, {
        status: 304,
        headers: {
          "Cache-Control": cacheControl,
          "CDN-Cache-Control": cdnCacheControl,
          ETag: etag,
          ...API_COMMON_HEADERS,
        },
      });
    }

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": cacheControl,
        "CDN-Cache-Control": cdnCacheControl,
        ETag: etag,
        ...API_COMMON_HEADERS,
      },
    });
  } catch (err) {
    console.error(`Failed to serve domain ${domainId}:`, err);
    return problemJson({
      status: 500,
      code: "snapshot_unavailable",
      title: "Snapshot Unavailable",
      detail: "The latest compiled ProChoice domain snapshot could not be loaded.",
      resolution: "Retry shortly or inspect https://prochoice.industries/docs.",
      instance: `/api/v1/domains/${encodeURIComponent(rawSlug)}`,
    });
  }
}

export function POST() {
  return methodNotAllowedProblem("/api/v1/domains");
}
export function PUT() {
  return methodNotAllowedProblem("/api/v1/domains");
}
export function PATCH() {
  return methodNotAllowedProblem("/api/v1/domains");
}
export function DELETE() {
  return methodNotAllowedProblem("/api/v1/domains");
}
