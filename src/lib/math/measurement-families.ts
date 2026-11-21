export const MIN_BENCHMARK_WEIGHT = 0.1;
export type FamilyWeightPolicy = "family-quality" | "family-equal";
export type AggregateWeightPolicy = "quality" | FamilyWeightPolicy;

export function usesMeasurementFamilies(epochVersion: string): boolean {
  const match = /^(coding|design-code|research|writing|harnesses|cyber)-v(\d+)\./.exec(
    epochVersion,
  );
  return (
    match !== null && Number(match[2]) >= (match[1] === "harnesses" || match[1] === "cyber" ? 2 : 3)
  );
}

export function epochWeightPolicy(epochVersion: string): AggregateWeightPolicy {
  return usesMeasurementFamilies(epochVersion) ? "family-equal" : "quality";
}

interface FamilyMember {
  benchmarkId: string;
  measurementFamily: string;
  qualityWeight: number;
}

export function allocateFamilyWeights(
  members: readonly FamilyMember[],
  policy: FamilyWeightPolicy,
): Map<string, number> {
  return new Map(
    members.map((m) => [m.benchmarkId, policy === "family-equal" ? 1 : m.qualityWeight]),
  );
}
