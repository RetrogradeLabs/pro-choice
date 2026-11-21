import { OG_CONTENT_TYPE, OG_IMAGE_SIZE, renderDomainOgImage } from "@/lib/og-card";
import { loadCachedRelease } from "@/lib/release-cache";

export const alt = "Design Composite Index | ProChoice";
export const size = OG_IMAGE_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function DesignOpenGraphImage() {
  const { snapshot } = await loadCachedRelease();
  return renderDomainOgImage("design_code", snapshot);
}
