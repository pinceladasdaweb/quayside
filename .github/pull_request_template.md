## What changed

<!-- What behavior is different after this, and why. -->

## How it was verified

<!-- Which checks you ran locally. CI runs lint, both type checks, unit,
     integration and the API report check on Node 22, 24 and 26. -->

- [ ] `npm test` (and `npm run test:integration` if the behavior touches a storage backend — needs Docker)
- [ ] `npm run check:types` and `npm run check:types:next`
- [ ] `npm run api:check` — or `npm run api:update` with the report committed, when the public API moved on purpose
- [ ] `npm run test:mutation` — surviving mutants explained below, if any

## Checklist

- [ ] A test fails without this change
- [ ] New storage adapter? It passes the shared contract suite (`tests/contract/storage-contract.ts`) against a real server via Testcontainers
- [ ] Errors carry a stable `code`; no test asserts message text
- [ ] Nothing is silently dropped or truncated — serialization and key handling fail loudly
- [ ] Defaults use `??` so `0` survives
- [ ] Nothing HTTP-shaped leaks into the core
- [ ] README updated if the public surface moved
