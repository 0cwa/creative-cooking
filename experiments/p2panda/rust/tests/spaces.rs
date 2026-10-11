//! p2panda-spaces 0.7.0 group encryption exercised via upstream public test
//! helpers (without any network). This is NOT an audited production stack.
use p2panda_auth::Access;
use p2panda_core::traits::Digest;
use p2panda_spaces::test_utils::TestPeer;
use p2panda_spaces::{Event, SpaceId, SpacesArgs};

#[tokio::test]
async fn third_device_joins_and_removed_peer_cannot_decrypt_future_data() {
    let alice = TestPeer::new(41).await;
    let bob = TestPeer::new(42).await;
    let claire = TestPeer::new(43).await;
    for other in [&bob, &claire] {
        alice.manager.register_member(&other.manager.me().await.unwrap())
            .await.unwrap();
        other.manager.register_member(&alice.manager.me().await.unwrap())
            .await.unwrap();
    }
    let space_id = SpaceId::digest(b"creative-cooking-opaque-household-test");
    let (space, initial) = alice.manager
        .create_space_persisted(space_id, &[(bob.manager.id(), Access::read())])
        .await.unwrap();
    for message in &initial {
        for peer in [&bob, &claire] {
            peer.persist_operation(message).await.unwrap();
            peer.manager.process_persisted(message).await.unwrap();
        }
    }
    let (add_auth, add_space) = space.add_persisted(claire.manager.id(), Access::read())
        .await.unwrap();
    for message in [&add_auth, &add_space] {
        for peer in [&bob, &claire] {
            peer.persist_operation(message).await.unwrap();
            peer.manager.process_persisted(message).await.unwrap();
        }
    }
    let body = vec![0, 255, 0, 1, 128, 42, 0, 17, 240];
    let encrypted = space.publish_persisted(&body).await.unwrap();
    match &encrypted.header.extensions {
        SpacesArgs::Application { ciphertext, .. } => assert_ne!(ciphertext, &body),
        _ => panic!("expected encrypted application frame")
    }
    for peer in [&bob, &claire] {
        peer.persist_operation(&encrypted).await.unwrap();
        let events = peer.manager.process_persisted(&encrypted).await.unwrap();
        assert!(events.iter().any(|e| matches!(
            e, Event::Application { data, .. } if data == &body
        )));
    }
    let (remove_auth, remove_space) = space.remove_persisted(bob.manager.id())
        .await.unwrap();
    for message in [&remove_auth, &remove_space] {
        for peer in [&bob, &claire] {
            peer.persist_operation(message).await.unwrap();
            peer.manager.process_persisted(message).await.unwrap();
        }
    }
    let future = vec![244, 0, 34, 99, 1, 255];
    let future_msg = space.publish_persisted(&future).await.unwrap();
    claire.persist_operation(&future_msg).await.unwrap();
    let events = claire.manager.process_persisted(&future_msg).await.unwrap();
    assert!(events.iter().any(|e| matches!(
        e, Event::Application { data, .. } if data == &future
    )));
    bob.persist_operation(&future_msg).await.unwrap();
    let bob_result = bob.manager.process_persisted(&future_msg).await;
    assert!(!matches!(bob_result, Ok(ref events) if events.iter().any(|e| matches!(
        e, Event::Application { data, .. } if data == &future
    ))));
}
