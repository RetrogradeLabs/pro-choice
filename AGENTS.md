# AGENTS.md

Canonical agent instructions for `pro-choice`. Keep this file lean and under 200 lines. Human setup and overview live in `README.md`.

## Global invariants

- Primary runtime is **Bun 1.4.x** (`bun --bun next dev`, `bun run`, `bunVersion: "1.4.x"` + `fluid: true` in `vercel.ts`), with **Node.js 26 LTS** (`>=26.0.0`, `@types/node@^26.6.6`) parity via relative imports in `src/config/`, `src/lib/`, and `scripts/ingest/`. Framework is Next.js 16.4.6 App Router (`reactCompiler: true`, `cacheComponents: true`, `partialPrefetching: true`, `typedRoutes: true` in `next.config.ts`), React 19.3, Tailwind CSS v4 Oxide via `src/app/globals.css`, and ultra-strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns` in `tsconfig.json`).
- Separate value and type imports strictly (`import type ...`). Never use TypeScript `enum` or `namespace` (`erasableSyntaxOnly`).
- Never use `export const runtime = "edge"`. Never add `tailwind.config.*`.
- Commands: `bun run check` (Biome v2), `bun run lint:fast` (Oxlint), `bun run lint` (ESLint 10), `bun run typecheck`, `bun run sync`, `bun run verify`, `bun run build`.
- Never add standalone unit, integration, or e2e test files without explicit user approval. Verify behavior through `bun run sync` and `bun run verify`.
- Ranked LLM model leaderboards (`domains.*`) strictly allow only nine model providers: `anthropic`, `openai`, `spacexai`, `google`, `meta`, `deepseek`, `moonshot`, `alibaba`, `zhipu` (`src/config/providers.ts`). Controlled harness comparisons in `harnessLeaderboard` are separate Terminal-Bench 4.0 and DeepSWE boards. Keep each board’s scores, control-model slices, uncertainty and costs within the same instrument.
- A domain composite scores one instrument per declared kind of work and dataset pool. Overlapping alternatives are `STANDALONE` observations outside all index math. The current release uses equal task weights and preserves data-derived quality weights for held-out comparisons. Historical scores replay from frozen anchors.
- Never invent public API prices for private/unpriced models, copy scores across effort tiers, copy costs across distinct coding harnesses, mix incompatible cost axes on one frontier, or silently weaken statistical gates. Missing task costs for non-retired models with verified first-party public API pricing are estimated on the domain's homogeneous cost axis via joint-OLS + isotonic effort-ladder regression (`src/lib/math/cost.ts`) with log-normal cost uncertainty propagated through bootstrap Pareto probabilities (`src/lib/math/pareto.ts`) and disclosed in expanded row details.
- Follow `.rules/` before editing matching files. Load a rule with `paths:` only when reading or editing a matching file.

## Rule map

| Rule file | Scoped paths | Responsibility |
| :--- | :--- | :--- |
| `.rules/psychometrics-and-pareto.md` | `src/lib/**/*.{ts,tsx}`, `src/config/**/*.{ts,json}` | Equal-1.0 anchor standardization, connected linear Rasch solver, homogeneous cost axis, correlated single-line Pareto math, saturation lifecycle math, strict token-bounded aliases. |
| `.rules/ingestion-and-lifecycle.md` | `scripts/ingest/**/*.ts`, `.github/workflows/**/*.yml`, `data/**/*.json` | Mandatory daily source adapters, partitioned cache, strict Arena CI/battle gates, immutable MAJOR epoch baselines, full-recompute CI validation gate. |
| `.rules/gallery-ui.md` | `src/app/**/*.{ts,tsx,css}`, `src/components/**/*.{ts,tsx}` | `sfcompute.com`-inspired gallery styling, CSS-var provider inks, WCAG AA contrast, zero-slop copy, React 19.3 + Next.js 16 PPR discipline, clipPath-revealed SVG Pareto chart and keyboard accessibility. |

## Maintaining rules

1. Put each new learning into the one rule whose `paths:` cover the affected files. Keep truly global facts only here.
2. Keep this file and every `.rules/*.md` file under 200 lines.
3. Cite exact files, symbols, or commands. Remove generic advice and prose fluff.
4. Update the Rule map whenever adding or removing a rule file, and resolve any conflicting rule immediately.
