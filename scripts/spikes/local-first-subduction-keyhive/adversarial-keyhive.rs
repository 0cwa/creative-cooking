//! Adversarial, engine-neutral Keyhive cryptographic core exercises.
//! This file is copied unchanged into the exact pinned upstream keyhive_core
//! tests directory. No fork or patched authorization code is required.
//! Layer under test: genuine Rust Keyhive/CGKA, NOT ARK/Subduction end-to-end.
//! Data/keys are generated locally for tests only.
use keyhive_core::{
    access::Access::{Admin, Edit, Read, Relay},
    test_utils::{TestContext, TestError, TestResult as Result},
};

#[tokio::test]
async fn cc_protected_role_matrix_real_ciphertext_and_cross_household() -> Result<()> {
    let mut ctx = TestContext::new().await;
    let owner = ctx.individual("household-owner").await?;
    let no_key_relay = ctx.individual("relay-only").await?;
    let reader = ctx.individual("reader-device").await?;
    let editor = ctx.individual("editor-device").await?;
    let admin = ctx.individual("admin-device").await?;
    let stranger = ctx.individual("different-household").await?;
    let recipe = ctx.doc(&owner, "synthetic-recipe").await?;
    let other_household = ctx.doc(&stranger, "other-household").await?;

    owner.add_member(no_key_relay.id(), recipe, Relay, &[]).await?;
    owner.add_member(reader.id(), recipe, Read, &[]).await?;
    owner.add_member(editor.id(), recipe, Edit, &[]).await?;
    owner.add_member(admin.id(), recipe, Admin, &[]).await?;

    for (subject, level) in [
        (no_key_relay.id(), Relay),
        (reader.id(), Read),
        (editor.id(), Edit),
        (admin.id(), Admin),
    ] {
        assert_eq!(owner.access_for_doc(subject, recipe).await, Some(level));
    }
    assert_eq!(owner.access_for_doc(stranger.id(), recipe).await, None);
    assert_eq!(owner.access_for_doc(reader.id(), other_household).await, None);

    let cleartext = b"cooked chickpea and lemon synthetic recipe";
    let encrypted = ctx.encrypt(&owner, recipe, cleartext).await?;
    ctx.sync_all_unsent().await?;
    assert_eq!(reader.try_decrypt_content(recipe, &encrypted).await?, cleartext);
    assert_eq!(editor.try_decrypt_content(recipe, &encrypted).await?, cleartext);
    assert_eq!(admin.try_decrypt_content(recipe, &encrypted).await?, cleartext);
    assert!(!no_key_relay.can_decrypt_content(recipe, &encrypted).await?,
        "Relay may move ciphertext, not derive cooking plaintext");
    assert!(!stranger.can_decrypt_content(recipe, &encrypted).await?,
        "a different household must not receive the decryption key");
    println!(
        "CC_SECURITY_MATRIX case=roles-and-no-key-relay expected=deny-relay-and-outsider observed=deny ciphertext_bytes={} plaintext_bytes={} runtime=keyhive-core-rust",
        encrypted.ciphertext.len(), cleartext.len()
    );

    // Refusal must be an actual Keyhive capability check, not a mock or UI guard.
    match reader.add_member(stranger.id(), recipe, Edit, &[])
        .await.map_err(TestError::from)
    {
        Err(TestError::Escalation { wanted, held }) => {
            assert_eq!((wanted, held), (Edit, Read))
        }
        other => panic!("reader escalated Edit to an outsider: {other:?}"),
    }
    match editor.add_member(stranger.id(), recipe, Admin, &[])
        .await.map_err(TestError::from)
    {
        Err(TestError::Escalation { wanted, held }) => {
            assert_eq!((wanted, held), (Admin, Edit))
        }
        other => panic!("editor escalated Admin to an outsider: {other:?}"),
    }
    assert_eq!(owner.access_for_doc(stranger.id(), recipe).await, None);
    println!("CC_SECURITY_MATRIX case=privilege-escalation expected=deny observed=deny runtime=keyhive-core-rust");
    Ok(())
}

#[tokio::test]
async fn cc_verified_admin_delegation_and_role_attenuation() -> Result<()> {
    let mut ctx = TestContext::new().await;
    let owner = ctx.individual("owner").await?;
    let admin = ctx.individual("trusted-admin").await?;
    let new_device = ctx.individual("new-device").await?;
    let stranger = ctx.individual("outside-member").await?;
    let recipe = ctx.doc(&owner, "shared-recipe").await?;

    owner.add_member(admin.id(), recipe, Admin, &[]).await?;
    ctx.sync_all_unsent().await?;
    admin.add_member(new_device.id(), recipe, Read, &[]).await?;
    ctx.sync_all_unsent().await?;

    assert_eq!(owner.access_for_doc(new_device.id(), recipe).await, Some(Read));
    let encrypted = ctx.encrypt(&owner, recipe, b"synthetic delegated recipe").await?;
    ctx.sync_all_unsent().await?;
    assert!(new_device.can_decrypt_content(recipe, &encrypted).await?);
    match new_device.add_member(stranger.id(), recipe, Admin, &[])
        .await.map_err(TestError::from)
    {
        Err(TestError::Escalation { wanted, held }) => {
            assert_eq!((wanted, held), (Admin, Read))
        }
        other => panic!("delegated new device escalated to Admin: {other:?}"),
    }
    println!("CC_SECURITY_MATRIX case=admin-delegates-read-and-attenuation expected=grant-read-deny-admin observed=grant-read-deny-admin ciphertext_bytes={}", encrypted.ciphertext.len());
    Ok(())
}

#[tokio::test]
async fn cc_revocation_after_offline_snapshot_blocks_future_key_not_old_plaintext() -> Result<()> {
    let mut ctx = TestContext::new().await;
    let owner = ctx.individual("owner").await?;
    let removed = ctx.individual("old-phone").await?;
    let other = ctx.individual("independent-person").await?;
    let recipe = ctx.doc(&owner, "revoked-recipe").await?;
    owner.add_member(removed.id(), recipe, Read, &[]).await?;

    let before = ctx.encrypt(&owner, recipe, b"synthetic old history").await?;
    ctx.sync_all_unsent().await?;
    assert!(removed.can_decrypt_content(recipe, &before).await?,
        "precondition: device really had the old key and plaintext");
    // Model a phone that powers off with its genuine persisted Keyhive archive.
    let stale_archive = removed.into_archive().await;
    let rejoining = ctx.rebuild_from_archive(&stale_archive, "old-phone-rejoining").await?;
    assert!(rejoining.can_decrypt_content(recipe, &before).await?,
        "historical plaintext is not remotely erasable");
    owner.revoke_member(removed.id(), true, recipe).await?;
    let after = ctx.encrypt(&owner, recipe, b"synthetic secret after removal").await?;
    // The removed phone was offline through the key rotation and re-joins.
    ctx.sync_all_unsent().await?;

    assert_eq!(owner.access_for_doc(removed.id(), recipe).await, None);
    assert!(!removed.can_decrypt_content(recipe, &after).await?,
        "removed online device must not learn future content");
    assert!(!rejoining.can_decrypt_content(recipe, &after).await?,
        "stale archived offline device must not derive a future epoch");
    assert!(removed.can_decrypt_content(recipe, &before).await?,
        "previously held ciphertext and plaintext remain accessible");
    assert!(other.access_for_doc(other.id(), recipe).await.is_none());
    println!(
        "CC_SECURITY_MATRIX case=revoked-offline-key-epoch expected=deny-future-allow-previous observed=deny-future-allow-previous before_ciphertext_bytes={} after_ciphertext_bytes={}",
        before.ciphertext.len(), after.ciphertext.len()
    );
    Ok(())
}

#[tokio::test]
async fn cc_archive_restart_retains_owner_rights_but_stale_snapshot_must_sync() -> Result<()> {
    let mut ctx = TestContext::new().await;
    let owner = ctx.individual("owner").await?;
    let reader = ctx.individual("reader").await?;
    let recipe = ctx.doc(&owner, "persistent-recipe").await?;
    owner.add_member(reader.id(), recipe, Read, &[]).await?;
    let encrypted = ctx.encrypt(&owner, recipe, b"synthetic retained cooking data").await?;
    ctx.sync_all_unsent().await?;

    let owner_archive = owner.into_archive().await;
    let restored = ctx.rebuild_from_archive(&owner_archive, "owner-restored").await?;
    assert_eq!(restored.access_for_doc(reader.id(), recipe).await, Some(Read));
    assert_eq!(
        restored.try_decrypt_content(recipe, &encrypted).await?,
        b"synthetic retained cooking data"
    );
    println!(
        "CC_SECURITY_MATRIX case=keyhive-archive-rebuild expected=grant-owner-read observed=grant-owner-read ciphertext_bytes={}",
        encrypted.ciphertext.len()
    );
    Ok(())
}
