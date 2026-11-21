## Summary

Explain what changed and why. Link any relevant issues or upstream benchmark references.

## Verification

- [ ] `bun run verify` passes locally with zero errors and zero warnings
- [ ] `STRICT_FRESHNESS=1 bun run validate:snapshot` passes on Bun 1.4.x
- [ ] `STRICT_FRESHNESS=1 node scripts/ingest/validate-snapshot.ts` passes on Node.js 26 LTS
- [ ] Archived MAJOR epoch files under `data/epochs/*.json` remain untouched
