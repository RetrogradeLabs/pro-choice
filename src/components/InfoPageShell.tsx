import Link from "next/link";
import type { ReactNode } from "react";
import { DOMAINS } from "@/config/benchmarks";
import { domainToPathname, ORG_NAME, ORG_URL, REPO_URL } from "@/lib/seo";
import { ThemeToggleButton } from "./ThemeToggleButton";

interface InfoPageShellProps {
  title: string;
  subtitle: string;
  updatedDate?: string;
  eyebrow?: string;
  children: ReactNode;
}

function BrandMark() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="shrink-0 text-(--ink) transition-transform duration-200 group-hover:scale-[1.04]"
    >
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
  );
}

export function InfoPageShell({
  title,
  subtitle,
  updatedDate,
  eyebrow,
  children,
}: InfoPageShellProps) {
  const copyrightYear = updatedDate ? updatedDate.slice(0, 4) : "2026";

  return (
    <div className="min-h-screen bg-(--bg) text-(--ink)">
      {/* Mobile sticky top bar matching ProChoiceGallery */}
      <header className="sticky top-0 z-30 border-b border-(--border) bg-(--bg)/95 backdrop-blur-sm lg:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Link href="/" className="group flex cursor-pointer items-center gap-2 text-left">
            <BrandMark />
            <span className="font-display text-[17px] font-medium tracking-[-0.02em]">
              prochoice
            </span>
          </Link>
          <ThemeToggleButton variant="mobile" />
        </div>
        <nav
          aria-label="Domains"
          className="no-scrollbar flex gap-1 overflow-x-auto border-t border-(--border)/70 px-3 py-1.5 text-[13px]"
        >
          {DOMAINS.map((d) => (
            <Link
              key={d.id}
              href={domainToPathname(d.id)}
              className="shrink-0 cursor-pointer rounded-md px-2.5 py-1 text-(--ink-muted) transition-colors hover:text-(--ink)"
            >
              {d.shortLabel}
            </Link>
          ))}
        </nav>
      </header>

      <div className="mx-auto flex max-w-315 flex-col lg:flex-row">
        {/* Desktop left sticky navigation rail aligned with page top padding and footer baseline */}
        <aside className="hidden lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-50 lg:shrink-0 lg:flex-col lg:justify-between lg:px-6 lg:pt-24 lg:pb-0">
          <div>
            <Link href="/" className="group flex cursor-pointer items-center gap-2 text-left">
              <BrandMark />
              <span className="font-display text-[17px] font-medium tracking-[-0.02em] text-(--ink)">
                prochoice
              </span>
            </Link>

            <nav
              aria-label="Domains"
              className="mt-8 flex flex-col items-start gap-2 text-[13.5px]"
            >
              {DOMAINS.map((d) => (
                <Link
                  key={d.id}
                  href={domainToPathname(d.id)}
                  className="relative cursor-pointer pl-3 text-left text-(--ink-faint) transition-colors duration-150 hover:text-(--ink)"
                >
                  <span>{d.shortLabel}</span>
                </Link>
              ))}
            </nav>
          </div>

          <div className="flex h-16.5 items-center">
            <ThemeToggleButton variant="desktop" />
          </div>
        </aside>

        {/* Central hairline-framed content column */}
        <main className="flex min-h-screen min-w-0 flex-1 flex-col overflow-x-clip lg:border-x lg:border-(--border)">
          <div className="flex-1 px-5 pt-12 pb-12 sm:px-9 sm:pt-16 lg:px-11 lg:pt-24 lg:pb-16">
            {eyebrow ? (
              <p className="mb-2 font-mono text-[12px] text-(--ink-faint)">{eyebrow}</p>
            ) : null}
            <h1 className="font-display text-[32px] leading-[1.1] font-normal tracking-tight text-(--ink) sm:text-[36px]">
              {title}
            </h1>
            <p className="mt-3 max-w-185 text-[15px] leading-[1.65] text-pretty text-(--ink-muted)">
              {subtitle}
            </p>

            <div className="mt-10 max-w-210 space-y-10 text-[14.5px] leading-[1.7] text-(--ink-secondary)">
              {children}
            </div>
          </div>

          <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-(--border) px-5 py-6 text-[12px] leading-4.5 text-(--ink-faint) sm:px-9 lg:h-16.75 lg:py-0 lg:px-11">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {updatedDate ? (
                <span className="font-mono text-[11px] tabular">Updated {updatedDate}</span>
              ) : null}
              <Link href="/docs" className="transition-colors hover:text-(--ink)">
                API docs
              </Link>
              <Link href="/about" className="transition-colors hover:text-(--ink)">
                About
              </Link>
              <Link href="/contact" className="transition-colors hover:text-(--ink)">
                Contact
              </Link>
              <Link href="/privacy" className="transition-colors hover:text-(--ink)">
                Privacy
              </Link>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="transition-colors hover:text-(--ink)"
              >
                GitHub
              </a>
            </div>
            <span>
              © {copyrightYear}{" "}
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
        </main>
      </div>
    </div>
  );
}
