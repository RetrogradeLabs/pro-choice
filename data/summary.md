# ProChoice Daily Ingestion Summary

- Generated at: 2026-11-21T06:39:49.514Z
- Snapshot hash: `43237d0f0a7497fc`
- Unmapped allowlisted records: 583

## Mandatory Source Health
| Source | Status | Rows | Stale Days | Note |
| :--- | :--- | ---: | ---: | :--- |
| Artificial Analysis Frontier Suite | OK | 1400 | 0 | OK |
| Aikido Arena Real-World CVE Detection | OK | 13 | 0 | OK |
| Collinear CWE-bench v2 (250 Public + Held-Out) | OK | 20 | 0 | OK |
| CyberArena Attack-Defense CTF (mc-v1) | OK | 14 | 0 | OK |
| Datacurve DeepSWE v1.1 | OK | 69 | 0 | OK |
| Epoch AI Benchmark Hub (10 Frontier Benchmarks) | OK | 1020 | 0 | OK |
| FrontierHarness Eval v1.1 (TB 2.1 + TB 4.0) | OK | 130 | 0 | OK |
| LMArena Style-Controlled Parquet Leaderboards | OK | 781 | 0 | OK |
| Terminal-Bench 4.1 Live Harness Board | OK | 54 | 0 | OK |
| Harness Leaderboard (TB 2.1 + DeepSWE) | OK | 60 | 0 | OK |
| LiveBench 2.0 Coding, Research & Data Analysis | OK | 114 | 0 | OK |
| Vals AI Vibe Code | OK | 129 | 0 | OK |
| VulcanBench SWE v4 Agent Stacks | OK | 91 | 0 | OK |
| DesignArena Website Arena | OK | 192 | 0 | OK |
| Lech Mazur & EQ-Bench v3 Longform Writing Feeds | OK | 210 | 0 | OK |
| Scale SEAL (SWE-bench Pro v2) | OK | 12 | 0 | OK |
| WeirdML v3 Coding Agent Stacks | OK | 29 | 0 | OK |
| First-Party API Pricing (LiteLLM Verified SKUs) | OK | 71 | 0 | OK |

## Domain Coverage
| Domain | Epoch | Eligible | Provisional | Frontier Curves |
| :--- | :--- | ---: | ---: | ---: |
| Coding | coding-v1.0.0 | 153 | 68 | 9 |
| Writing | writing-v1.0.0 | 101 | 28 | 9 |
| Design | design-code-v1.0.0 | 108 | 26 | 9 |
| Research | research-v1.0.0 | 238 | 57 | 9 |
| Cyber | cyber-v1.0.0 | 28 | 5 | 9 |
| Harnesses | harnesses-v1.0.0 | 117 | 29 | 21 |

## Daily Saturation & Lifecycle Audit
- Active benchmarks at sustained retirement trigger: 0
- Active benchmarks in warning state: 21
- Candidate benchmarks ready for next MAJOR cutover: 0

| Benchmark | Domain | State | Top Labs | S_index | Sep | LOO Tau | Status |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: | :--- |
| frontiercode_2_0 | coding | ACTIVE | 9 | 0.38 | 47% | 0.92 | WARNING |
| terminalbench_4_0 | coding | ACTIVE | 9 | 0.85 | 44% | 0.97 | WARNING |
| scicode_aa | coding | ACTIVE | 9 | 0.90 | 0% | 0.96 | WARNING |
| livebench_coding | coding | ACTIVE | 9 | 0.75 | 42% | 0.99 | WARNING |
| epoch_mirrorcode | coding | ACTIVE | 9 | 0.00 | 25% | 0.95 | WARNING |
| epoch_ale_bench | coding | ACTIVE | 9 | N/A | N/A | 0.98 | WARNING |
| deepswe_v1_1 | coding | ACTIVE | 9 | 0.01 | 64% | 0.91 | HEALTHY |
| swe_bench_pro_v2 | coding | ACTIVE | 6 | 0.00 | 53% | 0.98 | HEALTHY |
| epoch_frontierswe | coding | ACTIVE | 8 | 0.15 | 54% | 0.98 | HEALTHY |
| tbench_4_1 | harnesses | ACTIVE | 9 | 0.56 | 53% | 0.95 | WARNING |
| vulcanbench_swe_v4 | harnesses | ACTIVE | 5 | 0.00 | 60% | 0.88 | HEALTHY |
| aa_agent_frontiercode | harnesses | ACTIVE | 6 | 0.26 | 60% | 0.89 | HEALTHY |
| aa_agent_swe_atlas | harnesses | ACTIVE | 6 | 0.91 | 0% | 0.97 | WARNING |
| weirdml_v3 | harnesses | ACTIVE | 7 | 0.00 | 81% | 0.92 | HEALTHY |
| epoch_posttrainbench | harnesses | ACTIVE | 6 | 0.69 | 0% | 0.99 | WARNING |
| lmarena_creative_writing | writing | ACTIVE | 9 | 0.00 | 75% | 0.79 | HEALTHY |
| lmarena_document | research | ACTIVE | 7 | 0.00 | 81% | 0.98 | HEALTHY |
| aa_briefcase | research | ACTIVE | 9 | 0.00 | 92% | 0.99 | HEALTHY |
| gdpval_aa | research | ACTIVE | 8 | 0.00 | 82% | 0.99 | HEALTHY |
| lechmazur_writing | writing | ACTIVE | 9 | 0.00 | 92% | 0.84 | HEALTHY |
| eqbench_longform | writing | ACTIVE | 9 | 0.96 | 11% | 0.98 | WARNING |
| vals_vibe_code | design_code | ACTIVE | 9 | 0.00 | 33% | 0.92 | WARNING |
| lmarena_webdev | design_code | ACTIVE | 9 | 0.00 | 92% | 0.91 | HEALTHY |
| designarena_website | design_code | ACTIVE | 9 | 0.00 | 83% | 0.89 | HEALTHY |
| mlcr_aa | research | ACTIVE | 9 | 0.76 | 17% | 1.00 | WARNING |
| aa_omniscience | research | ACTIVE | 9 | 0.00 | 89% | 0.97 | HEALTHY |
| gdp_pdf | research | ACTIVE | 9 | 0.96 | 19% | 1.00 | WARNING |
| hle_diamond | research | ACTIVE | 9 | 0.00 | 92% | 0.98 | HEALTHY |
| critpt_v2_hard | research | ACTIVE | 9 | 0.40 | 44% | 0.99 | WARNING |
| terminalbench_science_aa | research | ACTIVE | 9 | 0.04 | 67% | 0.98 | HEALTHY |
| aa_analyst_agent | research | ACTIVE | 8 | 0.59 | 50% | 1.00 | WARNING |
| aa_mka | research | ACTIVE | 8 | 0.63 | 43% | 1.00 | WARNING |
| aa_vials | research | ACTIVE | 8 | 0.39 | 54% | 1.00 | HEALTHY |
| epoch_simpleqa_verified | research | ACTIVE | 9 | 0.00 | 83% | 0.97 | HEALTHY |
| epoch_frontiermath_t1_3 | research | ACTIVE | 9 | 0.00 | 69% | 0.98 | HEALTHY |
| epoch_frontiermath_t4 | research | ACTIVE | 9 | 0.07 | 67% | 0.98 | WARNING |
| epoch_proofbench | research | ACTIVE | 9 | 0.00 | 78% | 0.98 | HEALTHY |
| epoch_arc_agi_2 | research | ACTIVE | 9 | 0.16 | 69% | 0.95 | WARNING |
| epoch_apex_agents | research | ACTIVE | 8 | 0.00 | 57% | 1.00 | HEALTHY |
| lmarena_factuality | research | ACTIVE | 9 | 0.00 | 81% | 0.96 | HEALTHY |
| livebench_research | research | ACTIVE | 9 | 0.98 | 0% | 0.99 | WARNING |
| livebench_data_analysis | research | ACTIVE | 9 | 0.94 | 0% | 0.99 | WARNING |
| cwe_bench_v2 | cyber | ACTIVE | 9 | 0.00 | 78% | 0.93 | HEALTHY |
| cyberarena_mc_v1 | cyber | ACTIVE | 8 | 0.00 | 64% | 0.88 | HEALTHY |
| aikido_arena | cyber | ACTIVE | 6 | 0.92 | 0% | 0.98 | WARNING |
