# Isolated offline runtime candidate

This is an experimental runtime, not product pairing or a release-ready authority implementation. The browser fixture uses public deterministic test keys and a preaccepted authority record. It must not be used with user data. The candidate codec, native key storage and cross-platform runtime remain unapproved. Outbound enumeration returns candidates for a selected peer; the caller must reauthorize at actual send time.

SQLite and real candidate cryptography check:

```sh
agent-heavy -- node --experimental-strip-types --test src/loro/engine/runtime.test.mjs
```

For the browser check, bundle `browser-fixture.mjs` using esbuild 0.25.12 for the browser (`--bundle --format=esm --platform=browser`) into a scratch directory as `bundle.js`. Serve an `index.html` containing `<script type="module" src="/bundle.js"></script>` from that directory with a local server. Open the URL in two separate, invisible T3 preview profiles. The page exposes `window.runtimeTest`; its methods are `fault`, `execute`, `read`, `outbound`, `stage`, `recover` and `reopen`.

Reproduce the scenario: inject a local failure with `fault(true)` and verify `read()` is empty; clear the fault. In client A execute a `recipe-title` command and a `purchase` command with distinct command/effect IDs, and in B execute another purchase. Obtain `outbound()` arrays; inspect each envelope's authenticated header to identify its semantic effect. Stage A's purchase in B before the recipe, using cursor 0, and check `recover()` reports `MISSING_DEPENDENCY`. Stage the recipe with cursor 1, stage B's purchase in A, then recover both. Verify both states contain the recipe and both purchases, rerun recovery for duplicates, reopen both databases, and repeat the original command with the same operation ID and sequence to verify the saved outcome is replayed. Delete the fixture-created `loro-runtime-test` databases when finished. Manual staging does not exercise direct transport or establish E1.
