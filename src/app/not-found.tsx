import Link from "next/link";
import { InfoPageShell } from "@/components/InfoPageShell";
import { DOMAINS } from "@/config/benchmarks";
import { domainToPathname } from "@/lib/seo";

export default function NotFound() {
  return (
    <InfoPageShell
      eyebrow="404"
      title="Index not found"
      subtitle="That route does not match any ProChoice leaderboard. Pick one of the six live composite indices below or return to the overview."
    >
      <div className="flex flex-wrap gap-2 text-[13.5px]">
        <Link
          href="/"
          className="rounded-md border border-(--border-strong) bg-(--surface) px-3.5 py-1.5 font-medium text-(--ink) transition-colors hover:bg-(--surface-hover)"
        >
          Overview
        </Link>
        {DOMAINS.map((d) => (
          <Link
            key={d.id}
            href={domainToPathname(d.id)}
            className="rounded-md border border-(--border) bg-(--surface) px-3.5 py-1.5 text-(--ink-muted) transition-colors hover:bg-(--surface-hover) hover:text-(--ink)"
          >
            {d.shortLabel}
          </Link>
        ))}
      </div>
    </InfoPageShell>
  );
}
