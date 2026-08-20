# CHANGELOG

## 1.2.0 (2026-08-20)

* fix: emit the expired-recovery event the type union always declared by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/b47b4f23a123bee2bbd5bab855f27e7a2677f35d)
* fix: nestjs stops persisting server-status failures, kernel policy shared by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/039d9c26595d203a5cf5f09cbbf3206193796f47)
* refactor: build the sql statements once, share the storage constants by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/17ef68975c613a944af519c75f1235afcad321de)
* test: pin retry-after to the 409 alone across kernel and nestjs by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/5ef136d01eec5a8d6c6477e32e01bb4f765195f6)
* docs: what persists under persistFailures in the nestjs adapter by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/37f5d772402df01beb09f69df31ec35169bbfaad)
* feat: scope idempotency keys to a principal via a key extractor by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/48c3199f6daeebdad2c762a4f1d72b6fe4d20975)
* docs: scope keys to the caller on shared endpoints by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/26349e06a6402e7bd7564ba0af6040cdd7747686)
* fix: report an unparsed request body instead of degrading silently by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/7e1ec1b8988c25f5840190bd9e0a41debe3f6550)
* fix: typed views fingerprint as interpreted values, not raw bytes by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/be09477e3336843c531b68ae384508f9a984148b)
* fix: reject toJSON conversions the codec guard could never see by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/39456a05691299ed3ab9ef7bb4f1b8a60654a035)
* fix: header lookups are case-insensitive on every adapter by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/5bf9b490bd14dc8d422e11e5308f29e568234863)
* fix: hono streams flow to the client while the capture drains a clone by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/dea5c4ae27db47ed7934b3862f63c0564da50a3a)
* fix: nestjs serves completed work and never caches a declared 5xx by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/9ea6419085874f3bbdf2b892d20773000dcf1e3f)
* fix: bound the wait budget and stop reading data bugs as outages by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/dd8a463f316b14fc74d3e8add17a4388069f53fd)
* fix: honest key-required diagnostics, hardened revival, one record decoder by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/ae06f59446c795635c8199bc4895e4208914f815)
* fix: report an empty parsed body as the lost body it usually is by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/8f66e9ef193989c989cb3fda0cb9710b98ea5ea7)


## 1.1.1 (2026-08-19)

* chore: update dev dependencies by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/25f655725990c53b5156370a39691a0cc2c44068)
* refactor: resolve the call-removal mutants stryker 10 introduced by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/406b451bafa642b496e73a62ea809f8782e5b44f)


## 1.1.0 (2026-08-15)

* fix: put persisted failures through the configured codec (minor) by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/8e0c819eb9282c4331dd690cb945bba090aab710)
* perf: stop resending lua bodies and resubscribing between polls (minor) by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/0570bf81642cd207eb088b008a9e1dff3dc33c9a)
* perf: fingerprint paths as strings, and take resultTtl per call (minor) by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/3803682961bc55fc0d12445cf32d543c03fc9d64)


## 1.0.0 (2026-08-15)

* chore: keep stryker runner leftovers out of the repo by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/972e4b224e9a8ecc87f2823c91cbcc37f5bf2185)
* ci: publish from main through trusted publishing by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/dd26c1642f6268eef9c399eb073a43fabd1caa0d)
* docs: drop the work-in-progress banner now that the package ships by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/e2177df2c85f0977e6377da216647390b9e06beb)
* docs: draw the state machine instead of spelling it in ascii by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/1abd3f889484daa9185b5dbe7745566e53fe2300)
* docs: reuse the state machine diagram in the core reference by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/7307586d2f6949937613a0c7fabdaf86ed12f955)
* refactor: drop the key nobody reads from StoredRecord by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/3da7980f8af903386f913b2283822f224c011530)


## 0.1.0 (2026-08-14)

* chore: scaffold project foundation by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/3a55f0e462d06b7a56c688d289eb18d270b10c4a)
* build: ship dual ESM and CJS output by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/0f6cc2e78b00622bdd1a8f1a34949ad107926fce)
* feat: core idempotency engine with in-memory storage by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/db202799b505bcd353e339171e7482c7038653a7)
* feat: payload fingerprints, derived keys, key hygiene and failure policies by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/77e6bf84c589a121157480ac07d91045ad1c496c)
* feat: redis storage adapter with fenced Lua transitions by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/b21b6bd86f6843c7497a8bd112359f6ae5d10c89)
* chore: add docker compose for local redis experimentation by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/5ae3cf4dce7a5a413dfed06f5ff4d5f16eb9c637)
* chore: drop the docker compose file by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/815aa3c6d649b627c1425094020d8e93299f08f2)
* chore: add community health files by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/251e8e3c32a9be38ebecf14f5845526b2af7daf7)
* chore: stop generating a package lock by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/a4b8116bce4d4a621171886527debf8cd6ed85bd)
* feat: http kernel and express, fastify and hono adapters by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/657bc6cb2f57687fc78069feb35378de40c2dd65)
* feat: nestjs module, interceptor and Idempotent decorator by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/0e827f18af979f449dc3486f033d810add1d78b5)
* feat: postgres and mysql storage adapters by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/859238995479c298cbc920c1f5136caeb4462232)
* docs: comparison table, full README and core semantics reference by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/f9510e761443365aa25c094647b098fa80f68144)
* feat: prometheus and otel observability entry points by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/d38b80334274a53aad67e149ff8724b9d2bfd708)
* docs: queue recipes and per-storage benchmarks by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/288f0e97a504b54c38e5ec3cc99725518574bc3f)
* test: keep expected handler errors out of the test output by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/f29cbc13e309b296a7688917d590958ce4e4a55e)
* chore: wire Stryker mutation testing by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/cab84cf89006fac311346b2746177fb10fb656db)
* chore: scope the coverage report to src by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/c0ca31e6f4761a80cc15f99a953f31be8862a20c)
* test: eliminate every uncovered mutant and reach full line coverage by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/0fbd5da18215589fc0167c195e353b0d168812bb)
* test: kill every surviving mutant by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/cd22f46cdf061cd3ab934c5bf58f9b3ae01f87f8)
* fix: close the gaps found by the code review by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/cf08a9346d575603ae85c38057b9f6e896c04490)
* fix: answer 4xx for a key the client cannot use by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/a58f51f167d852689fe2999abe8770377570868e)
* fix: never release a fastify lock while its handler runs on by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/94160a657e9cfc07373334fb485a91a837de0357)
* chore: set the initial published version to 0.1.0 by Pedro Rogério [View](https://github.com/pinceladasdaweb/quayside/commit/9117995c56352a7df3317906dfffe68c10274a36)
