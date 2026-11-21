# ProChoice Daily Ingestion Summary

- Generated at: 2026-11-21T09:31:21.239Z
- Snapshot hash: `6aa5247f8f563c56`
- Unmapped allowlisted records: 612

## Mandatory Source Health
| Source | Status | Rows | Stale Days | Note |
| :--- | :--- | ---: | ---: | :--- |
| Artificial Analysis Frontier Suite | OK | 1367 | 0 | OK |
| Aikido Arena Real-World CVE Detection | OK | 13 | 0 | OK |
| Collinear CWE-bench v2 (250 Public + Held-Out) | OK | 20 | 0 | OK |
| Datacurve DeepSWE v1.1 | OK | 69 | 0 | OK |
| Epoch AI Benchmark Hub | OK | 711 | 0 | OK |
| FrontierHarness Eval v1.1 (TB 2.1 + TB 4.0) | OK | 130 | 0 | OK |
| LMArena Style-Controlled Parquet Leaderboards | OK | 781 | 0 | OK |
| Terminal-Bench 4.1 Live Harness Board | OK | 54 | 0 | OK |
| Harness Leaderboard (TB 2.1 + DeepSWE) | OK | 65 | 0 | OK |
| LiveBench 2.0 Coding, Research, Data Analysis and Design | OK | 190 | 0 | OK |
| Vals AI professional task benchmarks | OK | 301 | 0 | OK |
| VulcanBench SWE v4 Agent Stacks | OK | 91 | 0 | OK |
| DesignArena Website and SVG Arenas | OK | 311 | 0 | designarena_svg: Upstream btStdErr null on 124 rows; conservatively down-weighted by reliability model; designarena_website: Upstream btStdErr null on 187 rows; conservatively down-weighted by reliability model |
| Lech Mazur, EQ-Bench Longform and WritingBench Academic & Engineering | OK | 264 | 0 | OK |
| Scale SEAL (SWE-bench Pro v2) | OK | 12 | 0 | OK |
| Surge AI expert evaluations | OK | 115 | 0 | OK |
| WeirdML v3 Coding Agent Stacks | OK | 29 | 0 | OK |
| First-Party API Pricing (LiteLLM Verified SKUs) | OK | 71 | 0 | OK |
| ↳ designarena_svg | OK | 124 | | Upstream btStdErr null on 124 rows; conservatively down-weighted by reliability model |
| ↳ designarena_website | OK | 187 | | Upstream btStdErr null on 187 rows; conservatively down-weighted by reliability model |

## Domain Coverage
| Domain | Epoch | Eligible | Provisional | Frontier Curves |
| :--- | :--- | ---: | ---: | ---: |
| Coding | coding-v3.0.0 | 111 | 60 | 9 |
| Writing | writing-v3.0.0 | 29 | 77 | 7 |
| Design | design-code-v3.0.0 | 60 | 60 | 9 |
| Research | research-v3.0.0 | 134 | 34 | 9 |
| Cyber | cyber-v2.0.0 | 15 | 10 | 7 |
| Harnesses | harnesses-v2.0.0 | 61 | 37 | 4 |

## Longitudinal Epoch Linking
- coding-v3.0.0/standardized vs coding-v2.0.0.json: Verified Mean-Sigma link (n=171, labs=9, r=0.960)
- writing-v3.0.0/native vs writing-v2.0.0.json: Construct shift detected (r=0.588 < 0.85); epoch scales are incomparable
- design-code-v3.0.0/native vs design-code-v2.0.0.json: Verified Mean-Sigma link (n=120, labs=9, r=0.969)
- research-v3.0.0/native vs research-v2.0.0.json: Verified Mean-Sigma link (n=167, labs=9, r=0.935)
- cyber-v2.0.0/native vs cyber-v1.0.0.json: Verified Mean-Sigma link (n=25, labs=9, r=0.939)
- harnesses-v2.0.0/native vs harnesses-v1.0.0.json: Verified Mean-Sigma link (n=98, labs=7, r=0.884)

## Daily Saturation & Lifecycle Audit
- Active benchmarks at sustained retirement trigger: 0
- Active benchmarks in warning state: 19
- Candidate benchmarks ready for next MAJOR cutover: 0

| Benchmark | Domain | State | Top Labs | S_index | Sep | LOO Tau | Status |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: | :--- |
| vals_code_migration | coding | ACTIVE | 8 | 0.62 | 39% | 0.98 | WARNING |
| vals_medscribe | writing | ACTIVE | 9 | 0.23 | 11% | 0.81 | WARNING |
| vals_legal_research | research | ACTIVE | 9 | 0.08 | 19% | 0.95 | WARNING |
| vals_finance_agent | research | ACTIVE | 9 | 0.13 | 28% | 0.98 | WARNING |
| vals_excel_modeling | research | ACTIVE | 9 | 0.11 | 3% | 0.99 | WARNING |
| surge_chartography | research | ACTIVE | 8 | N/A | N/A | 0.98 | WARNING |
| surge_hemingway | writing | ACTIVE | 9 | 0.00 | 72% | 0.93 | HEALTHY |
| frontiercode_2_0 | coding | ACTIVE | 9 | 0.38 | 47% | 0.94 | WARNING |
| itbench_aa | coding | ACTIVE | 8 | 0.89 | 0% | 0.97 | WARNING |
| epoch_mirrorcode | coding | ACTIVE | 9 | 0.00 | 25% | 0.95 | WARNING |
| epoch_ale_bench | coding | ACTIVE | 9 | N/A | N/A | 0.93 | WARNING |
| vulcanbench_swe_v4 | harnesses | ACTIVE | 5 | 0.00 | 60% | 0.90 | HEALTHY |
| aa_agent_swe_atlas | harnesses | ACTIVE | 6 | 0.91 | 0% | 0.85 | WARNING |
| writingbench_academic_engineering | writing | ACTIVE | 5 | N/A | N/A | 0.99 | WARNING |
| eqbench_longform | writing | ACTIVE | 9 | 0.99 | 0% | 0.92 | WARNING |
| livebench_design | design_code | ACTIVE | 9 | 0.96 | 0% | 0.95 | WARNING |
| designarena_svg | design_code | ACTIVE | 9 | N/A | N/A | 0.96 | WARNING |
| code2video_aa | design_code | ACTIVE | 9 | 0.00 | 75% | 0.96 | HEALTHY |
| lmarena_webdev | design_code | ACTIVE | 9 | 0.00 | 92% | 0.85 | HEALTHY |
| mlcr_aa | research | ACTIVE | 9 | 0.76 | 17% | 0.94 | WARNING |
| aa_omniscience | research | ACTIVE | 9 | 0.00 | 89% | 0.92 | HEALTHY |
| terminalbench_science_aa | research | ACTIVE | 9 | 0.04 | 67% | 0.94 | HEALTHY |
| harvey_lab_aa | research | ACTIVE | 9 | 0.67 | 14% | 0.98 | WARNING |
| epoch_frontiermath_t1_3 | research | ACTIVE | 9 | 0.00 | 69% | 0.94 | HEALTHY |
| livebench_table_join | research | ACTIVE | 9 | N/A | N/A | 0.99 | WARNING |
| cwe_bench_v2 | cyber | ACTIVE | 9 | 0.00 | 78% | 0.64 | HEALTHY |
| aikido_arena | cyber | ACTIVE | 6 | 0.92 | 0% | 1.00 | WARNING |

## Agreement on shared benchmarks

Adjacent points on each provider's frontier, compared using only benchmark scores observed for both configurations and their frozen weights.

| Domain | Same order | Reverse order | Tied in either order | No shared benchmark |
| --- | ---: | ---: | ---: | ---: |
| coding | 24 | 4 | 0 | 5 |
| writing | 7 | 0 | 0 | 0 |
| design_code | 18 | 0 | 0 | 0 |
| research | 32 | 2 | 0 | 2 |
| harnesses | 10 | 2 | 1 | 0 |
| cyber | 5 | 0 | 0 | 0 |

## Held-out feed results

Each fit excludes the entire target feed before calibration. Kendall tau-b compares eligible predictions with the target benchmark's raw score on the same configurations. The baseline averages standardized scores equally. Both columns require four matched configurations and an order on both sides.

| Benchmark | Feed held out | Matched / observed | Matched providers | Refit index | Equal weight | Both policies matched | Equal family | Quality family |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| vals_code_migration | vals | 0/17 | 0 | N/A | N/A | 0 | N/A | N/A |
| frontiercode_2_0 | artificial-analysis | 16/85 | 8 | 0.717 | 0.717 | 16 | 0.717 | 0.700 |
| itbench_aa | artificial-analysis | 16/28 | 8 | 0.217 | 0.226 | 16 | 0.217 | 0.133 |
| epoch_mirrorcode | epoch | 0/47 | 0 | N/A | N/A | 0 | N/A | N/A |
| epoch_ale_bench | epoch | 0/82 | 0 | N/A | N/A | 0 | N/A | N/A |
| vals_medscribe | vals | 3/49 | 2 | N/A | N/A | 3 | N/A | N/A |
| surge_hemingway | surge | 8/28 | 4 | -0.286 | -0.143 | 8 | -0.286 | -0.143 |
| writingbench_academic_engineering | writing-feeds | 0/9 | 0 | N/A | N/A | 0 | N/A | N/A |
| eqbench_longform | writing-feeds | 0/55 | 0 | N/A | N/A | 0 | N/A | N/A |
| livebench_design | livebench | 23/30 | 9 | 0.615 | 0.647 | 23 | 0.615 | 0.631 |
| designarena_svg | designarena | 25/47 | 8 | 0.687 | 0.687 | 25 | 0.687 | 0.680 |
| code2video_aa | artificial-analysis | 6/17 | 5 | -0.067 | -0.067 | 6 | -0.067 | -0.067 |
| lmarena_webdev | lmarena | 0/89 | 0 | N/A | N/A | 0 | N/A | N/A |
| vals_legal_research | vals | 48/53 | 9 | 0.401 | 0.385 | 48 | 0.401 | 0.337 |
| vals_finance_agent | vals | 25/25 | 9 | 0.107 | 0.100 | 25 | 0.107 | 0.113 |
| vals_excel_modeling | vals | 28/28 | 9 | 0.645 | 0.624 | 28 | 0.645 | 0.609 |
| surge_chartography | surge | 30/31 | 8 | 0.586 | 0.545 | 30 | 0.586 | 0.618 |
| mlcr_aa | artificial-analysis | 29/74 | 9 | 0.218 | 0.258 | 29 | 0.218 | 0.223 |
| aa_omniscience | artificial-analysis | 27/87 | 9 | 0.367 | 0.413 | 27 | 0.367 | 0.328 |
| terminalbench_science_aa | artificial-analysis | 27/86 | 9 | 0.561 | 0.601 | 27 | 0.561 | 0.492 |
| harvey_lab_aa | artificial-analysis | 25/41 | 9 | 0.365 | 0.305 | 25 | 0.365 | 0.305 |
| epoch_frontiermath_t1_3 | epoch | 50/86 | 8 | 0.675 | 0.673 | 50 | 0.675 | 0.643 |
| livebench_table_join | livebench | 26/30 | 9 | 0.407 | 0.407 | 26 | 0.407 | 0.450 |
| vulcanbench_swe_v4 | vulcanbench | 17/86 | 2 | 0.435 | 0.435 | 17 | 0.435 | 0.435 |
| aa_agent_swe_atlas | artificial-analysis | 17/29 | 2 | 0.435 | 0.435 | 17 | 0.435 | 0.435 |
| cwe_bench_v2 | cwe-bench | 0/17 | 0 | N/A | N/A | 0 | N/A | N/A |
| aikido_arena | aikido | 2/10 | 2 | N/A | N/A | 2 | N/A | N/A |
