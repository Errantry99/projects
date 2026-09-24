# @dcx/policy

Repository policies for dcx, written as scanners (`src/`) and enforced by the Vitest suite
(`test/`). They run as part of `npm test` and as their own fast job in
`.github/workflows/dcx.yml` (spec 07 §6 "Policy tests", §3 items 12–14).

```sh
cd packages/policy && npx vitest run --reporter=verbose --silent=false   # prints the licence list
```

Every scanner resolves paths from its own file, not the cwd. Each one skips `node_modules`,
`dist` and this package, because this package quotes the patterns it looks for.

| Policy | Test | Rule |
|---|---|---|
| **H5 guard** | `h5.test.ts` | Training code paths may read labels only through `training_labels`. It fails with the file and line if one reads `judgments`, `judge_uses`, `decisions`, `decision_actions` or raw `labels`. A file is a training code path if it is under a `train/` directory, exports a function whose name matches `/train\|export.*training/i`, or implements a `--training` option. The DDL half opens an in-memory warehouse through `@dcx/core`. It asserts that the `labels.source` CHECK rejects `jev`, `llm:jev`, `llm:jev-1.13.0` and `JEV`, that it accepts `human`, `behaviour`, `llm:claude` and `rule:x`, and that `training_labels` drops `selected_by = 'jev_disagreement'` and LLM rows. |
| **Pinning** | `pinning.test.ts` | The unpinned Jev alias (`jev-` + `latest`) may appear only in rejection logic. The scan covers `.ts`, `.json` and `.sh` under `dcx/`, except the lockfile. **Always a violation:** the alias in a JSON file or in a non-comment shell line. **Allowed in `.ts`:** the alias in comments, in regex literals, on `assertPinned` / `isUnpinnedModel` lines, or on a line marked `// policy: rejects-alias`. **Test files:** a test file that asserts a rejection (`.toThrow`, `.rejects`, `lint*()`) is exempt. **Deliberate fixtures:** a JSON rejection fixture belongs under `test/…` with `reject`, `invalid` or `bad` in its path. |
| **Licences** | `licences.test.ts` | Reads every lockfile entry and every installed `node_modules/**/package.json`, including scoped packages and nested `node_modules`. It fails on AGPL, SSPL, Elastic/ELv2 or BUSL (`BANNED_LICENCE`) unless the package is on the allowlist, and prints the count of distinct packages per licence. |
| **No network in tests** | `network.test.ts` | Enforced for every test file under `packages/` and `projects/`. A test file may not import `node-fetch` or `undici`, or call a global `fetch(`, unless it contains the comment `// network: mocked`. The judge backend tests get a separate check that they were found and are clean. |
| **Cache key** | `cache-key.test.ts` | Parses the component table in `packages/core/CONTRACT.md`, the section whose heading contains "cache key", and asserts three things. There are exactly seven components. `CACHE_KEY_COLUMNS` lists them in the same order. `cacheKey()` returns exactly those columns, and changing any one of them changes `cacheKeyId`. |

## Adding a licence allowlist entry

`licence-allowlist.json` is a JSON array and is empty by default. An entry accepts a dependency
that would otherwise fail, and needs all three fields:

```json
[{ "name": "some-package", "version": "1.2.3", "reason": "used only in offline notebooks; not shipped" }]
```

`version` is an exact version, or `*` for any version. Keep the reason specific. The spec
permits AGPL code (PM4Py) only in offline notebooks, outside this workspace (07 §3 item 2), so an
entry should be rare and reviewed.

## Not covered

- There is no nightly Laya job yet (07 §6). The workflow has a comment noting that it is planned.
- The H5 scan is lexical. It sees SQL text and quoted table names, not queries built across
  variables or files.
