# Sync options diagrams

Evidence legend: **implemented** means source code exists; **model** means an executable illustration; **proposed** means design; **unverified** means evidence is missing. Sources: [comparison](TALKCO-COMPARISON.md), [relay plan](LORO-RELAY-IMPLEMENTATION.md), [contracts](LORO-POLICY-CONTRACTS.md), and [spike](../../spikes/relay-household-poc/README.md).

## Architecture alternatives

```mermaid
flowchart LR

  A0["Local only"] --> B0["Manual transfer"]

  A1["Peer CRDT: Loro or Automerge"] --> B1["Durable relay"]

  A2["LAN multicast"] --> B2["Reachability only"]

  A3["Archived PowerSync"] --> B3["Server-mediated sync"]

  A4["TAlkCo research candidates"] --> B4["No stack selected"]

```

Alternatives, not a single pipeline. Automerge 3.5 Hermes failed a historical probe; this is not a universal incompatibility claim.

## State and trust layers

```mermaid
flowchart LR

  A0["Domain semantics"] --> B0["Loro merge"]

  A1["Authority policy"] --> B1["Key release"]

  A2["Delivery"] --> B2["Receipt is not authority"]

  A3["Custody"] --> B3["Retention and availability"]

```

Each layer has its own owner and evidence. A relay receipt is neither peer receipt nor a custody guarantee.

## Keys and people

```mermaid
flowchart LR

  A0["Independent device keys"] --> B0["Person identity"]

  A1["Recovery code"] --> B1["Wraps catalog"]

  A2["Shamir shares"] --> B2["Reconstruct a secret"]

  A3["True threshold cryptography"] --> B3["Operation without reconstructing secret"]

  A4["Distinct adults"] --> B4["Votes, not device count"]

```

Recovery alone does not restore current household keys or votes. Shamir sharing alone is not threshold signing.

## Composed contracts

```mermaid
flowchart LR

  A0["Private"] --> B0["Personal recovery"]

  A1["Shared"] --> B1["Audience and purpose"]

  A2["Authority"] --> B2["Adult quorum"]

  A3["Infrastructure"] --> B3["Host and retention"]

  A4["Decision"] --> B4["Allow / local only / consent / pending / deny"]

```

Applicable rules intersect; changed content, recipient or purpose requires fresh consent. Silence is not consent.

## Fork and recovery

```mermaid
flowchart LR

  A0["One rogue of three"] --> B0["Independent checkpoint choice"]

  A1["Two compromised of three"] --> B1["Device majority can be wrong"]

  A2["Competing heads"] --> B2["Keep visible and compare"]

  A3["Selected semantic replay"] --> B3["New branch; dependencies may prevent replay"]

```

Checkpoint choice is social input, not an honesty oracle. Preserve original history and do not promise removal of causal operations.

## Reuse and evidence

```mermaid
flowchart LR

  A0["Cooking → TAlkCo"] --> B0["Domain counterexamples and policy composition"]

  A1["TAlkCo → Cooking"] --> B1["Context privacy and custody seams"]

  A2["Shared vocabulary"] --> B2["Bounded fixture after surface and observer budget"]

  A3["Evidence gaps"] --> B3["Crypto, crash atomicity, unlinkability and custody"]

```

Share fixture vocabulary first, not a production engine or untested wire format.
