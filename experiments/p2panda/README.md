# p2panda + Iroh substrate experiment

**Not a production feature. Do not deploy the gateway publicly.** No changes are made to the existing Creative Cooking application, data storage, backups, or credential handling.

## Evidence boundaries

- **Actual upstream p2panda:** `rust/src/lib.rs` publishes an opaque binary envelope through a real p2panda 0.7.1 local `Node`. `rust/src/bin/peer.rs` is an interactive two-process native discovery/sync harness. Running a process locally does **not** prove direct LAN, NAT traversal, or relay fallback; capture traffic separately.
- **Actual upstream p2panda Spaces:** `rust/tests/spaces.rs` exercises two/three-device encrypted message membership and revocation via p2panda-spaces public test helpers **without a network**. Security API is experimental, not independently audited.
- **Application-side contracts only:** `contract.mjs` is a transport-independent byte frame, `invitation.mjs` an unsigned/unredeemed QR-sized encoding proof.
- **Not p2panda:** `browser/interop.mjs` and `gateway.mjs` demonstrate a conventional HTTP ciphertext mailbox using WebCrypto, not p2panda/Iroh browser interoperability. The gateway is insecure (no authentication/quotas; `Access-Control-Allow-Origin: *`), accepts anyone knowing the space ID, and must bind localhost only.

## Reproduce

Node 22.13+:
```bash
node --test experiments/p2panda/*.test.mjs
node experiments/p2panda/gateway.mjs /tmp/creative-cooking-p2panda-mailbox 8765
# Serve experiments/p2panda/browser/ on localhost through any static server.
# Open index.html, click Generate demo key + space, publish a fixture.
# Close the publishing browser, reopen/refresh a reader, reuse the key+space.
```

Rust 1.96 (network access required for crate downloads):
```bash
cargo test --manifest-path experiments/p2panda/rust/Cargo.toml --all-targets
cargo run --manifest-path experiments/p2panda/rust/Cargo.toml --bin peer -- new /tmp/panda-a.db <A_64_HEX_SEED>
# Copy the printed topic, start another peer in a second terminal/host:
cargo run --manifest-path experiments/p2panda/rust/Cargo.toml --bin peer -- <TOPIC> /tmp/panda-b.db <B_64_HEX_SEED>
```

For a real LAN test use **separate devices**, ensure UDP 5353/mDNS and QUIC UDP pass the firewall, verify direct path with packet capture and record iOS/Android local network permissions. For remote testing pass a known `relay-url` and `bootstrap-node-id`; do not assume public default services. For persistent identity and reconnect use the **same** seed and SQLite path per peer, different for each device. Seed command-line arguments are visible in process listings; debug only.

This CLI is not proof that iOS/Android targets or Expo integration can compile/run. Rust cross-target CI checks are best-effort evidence, not signed device builds. Its SQLite transport store is separate from the current app's IndexedDB/AsyncStorage state.

## Test commands

- `node --test experiments/p2panda/*.test.mjs`
- `cargo test --manifest-path experiments/p2panda/rust/Cargo.toml --all-targets`
- `npm run check` and `npm run test:e2e` for normal app CI, executed by existing `.github/workflows/ci.yml`.

No secret credentials, cloud accounts, public relay availability, or app schema migration are required.

See [full report](../../docs/spikes/local-first-p2panda.md) for results and unsupported claims.
