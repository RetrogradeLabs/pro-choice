import { useState } from "react";
import { HARNESS_BY_ID } from "@/config/harnesses";
import { formatEffort, formatRawMetric } from "@/lib/format";
import type { HarnessId, ObservedBenchmark, ProviderId } from "@/lib/schema";

interface ObservedBenchmarkTablesProps {
  ready: boolean;
  failed: boolean;
  requestRows: () => void;
  benchmarks: readonly ObservedBenchmark[];
  showHarness: boolean;
  providers: ReadonlySet<ProviderId>;
  harness: HarnessId | "all";
}

export function ObservedBenchmarkTables({
  benchmarks,
  providers,
  harness,
  showHarness,
  ready,
  failed,
  requestRows,
}: ObservedBenchmarkTablesProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  return (
    <section
      id="additional-results"
      aria-label="Additional benchmark results"
      className="space-y-3 border-t border-(--border) px-5 py-6 sm:px-9 lg:px-11"
    >
      <h2 className="font-display text-[22px] text-(--ink)">Additional benchmark results</h2>
      <p className="max-w-prose text-[13px] leading-relaxed text-(--ink-muted)">
        These results stay on the publisher’s scale. They are available for individual tasks and
        carry zero weight in the index.
      </p>
      {benchmarks.map((bm) => {
        const visible = expanded.has(bm.benchmarkId);
        const rows = visible
          ? bm.rows.filter(
              (row) =>
                providers.has(row.provider) && (harness === "all" || row.harness === harness),
            )
          : [];
        return (
          <details
            key={bm.benchmarkId}
            className="border-t border-(--border) pt-3 text-[13px]"
            onToggle={(e) => {
              const open = e.currentTarget.open;
              if (open && !ready) requestRows();
              setExpanded((prev) => {
                if (prev.has(bm.benchmarkId) === open) return prev;
                const next = new Set(prev);
                if (open) next.add(bm.benchmarkId);
                else next.delete(bm.benchmarkId);
                return next;
              });
            }}
          >
            <summary className="cursor-pointer font-medium text-(--ink)">
              {bm.name}
              {visible && ready ? ` · ${rows.length} configurations` : ""}
            </summary>
            <a
              className="my-3 inline-block text-(--ink-muted) underline underline-offset-4 hover:text-(--ink)"
              href={bm.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Publisher results and scoring method
            </a>
            {!visible ? null : !ready ? (
              failed ? (
                <button
                  type="button"
                  className="underline"
                  onClick={() => window.location.reload()}
                >
                  Reload to see results
                </button>
              ) : (
                <output>Loading results…</output>
              )
            ) : rows.length ? (
              <table className="w-full text-left">
                <thead className="border-b border-(--border) text-[11.5px] text-(--ink-muted)">
                  <tr>
                    <th scope="col" className="py-2">
                      {showHarness ? "Harness + model" : "Model"}
                    </th>
                    <th scope="col" className="px-2">
                      Effort
                    </th>
                    <th scope="col" className="text-right">
                      Published score
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.configId} className="border-b border-(--border) last:border-b-0">
                      <th scope="row" className="py-2 font-normal">
                        {showHarness && `${HARNESS_BY_ID[row.harness].name} + `}
                        {row.displayName}
                      </th>
                      <td className="px-2">{formatEffort(row.effort)}</td>
                      <td className="text-right font-mono tabular">
                        {formatRawMetric(row.rawScore, bm.scale)}
                        {row.ciLower !== null && row.ciUpper !== null ? (
                          <span className="block whitespace-nowrap text-[10.5px] text-(--ink-muted)">
                            {row.ciLower.toFixed(1)} to {row.ciUpper.toFixed(1)}
                          </span>
                        ) : (
                          <span className="block text-[10.5px] text-(--ink-muted)">
                            {row.seRaw !== null && row.seRaw !== undefined
                              ? `Reported SE ${row.seRaw.toFixed(2)}`
                              : row.ciHalfWidth !== null
                                ? `Interval ±${row.ciHalfWidth.toFixed(2)}`
                                : "Interval unreported"}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-(--ink-muted)">No observations match this selection.</p>
            )}
          </details>
        );
      })}
    </section>
  );
}
