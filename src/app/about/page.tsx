import type { Metadata } from "next";
import Link from "next/link";
import { InfoPageShell } from "@/components/InfoPageShell";
import { loadCachedRelease } from "@/lib/release-cache";
import { formatUtcDate, LICENSE_URL, ORG_GITHUB_URL, ORG_NAME, ORG_URL, SITE_URL } from "@/lib/seo";

export const metadata: Metadata = {
  title: "About ProChoice",
  description:
    "How Retrograde Labs compiles daily LLM and coding agent harness Pareto frontiers across 45 active benchmarks and 18 live public sources.",
  alternates: {
    canonical: `${SITE_URL}/about`,
  },
};

export default async function AboutPage() {
  const { snapshot } = await loadCachedRelease();
  const updated = formatUtcDate(snapshot.generatedAt);

  return (
    <InfoPageShell
      title="About ProChoice"
      subtitle="Transparent, daily LLM and coding agent harness rankings built by Retrograde Labs."
      updatedDate={updated}
    >
      <section className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">Why ProChoice exists</h2>
        <p>
          Public AI leaderboards routinely scatter scores across dozens of incompatible scales while
          hiding real task cost, mixing reasoning effort tiers, or burying coding-agent harness
          effects inside model scores. ProChoice solves that by placing models on a shared composite
          scale per domain and plotting score directly against real dollar cost per task. Models
          that cost more while scoring lower are removed from the default frontier so teams can pick
          the strongest option for a real budget in seconds.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">Methodology in brief</h2>
        <p>
          Each day, ProChoice ingests 18 mandatory public benchmark and first-party pricing feeds
          covering 9 model providers: Anthropic, OpenAI, Google, SpaceXAI, Meta, DeepSeek, Moonshot,
          Alibaba, and Zhipu. All 45 active benchmarks contribute directly to their domain composite
          with zero shadow candidates. Scores are aligned via equal-1.0 anchor standardization and
          pooled with heteroscedastic REML Empirical Bayes using cross-benchmark joint-jackknife
          linking uncertainty. Missing task costs for non-retired models with verified first-party
          API pricing are estimated on each domain&apos;s homogeneous cost axis with active-set
          monotone effort regression and propagated through bootstrap Pareto probabilities.
        </p>
        <p>
          Controlled coding-agent harness evaluations live in their own{" "}
          <Link href="/harnesses" className="underline underline-offset-4 hover:text-(--ink)">
            Harnesses Composite Index
          </Link>
          , combining FrontierHarness v1.1 and Harness Leaderboard into one 25-harness board across
          8 open control models so harness design and model choice are never conflated.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">
          Maintainer and data license
        </h2>
        <p>
          ProChoice is built and maintained by{" "}
          <a
            href={ORG_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-(--ink)"
          >
            {ORG_NAME}
          </a>{" "}
          (
          <a
            href={ORG_GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-(--ink)"
          >
            github.com/RetrogradeLabs
          </a>
          ). Compiled ProChoice composite indices and API outputs are published under{" "}
          <a
            href={LICENSE_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-(--ink)"
          >
            Creative Commons Attribution 4.0 (CC BY 4.0)
          </a>{" "}
          with full upstream attribution to each source benchmark. See the{" "}
          <Link href="/docs" className="underline underline-offset-4 hover:text-(--ink)">
            API documentation
          </Link>{" "}
          for direct JSON and Markdown access.
        </p>
      </section>
    </InfoPageShell>
  );
}
