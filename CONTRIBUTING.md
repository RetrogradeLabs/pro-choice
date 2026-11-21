# Contributing to ProChoice

ProChoice is built around transparent, verifiable benchmark math and strict data provenance. Contributions that improve adapter reliability, model alias coverage, verified first-party pricing, statistical rigor, or UI clarity are welcome.

## Prerequisites

- Bun `1.4.x`
- Node.js `26` LTS for cross-runtime validation parity

Install dependencies:

```bash
bun install --frozen-lockfile
```

## Common contribution paths

### Adding or fixing a model alias or reasoning effort default

1. Edit `src/config/aliases.json` with the canonical `provider`, `modelSlug`, `displayName`, `releaseDate`, regex `patterns`, and verified first-party API `defaultEffort`.
2. Never use `"default"` as an effort tier. Cite the provider's first-party API documentation in your pull request when setting `defaultEffort`.
3. Ranked model leaderboards strictly allow the nine providers listed in `src/config/providers.ts`: `anthropic`, `openai`, `google`, `spacexai`, `meta`, `deepseek`, `moonshot`, `alibaba`, and `zhipu`.

### Updating first-party API pricing

1. Update or fix parsing in `scripts/ingest/sources/pricing.ts` using official provider pricing pages only.
2. Never invent list prices for private or unpriced models.

### Adding or repairing a benchmark adapter

1. Adapters live under `scripts/ingest/sources/` and use relative imports such as `../../src/...` so they run identically on Bun 1.4.x and Node.js 26 LTS.
2. Register benchmark metadata in `src/config/benchmarks.ts`. Every valid benchmark contributes directly to its domain composite with zero shadow candidates.
3. Keep harness evaluations isolated inside the `harnesses` domain. Never mix external harnesses into non-Harnesses model indices.

## Immutable epochs

Files under `data/epochs/*.json` and existing entries in `data/epochs/manifest.json` are strictly append-only. CI rejects any pull request that edits or deletes an archived MAJOR epoch baseline.

## Local verification before opening a pull request

Run the full verification suite locally:

```bash
bun run sync
STRICT_FRESHNESS=1 bun run validate:snapshot
STRICT_FRESHNESS=1 node scripts/ingest/validate-snapshot.ts
bun run verify
```

`bun run verify` runs Biome v2, Oxlint with `--deny-warnings`, ESLint 10, `next typegen` plus strict `tsc --noEmit`, and `next build`. Pull requests must pass all checks with zero warnings and zero errors.
