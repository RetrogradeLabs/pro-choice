import type { Metadata } from "next";
import { ProChoiceGallery } from "@/components/ProChoiceGallery";
import { defaultGalleryState } from "@/lib/gallery-url";
import { buildHomeSummaries } from "@/lib/home-summaries";
import { loadCachedRelease } from "@/lib/release-cache";
import type { DomainId, DomainSnapshot } from "@/lib/schema";
import {
  buildDomainJsonLd,
  buildDomainMetadata,
  domainToPathname,
  serializeJsonLd,
} from "@/lib/seo";

function stripDrawerOnlyFields(domain: DomainSnapshot): DomainSnapshot {
  return {
    ...domain,
    provisionalConfigs: [],
    ...(domain.observedBenchmarks
      ? { observedBenchmarks: domain.observedBenchmarks.map((b) => ({ ...b, rows: [] })) }
      : {}),
  };
}

export async function getDomainPageMetadata(domainId: DomainId): Promise<Metadata> {
  const { snapshot } = await loadCachedRelease();
  return buildDomainMetadata(domainId, snapshot);
}

export async function renderDomainPage(domainId: DomainId) {
  const { snapshot } = await loadCachedRelease();
  const homeSummaries = buildHomeSummaries(snapshot.domains, snapshot.harnessLeaderboard);
  const jsonLd = buildDomainJsonLd(domainId, snapshot);
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
        initialDomain={
          domainId === "harnesses" ? null : stripDrawerOnlyFields(snapshot.domains[domainId])
        }
        harnessLeaderboard={domainId === "harnesses" ? snapshot.harnessLeaderboard : null}
        homeSummaries={homeSummaries}
        lifecycle={null}
        initialState={defaultGalleryState(domainId)}
        initialUrl={domainToPathname(domainId)}
      />
    </>
  );
}
