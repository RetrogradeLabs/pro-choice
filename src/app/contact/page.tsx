import type { Metadata } from "next";
import Link from "next/link";
import { InfoPageShell } from "@/components/InfoPageShell";
import { loadCachedRelease } from "@/lib/release-cache";
import { formatUtcDate, ORG_GITHUB_URL, ORG_NAME, ORG_URL, SITE_URL } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Contact ProChoice",
  description:
    "How to reach Retrograde Labs regarding ProChoice benchmark data corrections, pricing updates, API integrations, or security disclosures.",
  alternates: {
    canonical: `${SITE_URL}/contact`,
  },
};

export default async function ContactPage() {
  const { snapshot } = await loadCachedRelease();
  const updated = formatUtcDate(snapshot.generatedAt);

  return (
    <InfoPageShell
      title="Contact ProChoice"
      subtitle="Report benchmark provenance issues, first-party API pricing changes, or technical questions to Retrograde Labs."
      updatedDate={updated}
    >
      <section className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">Official channels</h2>
        <p>
          ProChoice is published by{" "}
          <a
            href={ORG_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-(--ink)"
          >
            {ORG_NAME}
          </a>
          . For methodology inquiries, benchmark source corrections, or partnership requests, reach
          our team through the Retrograde Labs site or our GitHub organization.
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Organization website:{" "}
            <a
              href={ORG_URL}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[13px] underline underline-offset-4 hover:text-(--ink)"
            >
              {ORG_URL}
            </a>
          </li>
          <li>
            GitHub organization:{" "}
            <a
              href={ORG_GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[13px] underline underline-offset-4 hover:text-(--ink)"
            >
              {ORG_GITHUB_URL}
            </a>
          </li>
          <li>
            Security disclosure file:{" "}
            <a
              href={`${SITE_URL}/.well-known/security.txt`}
              className="font-mono text-[13px] underline underline-offset-4 hover:text-(--ink)"
            >
              {SITE_URL}/.well-known/security.txt
            </a>
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">
          Submitting data or pricing corrections
        </h2>
        <p>
          Every model score and first-party API price shown on ProChoice links directly to an
          audited upstream benchmark or official provider pricing table. When flagging a
          discrepancy, include the canonical model slug, exact reasoning effort tier, upstream
          benchmark URL, and the snapshot hash shown in{" "}
          <Link href="/docs" className="underline underline-offset-4 hover:text-(--ink)">
            /api/v1/snapshot
          </Link>{" "}
          so we can reproduce and verify the change deterministically.
        </p>
      </section>
    </InfoPageShell>
  );
}
