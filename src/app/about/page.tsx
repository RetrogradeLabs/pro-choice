import type { Metadata } from "next";
import Link from "next/link";
import { InfoPageShell } from "@/components/InfoPageShell";
import { loadCachedRelease } from "@/lib/release-cache";
import {
  CODE_LICENSE_URL,
  formatUtcDate,
  LICENSE_URL,
  ORG_NAME,
  ORG_URL,
  REPO_URL,
  SITE_URL,
} from "@/lib/seo";

export const metadata: Metadata = {
  title: "About ProChoice",
  description:
    "How ProChoice selects benchmarks, combines scores, and compares model quality against task cost.",
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
          that cost more while scoring lower are removed from the default frontier so readers can
          compare the cost of moving to a higher estimated score.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">Methodology in brief</h2>
        <p>
          Each day, ProChoice checks {snapshot.sources.length} benchmark and pricing feeds covering
          9 model providers: Anthropic, OpenAI, Google, SpaceXAI, Meta, DeepSeek, Moonshot, Alibaba,
          and Zhipu. This release tracks{" "}
          {Object.values(snapshot.domains).reduce((n, d) => n + d.activeBenchmarkIds.length, 0)}{" "}
          active benchmarks. Coding, Writing, Design and Research give each task family equal total
          weight. An overall recommendation requires direct results from multiple feeds and a lead
          over every eligible alternative on shared tests. Scores are aligned via provider-balanced
          anchor standardization and pooled with heteroscedastic REML Empirical Bayes using
          cross-benchmark joint-jackknife linking uncertainty. Missing task costs for non-retired
          models with verified first-party API pricing are estimated on each domain&apos;s
          homogeneous cost axis with active-set monotone effort regression and propagated through
          bootstrap Pareto probabilities.
        </p>
        <p>
          Controlled coding-agent harness evaluations live in their own{" "}
          <Link href="/harnesses" className="underline underline-offset-4 hover:text-(--ink)">
            Harnesses Composite Index
          </Link>
          , where Terminal-Bench 4.0 and DeepSWE 1.1 each have their own pass-rate and cost
          comparisons. Select a test model within either benchmark.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">
          Open source, maintainer, and licenses
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
          </a>
          . The complete web app, econometric scoring math, and daily ingestion pipeline are open
          source under the{" "}
          <a
            href={CODE_LICENSE_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-(--ink)"
          >
            MIT License
          </a>{" "}
          at{" "}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-(--ink)"
          >
            github.com/RetrogradeLabs/pro-choice
          </a>
          . Compiled ProChoice composite indices and API outputs are published under{" "}
          <a
            href={LICENSE_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-(--ink)"
          >
            Creative Commons Attribution 4.0
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
