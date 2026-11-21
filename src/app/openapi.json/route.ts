import { loadCachedRelease } from "@/lib/release-cache";
import { buildOpenApiSpec } from "@/lib/seo";

export async function GET() {
  const { snapshot } = await loadCachedRelease();
  const body = JSON.stringify(buildOpenApiSpec(snapshot), null, 2);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/openapi+json; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
