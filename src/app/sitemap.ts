import type { MetadataRoute } from "next";
import { DOMAINS } from "@/config/benchmarks";
import { loadCachedRelease } from "@/lib/release-cache";
import { domainToCanonicalUrl, SITE_URL } from "@/lib/seo";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { snapshot } = await loadCachedRelease();
  const lastModified = new Date(snapshot.generatedAt);

  return [
    {
      url: SITE_URL,
      lastModified,
      changeFrequency: "daily",
      priority: 1.0,
      images: [`${SITE_URL}/opengraph-image`],
    },
    ...DOMAINS.map((meta) => {
      const url = domainToCanonicalUrl(meta.id);
      return {
        url,
        lastModified,
        changeFrequency: "daily" as const,
        priority: 0.9,
        images: [`${url}/opengraph-image`],
      };
    }),
  ];
}
