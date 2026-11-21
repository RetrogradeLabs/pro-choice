# ProChoice Daily Ingestion Summary

- Generated at: 2026-11-21T21:16:16.186Z
- Snapshot hash: `43c4e78f820fecef`
- Unmapped allowlisted records: 684

## Mandatory Source Health
| Source | Status | Rows | Stale Days | Note |
| :--- | :--- | ---: | ---: | :--- |
| Artificial Analysis Frontier Suite | OK | 990 | 0 | OK |
| Aikido Arena Real-World CVE Detection | OK | 13 | 0 | OK |
| Collinear CWE-bench v2 (250 Public + Held-Out) | OK | 20 | 0 | OK |
| CyberArena Attack-Defense CTF (mc-v1) | OK | 14 | 0 | OK |
| Epoch AI Benchmark Hub (6 Frontier Benchmarks) | OK | 444 | 0 | OK |
| FrontierHarness Eval v1.1 (TB 2.1 + TB 4.0) | OK | 130 | 0 | OK |
| LMArena Style-Controlled & Agent Parquet Leaderboards | OK | 803 | 0 | OK |
| Terminal-Bench 4.1 Live Harness Board | OK | 54 | 0 | OK |
| Harness Leaderboard (TB 2.1 + DeepSWE) | OK | 65 | 0 | OK |
| LiveBench 2.0 Long-Agentic | OK | 38 | 0 | OK |
| Vals AI Frontier Suite (10 Benchmarks) | OK | 602 | 0 | OK |
| VulcanBench SWE v4 Agent Stacks | OK | 91 | 0 | OK |
| DesignArena Visual Arenas (Website, SVG, 3D, GameDev) | OK | 686 | 0 | designarena_3d: Upstream btStdErr null on 167 rows; conservatively down-weighted by reliability model; designarena_gamedev: Upstream btStdErr null on 173 rows; conservatively down-weighted by reliability model; designarena_svg: Upstream btStdErr null on 143 rows; conservatively down-weighted by reliability model; designarena_website: Upstream btStdErr null on 203 rows; conservatively down-weighted by reliability model |
| Lech Mazur & EQ-Bench v3 Creative and Longform Writing Feeds | OK | 356 | 0 | OK |
| Scale SEAL (PRBench Finance & Legal) | OK | 97 | 0 | OK |
| Surge AI Frontier Benchmarks (7 Benchmarks) | OK | 240 | 0 | OK |
| First-Party API Pricing (LiteLLM Verified SKUs) | OK | 71 | 0 | OK |

## Domain Coverage
| Domain | Epoch | Eligible | Provisional | Frontier Curves |
| :--- | :--- | ---: | ---: | ---: |
| Coding | coding-v2.0.0 | 155 | 41 | 9 |
| Writing | writing-v2.0.0 | 107 | 31 | 9 |
| Design | design-code-v2.0.0 | 125 | 30 | 9 |
| Research | research-v2.0.0 | 170 | 46 | 9 |
| Cyber | cyber-v2.0.0 | 28 | 5 | 9 |
| Harnesses | harnesses-v2.0.0 | 110 | 14 | 18 |

## Longitudinal Epoch Linking
- coding-v2.0.0/standardized vs coding-v1.0.0.json: Verified Mean-Sigma link (n=189, labs=9, r=0.939)
- writing-v2.0.0/native vs writing-v1.0.0.json: Verified Mean-Sigma link (n=129, labs=9, r=0.988)
- design-code-v2.0.0/native vs design-code-v1.0.0.json: Verified Mean-Sigma link (n=130, labs=9, r=0.976)
- research-v2.0.0/native vs research-v1.0.0.json: Verified Mean-Sigma link (n=205, labs=9, r=0.926)
- cyber-v2.0.0/native vs cyber-v1.0.0.json: Verified Mean-Sigma link (n=33, labs=9, r=0.999)
- harnesses-v2.0.0/native vs harnesses-v1.0.0.json: Verified Mean-Sigma link (n=124, labs=9, r=0.957)

## Daily Saturation & Lifecycle Audit
- Active benchmarks at sustained retirement trigger: 0
- Active benchmarks in warning state: 31
- Candidate benchmarks ready for next MAJOR cutover: 0

| Benchmark | Domain | State | Top Labs | S_index | Sep | LOO Tau | Status |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: | :--- |
| frontiercode_2_0 | coding | ACTIVE | 9 | 0.35 | 47% | 0.96 | WARNING |
| terminalbench_4_0 | coding | ACTIVE | 9 | 0.84 | 47% | 0.94 | WARNING |
| scicode_aa | coding | ACTIVE | 9 | 0.90 | 0% | 0.97 | WARNING |
| epoch_mirrorcode | coding | ACTIVE | 9 | 0.00 | 25% | 0.96 | WARNING |
| epoch_ale_bench | coding | ACTIVE | 9 | N/A | N/A | 0.96 | WARNING |
| epoch_frontierswe | coding | ACTIVE | 8 | 0.10 | 54% | 1.00 | HEALTHY |
| epoch_cursorbench | coding | ACTIVE | 5 | N/A | N/A | 0.99 | WARNING |
| lmarena_agent | coding | ACTIVE | 9 | 0.00 | 81% | 0.96 | HEALTHY |
| surge_sudo_l7 | coding | ACTIVE | 8 | 0.08 | 54% | 0.99 | HEALTHY |
| vals_code_migration | coding | ACTIVE | 9 | 0.00 | 83% | 0.99 | HEALTHY |
| vals_sre_bench | coding | ACTIVE | 8 | 0.00 | 86% | 0.97 | HEALTHY |
| livebench_long_agentic | coding | ACTIVE | 9 | 0.25 | 42% | 0.99 | WARNING |
| tbench_4_1 | harnesses | ACTIVE | 9 | 0.55 | 53% | 0.92 | WARNING |
| vulcanbench_swe_v4 | harnesses | ACTIVE | 5 | 0.00 | 60% | 0.91 | HEALTHY |
| aa_agent_frontiercode | harnesses | ACTIVE | 6 | 0.21 | 60% | 0.96 | HEALTHY |
| aa_agent_swe_atlas | harnesses | ACTIVE | 6 | 0.90 | 0% | 0.96 | WARNING |
| lmarena_creative_writing | writing | ACTIVE | 9 | 0.00 | 75% | 0.77 | HEALTHY |
| lechmazur_writing | writing | ACTIVE | 9 | 0.00 | 92% | 0.88 | HEALTHY |
| eqbench_creative_writing | writing | ACTIVE | 9 | 0.99 | 0% | 0.98 | WARNING |
| eqbench_longform_writing | writing | ACTIVE | 9 | 0.98 | 0% | 0.98 | WARNING |
| surge_complex_constraints | writing | ACTIVE | 8 | 0.72 | 21% | 0.98 | WARNING |
| vals_vibe_code | design_code | ACTIVE | 9 | 0.00 | 33% | 0.97 | WARNING |
| vals_swebench_multimodal | design_code | ACTIVE | 8 | 0.00 | 46% | 0.99 | WARNING |
| lmarena_webdev | design_code | ACTIVE | 9 | 0.00 | 92% | 0.93 | HEALTHY |
| designarena_website | design_code | ACTIVE | 9 | N/A | N/A | 0.99 | WARNING |
| designarena_svg | design_code | ACTIVE | 9 | N/A | N/A | 0.97 | WARNING |
| designarena_3d | design_code | ACTIVE | 9 | N/A | N/A | 0.97 | WARNING |
| designarena_gamedev | design_code | ACTIVE | 9 | N/A | N/A | 0.97 | WARNING |
| aa_code2video | design_code | ACTIVE | 8 | 0.00 | 79% | 0.99 | HEALTHY |
| mlcr_aa | research | ACTIVE | 9 | 0.74 | 25% | 0.99 | WARNING |
| aa_omniscience | research | ACTIVE | 9 | 0.00 | 89% | 0.98 | HEALTHY |
| gdp_pdf | research | ACTIVE | 9 | 0.95 | 25% | 0.99 | WARNING |
| hle_diamond | research | ACTIVE | 9 | 0.00 | 92% | 0.97 | HEALTHY |
| critpt_v2_hard | research | ACTIVE | 9 | 0.34 | 47% | 0.98 | WARNING |
| terminalbench_science_aa | research | ACTIVE | 9 | 0.02 | 69% | 0.97 | HEALTHY |
| aa_analyst_agent | research | ACTIVE | 8 | 0.61 | 50% | 1.00 | WARNING |
| aa_mka | research | ACTIVE | 8 | 0.63 | 43% | 1.00 | WARNING |
| aa_vials | research | ACTIVE | 8 | 0.28 | 57% | 1.00 | HEALTHY |
| aa_briefcase | research | ACTIVE | 9 | 0.00 | 92% | 1.00 | HEALTHY |
| gdpval_aa | research | ACTIVE | 8 | 0.00 | 82% | 1.00 | HEALTHY |
| epoch_simpleqa_verified | research | ACTIVE | 9 | 0.00 | 83% | 0.94 | HEALTHY |
| epoch_apex_agents | research | ACTIVE | 8 | 0.00 | 57% | 0.99 | HEALTHY |
| lmarena_factuality | research | ACTIVE | 9 | 0.00 | 81% | 0.96 | HEALTHY |
| vals_legal_research | research | ACTIVE | 9 | 0.08 | 11% | 0.98 | WARNING |
| vals_finance_agent | research | ACTIVE | 9 | 0.13 | 28% | 0.99 | WARNING |
| vals_emb | research | ACTIVE | 9 | 0.06 | 17% | 1.00 | WARNING |
| vals_tax_agent | research | ACTIVE | 9 | 0.04 | 39% | 0.96 | WARNING |
| vals_mystery_mechanism | research | ACTIVE | 9 | 0.00 | 64% | 0.99 | HEALTHY |
| vals_medcode | research | ACTIVE | 9 | 0.00 | 72% | 0.97 | HEALTHY |
| surge_gdp_xlsx | research | ACTIVE | 9 | 0.43 | 25% | 1.00 | WARNING |
| surge_dayjob_finance | research | ACTIVE | 9 | 0.32 | 61% | 0.99 | HEALTHY |
| surge_dayjob_law | research | ACTIVE | 8 | 0.41 | 54% | 1.00 | HEALTHY |
| surge_dayjob_healthcare | research | ACTIVE | 9 | 0.51 | 61% | 0.99 | WARNING |
| surge_riemann | research | ACTIVE | 9 | 0.49 | 44% | 1.00 | WARNING |
| scale_prbench_finance | research | ACTIVE | 6 | 0.00 | 93% | 0.99 | HEALTHY |
| scale_prbench_legal | research | ACTIVE | 7 | 0.00 | 86% | 0.96 | HEALTHY |
| cwe_bench_v2 | cyber | ACTIVE | 9 | 0.00 | 78% | N/A | HEALTHY |
| cyberarena_mc_v1 | cyber | ACTIVE | 8 | 0.00 | 64% | N/A | HEALTHY |
| aikido_arena | cyber | ACTIVE | 6 | 0.87 | 0% | 0.96 | WARNING |
