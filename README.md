# ProChoice

No nonsense LLM benchmark. Compare frontier models and coding-agent harnesses by score and real dollar cost across **Coding**, **Writing**, **Design**, **Research**, **Cyber**, and **Harnesses**, with one clean Pareto frontier line per lab and dominated configurations cut.

## Core principles

1. **Six independent tracks.** Coding, Writing, Design, Research, Cyber, and Harnesses stay separated, with empirical cross-domain Kendall tau correlations published in every lifecycle audit.
2. **Reliability and discrimination benchmark weights.** All 45 active benchmarks contribute directly with frozen data-derived `effectiveWeight` values in `[0.10, 1.00]`, lab-balanced anchor standardization, Kolen and Brennan Mean-Sigma overlap linking, weighted two-way linear Rasch equating, and all-config heteroscedastic REML Empirical Bayes shrinkage (`B >= 0.50`, zero shadow candidates).
3. **Strict nine-provider allowlist.** Anthropic, OpenAI, Google, SpaceXAI, Meta, DeepSeek, Moonshot, Alibaba, and Zhipu only across ranked model leaderboards, paired with a unified 25-harness controlled coding-agent board across 8 open test models (`FrontierHarness v1.1` + `Harness Leaderboard`).
4. **One monotonic line per provider.** Dominated models and reasoning efforts drop off the curve and appear in the Pruned table with exact wasted cost multiples.
5. **Automated saturation retirement.** Daily CI computes Akhtar et al. ICML 2026 saturation indices, Arena-Hard 95% CI pairwise separability, leave-one-out composite rank stability, and 14-day sustained trigger checks inside immutable semantic domain epochs.

## Technology stack

- **Local and remote runtime:** Bun 1.4.x (`bun --bun next dev`, native TypeScript execution, `bunfig.toml`, and `bunVersion: "1.4.x"` with Vercel Fluid Compute in `vercel.ts`) with Node.js 26 LTS parity.
- **Framework and rendering:** Next.js 16.4.6 App Router with `reactCompiler: true`, `cacheComponents: true`, `partialPrefetching: true`, `typedRoutes: true`, and React 19.3 (`<Activity>`, `useSyncExternalStore`, `useEffectEvent`, `flushSync`).
- **Styling and visualization:** Tailwind CSS v4 Oxide in `src/app/globals.css`, `@base-ui/react`, `motion/react`, and `d3-scale`.
- **Static verification:** Ultra-strict TypeScript, Biome v2, Oxlint, and ESLint 10.

## Local setup

Requires **Bun 1.4.x**, plus **Node.js 26 LTS** for Node parity verification.

```bash
bun install --frozen-lockfile
cp .env.example .env.local
```

### Run the daily ingestion and lifecycle pipeline

```bash
bun run sync
```

This runs three sequential stages:
1. `bun run ingest` fetches all 18 mandatory live upstream feeds (including FrontierHarness v1.1 and the Apache-2.0 Harness Leaderboard), validates and merges per-benchmark cache partitions under `data/raw/`, resolves strict token-bounded canonical `(provider, model, effort, harness, regime)` tuples, runs weighted linear Rasch aggregation, heteroscedastic REML Empirical Bayes shrinkage, joint-OLS isotonic cost estimation, and correlated 10,000-draw Monte Carlo Pareto bootstraps, and writes `data/snapshot.json`, immutable MAJOR `data/epochs/*.json` baselines, and `data/unmapped.json`.
2. `bun run audit:lifecycle` computes daily Akhtar saturation indices, Arena-Hard 95% CI separability, leave-one-out stability, and empirical cross-domain correlations into `data/lifecycle.json`.
3. `bun run validate:snapshot` enforces schema validity, canonical hash match, immutable MAJOR epoch anchor integrity, full recomputation of all frontiers/verdicts/probabilities/audits, and real-timestamp freshness.

### Run the web application

```bash
bun run dev
```

Open `http://localhost:3000`. The cached JSON payload with full-body strong `ETag` and conditional `304 Not Modified` support is served at `http://localhost:3000/api/snapshot`.

### Production verification

```bash
bun run verify
```

`bun run verify` runs `bun run check` via Biome v2, `bun run lint:fast` via Oxlint, `bun run lint` via ESLint 10, `bun run typecheck`, and `bun run build`.

## Environment variables

See `.env.example`:
- `HF_TOKEN`: Optional Hugging Face read token to avoid anonymous rate limits when pulling `lmarena-ai/leaderboard-dataset` Parquet files.
- `STRICT_FRESHNESS`: Set to `1` in CI to fail the pipeline if any mandatory adapter has been degraded for more than 7 consecutive days.

## Automated CI/CD and daily updates

- `.github/workflows/ci.yml` runs on every push to `main` and every pull request using Bun 1.4.x and Node.js 26, verifying snapshot recompute invariants under both runtimes plus Biome v2, Oxlint, ESLint 10, TypeScript, and the Next.js production build.
- `.github/workflows/daily-ingest.yml` runs every day at `06:00 UTC` with `STRICT_FRESHNESS=1`, validates full raw-to-release recompute invariants under both Bun 1.4.x and Node.js 26 LTS, runs `bun run verify` on the freshly generated data, posts a source health and saturation summary to GitHub Actions, and commits changes only when the canonical snapshot hash or lifecycle audit state changes.
