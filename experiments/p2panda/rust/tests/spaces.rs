//! p2panda-spaces 0.7.1 group encryption exercised via upstream public test
//! helpers (without any network). This is NOT an audited production stack.
use p2panda_auth::Access;
use std::borrow::Borrow;
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
    let extensions: &SpacesArgs<()> = encrypted.borrow();
    match extensions {
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


#[tokio::test]
async fn outsider_has_no_welcome_key_and_cannot_publish_or_read() {
    let alice = TestPeer::new(71).await;
    let outsider = TestPeer::new(72).await;
    let space_id = SpaceId::digest(b"creative-cooking-neg-outside-space");
    let (space, controls) = alice.manager.create_space_persisted(space_id, &[])
        .await.unwrap();
    for message in &controls {
        outsider.persist_operation(message).await.unwrap();
        outsider.manager.process_persisted(message).await.unwrap();
    }
    let outsider_space = outsider.manager.space(space_id).await.unwrap().unwrap();
    assert!(outsider_space.publish_persisted(b"unauthorized edit").await.is_err());
    let sealed = space.publish_persisted(b"opaque outsider must not read").await.unwrap();
    outsider.persist_operation(&sealed).await.unwrap();
    let result = outsider.manager.process_persisted(&sealed).await;
    assert!(!matches!(result, Ok(ref events) if events.iter().any(|e| matches!(
        e, Event::Application { data, .. } if data.as_slice() == b"opaque outsider must not read"
    ))));
}


/// Adversarial access-control distinction: p2panda Spaces encryption alone
/// does NOT necessarily enforce Access::write on a forged application message.
/// Record actual upstream 0.7.1 behavior. This test is a security-negative
/// OBSERVATION, not a claim of successful write authorization or a gate pass.
#[tokio::test]
async fn read_only_space_member_can_attempt_signed_ciphertext_publish() {
    let alice=TestPeer::new(81).await;
    let bob=TestPeer::new(82).await;
    alice.manager.register_member(&bob.manager.me().await.unwrap()).await.unwrap();
    bob.manager.register_member(&alice.manager.me().await.unwrap()).await.unwrap();
    let id=SpaceId::digest(b"creative-cooking-security-readonly-member");
    let (_alice_space, controls)=alice.manager
        .create_space_persisted(id,&[(bob.manager.id(),Access::read())])
        .await.unwrap();
    for control in &controls {
        bob.persist_operation(control).await.unwrap();
        bob.manager.process_persisted(control).await.unwrap();
    }
    let bob_space=bob.manager.space(id).await.unwrap().unwrap();
    let actual_read_only_grant=bob_space.members().await.unwrap();
    assert!(actual_read_only_grant.iter().any(|(member,access)|
        *member==bob.manager.id() && access==&Access::read()
    ));
    let forged_plain=b"CC_NEGATIVE_READ_ONLY_WRITE_MUST_NOT_BE_ACCEPTED";
    let forged=bob_space.publish_persisted(forged_plain).await;
    let forged_locally=forged.is_ok();
    let mut delivered_to_owner=false;
    if let Ok(message)=forged {
        alice.persist_operation(&message).await.unwrap();
        let result=alice.manager.process_persisted(&message).await;
        delivered_to_owner=matches!(result,Ok(ref events) if events.iter().any(|e| matches!(
            e,Event::Application {data,..} if data.as_slice()==forged_plain
        )));
    }
    println!(
        "CC_SPACES_READ_ONLY_ACCESS_NEGATIVE=read_only_can_forge:{};owner_receives:{}",
        forged_locally,delivered_to_owner
    );
}
