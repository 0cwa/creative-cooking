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

## Routed browser direct exchange

`tests/loro-direct.spec.mjs` runs the exported app. It creates two local browser identities, completes the existing household admission and encrypted household file handoff, and opens the same selected household on both devices. The browsers save different cooking edits offline. They then exchange a signed WebRTC offer by file and a signed answer by text. The test compares the two displayed codes and enters them separately. It verifies that both channels can already be open while cooking exchange stays locked until the second confirmation.

The test rejects a different household, an altered SDP, an answer for a different session, and a wrong verification code. It checks the receiving IndexedDB for zero staged or applied updates before confirmation. It observes the actual ICE candidate pair and checks that the full remote SDP, including its host candidates, arrived unchanged at `setRemoteDescription` and remains the current remote description. A failed local save and an injected import transaction rollback each leave a single staged update and no applied record. The sender sees one stored receipt until retry commits the update and adds an applied receipt. A subsequent send skips that applied object. Both browser profiles display all edits after reopening the app.

Build using `agent-heavy -- env EXPO_PUBLIC_BASE_URL=/creative-cooking npm run build:web`. Run the case using `agent-heavy -- npm run test:e2e -- tests/loro-direct.spec.mjs --project=web`. Playwright launches an isolated Chromium test browser with `--disable-features=WebRtcHideLocalIpsWithMdns` for this case. For two separate persistent browser processes, use `TEST_DIRECT_CDP_A` and `TEST_DIRECT_CDP_B` with their respective endpoints, and `TEST_CDP_ENDPOINT` to connect the standard fixture to an existing browser. Keep these profiles for one process restart, then run the same case with `TEST_DIRECT_REOPEN_ONLY=1` to verify their persisted edits. Use disposable profiles and remove them after the test.

Local proof used two separate, headless Brave 1.99.57 (Chromium 157.0.8103.79) profiles on one Linux host. With the default mDNS setting, both signed descriptions verified and each browser gathered host candidates, but ICE stayed `new` and the channels did not open. A standalone offer/answer probe reproduced that outcome. Launching the disposable proof browsers with `--disable-features=WebRtcHideLocalIpsWithMdns` produced real numeric host candidates. Both the standalone probe and the routed app then connected over a UDP host-to-host ICE pair with zero ICE servers. The application consumes the browser descriptions as generated. Default mDNS interoperability on this host, separate-host exchange and Android qualification remain open.
