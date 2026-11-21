import crypto from "node:crypto";
import { API_COMMON_HEADERS, methodNotAllowedProblem, problemJson } from "@/lib/api-response";
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
    console.error("Failed to serve ProChoice snapshot:", err);
    return problemJson({
      status: 500,
      code: "snapshot_unavailable",
      title: "Snapshot Unavailable",
      detail: "The latest compiled ProChoice snapshot could not be loaded.",
      resolution: "Retry shortly or inspect https://prochoice.industries/docs.",
      instance: "/api/snapshot",
    });
  }
}

export function POST() {
  return methodNotAllowedProblem("/api/snapshot");
}
export function PUT() {
  return methodNotAllowedProblem("/api/snapshot");
}
export function PATCH() {
  return methodNotAllowedProblem("/api/snapshot");
}
export function DELETE() {
  return methodNotAllowedProblem("/api/snapshot");
}
