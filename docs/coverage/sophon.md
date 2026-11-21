# Screening Sophon's evaluation catalog

On November 21, 2026, we enumerated all 27 pages of Sophon's catalog. The 630 distinct entry slugs matched the 630 records in the catalog's page data. Of those records, 389 had the directory's score flag, and 288 had the domain label `rl-env`. An environment can be useful for training without supplying comparable scores for evaluated model revisions. We used the catalog for discovery and checked shortlisted evaluations against their producers. [Catalog](https://sophon.at/evals) · [Sophon API documentation](https://sophon.at/cli)

## Decisions

| Lead | Use in ProChoice |
| --- | --- |
| SpreadsheetBench and financial analysis | Follow the underlying work product. An executable workbook built from an empty file tests a different skill from finding facts in filings. The publisher follow-up identified Vals Excel Modeling v1.1 Scratch. Scratch, Template and Overall reuse cases, so only Scratch can enter the index. SpreadsheetBench and Vals Excel Modeling are separate evaluations. [Research screening](sophon-research.md) |
| WritingBench, Hemingway-bench, EQ-Bench Longform and MedScribe | Separate academic briefs, short commissioned prose, a multi-chapter manuscript and clinical documentation. Use the WritingBench Academic & Engineering subscore. Keep overlapping short-fiction instruments outside the composite. [Writing and design screening](sophon-writing-design.md) |
| LiveCodeBench and repository repair boards | Check the task window, scorer, scaffold and effort. A coding leaderboard may provide valuable corroboration on an existing skill without measuring a new one. Public task dates alone do not establish that every tested model predates the problems. [Coding screening](sophon-coding.md) · [LiveCodeBench](https://livecodebench.github.io/) |
| IFBench, SAGE and visual understanding | IFBench evaluates formal instruction constraints. SAGE grades handwritten mathematics, even though its Sophon record carried a Legal domain label. Reading a chart or operating an interface also differs from creating a visual design. These distinctions determine where a score belongs. [SAGE producer](https://www.vals.ai/benchmarks/sage) · [Design screening](sophon-writing-design.md) |
| Existing benchmark families | Sophon also indexes LiveBench plus its subscores, overlapping versions of SWE-bench, FrontierMath, and the producer releases behind existing ProChoice sources. A directory copy, superset or alternative split supplies no additional independent evidence by itself. [Model-card review](model-cards.md) |

## What disjointness means

Each index measures several kinds of work. A scoring instrument needs its own task contract and dataset lineage. We exclude reused cases, two scores for the same outputs, mixed suites that repeat an included task, and substantially equivalent work even when it comes from a different publisher. Two distinct tasks may share models, a publisher or a judge. Shared model configurations make scale linking possible. Shared judges and undisclosed private prompts remain sources of uncertainty.

The review establishes protocol-level separation for private tests. Item-by-item uniqueness can be verified only for accessible task manifests. Publisher results left outside the index remain labeled separately wherever the underlying rows meet the ingestion rules. Their contribution to the score, calibration and cost basket is zero.
