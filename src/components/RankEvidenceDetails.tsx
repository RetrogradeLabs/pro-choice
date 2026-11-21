import { BENCHMARK_BY_ID } from "@/config/benchmarks";
import type { RankEvidence } from "@/lib/schema";

export function RankEvidenceDetails({ evidence }: { evidence: RankEvidence }) {
  const heldOut = evidence.heldOutBenchmarks.filter((r) => r.kendallTau !== null);
  return (
    <details className="border-y border-(--border) py-3 text-[12.5px] text-(--ink-secondary)">
      <summary className="cursor-pointer font-medium text-(--ink)">
        How well do the rankings hold up?
      </summary>
      <p className="mt-3 leading-relaxed">
        For each pair of configurations, we compare their overall scores with their order on the
        benchmarks both completed. The second row checks neighboring points on each provider’s cost
        curve. Even when their order agrees, the difference may be small.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-right text-[11.5px] tabular">
          <thead>
            <tr className="border-b border-(--border)">
              <th scope="col" className="py-2 text-left">
                Pairs
              </th>
              <th scope="col" className="px-1">
                Agree
              </th>
              <th scope="col" className="px-1">
                Reverse
              </th>
              <th scope="col" className="px-1">
                Tie
              </th>
              <th scope="col">No shared test</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["All ranked", evidence.allPairs],
                ["Curve neighbors", evidence.frontierSteps],
              ] as const
            ).map(([label, row]) => (
              <tr key={label} className="border-b border-(--border)">
                <th scope="row" className="py-2 text-left font-normal">
                  {label}
                </th>
                <td>{row.agreed}</td>
                <td>{row.reversed}</td>
                <td>{row.tied}</td>
                <td>{row.noOverlap}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 leading-relaxed">
        We also rebuild the index without an entire feed, then compare its predictions with the
        results we set aside. Kendall’s tau ranges from −1 for reversed order to 1 for agreement.
        The simple mean column compares the same configurations using an unweighted mean of their
        calibrated results. Coverage shows how many configurations could be scored without the feed.
      </p>
      <p className="my-2 font-medium text-(--ink)">
        {heldOut.length} of {evidence.heldOutBenchmarks.length} held-out tests had enough matched
        results to compare ranks.{" "}
        {!heldOut.some((r) => r.kendallTau !== null && r.kendallTau > 0) &&
          "This release has no positive held-out rank agreement for this index. For a specific task, consult its publisher results."}
      </p>
      <table className="mt-3 w-full text-right text-[11.5px] tabular">
        <thead>
          <tr className="border-b border-(--border)">
            <th scope="col" className="py-2 text-left">
              Test held out
            </th>
            <th scope="col" className="px-2">
              Coverage
            </th>
            <th scope="col" className="px-1">
              Providers
            </th>
            <th scope="col" className="px-2">
              Index
            </th>
            <th scope="col">Simple mean</th>
          </tr>
        </thead>
        <tbody>
          {evidence.heldOutBenchmarks.map((row) => (
            <tr key={row.benchmarkId} className="border-b border-(--border)">
              <th scope="row" className="py-2 text-left font-normal">
                {BENCHMARK_BY_ID[row.benchmarkId]?.shortName ?? row.benchmarkId}
              </th>
              <td className="px-2">
                {row.matchedConfigs}/{row.testConfigs}
              </td>
              <td className="px-1">{row.matchedProviders}</td>
              <td className="px-2">{row.kendallTau?.toFixed(2) ?? "N/A"}</td>
              <td>{row.equalWeightTau?.toFixed(2) ?? "N/A"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {evidence.heldOutBenchmarks.some((r) => r.familyPolicyComparison) && (
        <details className="mt-4">
          <summary className="cursor-pointer font-medium text-(--ink)">
            Compare weighting methods
          </summary>
          <p className="mt-2 leading-relaxed">
            Both fits omit the same feed and use the same scoring model. One gives distinct tasks
            equal weight. The other weights them by estimated quality. Agreement is calculated only
            on configurations both fits can score.
          </p>
          <table className="mt-2 w-full text-right text-[11.5px] tabular">
            <thead>
              <tr className="border-b border-(--border)">
                <th scope="col" className="py-2 text-left">
                  Test held out
                </th>
                <th scope="col">Matched</th>
                <th scope="col">Equal</th>
                <th scope="col">Quality</th>
              </tr>
            </thead>
            <tbody>
              {evidence.heldOutBenchmarks.map((row) => {
                const pair = row.familyPolicyComparison;
                return (
                  pair && (
                    <tr key={row.benchmarkId} className="border-b border-(--border)">
                      <th scope="row" className="py-2 text-left font-normal">
                        {BENCHMARK_BY_ID[row.benchmarkId]?.shortName ?? row.benchmarkId}
                      </th>
                      <td>{pair.matchedConfigs}</td>
                      <td>{pair.equalFamilyTau?.toFixed(2) ?? "N/A"}</td>
                      <td>{pair.qualityFamilyTau?.toFixed(2) ?? "N/A"}</td>
                    </tr>
                  )
                );
              })}
            </tbody>
          </table>
        </details>
      )}
    </details>
  );
}
