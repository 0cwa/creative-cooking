/**
 * Creative Cooking adversarial contract probes against the *pinned ARK source*.
 * Copied into ARK's test/ directory by our isolated CI workflow; not a
 * production crypto implementation. Uses real Keyhive WASM, Ed25519 identities,
 * authentic grants and ARK's actual JS server policy.
 *
 * A probe is a security invariant: a permission leak must FAIL this suite.
 * The attached JSON records observations even when an invariant fails.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
// Node bootstrap comes from the package's regular entrypoint, like ARK's
// documented Node integration. Do not instantiate uninitialized Repo/slim.
import { Repo } from "@automerge/automerge-repo";
// The pinned package's Node entrypoint initializes the same wasm used by
// Repo's slim import. The later 0.19.x initFromBase64Wasm helper does NOT
// exist in our coherent ARK lockfile's @automerge/automerge-subduction 0.16.1.
import "@automerge/automerge-subduction";
import {
  Access, Archive, ChangeId, CiphertextStore, ContactCard, DocumentId, Keyhive, Signer,
} from "@keyhive/keyhive/slim";
import {
  isUnprotectedDoc, initKeyhiveWasm, peerIdFromSigner,
} from "../src/index.js";
import {
  keyhiveIdFactory, LegacyAutomergeRepoKeyhive,
} from "../src/keyhive/automerge-repo-keyhive.js";
import { KeyhiveEventEmitter } from "../src/keyhive/emitter.js";
import { KeyhiveBlobInterceptor } from "../src/keyhive/blob-interceptor.js";
import { PromiseQueue } from "../src/network-adapter/pending.js";
import type { AutomergeUrl, PeerId } from "@automerge/automerge-repo/slim";

type Subject = { signer: Signer; keyhive: Keyhive; card: ContactCard };
const observations: Record<string, unknown>[] = [];
function record(testId: string, expected: string, observed: string, detail: Record<string, unknown> = {}) {
  const row = { testId, expected, observed, runtime: "Node 22 / pinned ARK Keyhive WASM", ...detail };
  observations.push(row);
  console.log("CC_SECURITY_PROBE=" + JSON.stringify(row));
}
const bytes = (value: Uint8Array) => Array.from(value);
const asSid = (id: Uint8Array) => ({ toBytes: () => id });
const asPeer = (id: Uint8Array) => ({ toBytes: () => id });
const asAuthor = (id: Uint8Array) => ({ toBytes: () => id });

async function subject(): Promise<Subject> {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const signer = await Signer.webCryptoSigner(keyPair);
  const keyhive = await Keyhive.init(signer, CiphertextStore.newInMemory(), () => {});
  // Match ARK createActive: reuse the signer-bound, existing signed card.
  return { signer, keyhive, card: await keyhive.getExistingContactCard() };
}
let owner: Subject;
let relay: Subject;
let reader: Subject;
let editor: Subject;
let admin: Subject;
let outsider: Subject;
let docUrl: AutomergeUrl;
let docId: Uint8Array;
let hive: LegacyAutomergeRepoKeyhive;
let repo: Repo;
let policy: ReturnType<LegacyAutomergeRepoKeyhive["buildServerSubductionPolicy"]>;
let previouslyEncrypted: { commitId: string; plaintext: Uint8Array; ciphertext: Uint8Array } | undefined;
let archiveDelivered = false;

async function assertPermission(
  id: string, expected: "grant" | "deny", operation: () => Promise<unknown>, 
  detail: Record<string, unknown> = {}
) {
  let actual: "grant" | "deny" = "grant";
  let error: string | undefined;
  try { await operation(); } catch(e) { actual = "deny"; error = String(e); }
  record(id, expected, actual, { ...detail, error });
  expect(actual, "SECURITY INVARIANT " + id + " (" + (error ?? "") + ")").toBe(expected);
}

describe.sequential("Creative Cooking: actual ARK/Keyhive policy invariants", () => {
  beforeAll(async () => {
    initKeyhiveWasm();
    // Side-effect Node entrypoint above initializes the shared WASM before
    // constructing Repo. See upstream Onomancy ARK Node integration guide.
    [owner, relay, reader, editor, admin, outsider] = await Promise.all(
      Array.from({length: 6}, () => subject())
    );
    // This is the exact factory that ARK's initialize* API installs into
    // RepoConfig. Use the real asynchronous Repo.create2 path; NEVER create().
    repo = new Repo({
      peerId: peerIdFromSigner(owner.signer),
      idFactory: keyhiveIdFactory(owner.keyhive),
    });
    const handle = await repo.create2({ pantry: ["synthetic chickpeas"] });
    docUrl = handle.url;
    // Parse the actual protected document ID using ARK's canonical parser.
    const { parseAutomergeUrl } = await import("@automerge/automerge-repo/slim");
    docId = parseAutomergeUrl(docUrl).binaryDocumentId;
    expect(isUnprotectedDoc(docUrl)).toBe(false);
    expect(await owner.keyhive.hasDocument(new DocumentId(docId))).toBe(true);

    // The policy we exercise is the genuine pinned ARK implementation. No
    // synthetic allowlist; only the network adapter is an inert test double.
    hive = new LegacyAutomergeRepoKeyhive(
      { contactCard: owner.card, signer: owner.signer, individual: await owner.keyhive.individual() } as never,
      owner.keyhive,
      { saveEventWithHash: async () => {} } as never,
      "security-owner" as PeerId,
      null,
      { disconnect() {} } as never,
      new KeyhiveEventEmitter(),
      keyhiveIdFactory(owner.keyhive),
      () => { throw new Error("adapter not used"); }
    );
    policy = hive.buildServerSubductionPolicy();
    for (const [agent, level] of [
      [relay, Access.relay()], [reader, Access.read()], [editor, Access.edit()], [admin, Access.admin()]
    ] as const) {
      // Contact cards are signed; ARK verifies and registers them before the grant.
      await hive.receiveContactCard(ContactCard.fromJson(agent.card.toJson()));
      await hive.addMemberToDoc(docUrl, ContactCard.fromJson(agent.card.toJson()), level);
    }
  }, 90_000);

  afterAll(async () => {
    writeFileSync(process.env.CC_ARK_SECURITY_EVIDENCE ?? "cc-ark-security-matrix.json",
      JSON.stringify({
        upstream: {ark: "5d09e8c8cfdebd5656b1426b66aea6b1395f83da", 
          keyhiveWasM: "0.3.0-alpha.1", automergeRepo: "2.6.0-subduction.48"},
        scope: "pinned ARK JS policy + genuine Keyhive WASM membership; policy invoked directly, not network E2E",
        protectedFactory: "repo.create2 with ARK keyhiveIdFactory",
        docIdBytes: docId?.length, observations,
      }, null, 2));
    try { hive?.close(); } catch { /* closing an experimental adapter is best effort */ }
    try { await repo?.shutdown(); } catch { /* no real remote opened */ }
  });

  it("creates a protected ID through the correct asynchronous factory", async () => {
    record("protected-factory", "protected-32-byte-id", isUnprotectedDoc(docUrl) ? "unprotected" : "protected",
      { docIdBytes: docId.length, idTailZero: bytes(docId.slice(16)).every(v => v === 0) });
    expect(docId).toHaveLength(32);
    expect(isUnprotectedDoc(docUrl)).toBe(false);
  });

  it("enforces Relay and Read, denying an ungranted household", async () => {
    for (const [agent, role] of [[relay,"Relay"],[reader,"Read"],[editor,"Edit"],[admin,"Admin"]] as const) {
      await assertPermission("fetch-"+role, "grant", () =>
        policy.authorizeFetch(asPeer(agent.signer.verifyingKey) as never, asSid(docId) as never),
        { role, protected: true });
    }
    await assertPermission("fetch-cross-household", "deny", () =>
      policy.authorizeFetch(asPeer(outsider.signer.verifyingKey) as never, asSid(docId) as never),
      { protected: true });
  });

  it("enforces Edit and Admin author role on writes", async () => {
    for (const [agent, role, expected] of [
      [relay,"Relay","deny"],[reader,"Read","deny"],[editor,"Edit","grant"],[admin,"Admin","grant"]
    ] as const) {
      await assertPermission("put-"+role, expected, () =>
        policy.authorizePut(asPeer(agent.signer.verifyingKey) as never,
          asAuthor(agent.signer.verifyingKey) as never, asSid(docId) as never),
        { role, protected: true, verifiedAuthor: "simulated policy input only; no signed-wire test" });
    }
    await assertPermission("put-cross-household", "deny", () =>
      policy.authorizePut(asPeer(outsider.signer.verifyingKey) as never,
        asAuthor(outsider.signer.verifyingKey) as never, asSid(docId) as never),
      { protected: true });
  });

  it("authenticates synthetic cooking bytes under a REAL Keyhive-produced envelope", async () => {
    const payload = new TextEncoder().encode("synthetic chickpea soup secret - CC_SECURITY_REAL_KEYHIVE");
    const commitId = createHash("sha256").update(payload).digest("hex");
    const interceptor = new KeyhiveBlobInterceptor(owner.keyhive, new PromiseQueue());
    const outgoing = await interceptor.transformOutgoing(
      docUrl.slice("automerge:".length) as never, commitId, [], payload
    );
    expect(outgoing, "Keyhive did not produce an encrypted outgoing envelope").not.toBeNull();
    expect(Buffer.from(outgoing!).includes(payload)).toBe(false);
    const returned = await interceptor.transformIncoming(
      docUrl.slice("automerge:".length) as never, commitId, outgoing!
    );
    expect(returned && bytes(returned)).toEqual(bytes(payload));
    record("authentic-keyhive-ciphertext", "owner-decrypts / ciphertext-not-plaintext",
      "owner-decrypts / ciphertext-not-plaintext",
      { plaintextBytes: payload.length, ciphertextBytes: outgoing!.byteLength, digest: commitId,
        caveat: "not a relay server or second-device decryption proof" });
  });



  it("rejects tampered signed contact-card pairing (verify admission, not just no exception)", async () => {
    const malformed = JSON.parse(outsider.card.toJson());
    const part = malformed.Rotate ?? malformed;
    if (!part.signature || !Array.isArray(part.signature)) {
      throw new Error("Upstream contact-card signature format changed; do not silently skip authentication");
    }
    part.signature[0] ^= 1;
    const modified = JSON.stringify(malformed);
    const tampered = ContactCard.fromJson(modified);
    const before = await owner.keyhive.getAgent(tampered.id);
    expect(before, "a supposedly untrusted signed card was already known").toBeUndefined();
    let returnedWithoutThrow = false;
    let error: string | undefined;
    try {
      await owner.keyhive.receiveContactCard(tampered);
      returnedWithoutThrow = true;
    } catch(e) { error = String(e); }
    // Keyhive can queue or ignore rejected events without throwing.
    // An exception alone is NOT the security predicate: verified *admission* is.
    const after = await owner.keyhive.getAgent(tampered.id);
    const actual = after ? "grant" : "deny";
    record("forged-contact-card-admission", "deny", actual,
      { returnedWithoutThrow, error, bytes: modified.length,
        signatureTamper: "first Ed25519 signature byte flipped", 
        scope: "Keyhive accepted agent in live graph, not just contact-card parser" });
    expect(actual, "tampered signed contact card must not become a trusted identity").toBe("deny");
  });

  it("delivers genuine signed Keyhive membership to separate reader and relay identities", async () => {
    const archive = await owner.keyhive.toArchive();
    const archiveBytes = archive.toBytes();
    for (const participant of [reader, relay, outsider, editor]) {
      await participant.keyhive.ingestArchive(new Archive(archiveBytes));
    }
    archiveDelivered = true;
    record("signed-membership-propagation", "separate identities ingest archive", "separate identities ingest archive",
      { archiveBytes: archiveBytes.length, format: "Keyhive WASM Archive; *not* a network sync session" });
  });

  it("verifies a second device can decrypt but a no-key relay and outsider cannot", async () => {
    expect(archiveDelivered).toBe(true);
    const payload = new TextEncoder().encode("synthetic family cooking secret - protected cross-client");
    const commitId = createHash("sha256").update(payload).digest("hex");
    const outgoing = await new KeyhiveBlobInterceptor(owner.keyhive, new PromiseQueue())
      .transformOutgoing(docUrl.slice("automerge:".length) as never, commitId, [], payload);
    expect(outgoing).not.toBeNull();
    // tryEncryptKeyed is allowed to emit a PCS rotation *during encryption*.
    // A member needs those newly signed key-epoch events, not just the
    // pre-encryption authorization archive.
    const postEncryption = await owner.keyhive.toArchive();
    for (const participant of [reader, relay, outsider]) {
      await participant.keyhive.ingestArchive(new Archive(postEncryption.toBytes()));
    }
    const read = async (participant: Subject) => {
      const interceptor = new KeyhiveBlobInterceptor(participant.keyhive, new PromiseQueue());
      return interceptor.transformIncoming(docUrl.slice("automerge:".length) as never, commitId, outgoing!);
    };
    const readerValue = await read(reader);
    const relayValue = await read(relay);
    const strangerValue = await read(outsider);
    record("cross-device-read", "reader decrypts", readerValue ? "reader decrypts" : "reader cannot decrypt",
      { plaintextBytes: payload.length, ciphertextBytes: outgoing!.byteLength, archiveSync: true,
        postEncryptionKeyEventsBytes: postEncryption.toBytes().length,
        readerDocumentKnown: await reader.keyhive.hasDocument(new DocumentId(docId)) });
    record("no-key-relay", "relay cannot decrypt", relayValue ? "relay decrypts" : "relay cannot decrypt",
      { ciphertextBytes: outgoing!.byteLength });
    record("cross-household-decrypt", "outsider cannot decrypt", strangerValue ? "outsider decrypts" : "outsider cannot decrypt");
    expect(readerValue && bytes(readerValue)).toEqual(bytes(payload));
    expect(relayValue).toBeNull();
    expect(strangerValue).toBeNull();
    previouslyEncrypted = { commitId, plaintext: payload, ciphertext: outgoing! };
  });

  it("rotates a role from Read -> Edit -> revoked -> Read without residual Edit", async () => {
    const device = await subject();
    const card = ContactCard.fromJson(device.card.toJson());
    await hive.addMemberToDoc(docUrl, card, Access.read());
    await assertPermission("upgrade-start-read", "deny", () =>
      policy.authorizePut(asPeer(device.signer.verifyingKey) as never,
        asAuthor(device.signer.verifyingKey) as never, asSid(docId) as never));
    await hive.addMemberToDoc(docUrl, card, Access.edit());
    await assertPermission("upgrade-edit", "grant", () =>
      policy.authorizePut(asPeer(device.signer.verifyingKey) as never,
        asAuthor(device.signer.verifyingKey) as never, asSid(docId) as never));
    await hive.revokeMemberFromDoc(docUrl, device.card.id);
    await assertPermission("downgrade-revoked", "deny", () =>
      policy.authorizePut(asPeer(device.signer.verifyingKey) as never,
        asAuthor(device.signer.verifyingKey) as never, asSid(docId) as never));
    await hive.addMemberToDoc(docUrl, card, Access.read());
    await assertPermission("downgrade-read", "deny", () =>
      policy.authorizePut(asPeer(device.signer.verifyingKey) as never,
        asAuthor(device.signer.verifyingKey) as never, asSid(docId) as never));
    await assertPermission("downgrade-fetch", "grant", () =>
      policy.authorizeFetch(asPeer(device.signer.verifyingKey) as never, asSid(docId) as never));
  });

  it("revokes Read from an authorized identity at the policy boundary", async () => {
    await hive.revokeMemberFromDoc(docUrl, reader.card.id);
    await assertPermission("read-revoked", "deny", () =>
      policy.authorizeFetch(asPeer(reader.signer.verifyingKey) as never, asSid(docId) as never));
    // An offline device's old plaintext and old keys are *not* erasable.
  });


  it("probes revoked reader's fresh-key access after real Keyhive archive propagation", async () => {
    expect(previouslyEncrypted).toBeDefined();
    const post = new TextEncoder().encode("never disclose this post-revocation recipe");
    const postCommit = createHash("sha256").update(post).digest("hex");
    const outgoing = await new KeyhiveBlobInterceptor(owner.keyhive, new PromiseQueue())
      .transformOutgoing(docUrl.slice("automerge:".length) as never, postCommit, [], post);
    expect(outgoing).not.toBeNull();
    const latestArchive = await owner.keyhive.toArchive();
    await reader.keyhive.ingestArchive(new Archive(latestArchive.toBytes()));
    const readerInterceptor = new KeyhiveBlobInterceptor(reader.keyhive, new PromiseQueue());
    const current = await readerInterceptor.transformIncoming(docUrl.slice("automerge:".length) as never,
      postCommit, outgoing!);
    record("revoked-reader-future-key", "deny", current ? "grant" : "deny",
      { archiveBytes: latestArchive.toBytes().length, ciphertextBytes: outgoing!.length,
        note: "archived historical plaintext is not remotely erasable" });
    expect(current, "revoked reader must not decrypt future key epoch").toBeNull();
  });

  it("rejects forwarding of an editor's signed write by an ungranted requester (KNOWN UPSTREAM GAP)", async () => {
    // This bypasses signature verification because it calls policy directly.
    // The editor identity is real and granted Edit; the requester holds nothing.
    // This checks if ARK policy independently enforces requester >= Relay.
    await assertPermission("put-unauthorized-forwarder", "deny", () =>
      policy.authorizePut(asPeer(outsider.signer.verifyingKey) as never,
        asAuthor(editor.signer.verifyingKey) as never, asSid(docId) as never),
      { protected: true, authorRole: "Edit", requesterRole: "none", 
        boundary: "ARK JS buildServerSubductionPolicy; no signed-wire attestation" });
  });

  it("rejects a legacy document-ID bypass, rather than silently granting anonymous access (KNOWN GAP)", async () => {
    const legacy = new Uint8Array(32);
    legacy.set(crypto.getRandomValues(new Uint8Array(16)), 0);
    await assertPermission("legacy-id-fetch", "deny", () =>
      policy.authorizeFetch(asPeer(outsider.signer.verifyingKey) as never,
        asSid(legacy) as never), { idTailZero: true });
    await assertPermission("legacy-id-put", "deny", () =>
      policy.authorizePut(asPeer(outsider.signer.verifyingKey) as never,
        asAuthor(outsider.signer.verifyingKey) as never,
        asSid(legacy) as never), { idTailZero: true });
  });
});
