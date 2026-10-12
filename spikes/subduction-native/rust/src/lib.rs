//! Isolated experimental native ABI over genuine pinned Subduction Rust APIs.
//! NEVER a production crypto, credentials or app-state adapter.
//! This intentionally uses ephemeral process-local Storage and OpenPolicy.
use std::{
    collections::BTreeSet,
    ffi::{CStr, CString, c_char},
    sync::Arc,
    time::Duration,
};
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use future_form::Sendable;
use sedimentree_core::{blob::Blob, id::SedimentreeId, loose_commit::id::CommitId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subduction_core::{
    policy::open::OpenPolicy,
    storage::memory::MemoryStorage,
    subduction::builder::SubductionBuilder,
    timeout::call::CallTimeout,
};
use subduction_crypto::signer::memory::MemorySigner;
use subduction_websocket::{
    tokio::{TokioSpawn, TimeoutTokio, client::TokioWebSocketClient},
};
const SYNC_TIMEOUT: CallTimeout = CallTimeout::TimeoutMillis(12000);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    relay_ws: String,
    service_name: String,
    phase: String,
    scenarios: Vec<Scenario>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scenario {
    engine: String,
    space_id: String,
    document_id: String,
    sedimentree_id_hex: String,
    expected_count: usize,
    publish: Vec<Commit>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Commit {
    id: String,
    dependencies: Vec<String>,
    ciphertext_base64: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioEvidence {
    engine: String,
    space_id: String,
    document_id: String,
    sedimentree_id_hex: String,
    subscribed_peer: String,
    expected_count: usize,
    received_count: usize,
    ciphertext_sha256: Vec<String>,
    blobs_base64: Vec<String>,
    posted_commits: usize,
    exact_binary: bool,
}
fn bytes32(value: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(value)?;
    if bytes.len() != 32 { bail!("must be 32-byte hex identifier"); }
    let mut result = [0u8; 32];
    result.copy_from_slice(&bytes);
    Ok(result)
}
fn hash(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}
async fn run_one(request: &Request, scenario: &Scenario) -> Result<ScenarioEvidence> {
    // One Subduction instance per unique (engine, space, document) namespace.
    // No hand-written handshake, protocol serialization or transport messages.
    let id = SedimentreeId::new(bytes32(&scenario.sedimentree_id_hex)?);
    let signer = MemorySigner::generate(); // ephemeral test identity, NOT Keyhive
    type Conn = TokioWebSocketClient<MemorySigner>;
    let (syncer, _handler, listener, manager) = SubductionBuilder::<_, _, _, _, _, _, 256>::new()
        .signer(signer.clone())
        .storage(MemoryStorage::new(), Arc::new(OpenPolicy))
        .spawner(TokioSpawn)
        .timer(TimeoutTokio)
        .build::<Sendable, Conn>();
    tokio::spawn(async move { let _ = listener.await; });
    tokio::spawn(async move { let _ = manager.await; });

    let address = request.relay_ws.parse().context("invalid relay WebSocket URI")?;
    let audience = subduction_core::handshake::audience::Audience::discover(
        request.service_name.as_bytes()
    );
    let (connection, receiver, sender, keepalive) =
        TokioWebSocketClient::new(address, signer, audience).await
            .context("native WebSocket and Subduction authentication handshake")?;
    let peer = connection.peer_id();
    tokio::spawn(async move { let _ = receiver.await; });
    tokio::spawn(async move { let _ = sender.await; });
    tokio::spawn(async move { let _ = keepalive.await; });
    syncer.add_connection(connection).await.context("register authenticated connection")?;

    // Initial subscription is required for a document not yet present locally.
    let (ok, _, _) = syncer.sync_with_peer(&peer, id, true, SYNC_TIMEOUT)
        .await.context("native initial Subduction sync")?;
    if !ok { bail!("initial Subduction sync returned unsuccessful"); }

    for commit in &scenario.publish {
        let dependencies: BTreeSet<CommitId> = commit.dependencies.iter()
            .map(|dep| bytes32(dep).map(CommitId::new))
            .collect::<Result<_>>()?;
        let bytes = STANDARD.decode(&commit.ciphertext_base64)?;
        if bytes.is_empty() { bail!("empty opaque update"); }
        syncer.add_commit(id, CommitId::new(bytes32(&commit.id)?), dependencies,
            Blob::new(bytes)).await.context("native upstream add_commit")?;
    }
    let mut last = 0;
    let mut blobs = Vec::new();
    for _attempt in 0..35 {
        let (ok, _, _) = syncer.sync_with_peer(&peer, id, true, SYNC_TIMEOUT)
            .await.context("native Subduction retry/catch-up")?;
        if !ok { bail!("native sync returned unsuccessful"); }
        blobs = syncer.get_blobs(id).await.context("native get_blobs")?
            .map(|nonempty| nonempty.into_iter().map(Blob::into_contents).collect())
            .unwrap_or_default();
        last = blobs.len();
        if last == scenario.expected_count { break; }
        if last > scenario.expected_count {
            bail!("unexpected extra updates: got {} expected {}", last, scenario.expected_count);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    if last != scenario.expected_count {
        bail!("native Subduction catch-up timeout: got {last}, expected {}", scenario.expected_count);
    }
    let mut hashes = blobs.iter().map(|b| hash(b)).collect::<Vec<_>>();
    hashes.sort();
    let distinct = hashes.iter().collect::<BTreeSet<_>>().len() == hashes.len();
    if !distinct { bail!("duplicate ciphertext delivered"); }
    syncer.disconnect_all().await.context("native disconnect")?;
    Ok(ScenarioEvidence {
        engine: scenario.engine.clone(), space_id: scenario.space_id.clone(),
        document_id: scenario.document_id.clone(),
        sedimentree_id_hex: scenario.sedimentree_id_hex.clone(),
        subscribed_peer: peer.to_string(), expected_count: scenario.expected_count,
        received_count: last, ciphertext_sha256: hashes,
        blobs_base64: blobs.iter().map(|b| STANDARD.encode(b)).collect(),
        posted_commits: scenario.publish.len(), exact_binary: true,
    })
}

async fn run(request: Request) -> Result<serde_json::Value> {
    if request.service_name.is_empty() || request.scenarios.len() != 2 {
        bail!("expected exactly two engines and non-empty service name");
    }
    if !(request.relay_ws.starts_with("ws://") || request.relay_ws.starts_with("wss://")) {
        bail!("unsupported transport URL: only upstream WebSocket here");
    }
    if !matches!(request.phase.as_str(), "first" | "relaunch" | "host") {
        bail!("unknown native phase");
    }
    let a = &request.scenarios[0];
    let b = &request.scenarios[1];
    if a.engine != "automerge" || b.engine != "loro"
        || a.space_id == b.space_id || a.sedimentree_id_hex == b.sedimentree_id_hex {
        bail!("engine, space and Sedimentree IDs must be distinct and ordered");
    }
    let mut proofs = Vec::new();
    for scenario in &request.scenarios {
        proofs.push(run_one(&request, scenario).await
            .with_context(|| format!("engine {} phase {}", scenario.engine, request.phase))?);
    }
    Ok(serde_json::json!({
        "status": "PASS", "runtime": "real-rust-subduction",
        "phase": request.phase, "pid": std::process::id(),
        "upstreamSha": "f0af1aab5f2fd44e5b224c22fc8b62660d50bc01",
        "security": "UNSAFE OpenPolicy, ephemeral signer and test fixture encryption; NOT Keyhive/ARK",
        "scenarios": proofs,
    }))
}
/// Pure JSON entry point also used by a distinct Linux Rust process for preflight.
pub fn execute(payload: &str) -> String {
    let result = std::panic::catch_unwind(|| -> Result<serde_json::Value> {
        let request: Request = serde_json::from_str(payload).context("parse native request")?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2).enable_all().build()?;
        runtime.block_on(run(request))
    });
    match result {
        Ok(Ok(value)) => value.to_string(),
        Ok(Err(error)) => serde_json::json!({
            "status": "FAIL", "pid": std::process::id(),
            "runtime": "real-rust-subduction", "error": format!("{error:#}")
        }).to_string(),
        Err(_) => serde_json::json!({
            "status": "FAIL", "pid": std::process::id(),
            "runtime": "real-rust-subduction", "error": "native panic trapped before FFI"
        }).to_string(),
    }
}
/// Ownership: caller frees only via cc_subduction_free; never with Swift/Obj-C free().
#[unsafe(no_mangle)]
pub extern "C" fn cc_subduction_run(request: *const c_char) -> *mut c_char {
    if request.is_null() { return std::ptr::null_mut(); }
    // SAFETY: native caller provides a NUL-terminated string, lives for this call.
    let input = unsafe { CStr::from_ptr(request) };
    let output = match input.to_str() {
        Ok(value) => execute(value),
        Err(_) => r#"{"status":"FAIL","error":"invalid UTF-8 input"}"#.to_owned(),
    };
    CString::new(output).expect("JSON cannot contain raw NUL").into_raw()
}
#[unsafe(no_mangle)]
pub extern "C" fn cc_subduction_free(result: *mut c_char) {
    if !result.is_null() {
        // SAFETY: pointer originates from cc_subduction_run and is freed once.
        unsafe { drop(CString::from_raw(result)); }
    }
}
#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_subductionnative_CcSubductionModule_runNative(
    mut env: jni::JNIEnv, _object: jni::objects::JObject,
    request: jni::objects::JString,
) -> jni::sys::jstring {
    let input: String = match env.get_string(&request) {
        Ok(s) => s.into(),
        Err(_) => return std::ptr::null_mut(),
    };
    let result = execute(&input);
    env.new_string(result).map(|v| v.into_raw()).unwrap_or(std::ptr::null_mut())
}
