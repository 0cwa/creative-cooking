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
import { Repo } from "@automerge/automerge-repo/slim";
import {
  Access, CiphertextStore, ContactCard, DocumentId, Keyhive, Signer,
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
  return { signer, keyhive, card: await keyhive.contactCard() };
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

  it("revokes Read from an authorized identity at the policy boundary", async () => {
    await hive.revokeMemberFromDoc(docUrl, reader.card.id);
    await assertPermission("read-revoked", "deny", () =>
      policy.authorizeFetch(asPeer(reader.signer.verifyingKey) as never, asSid(docId) as never));
    // An offline device's old plaintext and old keys are *not* erasable.
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
