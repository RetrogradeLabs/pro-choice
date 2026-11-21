"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { MouseEvent } from "react";
import { DOMAINS } from "@/config/benchmarks";
import type { HomeDomainSummary, HomeSparkPoint } from "@/lib/home-summaries";
import type { DomainId } from "@/lib/schema";
import { domainToPathname } from "@/lib/seo";
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

        <p className="mt-4 max-w-[960px] text-[15px] leading-[1.65] text-pretty text-(--ink-muted)">
          ProChoice compares AI models by score and real dollar cost across six domains.{" "}
          <strong className="font-medium text-(--ink)">
            Models that cost more while scoring lower are left off the chart
          </strong>
          , so you can quickly pick the best model for your task and budget.
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
                    {sum.topPick ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="w-[72px] shrink-0 text-[10.5px] text-(--ink-faint)">
                            Top score
                          </span>
                          {sum.topPick.provider ? (
                            <ProviderMarkerIcon provider={sum.topPick.provider} size={8} />
                          ) : (
                            <span
                              aria-hidden="true"
                              className="h-2 w-2 shrink-0 rounded-full bg-(--interactive)"
                            />
                          )}
                          <span className="truncate font-sans text-[12.5px] font-medium text-(--ink)">
                            {sum.topPick.name}
                          </span>
                          {sum.topPick.effort ? (
                            <span className="hidden shrink-0 text-[10.5px] text-(--ink-faint) xl:inline">
                              {sum.topPick.effort}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-(--ink-secondary)">
                          {sum.topPick.metricText} · {sum.topPick.costText}
                        </span>
                      </div>
                    ) : null}

                    {sum.secondaryPick && sum.secondaryPick.id !== sum.topPick?.id ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="w-[72px] shrink-0 text-[10.5px] text-(--ink-faint)">
                            {sum.secondaryTag}
                          </span>
                          {sum.secondaryPick.provider ? (
                            <ProviderMarkerIcon provider={sum.secondaryPick.provider} size={8} />
                          ) : (
                            <span
                              aria-hidden="true"
                              className="h-2 w-2 shrink-0 rounded-full bg-(--ink-muted)"
                            />
                          )}
                          <span className="truncate font-sans text-[12.5px] text-(--ink-secondary)">
                            {sum.secondaryPick.name}
                          </span>
                          {sum.secondaryPick.effort ? (
                            <span className="hidden shrink-0 text-[10.5px] text-(--ink-faint) xl:inline">
                              {sum.secondaryPick.effort}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-(--ink-muted)">
                          {sum.secondaryPick.metricText} · {sum.secondaryPick.costText}
                        </span>
                      </div>
                    ) : null}
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
            Each composite index combines live public benchmarks across nine model providers on one
            anchored scale using heteroscedastic REML Empirical Bayes pooling, paired with real
            dollar task cost from verified first-party API pricing. All 45 active benchmarks feed
            directly into their domain index with zero shadow candidates, while 25 coding agent
            harnesses are benchmarked separately across eight fixed open control models.
          </p>
          <p className="text-pretty">
            Snapshots rebuild daily from 18 public feeds with deterministic raw-to-release
            verification. Read the full methodology on{" "}
            <Link href="/about" className="text-(--ink) underline underline-offset-4">
              About
            </Link>
            , query live JSON or Markdown via the{" "}
            <Link href="/docs" className="text-(--ink) underline underline-offset-4">
              Public API docs
            </Link>{" "}
            and{" "}
            <Link
              href="/llms.txt"
              prefetch={false}
              className="text-(--ink) underline underline-offset-4"
            >
              llms.txt
            </Link>
            , or follow{" "}
            <a
              href="https://github.com/RetrogradeLabs"
              target="_blank"
              rel="noreferrer"
              className="text-(--ink) underline underline-offset-4"
            >
              Retrograde Labs on GitHub
            </a>
            .
          </p>
        </div>
      </section>
    </div>
  );
}
