# Distributed database review evidence

Reviewed 15 October 2026. Start with [the decision and worklanes](../../docs/distributed-database-access-control-decision.md). Eight source reviews distinguish current implementation, published releases, integration gaps and trust models. [evidence.json](evidence.json) inventories their source URLs and file hashes. The earlier catalog inventory remains a dated discovery snapshot; it is not overwritten as though the expanded research existed on 12 October.

## Fresh current ARK experiment

The existing 12-test harness was run against upstream ARK commit `390a1488826d26bd0f183d66ed260d69ca8b36af` and its unchanged frozen lockfile. Dependencies include Keyhive WASM `0.4.0-alpha.1`, Automerge Subduction `0.20.1` and Repo `2.6.0-subduction.49`. Runtime: Node24.19.0. Agent run: **8 pass / 4 fail**; coordinator rerun: **8 pass / 4 fail**. A nonzero test exit is the recorded negative research result, not a failed app test being concealed.

- [First structured observations](ark-current-security-matrix.json) and [raw log](ark-current-security.log).
- [Independent rerun observations](ark-root-confirmation.json) and [raw log](ark-root-confirmation.log).
- [Harness specimen](ark-current-security.test.ts.txt). The text extension keeps a foreign-project test outside the cooking application's TypeScript compilation. Only provenance/runtime metadata and an obsolete dependency comment differ from the older probe; no behavioral assertion was relaxed.

The test invokes ARK's actual JS policy directly, including simulated verified-author input, and real WASM signing/membership/encryption. It is not a live signed-wire Rust service test. A failed authorized-reader archive-decryption prerequisite prevents claiming subsequent read denial proves revocation. The ungranted-forwarder expectation represents a stricter service policy, not a universal ban on forwarding legitimate signed bytes. Legacy namespace admission is not evidence of protected-document decryption.

## Reproduce in an isolated upstream checkout

Use Node24.19.0 and pnpm10.15.0. Copy this repository's `ark-current-security.test.ts.txt` into the pinned upstream checkout as `test/creative-cooking-current-security.test.ts`, then:

```sh
git clone https://github.com/automerge/automerge-repo-keyhive.git ark-probe
cd ark-probe
git checkout 390a1488826d26bd0f183d66ed260d69ca8b36af
# Copy the harness specimen here as test/creative-cooking-current-security.test.ts.
npx --yes pnpm@10.15.0 install --frozen-lockfile
CC_ARK_SECURITY_EVIDENCE=ark-observations.json ./node_modules/.bin/vitest run test/creative-cooking-current-security.test.ts --reporter=verbose
```

The expected current result is exit1 with four failed tests. The fixture creates ephemeral synthetic identities/data; no real account, homeserver or user keys are required. Published artifact pins and current Rust core source pins are distinct: the experiment does not establish that the WASM package incorporates every newest Rust core fix.

Source-review assertions about upstream tests are not claimed as independently passing executions. None of the other surveyed stacks has been newly runtime-qualified by this report.
