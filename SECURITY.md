# Security Policy

## Supported versions

Until 1.0, only the latest published version is supported. Fixes ship
forward — there are no backport branches.

## Reporting a vulnerability

Please report privately through
[GitHub Security Advisories](https://github.com/pinceladasdaweb/quayside/security/advisories/new)
rather than opening a public issue.

Include the affected version, what an attacker can achieve, and a reproduction
if you have one. You can expect an acknowledgement within a few days; once a
fix is released, credit goes in the release notes unless you prefer otherwise.

## What this library does and does not touch

Useful context when judging whether something is a vulnerability here or in
your application:

- **Stored results are data, never code.** Replay parses stored JSON and
  returns it; replayed failures are rebuilt by assigning plain parsed fields
  onto a fresh `Error`. Nothing read from storage is ever evaluated.
- **The Lua scripts** used by the Redis adapter are static: key and fencing
  token travel as `KEYS`/`ARGV`, and user input is never interpolated into a
  script body.
- **Keys are escaped.** Namespace and key segments are percent-encoded before
  composition, so a client-supplied key cannot inject the separator and
  address another namespace. Composed keys over `maxKeyLength` are rejected —
  never truncated, because truncation aliases two keys into one record.
- **Fingerprints are compared in constant time**, so the comparison never
  leaks how much of a fingerprint matched.
- **A compromised storage backend can forge replays.** quayside authenticates
  nothing it reads back: whoever can write to your Redis/SQL store can decide
  what `execute` returns for a replayed key. Protect the store like you
  protect the database it sits next to.
- **Fail-open is explicit.** By default storage unavailability refuses to run
  (`StorageUnavailableError`); `onStorageError: 'open'` runs without the
  exactly-once guarantee and every bypass emits a `storage-bypass` event.
- **Credentials never pass through this library.** You construct and own the
  storage client; quayside only issues commands on it and logs nothing.
- **Runtime dependencies: zero.** The core and every adapter declare no
  runtime dependencies; storage clients are bring-your-own.
