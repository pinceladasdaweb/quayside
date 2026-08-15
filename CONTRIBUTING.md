# Contributing

Thanks for taking the time. This library guards a few invariants that are easy
to break by accident, so this document is mostly about those — not about
formatting, which the tooling handles for you.

## Getting set up

```bash
npm install
npm run hooks   # once per clone: enables lint and commit-message hooks
```

Node.js >= 22 is required. The integration suite manages its own containers
through Testcontainers, so the only external requirement is a running Docker.

## The checks

```bash
npm test                  # unit tests, no external services needed
npm run test:coverage     # the same, with a coverage report
npm run test:integration  # storage contract against real backends (Docker)
npm run test:mutation     # the mutation gate (see below)
npm run lint              # neostandard + the project rules
npm run check:types       # TypeScript 6
npm run check:types:next  # the same surface under TypeScript 7
npm run api:check         # build + public API report comparison
```

CI runs all of it on Node 22, 24 and 26.

## Invariants worth knowing before you change code

**The atomic create-if-absent is the lock.** There is no separate locking
step, and state transitions are never read-modify-write in the manager:
`complete`, `release` and `extend` are fenced inside the storage (Lua on
Redis, token-conditional `UPDATE` on SQL). If you find yourself checking a
token in JavaScript and writing afterwards, the bug is the gap between those
two lines.

**A stale holder must fail, never overwrite.** A holder that lost its lock
gets `FencingError` from the store itself. The split-brain test in
`tests/unit/resilience.test.ts` encodes this; it must never be weakened.

**Expired records read as absent** — on every store, including the ones that
reclaim lazily. And **keys are stored faithfully or rejected, never
truncated**: truncation silently aliases two keys into one record. Both are
enforced by the shared contract suite (`tests/contract/storage-contract.ts`),
which every storage adapter must pass unmodified.

**Errors carry a stable `code`; message text is not contract.** Never branch
on a message and never assert one in a test.

**Serialization is never magic.** A value that cannot be stored faithfully
(functions, symbols, bigint, non-finite numbers, nested `undefined`, cycles)
raises `SerializationError` instead of being silently dropped or mangled.

**Zero is a legitimate value.** Use `??`, never `||`, for defaults.

**The core knows nothing about HTTP** and has zero runtime dependencies.
Protocol semantics belong to the adapters; storage clients are
bring-your-own, typed structurally.

**`lockTtl` and `resultTtl` stay separate.** One bounds crash recovery, the
other bounds replay. Any change that couples them is wrong by design.

**The public API is frozen by the report in `etc/`.** `npm run api:check`
fails when exports drift; if the change is deliberate, run
`npm run api:update` and commit the report — the diff is part of the review.

## Tests

Every change needs a test that fails without it. Beyond that:

- **New storage adapter?** Run `runStorageContract` from
  `tests/contract/storage-contract.ts` against the real backend via
  Testcontainers, then add the adapter-specific failure modes (connection
  kills, process kills) alongside the Redis suite as a model.
- **Fixed a bug?** Name the test after the behavior and mark it with a
  `// Regression:` comment explaining what used to happen.
- **Observability changes** are asserted through the typed event stream and
  the `MetricsCollector`, not through log output.
- **Mutation gate.** `npm run test:mutation` (Stryker) grades whether the
  tests actually assert. It mutates the unit-covered source; the storage
  adapters that only real servers can exercise (`src/redis`, `src/sql`,
  `src/postgres`, `src/mysql`) are excluded and answer to the integration
  contract suite instead. A surviving mutant is either a missing assertion
  or an equivalent mutant — if it is the latter, say why in the pull
  request.

## Commits and branches

Commit messages follow Conventional Commits and are checked by commitlint on
commit. Branch names start with a type prefix (`feat/`, `fix/`, `chore/`,
...) and are checked on push. Identifiers and comments are English-only and
`enum` is banned — the linter enforces both.

Open pull requests against `development`, not `main`.

## How a release happens

Merging to `main` publishes. The workflow reads the version already on the
registry, bumps it from the merge commit message, publishes to npm through
OIDC trusted publishing (no token secret, provenance attached), then writes
`CHANGELOG.md`, tags `vX.Y.Z` and opens the GitHub release.

The bump follows the commit subject: `BREAKING CHANGE` or `major` for a
major, `minor` for a minor, anything else for a patch. Commit subjects are
the release notes, so write them for the person reading them later.
