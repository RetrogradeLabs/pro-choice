import Link from "next/link";
import { DOMAINS } from "@/config/benchmarks";
import { domainToPathname } from "@/lib/seo";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[720px] flex-col justify-center px-6 py-24 text-[var(--ink)]">
      <p className="font-mono text-[12px] text-[var(--ink-faint)]">404</p>
      <h1 className="mt-2 font-display text-[34px] leading-tight font-normal tracking-[-0.025em]">
        Index not found
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-[var(--ink-muted)]">
        That route does not match any ProChoice leaderboard. Pick one of the six live composite
        indices below or return to the overview.
      </p>
      <div className="mt-8 flex flex-wrap gap-2 text-[13.5px]">
        <Link
          href="/"
          className="rounded-md border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-1.5 font-medium text-[var(--ink)] transition-colors hover:bg-[var(--surface-hover)]"
        >
          Overview
        </Link>
        {DOMAINS.map((d) => (
          <Link
            key={d.id}
            href={domainToPathname(d.id)}
            className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]"
          >
            {d.shortLabel}
          </Link>
        ))}
      </div>
    </main>
  );
}
