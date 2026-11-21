import crypto from "node:crypto";
import { loadRelease } from "@/lib/data";
import { buildHomeSummaries } from "@/lib/home-summaries";
import { parseDomainSlug, renderDomainMarkdown, renderHomeMarkdown } from "@/lib/seo";

function matchesIfNoneMatch(header: string | null, strongEtag: string): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  return trimmed
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .some((tag) => tag === strongEtag);
}

export async function GET(request: Request) {
  // Read request metadata outside try/catch so Next.js 16 cacheComponents dynamic bailout propagates cleanly
  const reqUrl = new URL(request.url);
  const rawDomain = reqUrl.searchParams.get("d");
  const ifNoneMatch = request.headers.get("if-none-match");

  try {
    const { snapshot, lifecycle } = await loadRelease();
    let body: string;

    if (!rawDomain) {
      const summaries = buildHomeSummaries(snapshot.domains, snapshot.harnessLeaderboard);
      body = renderHomeMarkdown(snapshot, summaries);
    } else {
      const domainId = parseDomainSlug(rawDomain);
      if (!domainId) {
        return new Response("# 404 Not Found\n\nUnknown ProChoice domain.\n", {
          status: 404,
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            Vary: "Accept",
          },
        });
      }
      body = renderDomainMarkdown(domainId, snapshot, lifecycle);
    }

    const etag = `"${crypto.createHash("sha256").update(body).digest("hex").slice(0, 24)}"`;
    const cacheControl = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
    const approxTokens = String(Math.max(1, Math.ceil(body.length / 4)));

    if (matchesIfNoneMatch(ifNoneMatch, etag)) {
      return new Response(null, {
        status: 304,
        headers: {
          "Cache-Control": cacheControl,
          "CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
          ETag: etag,
          Vary: "Accept",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": cacheControl,
        "CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
        ETag: etag,
        Vary: "Accept",
        "X-Markdown-Tokens": approxTokens,
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error("Failed to render ProChoice Markdown:", err);
    return new Response("# 500 Internal Server Error\n\nSnapshot unavailable.\n", {
      status: 500,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }
}
