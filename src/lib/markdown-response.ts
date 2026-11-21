import crypto from "node:crypto";
import { loadRelease } from "@/lib/data";
import { buildHomeSummaries } from "@/lib/home-summaries";
import {
  parseDomainSlug,
  renderDomainMarkdown,
  renderHomeMarkdown,
  renderNotFoundMarkdown,
  renderStaticPageMarkdown,
} from "@/lib/seo";

const STATIC_INFO_BY_SLUG: Readonly<Record<string, "/docs" | "/about" | "/contact" | "/privacy">> =
  {
    docs: "/docs",
    about: "/about",
    contact: "/contact",
    privacy: "/privacy",
  };

function matchesIfNoneMatch(header: string | null, strongEtag: string): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  return trimmed
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .some((tag) => tag === strongEtag);
}

export async function buildMarkdownResponse(
  slug: string | null,
  notFoundPath: string | null,
  ifNoneMatch: string | null,
): Promise<Response> {
  if (notFoundPath !== null) {
    return new Response(renderNotFoundMarkdown(notFoundPath), {
      status: 404,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        Vary: "Accept",
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  }

  try {
    const { snapshot, lifecycle } = await loadRelease();
    let body: string;

    if (!slug || slug === "home" || slug === "index") {
      const summaries = buildHomeSummaries(snapshot.domains, snapshot.harnessLeaderboard);
      body = renderHomeMarkdown(snapshot, summaries);
    } else if (Object.hasOwn(STATIC_INFO_BY_SLUG, slug)) {
      body = renderStaticPageMarkdown(STATIC_INFO_BY_SLUG[slug]!, snapshot);
    } else {
      const domainId = parseDomainSlug(slug);
      if (!domainId) {
        return new Response(renderNotFoundMarkdown(`/${slug}`), {
          status: 404,
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            Vary: "Accept",
            "Access-Control-Allow-Origin": "*",
            "Cross-Origin-Resource-Policy": "cross-origin",
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
          "Cross-Origin-Resource-Policy": "cross-origin",
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
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  } catch (err) {
    console.error("Failed to render ProChoice Markdown:", err);
    return new Response("# 500 Internal Server Error\n\nSnapshot unavailable.\n", {
      status: 500,
      headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept" },
    });
  }
}
