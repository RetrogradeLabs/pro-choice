import { buildHomeSummaries } from "@/lib/home-summaries";
import { loadCachedRelease } from "@/lib/release-cache";
import { renderLlmsTxt } from "@/lib/seo";

export async function GET() {
  const { snapshot } = await loadCachedRelease();
  const summaries = buildHomeSummaries(snapshot.domains, snapshot.harnessLeaderboard);
  const body = renderLlmsTxt(snapshot, summaries);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
