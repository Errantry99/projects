# @dcx/core

This package is the contract every other dcx package codes against. It holds:

- the shared types (`src/types.ts`);
- RFC 8785 JCS canonical JSON, sha256 and the dcx content hashes: `payloadHash`, `questionHash`,
  `candidateSetHash` and `cacheKey` (`src/hash.ts`);
- read-time calibration that matches the SQL macros (`src/calibrate.ts`);
- the pinning and H5 label-source guards (`src/policy.ts`);
- the full DDL for the SQLite journal and the DuckDB warehouse (`src/schema/*.sql`), with
  idempotent migrations and thin openers (`src/migrate.ts`).

```ts
import { cacheKey, cacheKeyId, openWarehouse, payloadHash, questionHash } from "@dcx/core";

const wh = await openWarehouse("demo.duckdb"); // migrated; wh.conn is a DuckDBConnection
const key = cacheKey({
  payloadHash: payloadHash(state, def.fields),
  questionHash: questionHash(def),
  backend: "jev",
  modelV: "jev-1.13.0",
});
const fixtureId = cacheKeyId(key);
```

See [CONTRACT.md](./CONTRACT.md) for the full reference. Tests: `npx vitest run`. To regenerate
the conformance vectors, run `npm run vectors`.
