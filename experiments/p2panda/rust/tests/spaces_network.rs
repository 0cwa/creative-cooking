//! Real p2panda Spaces 0.7.1 ciphertext is carried by a REAL p2panda Node.
//! Alice/Bob Spaces control messages stay in memory; the Node transports the
//! actual encrypted Application ciphertext only, not serialized Spaces headers.
//! This is NOT an authenticated remote cross-process Spaces runtime, durable
//! encrypted group replication, or a negative security qualification.
use creative_cooking_p2panda_spike::ReplicatedFrame;
use futures_util::StreamExt;
use p2panda::network::MdnsDiscoveryMode;
use p2panda::streams::StreamEvent;
use p2panda_core::traits::Digest;
use p2panda_auth::Access;
use p2panda_spaces::test_utils::TestPeer;
use p2panda_spaces::{Event, SpaceId, SpacesArgs};
use std::{borrow::Borrow, time::Duration};

#[tokio::test]
async fn real_spaces_ciphertext_is_opaque_on_signed_native_operation() {
    let alice = TestPeer::new(131).await;
    let bob = TestPeer::new(132).await;
    alice.manager.register_member(&bob.manager.me().await.unwrap())
        .await.unwrap();
    bob.manager.register_member(&alice.manager.me().await.unwrap())
        .await.unwrap();
    let id = SpaceId::digest(b"cc-net-actual-encrypted-spaces-ciphertext");
    let (space, controls) = alice.manager
        .create_space_persisted(id, &[(bob.manager.id(), Access::read())])
        .await.unwrap();
    for msg in &controls {
        bob.persist_operation(msg).await.unwrap();
        bob.manager.process_persisted(msg).await.unwrap();
    }
    let plaintext = b"cc_spaces_test_secret_never_transmitted_as_plaintext_abc".to_vec();
    let message = space.publish_persisted(&plaintext).await.unwrap();
    let extensions: &SpacesArgs<()> = message.borrow();
    let ciphertext = if let SpacesArgs::Application { ciphertext, .. } = extensions {
        ciphertext.clone()
    } else {
        panic!("Spaces application must be encrypted");
    };
    assert!(!ciphertext.windows(plaintext.len()).any(|chunk| chunk == plaintext));
    let node = p2panda::builder()
        .mdns_mode(MdnsDiscoveryMode::Disabled)
        .spawn().await.unwrap();
    let (tx, mut rx) = node.stream::<ReplicatedFrame>(p2panda::Topic::random())
        .await.unwrap();
    tx.publish(ReplicatedFrame {
        document_id: "test/real-spaces-ciphertext".into(), bytes: ciphertext.clone(),
    }).await.unwrap();
    let recovered = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match rx.next().await {
                Some(StreamEvent::Processed { operation, .. }) =>
                    break operation.message().clone(),
                Some(StreamEvent::ProcessingFailed { error, .. }) =>
                    panic!("p2panda native processing error: {error:?}"),
                Some(StreamEvent::DecodeFailed { error, .. }) =>
                    panic!("p2panda native decode error: {error:?}"),
                Some(_) => continue,
                None => panic!("p2panda native stream ended"),
            }
        }
    }).await.expect("native Spaces ciphertext transport timeout");
    assert_eq!(recovered.bytes, ciphertext);
    // Recipient's *separate* Spaces manager uses the retained original full
    // signed Spaces message, not a reconstruction of its headers from Node.
    bob.persist_operation(&message).await.unwrap();
    let events = bob.manager.process_persisted(&message).await.unwrap();
    assert!(events.iter().any(|e| matches!(
        e, Event::Application { data, .. } if data == &plaintext
    )));
}
