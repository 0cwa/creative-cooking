# Isolated browser RTC integration

This harness joins two isolated browser profiles through the actual T2 RTC frame adapter. Each profile has its own IndexedDB database, Loro peer, signing identity and preaccepted authority record. Test keys are public and deterministic; this is not product pairing. The candidate codec and authority remain experimental.

From a checkout with its pinned dependencies installed, bundle with esbuild 0.25.12 into a task-owned scratch directory:

```sh
agent-heavy -- esbuild tests/loro/integration/browser-client.mjs --bundle --format=esm --platform=browser --outfile="$LORO_SCRATCH/bundle.js"
agent-heavy -- env LORO_TEST_IP="$LOCAL_IPV4" node tests/loro/integration/scenario.mjs "$LORO_SCRATCH/bundle.js" "$LORO_SCRATCH/rtc-transcript.json"
```

The server prints two URLs. Open them in separate, invisible T3 preview profiles. Use a checked local IPv4 address for `LOCAL_IPV4`. The test has no STUN/TURN servers. It substitutes that address for mDNS names in the final SDP, then signs and verifies those final descriptions with the two preaccepted test identities. This same-host substitution is a test limitation, not product signaling or pairing.

The script asserts an injected local failure and import failure, authority denial, signed stored and applied receipts at their durable boundaries, offline recipe and independent purchase edits, out-of-order delivery, duplicate chunks before and after a reconnect, convergence, reopen and exact retry. It verifies both test identity signatures over the final transcript, which includes source hashes, base commit, browser user agents and network conditions. It closes both databases and deletes the fixture databases on success. Close the two preview tabs after the script exits. The RTC scenario runs the file encoding/decoding path in memory; the separate file proof below exercises disk download and upload. It proves neither native interoperability nor global E1 acceptance.

For the encrypted runtime file proof, serve a `file.html` containing `<script type="module" src="/bundle.js"></script>` beside the same bundle. Connect Playwright to a task-owned invisible Chromium-compatible browser and run:

```sh
agent-heavy -- env LORO_SCRATCH="$LORO_SCRATCH" LORO_CDP="$LORO_CDP" LORO_ORIGIN="$LORO_ORIGIN" node tests/loro/integration/file-proof.cjs
```

The browser saves the downloaded encrypted object to `runtime-object.bundle`; the second isolated context uploads that path through a file input. The proof checks authenticated import, exact retry, convergence and IndexedDB reopen. Remove the task-owned download and profile afterward. This test uses preaccepted deterministic test identities, not product pairing or human identity.
