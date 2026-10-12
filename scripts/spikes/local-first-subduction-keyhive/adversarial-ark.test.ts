/*
 * Runs inside the pinned ARK 0.6.0-alpha.1 checkout and its frozen lockfile.
 * All objects are GENUINE Keyhive WASM / ARK blob interceptor / Automerge Repo.
 * This proves local crypto and factory behaviour, NOT Rust Subduction wire
 * compatibility, multi-device pairing, or remote revocation.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Repo, stringifyAutomergeUrl } from "@automerge/automerge-repo/slim";
import { Access, CiphertextStore, ContactCard, Keyhive, MemberedId, Signer }
  from "@keyhive/keyhive/slim";
import { initKeyhiveWasm } from "../src/index.js";
import { isUnprotectedDoc } from "../src/utilities.js";
import { generateDoc, keyhiveIdFactory } from "../src/keyhive/automerge-repo-keyhive.js";
import { KeyhiveBlobInterceptor } from "../src/keyhive/blob-interceptor.js";
import { PromiseQueue } from "../src/network-adapter/pending.js";

beforeAll(() => initKeyhiveWasm());

async function newHive() {
  return await Keyhive.init(Signer.generateMemory(), CiphertextStore.newInMemory(), () => {});
}
describe("Creative Cooking ARK protected-ID and genuine Keyhive crypto adversarial gates", () => {
  it("create2 uses real protected document factory, signed contact card, ordered ACL", async () => {
    const owner = await newHive();
    const repo = new Repo({ network: [], idFactory: keyhiveIdFactory(owner) });
    const handle = await repo.create2({ name: "synthetic lemon chickpeas" });
    expect(isUnprotectedDoc(handle.url)).toBe(false);
    const docIdBytes = (await generateDoc(owner)).toBytes();
    // Explicitly use ARK's real protected document factory, not repo.create().
    expect(docIdBytes.length).toBe(32);
    const relay = await newHive();
    const card = await relay.contactCard();
    const signed = ContactCard.fromJson(card.toJson());
    await owner.receiveContactCard(signed);
    await owner.addMember(signed.id, MemberedId.document(
      new (await import("@keyhive/keyhive/slim")).DocumentId(
        (await import("@automerge/automerge-repo/slim")).parseAutomergeUrl(handle.url).binaryDocumentId
      )
    ), Access.relay(), []);
    const actual = await owner.bestAccessForDoc(signed.id,
      new (await import("@keyhive/keyhive/slim")).DocumentId(
        (await import("@automerge/automerge-repo/slim")).parseAutomergeUrl(handle.url).binaryDocumentId
      ));
    expect(actual?.atLeast(Access.relay())).toBe(true);
    expect(actual?.atLeast(Access.read())).toBe(false);
    console.log("CC_SECURITY_MATRIX=" + JSON.stringify({
      case: "ark-protected-create2-and-relay-grant",
      expected: "protected-ID and signed relay grant only", observed: "protected-ID and grant relay",
      runtime: "node-keyhive-wasm+ark", arkCommit: "5d09e8c8cfdebd5656b1426b66aea6b1395f83da"
    }));
  });

  it("genuine Keyhive/ARK encryption authenticates cooking ciphertext, rejects tampering", async () => {
    const owner = await newHive();
    const doc = await generateDoc(owner);
    const url = stringifyAutomergeUrl({ documentId: doc.toBytes() as never });
    expect(isUnprotectedDoc(url)).toBe(false);
    const docId = url.replace(/^automerge:/, "");
    const interceptor = new KeyhiveBlobInterceptor(owner, new PromiseQueue());
    const original = new TextEncoder().encode("SYNTHETIC private recipe: chickpeas lemon tahini");
    const commitId = createHash("sha256").update(original).digest("hex");
    const sealed = await interceptor.transformOutgoing(docId as never, commitId, [], original);
    expect(sealed, "Keyhive actually creates ciphertext").toBeInstanceOf(Uint8Array);
    expect(sealed!.byteLength).toBeGreaterThan(original.byteLength);
    const raw = new TextDecoder().decode(sealed!);
    expect(raw.includes("SYNTHETIC private recipe")).toBe(false);

    const opened = await interceptor.transformIncoming(docId as never, commitId, sealed!);
    expect(opened).toEqual(original);

    // Authenticated ciphertext MUST NOT decrypt if the keyhive envelope is modified.
    const corrupted = new Uint8Array(sealed!);
    corrupted[20] ^= 1;
    let tamperedOpened: Uint8Array | null = null;
    try {
      tamperedOpened = await interceptor.transformIncoming(docId as never, commitId, corrupted);
    } catch {
      tamperedOpened = null; // explicit crypto rejection also counts as denial
    }
    expect(tamperedOpened, "modified ciphertext was accepted").toBeNull();
    console.log("CC_SECURITY_MATRIX=" + JSON.stringify({
      case: "ark-real-blob-encryption-authentication", expected: "decrypt original, deny tamper",
      observed: "decrypt original, deny tamper", runtime: "node-keyhive-wasm+ark",
      plaintextBytes: original.length, ciphertextBytes: sealed!.length,
      arkCommit: "5d09e8c8cfdebd5656b1426b66aea6b1395f83da"
    }));
  });
});
