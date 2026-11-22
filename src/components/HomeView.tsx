"use client";

import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Code2,
  FileText,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import type { MouseEvent } from "react";
import { BENCHMARKS, DOMAINS } from "@/config/benchmarks";
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
      <section className="px-5 pt-12 pb-6 sm:px-9 sm:pt-16 sm:pb-7 lg:px-11 lg:pt-24 lg:pb-8">
        <h1 className="font-display text-[28px] leading-[1.12] font-normal tracking-tight text-(--ink) sm:text-[34px] xl:text-[38px]">
          <strong className="font-medium text-(--ink)">No Nonsense</strong> LLM Benchmarks,
          Leaderboards &amp; Rankings
        </h1>
        <p className="mt-4 max-w-240 text-[15px] leading-[1.65] text-pretty text-(--ink-muted)">
          ProChoice helps you choose the model that performs best for your task and fits your
          budget.
        </p>
      </section>

      <section
        aria-label="Core principles"
        className="grid grid-cols-1 divide-y divide-(--border) border-t border-(--border) md:grid-cols-3 md:divide-x md:divide-y-0"
      >
        <div className="px-5 py-5 sm:px-9 md:pr-6 lg:pl-11 lg:pr-7">
          <div className="flex items-center gap-2 text-(--ink)">
            <ShieldCheck
              aria-hidden="true"
              strokeWidth={1.6}
              className="h-4 w-4 shrink-0 text-(--ink-secondary)"
            />
            <h2 className="text-[13.5px] font-medium tracking-[-0.01em]">
              Private &amp; live benchmarks only
            </h2>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-[1.55] text-pretty text-(--ink-muted)">
            {BENCHMARKS.length} private held-out and live tests. Zero static public datasets that
            leak into training.
          </p>
        </div>

        <div className="px-5 py-5 sm:px-9 md:px-6 lg:px-7">
          <div className="flex items-center gap-2 text-(--ink)">
            <TrendingUp
              aria-hidden="true"
              strokeWidth={1.6}
              className="h-4 w-4 shrink-0 text-(--ink-secondary)"
            />
            <h2 className="text-[13.5px] font-medium tracking-[-0.01em]">
              Best models for the price
            </h2>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-[1.55] text-pretty text-(--ink-muted)">
            Models and reasoning effort levels that cost more while scoring lower stay off the
            chart.
          </p>
        </div>

        <div className="px-5 py-5 sm:px-9 md:pl-6 lg:pl-7 lg:pr-11">
          <div className="flex items-center gap-2 text-(--ink)">
            <RefreshCw
              aria-hidden="true"
              strokeWidth={1.6}
              className="h-4 w-4 shrink-0 text-(--ink-secondary)"
            />
            <h2 className="text-[13.5px] font-medium tracking-[-0.01em]">Updated daily</h2>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-[1.55] text-pretty text-(--ink-muted)">
            Fresh scores and verified first-party API prices refresh automatically every day.
          </p>
        </div>
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
                className={`group relative flex flex-col justify-between bg-(--surface) px-5 py-6 text-left transition-colors hover:bg-(--subtle)/70 focus-within:ring-2 focus-within:ring-inset focus-within:ring-(--interactive) sm:py-5 ${
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
                          <span className="w-18 shrink-0 text-[10.5px] text-(--ink-faint)">
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
                          <span className="w-18 shrink-0 text-[10.5px] text-(--ink-faint)">
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

      <nav
        aria-label="Reference links"
        className="flex flex-wrap items-center gap-x-6 gap-y-2.5 px-5 py-6 text-[13px] text-(--ink-muted) sm:px-9 lg:px-11"
      >
        <Link
          href="/about"
          className="inline-flex items-center gap-1.5 transition-colors hover:text-(--ink)"
        >
          <BookOpen aria-hidden="true" strokeWidth={1.6} className="h-3.5 w-3.5" />
          <span>About &amp; methodology</span>
        </Link>
        <Link
          href="/docs"
          className="inline-flex items-center gap-1.5 transition-colors hover:text-(--ink)"
        >
          <Code2 aria-hidden="true" strokeWidth={1.6} className="h-3.5 w-3.5" />
          <span>API docs</span>
        </Link>
        <Link
          href="/llms.txt"
          prefetch={false}
          className="inline-flex items-center gap-1.5 transition-colors hover:text-(--ink)"
        >
          <FileText aria-hidden="true" strokeWidth={1.6} className="h-3.5 w-3.5" />
          <span>llms.txt</span>
        </Link>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 transition-colors hover:text-(--ink)"
        >
          <span>GitHub</span>
          <ArrowUpRight aria-hidden="true" strokeWidth={1.6} className="h-3.5 w-3.5" />
        </a>
      </nav>
    </div>
  );
}
