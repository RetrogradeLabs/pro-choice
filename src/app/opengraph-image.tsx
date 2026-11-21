import { OG_CONTENT_TYPE, OG_IMAGE_SIZE, renderHomeOgImage } from "@/lib/og-card";
import { loadCachedRelease } from "@/lib/release-cache";

export const alt = "ProChoice | No Nonsense LLM Leaderboards & Rankings";
export const size = OG_IMAGE_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function OpenGraphImage() {
  const { snapshot } = await loadCachedRelease();
  return renderHomeOgImage(snapshot);
}
