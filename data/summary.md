# ProChoice Daily Ingestion Summary

- Generated at: 2026-11-22T14:18:22.348Z
- Snapshot hash: `313a974fbd864b61`
- Unmapped allowlisted records: 497

## Mandatory Source Health
| Source | Status | Rows | Stale Days | Note |
| :--- | :--- | ---: | ---: | :--- |
| Artificial Analysis Frontier Suite | OK | 379 | 0 | OK |
| Aikido Arena Real-World CVE Detection | OK | 13 | 0 | OK |
| ARC Prize (ARC-AGI-3 Semi-Private) | OK | 89 | 0 | OK |
| Collinear CWE-bench v2 (150 Held-Out Private Tasks) | OK | 20 | 0 | OK |
| CyberArena Attack-Defense CTF (mc-v1) | OK | 14 | 0 | OK |
| Epoch AI Benchmark Hub (2 Frontier Benchmarks) | OK | 181 | 0 | OK |
| FrontierHarness Eval v1.1 (TB 2.1 + TB 4.0) | OK | 130 | 0 | OK |
| LMArena Style-Controlled & Agent Parquet Leaderboards | OK | 871 | 0 | OK |
| Harness Leaderboard (TB 2.1 + DeepSWE) | OK | 65 | 0 | OK |
| LiveBench 2.0 Contamination-Free Suite | OK | 38 | 0 | OK |
| Vals AI Frontier Suite (8 Benchmarks) | OK | 447 | 0 | OK |
| DesignArena Visual & Agentic Arenas (7 Modalities) | OK | 776 | 0 | designarena_slides: Upstream btStdErr null on 38 rows; conservatively down-weighted by reliability model; designarena_svg: Upstream btStdErr null on 143 rows; conservatively down-weighted by reliability model |
| Surge AI Frontier Benchmarks (11 Benchmarks) | OK | 398 | 0 | OK |
| ToneBench Script Writing | OK | 150 | 0 | OK |
| First-Party API Pricing (LiteLLM Verified SKUs) | OK | 71 | 0 | OK |

## Domain Coverage
| Domain | Epoch | Eligible | Provisional | Frontier Curves |
| :--- | :--- | ---: | ---: | ---: |
| Coding | coding-v3.0.0 | 59 | 69 | 9 |
| Writing | writing-v4.0.0 | 37 | 124 | 8 |
| Design | design-code-v4.0.0 | 64 | 64 | 9 |
| Research | research-v4.0.0 | 47 | 195 | 9 |
| Cyber | cyber-v3.0.0 | 28 | 5 | 9 |
| Harnesses | harnesses-v3.0.0 | 28 | 1 | 10 |

## Longitudinal Epoch Linking
- coding-v3.0.0/standardized vs coding-v2.0.0.json: Verified Mean-Sigma link (n=64, labs=9, r=0.971)
- writing-v4.0.0/native vs writing-v3.0.0.json: Verified Mean-Sigma link (n=43, labs=8, r=0.969)
- design-code-v4.0.0/native vs design-code-v3.0.0.json: Verified Mean-Sigma link (n=66, labs=9, r=0.997)
- research-v4.0.0/native vs research-v3.0.0.json: Verified Mean-Sigma link (n=53, labs=9, r=0.968)
- cyber-v3.0.0/native vs cyber-v2.0.0.json: Verified Mean-Sigma link (n=33, labs=9, r=0.996)
- harnesses-v3.0.0/native vs harnesses-v2.0.0.json: Verified Mean-Sigma link (n=29, labs=6, r=0.910)

## Daily Saturation & Lifecycle Audit
- Active benchmarks at sustained retirement trigger: 0
- Active benchmarks in warning state: 25
- Candidate benchmarks ready for next MAJOR cutover: 0

| Benchmark | Domain | State | Top Labs | S_index | Sep | LOO Tau | Status |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: | :--- |
| frontiercode_2_0 | coding | ACTIVE | 9 | 0.35 | 47% | 0.94 | WARNING |
| epoch_cursorbench | coding | ACTIVE | 5 | N/A | N/A | 0.98 | WARNING |
| lmarena_agent | coding | ACTIVE | 9 | 0.00 | 81% | 0.96 | HEALTHY |
| surge_sudo_l7 | coding | ACTIVE | 8 | 0.08 | 54% | 0.98 | HEALTHY |
| vals_code_migration | coding | ACTIVE | 9 | 0.00 | 83% | 0.96 | HEALTHY |
| livebench_long_agentic | coding | ACTIVE | 9 | 0.25 | 42% | 0.98 | WARNING |
| aa_agent_frontiercode | harnesses | ACTIVE | 6 | 0.21 | 60% | N/A | HEALTHY |
| lmarena_creative_writing | writing | ACTIVE | 9 | 0.00 | 75% | N/A | HEALTHY |
| tonebench_writing | writing | ACTIVE | 9 | 0.06 | 31% | N/A | WARNING |
| lmarena_webdev | design_code | ACTIVE | 9 | 0.00 | 92% | 0.97 | HEALTHY |
| designarena_website | design_code | ACTIVE | 9 | 0.00 | 83% | 0.98 | HEALTHY |
| designarena_svg | design_code | ACTIVE | 9 | N/A | N/A | 0.95 | WARNING |
| designarena_3d | design_code | ACTIVE | 9 | 0.00 | 94% | 0.97 | HEALTHY |
| designarena_gamedev | design_code | ACTIVE | 9 | 0.00 | 89% | 0.98 | HEALTHY |
| designarena_dataviz | design_code | ACTIVE | 9 | 0.00 | 75% | 0.99 | HEALTHY |
| designarena_mobileapps | design_code | ACTIVE | 8 | 0.00 | 79% | 0.98 | HEALTHY |
| designarena_slides | design_code | ACTIVE | 8 | N/A | N/A | 0.98 | WARNING |
| mlcr_aa | research | ACTIVE | 9 | 0.74 | 25% | 0.99 | WARNING |
| critpt_v2_hard | research | ACTIVE | 9 | 0.34 | 47% | 0.98 | WARNING |
| aa_analyst_agent | research | ACTIVE | 8 | 0.61 | 50% | 1.00 | WARNING |
| aa_mka | research | ACTIVE | 8 | 0.63 | 43% | 1.00 | WARNING |
| aa_briefcase | research | ACTIVE | 9 | 0.00 | 92% | 0.99 | HEALTHY |
| aa_harvey_lab | research | ACTIVE | 7 | 0.42 | 48% | 0.99 | WARNING |
| lmarena_factuality | research | ACTIVE | 9 | 0.00 | 81% | 0.91 | HEALTHY |
| vals_legal_research | research | ACTIVE | 9 | 0.08 | 11% | 0.98 | WARNING |
| vals_finance_agent | research | ACTIVE | 9 | 0.13 | 28% | 1.00 | WARNING |
| vals_emb | research | ACTIVE | 9 | 0.06 | 17% | 0.99 | WARNING |
| vals_tax_agent | research | ACTIVE | 9 | 0.04 | 39% | 0.94 | WARNING |
| vals_mystery_mechanism | research | ACTIVE | 9 | 0.00 | 64% | 0.98 | HEALTHY |
| vals_medcode | research | ACTIVE | 9 | 0.00 | 72% | 0.96 | HEALTHY |
| surge_gdp_xlsx | research | ACTIVE | 9 | 0.43 | 25% | 1.00 | WARNING |
| surge_dayjob_finance | research | ACTIVE | 9 | 0.32 | 61% | 0.98 | HEALTHY |
| surge_dayjob_law | research | ACTIVE | 8 | 0.41 | 54% | 0.99 | HEALTHY |
| surge_dayjob_healthcare | research | ACTIVE | 9 | 0.51 | 61% | 0.98 | WARNING |
| surge_corecraft | research | ACTIVE | 9 | N/A | N/A | 0.99 | WARNING |
| surge_riemann | research | ACTIVE | 9 | 0.49 | 44% | 0.99 | WARNING |
| epoch_frontiermath_t13 | research | ACTIVE | 9 | 0.00 | 69% | 0.93 | HEALTHY |
| arc_agi_3 | research | ACTIVE | 6 | 0.00 | 60% | 0.98 | HEALTHY |
| lmarena_agent_work | research | ACTIVE | 9 | 0.00 | 89% | 0.95 | HEALTHY |
| vals_a2j | research | ACTIVE | 9 | 0.00 | 64% | 0.99 | HEALTHY |
| surge_dayjob_tax | research | ACTIVE | 9 | 0.72 | 17% | 1.00 | WARNING |
| surge_handbook | research | ACTIVE | 9 | 0.76 | 31% | 1.00 | WARNING |
| surge_chartography | research | ACTIVE | 9 | 0.50 | 44% | 0.99 | WARNING |
| surge_complex_constraints | research | ACTIVE | 8 | 0.72 | 21% | 1.00 | WARNING |
| cwe_bench_v2 | cyber | ACTIVE | 9 | 0.55 | 56% | N/A | WARNING |
| cyberarena_mc_v1 | cyber | ACTIVE | 8 | 0.00 | 64% | N/A | HEALTHY |
| aikido_arena | cyber | ACTIVE | 6 | 0.87 | 0% | 0.96 | WARNING |
