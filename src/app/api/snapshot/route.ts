import crypto from "node:crypto";
import { loadRelease } from "@/lib/data";

function matchesIfNoneMatch(header: string | null, strongEtag: string): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  return trimmed
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .some((tag) => tag === strongEtag);
}

const LINK_HEADER =
  '</openapi.json>; rel="service-desc"; type="application/openapi+json", </llms.txt>; rel="service-doc"; type="text/markdown"';

export async function GET(request: Request) {
  // Read request headers outside try/catch so Next.js 16 cacheComponents dynamic bailout propagates cleanly
  const ifNoneMatch = request.headers.get("if-none-match");

  try {
    const { snapshot, lifecycle } = await loadRelease();
    const body = JSON.stringify({ snapshot, lifecycle });
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
          Link: LINK_HEADER,
          "Access-Control-Allow-Origin": "*",
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
        Link: LINK_HEADER,
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error("Failed to serve ProChoice snapshot:", err);
    return Response.json({ error: "Snapshot unavailable" }, { status: 500 });
  }
}
