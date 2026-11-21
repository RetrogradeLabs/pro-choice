const FAMILY_BY_BENCHMARK: Readonly<Record<string, string>> = {
  cwe_bench_v2: "Security repair",
  aikido_arena: "Security defect detection",
  tbench_4_1: "Terminal work",
  vulcanbench_swe_v4: "Repository changes",
  aa_agent_frontiercode: "Repository changes",
  aa_agent_swe_atlas: "Repository comprehension",
  frontiercode_2_0: "Repository changes",
  deepswe_v1_1: "Repository changes",
  swe_bench_pro_v2: "Repository changes",
  livebench_coding: "Repository changes",
  terminalbench_4_0: "Terminal work",
  itbench_aa: "Incident diagnosis",
  epoch_mirrorcode: "Behavioral reconstruction",
  epoch_ale_bench: "Algorithmic optimization",
  epoch_frontierswe: "Long-horizon engineering projects",
  vals_code_migration: "Code migration",

  surge_hemingway: "Mixed-genre editorial preference",
  writingbench_academic_engineering: "Academic and engineering writing",
  lmarena_creative_writing: "Mixed-genre editorial preference",
  lechmazur_writing: "Mixed-genre editorial preference",
  eqbench_longform: "Long-form narrative",
  vals_medscribe: "Clinical documentation",

  vals_vibe_code: "Web interfaces",
  lmarena_webdev: "Web interfaces",
  designarena_website: "Web interfaces",
  livebench_design: "Document and slide design",
  designarena_svg: "Vector illustration",
  code2video_aa: "Motion graphics",

  surge_chartography: "Chart interpretation",
  epoch_frontiermath_t1_3: "Research mathematics",
  mlcr_aa: "Clinical record reasoning",
  aa_omniscience: "Factual recall",
  terminalbench_science_aa: "Scientific computing",
  harvey_lab_aa: "Legal work products",
  vals_legal_research: "Legal research",
  vals_finance_agent: "Financial research",
  livebench_table_join: "Table schema matching",
  vals_excel_modeling: "Executable financial workbook construction",
};

export function measurementFamilyFor(benchmarkId: string): string {
  const family = FAMILY_BY_BENCHMARK[benchmarkId];
  if (!family) throw new Error(`No measurement family for benchmark ${benchmarkId}`);
  return family;
}

// A new edition of the same problem set keeps the same pool ID. A documented disjoint split may have its own.
const DATASET_POOLS: Readonly<Record<string, readonly string[]>> = {
  frontiercode_2_0: ["cognition/frontiercode-2"],
  aa_agent_frontiercode: ["cognition/frontiercode-2"],
  deepswe_v1_1: ["datacurve/deepswe-1"],
  swe_bench_pro_v2: ["scale/swe-bench-pro-public"],
  livebench_coding: ["livebench/20261106/coding"],
  terminalbench_4_0: ["laude/terminal-bench-4"],
  tbench_4_1: ["laude/terminal-bench-4"],
  itbench_aa: ["ibm/itbench-sre"],
  epoch_mirrorcode: ["epoch/mirrorcode"],
  epoch_ale_bench: ["sakana/ale-bench"],
  epoch_frontierswe: ["frontierswe/engineering-v2"],
  vals_code_migration: ["vals/code-migration"],
  vulcanbench_swe_v4: ["vulcanbench/swe-v4"],
  aa_agent_swe_atlas: ["scale/swe-atlas-qna"],

  surge_hemingway: ["surge/hemingway"],
  writingbench_academic_engineering: ["x-plug/writingbench/academic-engineering"],
  lmarena_creative_writing: ["arena/text-preference-battles"],
  lechmazur_writing: ["lechmazur/writing"],
  eqbench_longform: ["eqbench/longform-story-prompts"],
  vals_medscribe: ["vals/medscribe"],

  vals_vibe_code: ["vals/vibe-code"],
  lmarena_webdev: ["arena/webdev-battles"],
  designarena_website: ["designarena/website"],
  designarena_svg: ["designarena/svg"],
  livebench_design: ["livebench/20261106/design"],
  code2video_aa: ["artificial-analysis/code2video"],

  surge_chartography: ["surge/chartography"],
  epoch_frontiermath_t1_3: ["epoch/frontiermath/tiers-1-3"],
  mlcr_aa: ["artificial-analysis/medical-long-context-reasoning"],
  aa_omniscience: ["artificial-analysis/omniscience"],
  terminalbench_science_aa: ["terminal-bench/science"],
  harvey_lab_aa: ["harvey/legal-agent-benchmark-1"],
  vals_legal_research: ["vals/legal-research"],
  vals_finance_agent: ["vals/finance-agent"],
  vals_excel_modeling: ["vals/excel-modeling"],
  livebench_table_join: ["livebench/20261106/data-analysis/table-join"],
  aikido_arena: ["aikido/arena-detection"],
  cwe_bench_v2: ["collinear/cwe-bench-v2"],
};

export function datasetPoolsFor(id: string): readonly string[] {
  const pools = DATASET_POOLS[id];
  if (!pools?.length) throw new Error(`No dataset lineage declared for ${id}`);
  return pools;
}

export function assertDisjointRoster(
  members: readonly {
    benchmarkId: string;
    measurementFamily: string;
    datasetPools: readonly string[];
  }[],
): void {
  const familyOwners = new Map<string, string>();
  const poolOwners = new Map<string, string>();
  for (const member of members) {
    const familyOwner = familyOwners.get(member.measurementFamily);
    if (familyOwner) {
      throw new Error(
        `Overlapping work: ${familyOwner} and ${member.benchmarkId} both measure ${member.measurementFamily}`,
      );
    }
    familyOwners.set(member.measurementFamily, member.benchmarkId);
    for (const pool of member.datasetPools) {
      for (const [used, owner] of poolOwners) {
        if (used === pool || used.startsWith(`${pool}/`) || pool.startsWith(`${used}/`)) {
          throw new Error(
            `Overlapping datasets: ${owner} (${used}) and ${member.benchmarkId} (${pool})`,
          );
        }
      }
      poolOwners.set(pool, member.benchmarkId);
    }
  }
}
