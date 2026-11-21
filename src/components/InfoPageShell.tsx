import Link from "next/link";
import type { ReactNode } from "react";
import { DOMAINS } from "@/config/benchmarks";
import { domainToPathname, ORG_NAME, ORG_URL } from "@/lib/seo";

interface InfoPageShellProps {
  title: string;
  subtitle: string;
  updatedDate: string;
  children: ReactNode;
}

export function InfoPageShell({ title, subtitle, updatedDate, children }: InfoPageShellProps) {
  return (
    <div className="min-h-screen bg-(--bg) text-(--ink)">
      <div className="mx-auto flex min-h-screen max-w-[960px] flex-col border-x border-(--border) bg-(--bg)">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-(--border) px-6 py-5 sm:px-10">
          <Link
            href="/"
            className="flex items-center gap-2 font-display text-[17px] font-medium tracking-[-0.02em] text-(--ink)"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect
                x="0.75"
                y="0.75"
                width="22.5"
                height="22.5"
                rx="6"
                fill="var(--surface)"
                stroke="var(--border-strong)"
                strokeWidth="1.2"
              />
              <g transform="translate(2.65 4.15) scale(0.7)">
                <path
                  d="M10.5 13.1L5.2 7.8L7.4 5.6L12 10.2L10.5 13.1Z"
                  fill="currentColor"
                  fillOpacity="0.28"
                />
                <path
                  d="M10.4 20.5V11.8L16.3 5.9H12.4V3.2H20.8V11.6H18.1V7.7L13.2 12.6V20.5H10.4Z"
                  fill="currentColor"
                />
              </g>
            </svg>
            <span>prochoice</span>
          </Link>

          <nav
            aria-label="Domains"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-(--ink-muted)"
          >
            {DOMAINS.map((d) => (
              <Link
                key={d.id}
                href={domainToPathname(d.id)}
                className="transition-colors hover:text-(--ink)"
              >
                {d.shortLabel}
              </Link>
            ))}
          </nav>
        </header>

        <main className="flex-1 px-6 py-12 sm:px-10 sm:py-16">
          <h1 className="font-display text-[32px] leading-[1.12] font-normal tracking-tight text-(--ink) sm:text-[38px]">
            {title}
          </h1>
          <p className="mt-3 max-w-[740px] text-[15px] leading-[1.65] text-(--ink-muted)">
            {subtitle}
          </p>

          <div className="mt-10 space-y-10 text-[14.5px] leading-[1.7] text-(--ink-secondary)">
            {children}
          </div>
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-(--border) px-6 py-6 text-[12px] text-(--ink-faint) sm:px-10">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-[11px] tabular">Updated {updatedDate}</span>
            <Link href="/docs" className="hover:text-(--ink)">
              API docs
            </Link>
            <Link href="/about" className="hover:text-(--ink)">
              About
            </Link>
            <Link href="/contact" className="hover:text-(--ink)">
              Contact
            </Link>
            <Link href="/privacy" className="hover:text-(--ink)">
              Privacy
            </Link>
          </div>
          <span>
            © {updatedDate.slice(0, 4)}{" "}
            <a
              href={ORG_URL}
              target="_blank"
              rel="noreferrer"
              className="text-(--ink-muted) underline-offset-4 hover:text-(--ink) hover:underline"
            >
              {ORG_NAME}
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}
