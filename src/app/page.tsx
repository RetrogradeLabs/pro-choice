import type { Metadata } from "next";
import { ProChoiceGallery } from "@/components/ProChoiceGallery";
import { defaultGalleryState } from "@/lib/gallery-url";
import { buildHomeSummaries } from "@/lib/home-summaries";
import { loadCachedRelease } from "@/lib/release-cache";
import { buildHomeJsonLd, buildHomeMetadata, serializeJsonLd } from "@/lib/seo";

export async function generateMetadata(): Promise<Metadata> {
  const { snapshot } = await loadCachedRelease();
  return buildHomeMetadata(snapshot);
}

export default async function HomePage() {
  const { snapshot } = await loadCachedRelease();
  const homeSummaries = buildHomeSummaries(snapshot.domains, snapshot.harnessLeaderboard);
  const jsonLd = buildHomeJsonLd(snapshot, homeSummaries);
  const snapshotMeta = {
    schemaVersion: snapshot.schemaVersion,
    generatedAt: snapshot.generatedAt,
    snapshotHash: snapshot.snapshotHash,
    sources: [],
  };

  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped static JSON-LD graph
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
      <ProChoiceGallery
        snapshotMeta={snapshotMeta}
        initialDomain={null}
        harnessLeaderboard={null}
        homeSummaries={homeSummaries}
        lifecycle={null}
        initialState={defaultGalleryState("home")}
        initialUrl="/"
      />
    </>
  );
}
