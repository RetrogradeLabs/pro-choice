import { z } from "zod";

export const HttpsUrlSchema = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), { message: "URL must use https://" });

export const ProviderIdSchema = z.enum([
  "anthropic",
  "openai",
  "spacexai",
  "google",
  "meta",
  "deepseek",
  "moonshot",
  "alibaba",
  "zhipu",
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderGroupSchema = z.enum(["western_subscription", "chinese_frontier"]);
export type ProviderGroup = z.infer<typeof ProviderGroupSchema>;

export const DomainIdSchema = z.enum([
  "coding",
  "writing",
  "design_code",
  "research",
  "cyber",
  "harnesses",
]);
export type DomainId = z.infer<typeof DomainIdSchema>;

export const ReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "thinking",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const HarnessIdSchema = z.enum([
  "direct",
  "multi-harness",
  "claude-code",
  "codex",
  "antigravity",
  "cursor",
  "opencode",
  "copilot",
  "devin-cli",
  "grok-build",
  "muse-code",
  "gemini-cli",
  "kimi-code",
  "deepseek-harness",
  "mirror-cli",
  "factory",
  "standardized-suite",
  "mini-swe-agent",
  "openhands",
  "harbor",
  "stirrup",
  "proximus",
]);
export type HarnessId = z.infer<typeof HarnessIdSchema>;

export const HarnessRegimeSchema = z.enum(["native", "standardized"]);
export type HarnessRegime = z.infer<typeof HarnessRegimeSchema>;

export const BenchmarkScaleSchema = z.enum(["percent", "elo", "rubric"]);
export type BenchmarkScale = z.infer<typeof BenchmarkScaleSchema>;

export const BenchmarkLifecycleStateSchema = z.enum([
  "CANDIDATE",
  "ACTIVE",
  "WATCHLIST",
  "RETIRED",
]);
export type BenchmarkLifecycleState = z.infer<typeof BenchmarkLifecycleStateSchema>;

export const CostSourceSchema = z.enum(["measured", "suite", "list"]);
export type CostSource = z.infer<typeof CostSourceSchema>;

export const SeModelSchema = z.enum([
  "upstream_ci",
  "upstream_se",
  "popoviciu_upper_bound",
  "unreported",
]);
export type SeModel = z.infer<typeof SeModelSchema>;

export const CostUnitSchema = z.literal("usd_per_task");
export type CostUnit = z.infer<typeof CostUnitSchema>;

export const SourceStatusSchema = z.enum(["ok", "degraded"]);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const RawObservationSchema = z.object({
  sourceId: z.string().min(1),
  sourceRowId: z.string().min(1),
  benchmarkId: z.string().min(1),
  benchmarkVersion: z.string().min(1),
  domainId: DomainIdSchema,
  rawModelName: z.string().min(1),
  rawProvider: z.string().nullable(),
  rawEffort: z.string().nullable(),
  rawHarness: z.string().nullable(),
  observedHarness: z.string().min(1).nullable(),
  harnessRegime: HarnessRegimeSchema,
  rawScore: z.number().finite(),
  seRaw: z.number().finite().positive().nullable().optional(),
  ciHalfWidth: z.number().finite().positive().nullable(),
  ciLower: z.number().finite().nullable(),
  ciUpper: z.number().finite().nullable(),
  battleCount: z.number().int().nonnegative().nullable(),
  measuredCostUsd: z.number().finite().positive().nullable(),
  measuredCostEstimated: z.boolean().optional(),
  fallbackRouting: z.boolean().optional(),
  refusalRate: z.number().min(0).max(1).nullable().optional(),
  suiteCostUsd: z.number().finite().positive().nullable(),
  measuredInputTokens: z.number().finite().nonnegative().nullable(),
  measuredOutputTokens: z.number().finite().nonnegative().nullable(),
  evalDate: z.string().min(1).nullable(),
  publishedDate: z.string().min(1).nullable(),
  sourceUrl: HttpsUrlSchema,
});
export type RawObservation = z.infer<typeof RawObservationSchema>;

export const PricingRecordSchema = z.object({
  provider: ProviderIdSchema,
  servingProvider: ProviderIdSchema,
  apiSku: z.string().min(1).nullable(),
  modelSlug: z.string().min(1),
  inputPer1mUsd: z.number().finite().nonnegative(),
  outputPer1mUsd: z.number().finite().nonnegative(),
  cachedInputPer1mUsd: z.number().finite().nonnegative().nullable(),
  contextWindow: z.number().int().positive().nullable(),
  releaseDate: z.string().nullable(),
  sourceId: z.string().min(1),
});
export type PricingRecord = z.infer<typeof PricingRecordSchema>;

export const SubFeedHealthSchema = z.object({
  benchmarkId: z.string().min(1),
  status: SourceStatusSchema,
  rowCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  consecutiveDropDays: z.number().int().nonnegative(),
  lastLowCountDate: z.string().min(1).nullable(),
  lastHealthyAt: z.string().min(1).nullable(),
  message: z.string().nullable(),
});
export type SubFeedHealth = z.infer<typeof SubFeedHealthSchema>;

export const SourceHealthSchema = z.object({
  sourceId: z.string().min(1),
  label: z.string().min(1),
  status: SourceStatusSchema,
  fetchedAt: z.string().min(1),
  lastHealthyAt: z.string().min(1).nullable(),
  staleDays: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  license: z.string().min(1),
  sourceUrl: HttpsUrlSchema,
  message: z.string().nullable(),
  subFeeds: z.array(SubFeedHealthSchema),
  pricingHealth: SubFeedHealthSchema.nullable(),
});
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export const AnchorStatsSchema = z.object({
  benchmarkId: z.string().min(1),
  mean: z.number().finite(),
  sd: z.number().finite().positive(),
  anchorCount: z.number().int().positive(),
  anchorLabs: z.number().int().positive(),
  linkedViaMeanSigma: z.boolean(),
  raschDelta: z.number().finite(),
  reliability: z.number().min(0).max(1),
  discrimination: z.number().min(0).max(1),
  effectiveWeight: z.number().min(0.1).max(1),
  introducedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  invertScore: z.boolean(),
  popoviciuSe: z.number().finite().positive().optional(),
  linkVarIntercept: z.number().finite().nonnegative().optional(),
  linkVarSlope: z.number().finite().nonnegative().optional(),
  linkCovIS: z.number().finite().optional(),
});
export type AnchorStats = z.infer<typeof AnchorStatsSchema>;

export const BenchmarkScoreDetailSchema = z.object({
  benchmarkId: z.string().min(1),
  benchmarkVersion: z.string().min(1),
  sourceId: z.string().min(1),
  sourceRowId: z.string().min(1),
  observedHarness: z.string().min(1).nullable(),
  rawScore: z.number().finite(),
  zScore: z.number().finite(),
  seModel: SeModelSchema,
  seRaw: z.number().finite().positive().nullable().optional(),
  ciHalfWidth: z.number().finite().positive().nullable(),
  ciLower: z.number().finite().nullable(),
  ciUpper: z.number().finite().nullable(),
  measuredCostUsd: z.number().finite().positive().nullable(),
  measuredCostEstimated: z.boolean().optional(),
  fallbackRouting: z.boolean().optional(),
  refusalRate: z.number().min(0).max(1).nullable().optional(),
  evalDate: z.string().min(1).nullable(),
  publishedDate: z.string().min(1).nullable(),
  sourceUrl: HttpsUrlSchema,
});
export type BenchmarkScoreDetail = z.infer<typeof BenchmarkScoreDetailSchema>;

export const EvaluatedConfigSchema = z
  .object({
    id: z.string().min(1),
    provider: ProviderIdSchema,
    modelSlug: z.string().min(1),
    displayName: z.string().min(1),
    effort: ReasoningEffortSchema,
    harness: HarnessIdSchema,
    harnessRegime: HarnessRegimeSchema,
    domainId: DomainIdSchema,
    theta: z.number().finite(),
    shrinkageFactor: z.number().gt(0).max(1),
    score: z.number().finite(),
    se: z.number().finite().nonnegative(),
    samplingSe: z.number().finite().nonnegative(),
    residualSe: z.number().finite().nonnegative(),
    coverageCount: z.number().int().positive(),
    activeBenchmarkCount: z.number().int().positive(),
    eligibleForFrontier: z.boolean(),
    imputationSensitive: z.boolean(),
    effectiveCostUsd: z.number().finite().positive().nullable(),
    costFixedFloorUsd: z.number().finite().nonnegative().optional(),
    costLogSd: z.number().finite().nonnegative().optional(),
    costMinUsd: z.number().finite().positive().optional(),
    costMaxUsd: z.number().finite().positive().optional(),
    costImputed: z.boolean(),
    costEstimated: z.boolean(),
    usesFallbackRouting: z.boolean(),
    costUnit: CostUnitSchema,
    costSource: CostSourceSchema,
    blendedListPricePer1mUsd: z.number().finite().nonnegative().nullable(),
    inputPer1mUsd: z.number().finite().nonnegative().nullable(),
    outputPer1mUsd: z.number().finite().nonnegative().nullable(),
    contextWindow: z.number().int().positive().nullable(),
    releaseDate: z.string().nullable(),
    paretoProb: z.number().min(0).max(1),
    benchmarks: z.array(BenchmarkScoreDetailSchema),
  })
  .superRefine((val, ctx) => {
    if (
      val.costFixedFloorUsd !== undefined &&
      val.effectiveCostUsd !== null &&
      val.costFixedFloorUsd > val.effectiveCostUsd + 1e-6
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["costFixedFloorUsd"],
        message: "costFixedFloorUsd must be <= effectiveCostUsd",
      });
    }
    if (
      val.costMinUsd !== undefined &&
      val.effectiveCostUsd !== null &&
      val.costMinUsd > val.effectiveCostUsd + 1e-6
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["costMinUsd"],
        message: "costMinUsd must be <= effectiveCostUsd",
      });
    }
    if (
      val.costMaxUsd !== undefined &&
      val.effectiveCostUsd !== null &&
      val.effectiveCostUsd > val.costMaxUsd + 1e-6
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["costMaxUsd"],
        message: "effectiveCostUsd must be <= costMaxUsd",
      });
    }
    if (
      val.costMinUsd !== undefined &&
      val.costMaxUsd !== undefined &&
      val.costMinUsd > val.costMaxUsd + 1e-6
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["costMinUsd"],
        message: "costMinUsd must be <= costMaxUsd",
      });
    }
  });
export type EvaluatedConfig = z.infer<typeof EvaluatedConfigSchema>;

export const FrontierPointSchema = z.object({
  configId: z.string().min(1),
  zStepFromPrev: z.number().finite().nullable(),
  pBetterThanPrev: z.number().min(0).max(1).nullable(),
  statisticallyTied: z.boolean(),
  imputationSensitive: z.boolean(),
  paretoProb: z.number().min(0).max(1),
  marginalScorePerDollar: z.number().finite().nullable(),
  costMultipleFromPrev: z.number().finite().positive().nullable(),
});
export type FrontierPoint = z.infer<typeof FrontierPointSchema>;

export const PrunedConfigSchema = z.object({
  configId: z.string().min(1),
  dominatedById: z.string().min(1),
  scoreDeficit: z.number().finite().nonnegative(),
  costRatio: z.number().finite().positive().nullable(),
  costComparisonNote: z.string().min(1).nullable(),
});
export type PrunedConfig = z.infer<typeof PrunedConfigSchema>;

export const ProviderFrontierSchema = z.object({
  provider: ProviderIdSchema,
  harnessRegime: HarnessRegimeSchema,
  harnessFilter: z.union([HarnessIdSchema, z.literal("all")]),
  frontier: z.array(FrontierPointSchema),
  pruned: z.array(PrunedConfigSchema),
  verdicts: z.object({
    budgetId: z.string().nullable(),
    defaultId: z.string().nullable(),
    maxId: z.string().nullable(),
  }),
});
export type ProviderFrontier = z.infer<typeof ProviderFrontierSchema>;

export const EpochLinkSchema = z.object({
  previousEpoch: z.string().min(1),
  linked: z.boolean(),
  overlapCount: z.number().int().nonnegative(),
  overlapLabs: z.number().int().nonnegative(),
  slope: z.number().finite().nullable(),
  intercept: z.number().finite().nullable(),
  pearsonR: z.number().min(-1).max(1).nullable(),
  reason: z.string().min(1),
});
export type EpochLink = z.infer<typeof EpochLinkSchema>;

// Verify symmetric matrix M is PSD via exact zero-diagonal Cauchy-Schwarz + scale-invariant correlation Cholesky
function isSymmetricPsdMatrix(mat: readonly (readonly number[])[], tol = 1e-9): boolean {
  const n = mat.length;
  const posIdxs: number[] = [];
  for (let i = 0; i < n; i++) {
    const row = mat[i];
    if (!row || row.length !== n) return false;
    const di = row[i]!;
    if (!(di >= 0)) return false;
    for (let j = i + 1; j < n; j++) {
      const a = row[j]!;
      const b = mat[j]![i]!;
      const scale = Math.max(1, Math.abs(a), Math.abs(b));
      if (Math.abs(a - b) > tol * scale) return false;
      const dj = mat[j]![j]!;
      if (di === 0 || dj === 0) {
        if (Math.abs(a) > 0) return false;
      } else if (a * a > di * dj * (1 + tol)) {
        return false;
      }
    }
    if (di > 0) posIdxs.push(i);
  }
  const m = posIdxs.length;
  const l: number[][] = Array.from({ length: m }, () => Array.from({ length: m }, () => 0));
  for (let i = 0; i < m; i++) {
    const ri = posIdxs[i]!;
    const si = Math.sqrt(mat[ri]![ri]!);
    for (let j = 0; j <= i; j++) {
      const rj = posIdxs[j]!;
      const sj = Math.sqrt(mat[rj]![rj]!);
      let s = i === j ? 1 + tol : mat[ri]![rj]! / (si * sj);
      for (let k = 0; k < j; k++) s -= l[i]![k]! * l[j]![k]!;
      if (i === j) {
        if (!(s > 0)) return false;
        l[i]![j] = Math.sqrt(s);
      } else {
        l[i]![j] = s / l[j]![j]!;
      }
    }
  }
  return true;
}

export const LinkJointCovSchema = z
  .object({
    benchmarkIds: z.array(z.string().min(1)),
    covMatrix: z.array(z.array(z.number().finite())),
  })
  .superRefine((val, ctx) => {
    const uniqueIds = new Set(val.benchmarkIds);
    if (uniqueIds.size !== val.benchmarkIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["benchmarkIds"],
        message: "linkJointCov.benchmarkIds must be unique",
      });
    }
    const expectedDim = val.benchmarkIds.length * 2;
    if (
      val.covMatrix.length !== expectedDim ||
      val.covMatrix.some((row) => row.length !== expectedDim)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["covMatrix"],
        message: `linkJointCov.covMatrix must be ${expectedDim}x${expectedDim}`,
      });
      return;
    }
    if (!isSymmetricPsdMatrix(val.covMatrix)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["covMatrix"],
        message: "linkJointCov.covMatrix must be symmetric positive semi-definite",
      });
    }
  });
export type LinkJointCov = z.infer<typeof LinkJointCovSchema>;

export const RegimeMetaSchema = z.object({
  activeBenchmarkIds: z.array(z.string().min(1)),
  costSource: CostSourceSchema,
  measuredCostBenchmarkIds: z.array(z.string().min(1)),
  coverageFloor: z.number().int().positive(),
  tauResid: z.number().finite().nonnegative(),
  calibrationTauResidSq: z.number().finite().nonnegative(),
  priorMean: z.number().finite().min(-2).max(2),
  tauModelSq: z.number().finite().min(0.1).max(5.0),
  anchorLabs: z.number().int().nonnegative(),
  withheldBenchmarkIds: z.array(z.string().min(1)),
  linkJointCov: LinkJointCovSchema.optional(),
  epochLink: EpochLinkSchema.nullable(),
});
export type RegimeMeta = z.infer<typeof RegimeMetaSchema>;

export const EpochVersionSchema = z
  .string()
  .regex(/^[a-z0-9-]+-v[1-9]\d*\.\d+\.\d+$/, "Invalid semantic epoch version");

export const EpochManifestSchema = z.record(
  z.string().regex(/^[a-z0-9-]+-v[1-9]\d*\.0\.0\.json$/),
  z.string().regex(/^[0-9a-f]{64}$/),
);
export type EpochManifest = z.infer<typeof EpochManifestSchema>;

export const DomainSnapshotSchema = z.object({
  domainId: DomainIdSchema,
  epochVersion: EpochVersionSchema,
  costUnit: CostUnitSchema,
  activeBenchmarkIds: z.array(z.string().min(1)),
  candidateBenchmarkIds: z.array(z.string().min(1)),
  benchmarkVersions: z.record(z.string(), z.string().min(1)),
  coverageFloor: z.number().int().positive(),
  tauResid: z.number().finite().nonnegative(),
  regimeMeta: z.partialRecord(HarnessRegimeSchema, RegimeMetaSchema),
  anchorStats: z.record(z.string(), AnchorStatsSchema),
  configs: z.array(EvaluatedConfigSchema),
  provisionalConfigs: z.array(EvaluatedConfigSchema),
  frontiers: z.array(ProviderFrontierSchema),
});
export type DomainSnapshot = z.infer<typeof DomainSnapshotSchema>;

export const BenchmarkAuditSchema = z.object({
  benchmarkId: z.string().min(1),
  benchmarkVersion: z.string().min(1),
  domainId: DomainIdSchema,
  harnessRegime: HarnessRegimeSchema,
  lifecycleState: BenchmarkLifecycleStateSchema,
  top5LabsCount: z.number().int().nonnegative(),
  coveredLabsCount: z.number().int().nonnegative(),
  top1Score: z.number().finite().nullable(),
  top5Score: z.number().finite().nullable(),
  top5Median: z.number().finite().nullable(),
  rNorm: z.number().finite().nullable(),
  saturationIndex: z.number().min(0).max(1).nullable(),
  separability: z.number().min(0).max(1).nullable(),
  looKendallTau: z.number().min(-1).max(1).nullable(),
  looCohortCount: z.number().int().nonnegative(),
  itemRestTau: z.number().min(-1).max(1).nullable(),
  ageMonths: z.number().finite().nonnegative(),
  upstreamLagDays: z.number().int().nonnegative().nullable(),
  triggerSince: z.string().min(1).nullable(),
  consecutiveTriggerDays: z.number().int().nonnegative(),
  status: z.enum([
    "healthy",
    "warning",
    "retire_trigger",
    "probation_ready",
    "probation_wait",
    "insufficient",
  ]),
  reasons: z.array(z.string()),
});
export type BenchmarkAudit = z.infer<typeof BenchmarkAuditSchema>;

export const CrossDomainCorrelationSchema = z.object({
  domainA: DomainIdSchema,
  regimeA: HarnessRegimeSchema,
  domainB: DomainIdSchema,
  regimeB: HarnessRegimeSchema,
  overlapCount: z.number().int().nonnegative(),
  kendallTau: z.number().min(-1).max(1).nullable(),
});
export type CrossDomainCorrelation = z.infer<typeof CrossDomainCorrelationSchema>;

function isValidIsoUtcTimestamp(value: string): boolean {
  const m = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const ss = Number(m[6]);
  if (hh > 23 || mm > 59 || ss > 59) return false;
  const tz = m[7]!;
  if (tz !== "Z") {
    const offH = Number(tz.slice(1, 3));
    const offM = Number(tz.slice(4, 6));
    if (offH > 23 || offM > 59) return false;
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

const IsoUtcTimestampSchema = z
  .string()
  .refine(isValidIsoUtcTimestamp, "Expected valid ISO-8601 UTC timestamp");

export const LifecycleReportSchema = z.object({
  auditedAt: IsoUtcTimestampSchema,
  audits: z.array(BenchmarkAuditSchema),
  crossDomainTau: z.array(CrossDomainCorrelationSchema),
});
export type LifecycleReport = z.infer<typeof LifecycleReportSchema>;

export const HarnessBenchmarkMetricSchema = z
  .object({
    benchmarkId: z.string().min(1),
    name: z.string().min(1),
    passRate: z.number().min(0).max(100),
    ciLower: z.number().min(0).max(100).nullable(),
    ciUpper: z.number().min(0).max(100).nullable(),
    ciIsUpperBound: z.boolean(),
    passAll3Rate: z.number().min(0).max(100).nullable().optional(),
    costPerTrialUsd: z.number().finite().positive(),
    nTasks: z.number().int().positive(),
    sourceUrl: HttpsUrlSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.ciLower !== null && val.ciUpper !== null && val.ciLower > val.ciUpper) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ciLower"],
        message: "ciLower must be <= ciUpper",
      });
    }
    if (
      val.passAll3Rate !== undefined &&
      val.passAll3Rate !== null &&
      val.passAll3Rate > val.passRate + 1e-6
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["passAll3Rate"],
        message: "passAll3Rate must be <= passRate",
      });
    }
  });
export type HarnessBenchmarkMetric = z.infer<typeof HarnessBenchmarkMetricSchema>;

export const HarnessEntrySchema = z
  .object({
    harnessId: z.string().min(1),
    name: z.string().min(1),
    vendor: z.string().min(1),
    color: z.string().min(1),
    version: z.string().min(1).nullable(),
    passRate: z.number().min(0).max(100),
    ciLower: z.number().min(0).max(100).nullable(),
    ciUpper: z.number().min(0).max(100).nullable(),
    costPerTrialUsd: z.number().finite().positive(),
    costPerPassUsd: z.number().finite().positive().nullable(),
    passAll3Rate: z.number().min(0).max(100).nullable(),
    tokensPerTrial: z.number().finite().nonnegative().nullable(),
    agentSecondsPerTrial: z.number().finite().nonnegative().nullable(),
    nScored: z.number().int().nonnegative(),
    onFrontier: z.boolean(),
    dominatedById: z.string().min(1).nullable(),
    scoreDeficit: z.number().finite().nonnegative().nullable(),
    costRatio: z.number().finite().positive().nullable(),
    benchmarks: z.array(HarnessBenchmarkMetricSchema).min(1),
  })
  .superRefine((val, ctx) => {
    if (val.ciLower !== null && val.ciUpper !== null && val.ciLower > val.ciUpper) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ciLower"],
        message: "ciLower must be <= ciUpper",
      });
    }
    if (val.passAll3Rate !== null && val.passAll3Rate > val.passRate + 1e-6) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["passAll3Rate"],
        message: "passAll3Rate must be <= passRate",
      });
    }
    const seenBms = new Set<string>();
    for (const bm of val.benchmarks) {
      if (seenBms.has(bm.benchmarkId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["benchmarks"],
          message: `Duplicate benchmarkId '${bm.benchmarkId}'`,
        });
      }
      seenBms.add(bm.benchmarkId);
    }
    if (val.onFrontier) {
      if (val.dominatedById !== null || val.scoreDeficit !== null || val.costRatio !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["onFrontier"],
          message: "Frontier harness must not have dominatedById, scoreDeficit, or costRatio",
        });
      }
    } else if (val.dominatedById === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dominatedById"],
        message: "Dominated harness must reference a frontier dominatedById",
      });
    }
  });
export type HarnessEntry = z.infer<typeof HarnessEntrySchema>;

export const HarnessModelSliceSchema = z
  .object({
    sliceId: z.string().min(1),
    label: z.string().min(1),
    org: z.string().nullable(),
    entries: z.array(HarnessEntrySchema).min(8),
  })
  .superRefine((slice, ctx) => {
    const seenIds = new Set<string>();
    const frontierIds = new Set<string>();
    for (const entry of slice.entries) {
      if (seenIds.has(entry.harnessId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries"],
          message: `Duplicate harnessId '${entry.harnessId}' in slice '${slice.sliceId}'`,
        });
      }
      seenIds.add(entry.harnessId);
      if (entry.onFrontier) frontierIds.add(entry.harnessId);
    }
    if (frontierIds.size === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: `Slice '${slice.sliceId}' has no frontier harness`,
      });
    }
    for (const entry of slice.entries) {
      if (entry.dominatedById !== null && !frontierIds.has(entry.dominatedById)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries"],
          message: `Harness '${entry.harnessId}' references non-frontier dominatedById '${entry.dominatedById}'`,
        });
      }
    }
  });
export type HarnessModelSlice = z.infer<typeof HarnessModelSliceSchema>;

export const HarnessLeaderboardSnapshotSchema = z
  .object({
    sourceVersion: z.string().min(1),
    upstreamGeneratedAt: IsoUtcTimestampSchema,
    sourceUrl: HttpsUrlSchema,
    slices: z.array(HarnessModelSliceSchema).min(1),
  })
  .superRefine((board, ctx) => {
    if (board.slices[0]?.sliceId !== "_all") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slices", 0, "sliceId"],
        message: "First harness leaderboard slice must be pooled '_all'",
      });
    }
    const seenSlices = new Set<string>();
    for (const slice of board.slices) {
      if (seenSlices.has(slice.sliceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["slices"],
          message: `Duplicate sliceId '${slice.sliceId}'`,
        });
      }
      seenSlices.add(slice.sliceId);
    }
  });
export type HarnessLeaderboardSnapshot = z.infer<typeof HarnessLeaderboardSnapshotSchema>;

export const ProChoiceSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: IsoUtcTimestampSchema,
  snapshotHash: z.string().min(1),
  sources: z.array(SourceHealthSchema),
  domains: z.record(DomainIdSchema, DomainSnapshotSchema),
  harnessLeaderboard: HarnessLeaderboardSnapshotSchema,
});
export type ProChoiceSnapshot = z.infer<typeof ProChoiceSnapshotSchema>;

export const UnmappedRecordSchema = z.object({
  sourceId: z.string().min(1),
  benchmarkId: z.string().min(1),
  rawModelName: z.string().min(1),
  rawProvider: z.string().nullable(),
  rawHarness: z.string().nullable(),
  reason: z.string().min(1),
});
export type UnmappedRecord = z.infer<typeof UnmappedRecordSchema>;
