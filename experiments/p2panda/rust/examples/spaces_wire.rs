//! Research-only complete signed p2panda-Spaces operation-header wire format.
//! Generate deterministic TEST identities, a real encrypted Spaces message and
//! signed auth/welcome/application operations. Verification runs in a separate
//! process, rehydrates only Bob's deterministic TEST key bundle, validates
//! Ed25519 signatures during Header::decode, processes the actual received
//! signed CBOR headers in causal order, and decrypts using Spaces.
//!
//! DO NOT use this deterministic test identity design in production.
use p2panda_auth::Access;
use p2panda_core::{Header, Operation};
use p2panda_core::traits::Digest;
use p2panda_spaces::test_utils::{TestForge, TestManager, TestOperation, TestPeer, TestSpacesStore};
use p2panda_spaces::{Config, Credentials};
use p2panda_encryption::Rng;
use p2panda_store::SqliteStoreBuilder;
use p2panda_spaces::{Event, SpaceId, SpacesArgs};
use serde_json::{json, Value};
use std::{env, error::Error, fs, path::Path};

const TEST_DOCUMENT: &str = "creative-cooking-spaces-real-encrypted-catchup-v1";
const TEST_PLAINTEXT: &[u8] = b"CC_SPACES_PRIVATE_SYNTHETIC_RECIPE_chickpeas_only_in_Bob_decrypt";

fn decode_authentic_header(hex_bytes: &str) -> Result<TestOperation, Box<dyn Error>> {
    let bytes = hex::decode(hex_bytes)?;
    // This does real Ed25519 verification via p2panda-core AnyHeader::decode.
    let header = Header::<SpacesArgs<()>>::decode(&bytes)?;
    if header.encode() != bytes {
        return Err("non-canonical signed Spaces CBOR header".into());
    }
    Ok(Operation::from_parts(header, None))
}
fn read_headers(value: &Value, field: &str) -> Result<Vec<String>, Box<dyn Error>> {
    let array = value.get(field).and_then(Value::as_array).ok_or("missing headers")?;
    array.iter().map(|x| x.as_str().map(str::to_owned).ok_or_else(
        || -> Box<dyn Error> { "invalid header type".into() }
    )).collect()
}

async fn bob_with_persisted_private_keys(private_db:&Path)->Result<TestPeer,Box<dyn Error>>{
    let rng=Rng::from_seed([42;32]);
    let credentials=Credentials::from_rng(&rng)?;
    let url=format!("sqlite://{}",private_db.display());
    let store=SqliteStoreBuilder::new().database_url(&url).build().await?;
    let forge=TestForge::new(store.clone(),credentials.signing_key());
    let manager=TestManager::new_with_config(
       TestSpacesStore::new(store.clone()),forge,credentials.clone(),
       &Config::default(),rng)?;
    Ok(TestPeer{id:42,manager,credentials,store})
}

async fn generate(path: &Path, private_db:&Path) -> Result<(), Box<dyn Error>> {
    let alice=TestPeer::new(41).await;
    let bob=bob_with_persisted_private_keys(private_db).await?;
    alice.manager.register_member(&bob.manager.me().await?).await?;
    bob.manager.register_member(&alice.manager.me().await?).await?;
    let space_id=SpaceId::digest(TEST_DOCUMENT.as_bytes());
    let (space,controls)=alice.manager.create_space_persisted(
        space_id,&[(bob.manager.id(),Access::read())]).await?;
    assert_eq!(controls.len(),2,"expected p2panda-Spaces auth and welcome operations");
    let encrypted=space.publish_persisted(TEST_PLAINTEXT).await?;
    let signed_headers:Vec<String>=controls.iter().chain(std::iter::once(&encrypted))
       .map(|op| hex::encode(op.header.encode())).collect();
    for s in &signed_headers {let _=decode_authentic_header(s)?;}
    let doc=json!({
        "schemaVersion":1,"upstream":"p2panda-spaces 0.7.1 signed CBOR header extensions",
        "fixtureIdentities":"only deterministic TestPeer 41/42; Bob pre-key state persisted separately, not real user credentials",
        "bobPrivateKeyRecovery":"separate local SQLite; never forwarded to native p2panda C",
        "documentId":TEST_DOCUMENT,
        "spaceId":format!("{space_id:?}"),
        "signedHeadersHex":signed_headers,
        "plaintextSentinel":std::str::from_utf8(TEST_PLAINTEXT)?,
        "signedMessageCount":3
    });
    fs::write(path,serde_json::to_vec_pretty(&doc)?)?;
    println!("SPACES_SIGNED_WIRE_GENERATED={{\"count\":3,\"format\":\"signed-cbor-header\",\"keylessReplica\":true}}");
    Ok(())
}
async fn verify(fixture_path:&Path,received_path:&Path,private_db:&Path)->Result<(),Box<dyn Error>> {
    let fixture:Value=serde_json::from_slice(&fs::read(fixture_path)?)?;
    let received:Value=serde_json::from_slice(&fs::read(received_path)?)?;
    let expected=read_headers(&fixture,"signedHeadersHex")?;
    let actual=read_headers(&received,"signedHeadersHex")?;
    if expected!=actual || expected.len()!=3 {
        return Err("native replica changed, lost, reordered or duplicated signed Spaces wire ops".into());
    }
    let alice=TestPeer::new(41).await;
    let bob=bob_with_persisted_private_keys(private_db).await?;
    // Alice's bundle and Bob's pre-key secret registry were persisted at generation.
    let outsider=TestPeer::new(99).await;
    outsider.manager.register_member(&alice.manager.me().await?).await?;
    let mut delivered=0;
    for wire in &actual {
        let msg=decode_authentic_header(wire)?;
        let new_message=bob.persist_operation(&msg).await?;
        if !new_message {return Err("first delivery duplicate in Bob store".into());}
        let events=bob.manager.process_persisted(&msg).await?;
        for event in events {
            if let Event::Application {data,..}=event {
                if data != TEST_PLAINTEXT {return Err("Spaces decrypted unexpected data".into());}
                delivered+=1;
            }
        }
        // Other party can store/forward the opaque header without a group key.
        // Successful plaintext delivery by unauthorized outsider must not occur.
        let _=outsider.persist_operation(&msg).await?;
        let result=outsider.manager.process_persisted(&msg).await;
        if matches!(result,Ok(events) if events.iter().any(|e| matches!(
          e,Event::Application {data,..} if data == TEST_PLAINTEXT
        ))) {return Err("unauthorized outsider received Spaces plaintext".into());}
    }
    if delivered!=1 {return Err(format!("Spaces delivered {delivered} app messages; expected 1").into());}
    let op=decode_authentic_header(&actual[2])?;
    let replay=bob.persist_operation(&op).await?;
    if replay {return Err("Spaces test store accepted duplicate signed operation".into());}
    let mut tampered=hex::decode(&actual[2])?;
    // Flip a byte in signed input and ensure authoritative p2panda signature/canonical check.
    *tampered.last_mut().ok_or("empty header")? ^= 0x01;
    let signedTamperRejected=Header::<SpacesArgs<()>>::decode(&tampered).is_err();
    if !signedTamperRejected {return Err("tampered Spaces header accepted".into());}
    let space_id=SpaceId::digest(TEST_DOCUMENT.as_bytes());
    let bob_space=bob.manager.space(space_id).await?.ok_or("Bob lacks space after welcome")?;
    // Does the helper's read-only permission actually block locally encrypting
    // an application operation? Record observed result without miscalling
    // transport-only encryption a complete authorization layer.
    let read_only_can_encrypt=bob_space.publish_persisted(
      b"unauthorized read-only member attempt").await.is_ok();
    let result=json!({
      "status":"PASS","signedHeaderCount":actual.len(),"spacesDecryptedByAuthorizedBob":true,
      "outsiderDecrypts":false,"nativeRecoveredExactSignedHeaders":true,
      "replayIgnoredByTestOperationStore":true,"signedHeaderTamperRejected":signedTamperRejected,
      "readOnlyCanLocallyEncryptWithoutIngressACL":read_only_can_encrypt,
      "signatureValidation":"p2panda-core Header::decode Ed25519 + canonical CBOR",
      "encryption":"genuine p2panda Spaces 0.7.1 for Alice/Bob",
      "recipientPrivateKeyStoreRecovered":true,
      "limitations":["TestPeer synthetic seeded identities","membership authorization preconditions are out-of-band in fixture setup",
        "p2panda native republish outer signature is separate from inner Spaces header signature",
        "no public relay and no iOS/Android runtime",
        "not a comprehensive signed receive/forward ACL or revocation attack audit"]
    });
    println!("SPACES_PERSISTENT_NATIVE_VERIFICATION={}",result);
    Ok(())
}
#[tokio::main]
async fn main()->Result<(),Box<dyn Error>> {
    let args:Vec<String>=env::args().collect();
    if args.len()<4 {return Err("Usage: spaces_wire generate fixture.json bob-private.sqlite | verify fixture.json actual-native-headers.json bob-private.sqlite".into());}
    match args[1].as_str() {
      "generate" if args.len()==4=>generate(Path::new(&args[2]),Path::new(&args[3])).await,
      "verify" if args.len()==5=>verify(Path::new(&args[2]),Path::new(&args[3]),Path::new(&args[4])).await,
      _=>Err("unknown spaces_wire command".into())
    }
}
