import type {
  HarnessLeaderboardSnapshot,
  PricingRecord,
  RawObservation,
  SourceHealth,
} from "../../src/lib/schema.ts";

export interface PartitionStats {
  attempted: number;
  rejected: number;
  excluded: number;
  error?: string;
  note?: string;
}

export interface ShrinkStateEntry {
  consecutiveDropDays: number;
  lastLowCountDate: string;
  confirmed?: boolean;
  baselineRowCount?: number;
}

export type ShrinkStateMap = Record<string, ShrinkStateEntry>;

export interface SourcePayload {
  observations: RawObservation[];
  pricing: PricingRecord[];
  harnessLeaderboard?: HarnessLeaderboardSnapshot;
  partitionStats?: Record<string, PartitionStats>;
  pricingStats?: PartitionStats;
  harnessLeaderboardStats?: PartitionStats;
  conflictingPricingApiSkus?: string[];
  conflictingPricingModelSlugs?: string[];
  disqualifiedSourceRowIdsByBenchmark?: Record<string, string[]>;
}

export interface SourceAdapter {
  id: string;
  label: string;
  license: string;
  sourceUrl: string;
  expectedBenchmarks: readonly string[];
  expectsPricing: boolean;
  expectsHarnessLeaderboard?: boolean;
  fetchLive: (nowIso: string) => Promise<SourcePayload>;
}

export interface CachedSourceFile {
  health: SourceHealth;
  payload: SourcePayload;
  shrinkCheckpoints?: ShrinkStateMap;
}
