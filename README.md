# ProChoice

Open-source LLM leaderboard and coding agent harness benchmark by [Retrograde Labs](https://inretrograde.io). Compare frontier language models by composite score and real dollar cost across six independent domains, with dominated configurations cut from the chart.

**Live site:** [prochoice.industries](https://prochoice.industries)

[![CI](https://github.com/RetrogradeLabs/pro-choice/actions/workflows/ci.yml/badge.svg)](https://github.com/RetrogradeLabs/pro-choice/actions/workflows/ci.yml)
[![Daily Ingest](https://github.com/RetrogradeLabs/pro-choice/actions/workflows/daily-ingest.yml/badge.svg)](https://github.com/RetrogradeLabs/pro-choice/actions/workflows/daily-ingest.yml)
[![Code License: MIT](https://img.shields.io/badge/code-MIT-111111.svg)](LICENSE)
[![Data License: CC BY 4.0](https://img.shields.io/badge/data-CC%20BY%204.0-4a4742.svg)](https://creativecommons.org/licenses/by/4.0/)

<a href="https://prochoice.industries/coding">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/prochoice-coding-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/prochoice-coding-light.png" />
    <img alt="ProChoice Coding Composite Index showing score versus real dollar task cost Pareto frontiers across AI providers" src="docs/assets/prochoice-coding-light.png" width="100%" />
  </picture>
</a>

## Live composite indices

Snapshot `43237d0f0a7497fc`, updated `2026-11-21` from 18 live public benchmark and first-party pricing feeds. Default model picks cover the five Western providers shown on initial load; toggle DeepSeek, Moonshot, Alibaba, and Zhipu on [prochoice.industries](https://prochoice.industries) to compare all nine.

| Composite index | Active benchmarks | Budget | Best value | Top score |
| :--- | :---: | :--- | :--- | :--- |
| [Coding](https://prochoice.industries/coding) | 9 | GPT-6 Luna at 30.6, \$0.0051 | GPT-6.2 Sol at 64.2, \$0.41 | Claude Opus 5.5 at 77.5, \$10.0 |
| [Writing](https://prochoice.industries/writing) | 3 | GPT-6 Luna at 44.4, \$0.0030 | Claude Opus 5.5 at 74.6, \$0.12 | GPT-6.2 Astra at 79.2, \$0.24 |
| [Design](https://prochoice.industries/design) | 3 | Muse Ember at 58.1, \$0.029 | GPT-6.2 Sol at 72.9, \$2.18 | Claude Fable 5.2 at 81.1, \$24.7 |
| [Research](https://prochoice.industries/research) | 21 | GPT-6 Luna at 35.0, \$0.0051 | GPT-6.2 Sol at 71.3, \$0.56 | Claude Fable 5.2 at 81.7, \$26.5 |
| [Cyber](https://prochoice.industries/cyber) | 3 | Gemini 3.7 Flash at 45.3, \$3.49 | GPT-6 Sol at 66.4, \$4.57 | Claude Fable 5.2 at 79.3, \$67.0 |
| [Harnesses](https://prochoice.industries/harnesses) | 3 | OpenClaw at 38.7%, \$0.39 | Pi at 44.8%, \$0.52 | OpenCode at 48.0%, \$0.57 |

## Why ProChoice

Most public AI leaderboards scatter scores across dozens of incompatible scales, omit real dollar task cost, average together different reasoning effort levels, or mix coding agent scaffolding into raw model rankings. Picking a model for real production traffic turns into guesswork.

ProChoice fixes those four gaps directly:

- **One monotonic frontier per provider.** Models and reasoning efforts that cost more while scoring lower drop off the default chart and move into the Pruned table with exact wasted cost multiples.
- **Six separated tracks.** Coding, Writing, Design, Research, Cyber, and Harnesses never collapse into one arbitrary overall average. Cross-domain Kendall tau correlations appear in every daily lifecycle audit.
- **Explicit reasoning effort tiers.** Every configuration resolves to a verified first-party API reasoning effort tier. Scores never copy across effort tiers, and costs never copy across distinct harnesses.
- **Controlled coding agent harness rankings.** Harnesses run separately across eight fixed open control models by merging FrontierHarness v1.1 and Harness Leaderboard into one 25-harness board covering OpenCode, Pi, Claude Code, Codex, OpenClaw, and 20 more agents.

## Public API and AI agents

ProChoice publishes unauthenticated, read-only JSON and Markdown endpoints under [prochoice.industries/docs](https://prochoice.industries/docs) with strong `ETag` headers for conditional `304 Not Modified` polling.

```bash
# Fetch the Coding Pareto frontier as typed JSON
curl -sS https://prochoice.industries/api/v1/domains/coding

# Fetch the full snapshot and lifecycle audit across all six domains
curl -sS https://prochoice.industries/api/v1/snapshot

# Request compact Markdown directly from any route
curl -sS -H "Accept: text/markdown" https://prochoice.industries/coding

# Read the agent directory, full Markdown compendium, or OpenAPI 3.1 schema
curl -sS https://prochoice.industries/llms.txt
curl -sS https://prochoice.industries/llms-full.txt
curl -sS https://prochoice.industries/openapi.json
```

Machine-readable discovery also ships at `/.well-known/api-catalog`, `/sitemap.xml`, and static Markdown aliases `/coding.md` through `/harnesses.md`.

## Methodology

Every daily pipeline run executes the same deterministic psychometric and economic pipeline from raw cached upstream feeds:

1. **Nine-provider allowlist.** Model leaderboards rank Anthropic, OpenAI, Google, SpaceXAI, Meta, DeepSeek, Moonshot, Alibaba, and Zhipu only, resolved through strict token-bounded aliases in `src/config/aliases.json`.
2. **All 45 active benchmarks weighted by signal.** Zero shadow candidates sit on the shelf. Each active benchmark receives a frozen data-derived `effectiveWeight` in `[0.10, 1.00]` from empirical reliability and discrimination.
3. **Equal-1.0 anchor standardization and REML Empirical Bayes pooling.** Raw scores align via provider-balanced anchor standardization, Kolen and Brennan Mean-Sigma overlap linking with joint-jackknife uncertainty, weighted two-way linear Rasch equating, and heteroscedastic REML Empirical Bayes shrinkage with a `B >= 0.50` eligibility floor.
4. **Homogeneous cost axis and correlated Pareto bootstraps.** Missing task costs for non-retired models with verified first-party public API pricing are estimated on the domain's homogeneous cost axis through joint OLS plus isotonic effort-ladder regression. Log-normal cost uncertainty propagates through 10,000 correlated Monte Carlo draws to estimate frontier membership and knee probabilities.
5. **Automated saturation retirement.** Daily CI computes Akhtar et al. ICML 2026 saturation indices, Arena-Hard 95% CI pairwise separability, leave-one-out composite rank stability, and 14-day sustained trigger checks inside immutable semantic MAJOR domain epochs under `data/epochs/`.

## Local development

Requires Bun `1.4.x`, plus Node.js `26` LTS for cross-runtime validation parity.

```bash
git clone https://github.com/RetrogradeLabs/pro-choice.git
cd pro-choice
bun install --frozen-lockfile
cp .env.example .env.local
bun run dev
```

Open `http://localhost:3000`. The app uses Next.js 16.4 App Router with React 19.3, React Compiler, `cacheComponents`, Tailwind CSS v4 Oxide, `@base-ui/react`, `motion/react`, and `d3-scale`.

### Run the full ingestion and verification pipeline

```bash
bun run sync
bun run verify
```

`bun run sync` runs three stages in order:

1. `bun run ingest` fetches all 18 mandatory upstream feeds, updates per-benchmark partitions under `data/raw/`, computes Rasch scores, Empirical Bayes shrinkage, monotone effort cost estimates, and bootstrap Pareto probabilities, and writes `data/snapshot.json`, `data/epochs/*.json`, and `data/unmapped.json`.
2. `bun run audit:lifecycle` computes daily saturation indices, pairwise separability, leave-one-out stability, and cross-domain correlations into `data/lifecycle.json`.
3. `bun run validate:snapshot` verifies schema validity, canonical hash match, immutable MAJOR epoch baselines, full raw-to-release recomputation, and source freshness.

`bun run verify` runs Biome v2, Oxlint with `--deny-warnings`, ESLint 10, `next typegen` plus strict TypeScript `tsc --noEmit`, and the Next.js production build.

### Environment variables

See [`.env.example`](.env.example):

- `HF_TOKEN`: Optional Hugging Face read token to avoid anonymous rate limits when downloading `lmarena-ai/leaderboard-dataset` Parquet files.
- `STRICT_FRESHNESS`: Set to `1` in CI to fail the pipeline if any mandatory adapter stays degraded for more than 7 consecutive days.

## Repository layout

| Path | Responsibility |
| :--- | :--- |
| `src/app/` | Next.js 16 App Router pages, static domain routes, OpenGraph cards, `/api/v1/*`, `/llms.txt`, and `/openapi.json` |
| `src/components/` | Pareto SVG charts, verdict placards, multi-row tables, harness tabs, and methodology monograph drawer |
| `src/config/` | Provider allowlist, 45 benchmark definitions, effort defaults, and strict model aliases |
| `src/lib/math/` | Anchor standardization, linear Rasch solver, REML Empirical Bayes, isotonic cost regression, and Pareto bootstraps |
| `scripts/ingest/` | 18 mandatory upstream source adapters, lifecycle saturation auditor, and dual-runtime snapshot validator |
| `data/` | Partitioned raw caches, canonical `snapshot.json`, `lifecycle.json`, and append-only MAJOR `epochs/*.json` |

## Automation

- `.github/workflows/ci.yml` runs on every push to `main` and every pull request on Blacksmith.sh runners using Bun `1.4.x` and Node.js `26` LTS. It checks immutable MAJOR epochs, cross-runtime snapshot recomputation, Biome v2, Oxlint, ESLint 10, TypeScript, and `next build`.
- `.github/workflows/daily-ingest.yml` runs daily at `06:00 UTC` with `STRICT_FRESHNESS=1`, validates full recomputation on both Bun and Node, verifies the production build, and commits updates only when the canonical snapshot hash or lifecycle audit state changes.

## Licenses and attribution

- **Source code:** [MIT License](LICENSE), Copyright 2026 Retrograde Labs.
- **Compiled datasets and API outputs:** [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) with upstream attribution to every source benchmark, including FrontierCode, Terminal-Bench, DeepSWE, SWE-bench Pro, LiveBench, SciCode, LMArena, EQ-Bench, DesignArena, Vals AI, Artificial Analysis, Epoch AI, FrontierMath, FrontierHarness, and Harness Leaderboard.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report suspected security issues privately following [SECURITY.md](SECURITY.md).

## Citation

If you use ProChoice rankings, methodology, or compiled snapshots in papers or evaluations, cite this repository or use GitHub's "Cite this repository" panel backed by [`CITATION.cff`](CITATION.cff):

```bibtex
@software{retrograde_labs_prochoice_2026,
  author  = {{Retrograde Labs}},
  title   = {{ProChoice: Composite LLM and Coding Agent Harness Pareto Leaderboards}},
  version = {1.0.0},
  year    = {2026},
  url     = {https://prochoice.industries},
  note    = {Source code: https://github.com/RetrogradeLabs/pro-choice}
}
```
