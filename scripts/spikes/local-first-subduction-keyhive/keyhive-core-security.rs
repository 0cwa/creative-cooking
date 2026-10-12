//! Creative Cooking pinned Keyhive core adversarial crypto/ACL controls.
//!
//! This file is copied into the EXACT pinned upstream checkout's tests/ by
//! its own isolated workflow job. These are Keyhive-core tests, not a claimed
//! ARK→Subduction signed-wire or mobile-stack security certification.
//! All identities, documents and plaintext are disposable test fixtures.
use keyhive_core::{
    access::Access::{Admin, Edit, Read, Relay},
    test_utils::{TestContext, TestResult as Result},
};

#[tokio::test]
async fn independent_identities_relay_read_edit_admin_and_other_household() -> Result<()> {
    let mut ctx = TestContext::new().await;
    let owner = ctx.individual("owner").await?;
    let forwarder = ctx.individual("ciphertext-forwarder").await?;
    let reader = ctx.individual("reader").await?;
    let editor = ctx.individual("editor").await?;
    let admin = ctx.individual("admin").await?;
    let stranger = ctx.individual("unrelated-household").await?;
    let pantry = ctx.doc(&owner, "cc-synthetic-pantry").await?;
    owner.add_member(forwarder.id(), pantry, Relay, &[]).await?;
    owner.add_member(reader.id(), pantry, Read, &[]).await?;
    owner.add_member(editor.id(), pantry, Edit, &[]).await?;
    owner.add_member(admin.id(), pantry, Admin, &[]).await?;
    let cipher = ctx.encrypt(&owner, pantry, b"synthetic chickpea soup and roasted apples").await?;
    ctx.sync_all_unsent().await?;

    for (person, level) in [(&forwarder, Relay), (&reader, Read), (&editor, Edit), (&admin, Admin)] {
        assert_eq!(owner.access_for_doc(person.id(), pantry).await, Some(level));
    }
    assert_eq!(owner.access_for_doc(stranger.id(), pantry).await, None);
    assert!(!forwarder.can_decrypt_content(pantry, &cipher).await?, "Relay cannot read");
    assert!(reader.can_decrypt_content(pantry, &cipher).await?, "Read decrypts");
    assert!(editor.can_decrypt_content(pantry, &cipher).await?, "Edit decrypts");
    assert!(admin.can_decrypt_content(pantry, &cipher).await?, "Admin decrypts");
    println!("CC_KEYHIVE_CORE={{\"case\":\"independent-role-crypto\",\"expected\":\"Relay deny, Read/Edit/Admin decrypt, outsider no membership\",\"observed\":\"PASS\",\"boundary\":\"genuine pinned keyhive_core independent identities\"}}");
    Ok(())
}

#[tokio::test]
async fn capability_attenuation_allows_reader_subdelegation_but_not_edit_escalation() -> Result<()> {
    // Keyhive *intentionally* allows any grantee to pass onward a capability
    // bounded by its own strength. Admin is NOT required for subdelegation.
    // See pinned design/glossary.md PoLA ("never restricts sub-delegation").
    let mut ctx = TestContext::new().await;
    let owner = ctx.individual("owner").await?;
    let reader = ctx.individual("reader").await?;
    let admin = ctx.individual("admin").await?;
    let newcomer = ctx.individual("newcomer").await?;
    let second = ctx.individual("second").await?;
    let pantry = ctx.doc(&owner, "cc-delegation").await?;
    owner.add_member(reader.id(), pantry, Read, &[]).await?;
    owner.add_member(admin.id(), pantry, Admin, &[]).await?;
    ctx.sync_all_unsent().await?;

    reader.add_member(newcomer.id(), pantry, Read, &[]).await?;
    ctx.sync_all_unsent().await?;
    assert_eq!(owner.access_for_doc(newcomer.id(), pantry).await, Some(Read));
    // Whether the API rejects this request or attenuates it, it must never
    // make the target an editor through a Read-only delegation.
    let upgrade_result = reader.add_member(newcomer.id(), pantry, Edit, &[]).await;
    ctx.sync_all_unsent().await?;
    let effective = owner.access_for_doc(newcomer.id(), pantry).await;
    assert_eq!(effective, Some(Read),
        "SECURITY FAIL: Read holder's Edit attempted escalation became effective");
    if let Ok(op) = upgrade_result {
        println!("CC_KEYHIVE_CORE={{\"case\":\"attenuation-attempt\",\"observed\":\"API returned signed op but effective authorization remained Read\",\"note\":\"not evidence of Edit escalation\"}}");
        drop(op);
    }

    admin.add_member(second.id(), pantry, Edit, &[]).await?;
    ctx.sync_all_unsent().await?;
    assert_eq!(owner.access_for_doc(second.id(), pantry).await, Some(Edit));
    println!("CC_KEYHIVE_CORE={{\"case\":\"capability-attenuation\",\"expected\":\"Read holder can delegate Read but not escalate Edit; Admin delegates Edit\",\"observed\":\"PASS\",\"model\":\"Keyhive PoLA intentionally permits attenuated subdelegation\"}}");
    Ok(())
}

#[tokio::test]
async fn revoked_reader_stale_offline_archive_rejoins_but_cannot_decrypt_future_epoch() -> Result<()> {
    let mut ctx = TestContext::new().await;
    let owner = ctx.individual("owner").await?;
    let reader = ctx.individual("reader").await?;
    let pantry = ctx.doc(&owner, "cc-revocation").await?;
    owner.add_member(reader.id(), pantry, Read, &[]).await?;
    let old = ctx.encrypt(&owner, pantry, b"synthetic historic ramen").await?;
    ctx.sync_all_unsent().await?;
    assert!(reader.can_decrypt_content(pantry, &old).await?, "positive Read precondition");

    // Stale offline archive still has *all* old local keys and plaintext; it
    // must not gain a post-revocation key when it rejoins on older ACL state.
    let stale_archive = reader.into_archive().await;
    owner.revoke_member(reader.id(), true, pantry).await?;
    let future = ctx.encrypt(&owner, pantry, b"synthetic future pie secret").await?;
    let offline = ctx.rebuild_from_archive(&stale_archive, "reader-returning-offline").await?;
    ctx.sync(&owner, &offline).await?;
    ctx.sync_all_unsent().await?;
    assert_eq!(owner.access_for_doc(reader.id(), pantry).await, None);
    assert!(!reader.can_decrypt_content(pantry, &future).await?, "current revoked reader");
    assert!(!offline.can_decrypt_content(pantry, &future).await?, "offline stale archive");
    println!("CC_KEYHIVE_CORE={{\"case\":\"offline-rejoin-revoked-future-key\",\"expected\":\"old key retained, future key denied after stale archive rejoin\",\"observed\":\"PASS\",\"limit\":\"no queued Subduction write/replay test\"}}");
    Ok(())
}

#[tokio::test]
async fn second_device_same_identity_needs_prekey_secrets_and_can_recover_history() -> Result<()> {
    let mut ctx = TestContext::new().await;
    let owner = ctx.individual("owner").await?;
    let phone = ctx.individual("reader-phone").await?;
    let tablet = ctx.new_keyhive_instance_for(&phone, "reader-tablet").await?;
    let pantry = ctx.doc(&owner, "cc-device-history").await?;
    owner.add_member(phone.id(), pantry, Read, &[]).await?;
    let old = ctx.encrypt(&owner, pantry, b"synthetic shared historic recipe").await?;
    ctx.sync_all_unsent().await?;
    let phone_has = phone.can_decrypt_content(pantry, &old).await?;
    let tablet_has = tablet.can_decrypt_content(pantry, &old).await?;
    assert!(phone_has ^ tablet_has, "one individual prekey was actually invited");
    if phone_has {
        ctx.share_prekey_secrets(&phone, &tablet).await?;
    } else {
        ctx.share_prekey_secrets(&tablet, &phone).await?;
    }
    ctx.sync_all_unsent().await?;
    assert!(phone.can_decrypt_content(pantry, &old).await?);
    assert!(tablet.can_decrypt_content(pantry, &old).await?);
    println!("CC_KEYHIVE_CORE={{\"case\":\"new-device-prekey-recovery\",\"expected\":\"distinct instances sharing signer need explicit prekey secrets to open historical content\",\"observed\":\"PASS\",\"limit\":\"device key transfer not a QR/invite UX or ARK integration\"}}");
    Ok(())
}

#[tokio::test]
async fn keyhive_archive_restore_keeps_roles_and_owner_crypto() -> Result<()> {
    let mut ctx = TestContext::new().await;
    let owner = ctx.individual("owner").await?;
    let editor = ctx.individual("editor").await?;
    let pantry = ctx.doc(&owner, "cc-restore").await?;
    owner.add_member(editor.id(), pantry, Edit, &[]).await?;
    let cipher = ctx.encrypt(&owner, pantry, b"synthetic archive recovery dish").await?;
    ctx.sync_all_unsent().await?;
    let archive = owner.into_archive().await;
    let restored = ctx.rebuild_from_archive(&archive, "owner-restored").await?;
    assert_eq!(restored.access_for_doc(editor.id(), pantry).await, Some(Edit));
    assert_eq!(restored.try_decrypt_content(pantry, &cipher).await?, b"synthetic archive recovery dish".to_vec());
    println!("CC_KEYHIVE_CORE={{\"case\":\"archive-restore\",\"expected\":\"role state and owner historic content decrypt\",\"observed\":\"PASS\",\"limit\":\"not a real Subduction redb plus .keyhive crash-consistency restore\"}}");
    Ok(())
}
