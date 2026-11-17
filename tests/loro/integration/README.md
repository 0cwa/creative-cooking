# Isolated browser RTC integration

This harness joins two isolated browser profiles through the actual T2 RTC frame adapter. Each profile has its own IndexedDB database, Loro peer, signing identity and preaccepted authority record. Test keys are public and deterministic; this is not product pairing. The candidate codec and authority remain experimental.

From a checkout with its pinned dependencies installed, bundle with esbuild 0.25.12 into a task-owned scratch directory:

```sh
agent-heavy -- esbuild tests/loro/integration/browser-client.mjs --bundle --format=esm --platform=browser --outfile="$LORO_SCRATCH/bundle.js"
agent-heavy -- env LORO_TEST_IP="$LOCAL_IPV4" node tests/loro/integration/scenario.mjs "$LORO_SCRATCH/bundle.js" "$LORO_SCRATCH/rtc-transcript.json"
```

The server prints two URLs. Open them in separate, invisible T3 preview profiles. Use a checked local IPv4 address for `LOCAL_IPV4`. The test has no STUN/TURN servers. It substitutes that address for mDNS names in the final SDP, then signs and verifies those final descriptions with the two preaccepted test identities. This same-host substitution is a test limitation, not product signaling or pairing.

The script asserts an injected local failure and import failure, authority denial, signed stored and applied receipts at their durable boundaries, offline recipe and independent purchase edits, out-of-order delivery, duplicate chunks before and after a reconnect, convergence, reopen and exact retry. It verifies both test identity signatures over the final transcript, which includes source hashes, base commit, browser user agents and network conditions. It closes both databases and deletes the fixture databases on success. Close the two preview tabs after the script exits. The test runs the file encoding/decoding path in memory only; it does not establish a browser disk download/upload round trip. It proves neither native interoperability nor global E1 acceptance.
