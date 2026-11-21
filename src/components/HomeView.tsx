"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { MouseEvent } from "react";
import { DOMAINS } from "@/config/benchmarks";
import { formatScoreEvidence } from "@/lib/format";
import type { HomeDomainSummary, HomeSparkPoint } from "@/lib/home-summaries";
import type { DomainId } from "@/lib/schema";
import { domainToPathname, REPO_URL } from "@/lib/seo";
import { ProviderMarkerIcon } from "./ProviderMarkerIcon";

function isModifiedClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

interface HomeViewProps {
  summaries: readonly HomeDomainSummary[];
  onSelectDomain: (domainId: DomainId) => void;
}

function MiniParetoSparkline({ points }: { points: readonly HomeSparkPoint[] }) {
  if (points.length < 2) return null;
  const w = 104;
  const h = 34;
  const pad = 4;
  const mapped = points.map((p) => ({
    x: pad + p.x * (w - pad * 2),
    y: h - pad - p.y * (h - pad * 2),
  }));
  const lineD = mapped
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
  const areaD = `${lineD} L ${mapped[mapped.length - 1]!.x.toFixed(1)} ${(h - pad).toFixed(1)} L ${mapped[0]!.x.toFixed(1)} ${(h - pad).toFixed(1)} Z`;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      className="shrink-0 overflow-visible"
    >
      <path d={areaD} fill="var(--interactive)" fillOpacity={0.07} />
      <path
        d={lineD}
        fill="none"
        stroke="var(--ink-secondary)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {mapped.map((pt, idx) => {
        const isEnd = idx === mapped.length - 1;
        return (
          <circle
            key={`${pt.x}-${pt.y}`}
            cx={pt.x}
            cy={pt.y}
            r={isEnd ? 2.6 : 1.8}
            fill={isEnd ? "var(--interactive)" : "var(--ink)"}
          />
        );
      })}
    </svg>
  );
}

export function HomeView({ summaries, onSelectDomain }: HomeViewProps) {
  const summaryById = new Map(summaries.map((s) => [s.domainId, s]));

  return (
    <div className="bg-(--bg)">
      {/* Clean Retrograde-style editorial hero */}
      <section className="px-5 pt-12 pb-8 sm:px-9 sm:pt-16 sm:pb-9 lg:px-11 lg:pt-24 lg:pb-10">
        <h1 className="font-display text-[28px] leading-[1.12] font-normal tracking-tight text-(--ink) sm:text-[34px] lg:whitespace-nowrap lg:text-[38px]">
          No Nonsense LLM Leaderboards &amp; Rankings
        </h1>

        <p className="mt-4 max-w-240 text-[15px] leading-[1.65] text-pretty text-(--ink-muted)">
          ProChoice compares AI models by score and real dollar cost across six composite indices.{" "}
          <strong className="font-medium text-(--ink)">
            Models that cost more while scoring lower are left off the chart
          </strong>
          . Open a score to see its evidence and uncertainty.
        </p>
      </section>

      {/* Immediate answer ledger aligned to page gutter */}
      <section aria-label="Composite indices" className="border-y border-(--border)">
        <div className="grid grid-cols-1 divide-y divide-(--border) sm:grid-cols-2 sm:divide-y-0">
          {DOMAINS.map((meta, idx) => {
            const sum = summaryById.get(meta.id);
            const isLeftCol = idx % 2 === 0;
            const hasTopBorder = idx >= 2;

            return (
              <article
                key={meta.id}
                className={`group relative flex flex-col justify-between bg-(--surface) px-5 py-6 text-left transition-colors hover:bg-(--subtle)/70 sm:py-5 ${
                  isLeftCol
                    ? "sm:border-r sm:border-(--border) sm:pl-9 sm:pr-7 lg:pl-11 lg:pr-9"
                    : "sm:pl-7 sm:pr-9 lg:pl-9 lg:pr-11"
                } ${hasTopBorder ? "sm:border-t sm:border-(--border)" : ""}`}
              >
                <div>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="font-display text-[22px] leading-tight font-normal tracking-[-0.02em] text-(--ink)">
                        <Link
                          href={domainToPathname(meta.id)}
                          prefetch={false}
                          onClick={(e) => {
                            if (isModifiedClick(e)) return;
                            e.preventDefault();
                            onSelectDomain(meta.id);
                          }}
                          className="inline-flex cursor-pointer items-center gap-2 text-left after:absolute after:inset-0 focus-visible:outline-none"
                        >
                          <span>{meta.shortLabel}</span>
                          <ArrowRight
                            aria-hidden="true"
                            className="h-4 w-4 text-(--ink-faint) transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-(--ink)"
                          />
                        </Link>
                      </h2>
                      <p className="mt-1.5 text-[13px] leading-snug text-(--ink-muted)">
                        {sum?.tagline ?? meta.description}
                      </p>
                    </div>

                    {sum && sum.sparkline.length >= 2 ? (
                      <MiniParetoSparkline points={sum.sparkline} />
                    ) : null}
                  </div>
                </div>

                {sum ? (
                  <div className="mt-4 space-y-2 border-t border-(--border) pt-3 font-mono text-[11.5px] tabular">
                    {[
                      {
                        label:
                          sum.domainId === "harnesses"
                            ? "Highest pass rate"
                            : sum.topRecommended
                              ? "Top score"
                              : "Highest estimate",
                        pick: sum.topPick,
                        descriptiveOnly: sum.topRecommended === false,
                      },
                      {
                        label: sum.secondaryTag,
                        pick: sum.secondaryPick,
                        descriptiveOnly: false,
                      },
                    ].map(
                      ({ label, pick, descriptiveOnly }) =>
                        pick && (
                          <div key={label}>
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="shrink-0 text-[10.5px] text-(--ink-faint)">
                                  {label}
                                </span>
                                {pick.provider && (
                                  <ProviderMarkerIcon provider={pick.provider} size={8} />
                                )}
                                <span className="truncate font-sans text-[12.5px] font-medium text-(--ink)">
                                  {pick.name}
                                </span>
                                {pick.effort && (
                                  <span className="shrink-0 text-[10.5px] text-(--ink-muted)">
                                    {pick.effort}
                                  </span>
                                )}
                              </span>
                              <span className="shrink-0 text-(--ink-secondary)">
                                {pick.metricText} · {pick.costText}
                              </span>
                            </div>
                            {pick.controlInterval && (
                              <p className="mt-0.5 text-[10.5px] text-(--ink-muted)">
                                {pick.controlInterval}
                              </p>
                            )}
                            {pick.evidence && (
                              <p className="mt-0.5 text-[10.5px] leading-relaxed text-(--ink-muted)">
                                {formatScoreEvidence(pick.evidence)}
                                {descriptiveOnly ? " · Estimate only" : ""}
                              </p>
                            )}
                          </div>
                        ),
                    )}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      <section aria-label="How ProChoice works" className="px-5 py-8 sm:px-9 lg:px-11 lg:py-9">
        <div className="grid grid-cols-1 gap-6 text-[13px] leading-[1.65] text-(--ink-muted) sm:grid-cols-2 lg:gap-10">
          <p className="text-pretty">
            Each index combines benchmarks for one kind of work. Open a model row to see which tasks
            it was tested on, how much each benchmark counts, and how its cost was calculated. The
            harness leaderboard compares coding agents on shared test models.
          </p>
          <p className="text-pretty">
            Rankings update daily from public benchmark and pricing feeds. Read how scores and costs
            are computed on{" "}
            <Link href="/about" className="text-(--ink) underline underline-offset-4">
              About
            </Link>
            , query the live JSON or Markdown endpoints via{" "}
            <Link href="/docs" className="text-(--ink) underline underline-offset-4">
              API docs
            </Link>{" "}
            and{" "}
            <Link
              href="/llms.txt"
              prefetch={false}
              className="text-(--ink) underline underline-offset-4"
            >
              llms.txt
            </Link>
            , or inspect the open-source code on{" "}
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="text-(--ink) underline underline-offset-4"
            >
              GitHub
            </a>
            .
          </p>
        </div>
      </section>
    </div>
  );
}
