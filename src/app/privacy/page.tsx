import type { Metadata } from "next";
import Link from "next/link";
import { InfoPageShell } from "@/components/InfoPageShell";
import { loadCachedRelease } from "@/lib/release-cache";
import { formatUtcDate, ORG_NAME, ORG_URL, SITE_URL } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "ProChoice collects no personal accounts, sets no tracking cookies, and runs zero third-party ad or analytics trackers.",
  alternates: {
    canonical: `${SITE_URL}/privacy`,
  },
};

export default async function PrivacyPage() {
  const { snapshot } = await loadCachedRelease();
  const updated = formatUtcDate(snapshot.generatedAt);

  return (
    <InfoPageShell
      title="Privacy Policy"
      subtitle="ProChoice is a public benchmark reference designed to run without accounts, cookies, or third-party trackers."
      updatedDate={updated}
    >
      <section className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">
          What we do not collect
        </h2>
        <p>
          ProChoice does not offer user accounts, does not set advertising or cross-site tracking
          cookies, does not load third-party analytics pixels, and does not sell or broker visitor
          data. All web fonts are self-hosted at build time from our own origin so your browser
          makes no runtime requests to external font or tracker domains.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">
          Browser storage and infrastructure logs
        </h2>
        <p>
          If you toggle between light and dark mode, your browser stores a single preference string
          under <code className="font-mono text-[13px] text-(--ink)">localStorage</code> key{" "}
          <code className="font-mono text-[13px] text-(--ink)">prochoice-theme</code>. That value
          never leaves your device and is cleared when you switch back to your operating system
          default.
        </p>
        <p>
          Like any public website, HTTPS requests to{" "}
          <code className="font-mono text-[13px] text-(--ink)">prochoice.industries</code> pass
          through our hosting infrastructure on Vercel, which processes standard network metadata
          such as IP address, user agent, and requested path solely to deliver responses, enforce
          rate limits, and defend against denial-of-service traffic.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">Questions</h2>
        <p>
          ProChoice is operated by{" "}
          <a
            href={ORG_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-(--ink)"
          >
            {ORG_NAME}
          </a>
          . Reach us through the{" "}
          <Link href="/contact" className="underline underline-offset-4 hover:text-(--ink)">
            Contact page
          </Link>{" "}
          with any privacy questions.
        </p>
      </section>
    </InfoPageShell>
  );
}
