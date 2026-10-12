# Household key and transport boundary — feasibility fixture

Run `node --test spikes/household-security-options/mailbox.test.mjs` from the repository root. It uses built-in Node WebCrypto and local temporary files, needs no package install, and retains no keys or household content after tests.

**This is a disposable test format, not a production protocol, secure-stack selection, audited E2EE implementation, or Expo qualification.** No application integration or public network service exists here.

Five tests establish bounded facts:

1. Signed encrypted bytes are persisted with file and directory `fsync`; a new mailbox instance reads and decrypts them. Exact duplicate delivery returns the same content digest/receipt.
2. A signed household-A frame cannot be sent to the household-B route; a nonmember cannot fetch; the wrong group key cannot decrypt.
3. Tampered ciphertext, substituted author, unsupported version, wrong epoch, unsigned extra plaintext field, and outsider signature are rejected.
4. A trusted test policy changes to epoch 2 and removes Bob. Future ciphertext uses a new key that Bob's old key cannot decrypt; his retained epoch-1 ciphertext remains decryptable. Stale epoch uploads and removed readers/writers are denied.
5. One hundred randomly generated 96-bit nonces are distinct in this sample. Injected failure after temporary-file sync but before rename produces no receipt and no readable message; retry then succeeds.

The relay stores opaque ciphertext, but it sees household IDs, device IDs, epochs, sizes, and timing. IDs must be opaque in a deployed format. Trust configuration is in memory and supplied by the test: there is no authentication, distributed membership policy, group-key wrapping, invitation, key verification, backup/recovery, admin concurrency, replay ledger, persistent identity, multi-writer locking, cross-machine restart, storage fault campaign, power-loss proof, browser/native execution, or cryptographic review. A sampled nonce test does not prove lifetime nonce safety. File syncing on the local filesystem does not prove cloud or network durability. A same-process new instance is a storage reopen test, not a native process-restart qualification.

The asymmetric signature authenticates the frame against an explicitly trusted public key. Encryption binds the complete fixed header as additional authenticated data. This illustrates why a relay's account permission and a client's verified author/key epoch must be separate boundaries. These primitives are standard; combining them into this fixture does **not** create a reviewed secure group protocol.

Before any deployment choose a maintained security protocol/library, validate its browser and Expo bindings, implement authenticated invitation and policy distribution, and meet the gates in `../../docs/household-key-transport-options.md`. Keep Automerge payloads and application documents behind this independent byte boundary.

To verify actual Automerge update composability after checking out the household foundation and running `npm ci` in its `packages/household-replication`, run:

```sh
node spikes/household-security-options/automerge-interop.mjs /path/to/household-foundation/packages/household-replication/index.mjs
```

Record the exact household-foundation commit used. This script is separate from the five primitive mailbox tests and does not select a group-key protocol.
