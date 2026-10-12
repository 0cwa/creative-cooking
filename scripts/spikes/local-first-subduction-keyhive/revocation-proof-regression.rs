//! Regression from Keyhive upstream security fix a864f5c (#250), run unchanged
//! against Creative Cooking's pinned b7968be and the newer fixed a864f5c.
 //! Security invariant: Mallory may not revoke Bob by citing ALICE's signing
//! delegation even when the delegation being revoked descends from that proof.
//! This tests *genuine* Keyhive Ed25519 signed revocations, not mock policy
//! identities, browser transports, or a patched upstream library.
use keyhive_core::{
    access::Access::Read,
    crypto::digest::Digest,
    principal::{group::revocation::StaticRevocation, identifier::Identifier},
    test_utils::{TestContext, TestResult as Result},
};

#[tokio::test]
async fn cc_forged_revocation_cannot_cite_someone_elses_delegation() -> Result<()> {
    let mut ctx = TestContext::new().await;
    let alice = ctx.individual("synthetic-household-owner").await?;
    let bob = ctx.individual("synthetic-authorized-reader").await?;
    let mallory = ctx.individual("synthetic-outside-attacker").await?;
    let document = ctx.doc(&alice, "synthetic-cooking-recipe").await?;

    let bob_delegation: [u8; 32] = alice
        .add_member(bob.id(), document, Read, &[])
        .await?
        .delegation
        .digest()
        .into();
    let alice_proof: [u8; 32] = alice
        .get_document(document).await.expect("owner document exists")
        .lock().await
        .get_capability(&Identifier::from(alice.id()))
        .expect("owner has founding delegation")
        .digest().into();

    assert_eq!(alice.access_for_doc(bob.id(), document).await, Some(Read));
    let forged = mallory
        .try_sign(StaticRevocation::<[u8; 32]> {
            revoke: Digest::from(bob_delegation),
            proof: Some(Digest::from(alice_proof)),
            after_content: Default::default(),
        })
        .await?;

    let result = alice.receive_revocation(&forged).await;
    let observed = if result.is_err() { "DENY" } else { "UNAUTHORIZED_REVOKE_ACCEPTED" };
    println!(
        "CC_SECURITY_MATRIX case=forged-revocation-citing-third-party-proof expected=DENY observed={} base_or_fix={} runtime=genuine-keyhive-Rust-Ed25519",
        observed,
        option_env!("CC_SECURITY_PIN").unwrap_or("see-job-checkout-sha")
    );
    assert!(result.is_err(),
        "SECURITY FAIL: forged signed revocation citing another person's delegation was accepted");
    assert_eq!(alice.access_for_doc(bob.id(), document).await, Some(Read),
        "a forged revocation must not revoke the authorized device");
    Ok(())
}
