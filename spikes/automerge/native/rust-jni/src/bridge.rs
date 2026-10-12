//! Experimental handle-based JNI surface backed by Automerge 0.12.0.
//! Only the handle registry owns native documents and peer SyncState instances.
//! All JNI-owned byte arrays are copied; callers never receive Rust pointers.
use automerge::{
    sync::{Message, State, SyncDoc}, transaction::Transactable,
    ActorId, Author, AutoCommit, ChangeHash, ObjId, ObjType, ReadDoc,
    ScalarValue, Value, ROOT,
};
use jni::{
    objects::{JByteArray, JClass, JObjectArray, JString},
    sys::{jbyteArray, jint, jlong, jstring},
    JNIEnv,
};
use serde_json::{json, Value as JsonValue};
use std::{
    collections::HashMap,
    panic::{catch_unwind, AssertUnwindSafe},
    ptr,
    str::FromStr,
    sync::{Mutex, OnceLock},
};

type Result<T> = std::result::Result<T, String>;
const JNI_PREFIX: &str = "creative.cooking.automerge.spike.CurrentCoreBridge";

#[derive(Default)]
struct Registry {
    next: i64,
    docs: HashMap<i64, AutoCommit>,
    sessions: HashMap<i64, State>,
}
impl Registry {
    fn id(&mut self) -> Result<i64> {
        self.next = self.next.checked_add(1).ok_or("Native handle ID exhausted")?;
        Ok(self.next)
    }
}
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
fn with_registry<T>(f: impl FnOnce(&mut Registry) -> Result<T>) -> Result<T> {
    let mut guard = REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
        .lock().map_err(|_| "Native registry mutex poisoned".to_owned())?;
    f(&mut guard)
}
fn with_doc<T>(id: jlong, f: impl FnOnce(&mut AutoCommit) -> Result<T>) -> Result<T> {
    with_registry(|r| f(r.docs.get_mut(&id).ok_or(format!("Unknown/disposed doc: {id}"))?))
}
fn jni<T>(env: &mut JNIEnv<'_>, fallback: T, f: impl FnOnce(&mut JNIEnv<'_>) -> Result<T>) -> T {
    match catch_unwind(AssertUnwindSafe(|| f(env))) {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            fallback
        }
        Err(_) => {
            let _ = env.throw_new("java/lang/IllegalStateException", "Automerge native panic");
            fallback
        }
    }
}
fn bytes(env: &mut JNIEnv<'_>, input: JByteArray<'_>) -> Result<Vec<u8>> {
    env.convert_byte_array(input).map_err(|e| e.to_string())
}
fn make_bytes(env: &mut JNIEnv<'_>, b: &[u8]) -> Result<jbyteArray> {
    env.byte_array_from_slice(b).map(|x| x.into_raw()).map_err(|e| e.to_string())
}
fn make_string(env: &mut JNIEnv<'_>, s: &str) -> Result<jstring> {
    env.new_string(s).map(|x| x.into_raw()).map_err(|e| e.to_string())
}
fn string(env: &mut JNIEnv<'_>, s: JString<'_>) -> Result<String> {
    Ok(env.get_string(&s).map_err(|e| e.to_string())?.into())
}
fn path(env: &mut JNIEnv<'_>, arr: JObjectArray<'_>) -> Result<Vec<String>> {
    let len = env.get_array_length(&arr).map_err(|e| e.to_string())?;
    if len == 0 || len > 32 { return Err("Path length must be 1..32".into()); }
    let mut result = Vec::with_capacity(len as usize);
    for i in 0..len {
        let item = env.get_object_array_element(&arr, i).map_err(|e| e.to_string())?;
        let s = string(env, JString::from(item))?;
        if s.is_empty() { return Err("Empty map key".into()); }
        result.push(s);
    }
    Ok(result)
}
fn new_identity(doc: &mut AutoCommit, actor: &[u8], author: &[u8]) -> Result<()> {
    if actor.len() != 16 { return Err("Actor ID must be 16 bytes".into()); }
    doc.set_actor(ActorId::from(actor.to_vec()));
    if !author.is_empty() { doc.set_author(Some(Author::from(author.to_vec()))); }
    Ok(())
}
fn parent(doc: &mut AutoCommit, path: &[String], create: bool) -> Result<(ObjId, String)> {
    let (leaf, ancestors) = path.split_last().ok_or("Path is empty")?;
    let mut obj = ROOT;
    for key in ancestors {
        let next = doc.get(&obj, key.as_str()).map_err(|e| e.to_string())?;
        obj = match next {
            Some((Value::Object(ObjType::Map), id)) => id,
            None if create => doc.put_object(&obj, key.as_str(), ObjType::Map).map_err(|e| e.to_string())?,
            None => return Err(format!("Missing parent map: {key}")),
            Some(_) => return Err(format!("Expected map at: {key}")),
        };
    }
    Ok((obj, leaf.clone()))
}
fn scalar_json(value: Value<'_>) -> JsonValue {
    match value {
        Value::Scalar(s) => match s.as_ref() {
            ScalarValue::Str(s) => json!(s.as_str()),
            ScalarValue::Int(i) => json!(i),
            ScalarValue::Uint(i) => json!(i),
            ScalarValue::Boolean(b) => json!(b),
            ScalarValue::Null => JsonValue::Null,
            other => json!({"kind":"otherScalar","debug":format!("{other:?}")}),
        },
        Value::Object(kind) => json!({"kind":"object","objectType":format!("{kind:?}")}),
    }
}
fn get_json(doc: &mut AutoCommit, keys: &[String]) -> Result<String> {
    let (object, leaf) = parent(doc, keys, false)?;
    let value = doc.get(&object, leaf.as_str()).map_err(|e| e.to_string())?
        .map(|(v, _)| scalar_json(v)).unwrap_or(JsonValue::Null);
    Ok(value.to_string())
}
fn conflicts_json(doc: &mut AutoCommit, keys: &[String]) -> Result<String> {
    let (object, leaf) = parent(doc, keys, false)?;
    let mut alternatives: Vec<JsonValue> = doc.get_all(&object, leaf.as_str())
        .map_err(|e| e.to_string())?.into_iter()
        .map(|(value, op_id)| {
            let op = op_id.to_string();
            let actor = op.split_once('@').map(|(_, a)| a).unwrap_or("");
            json!({"value":scalar_json(value),"opId":op,"actor":actor})
        }).collect();
    alternatives.sort_by_key(|a| a["opId"].as_str().unwrap_or("").to_owned());
    Ok(json!({"alternatives":alternatives}).to_string())
}
fn changes_json(doc: &mut AutoCommit) -> String {
    let changes: Vec<JsonValue> = doc.get_changes(&[]).iter().map(|c| json!({
        "hash":c.hash().to_string(),
        "actor":c.actor_id().to_string(),
        "author":c.author().map(|a| a.to_hex_string()),
        "deps":c.deps().iter().map(ToString::to_string).collect::<Vec<_>>(),
        "seq":c.seq(),
        "message":c.message(),
        "time":c.timestamp(),
    })).collect();
    json!({"changes": changes}).to_string()
}

#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_create(
    mut env: JNIEnv<'_>, _: JClass<'_>, actor: JByteArray<'_>, author: JByteArray<'_>
) -> jlong {
    jni(&mut env, 0, |env| {
        let actor = bytes(env, actor)?;
        let author = bytes(env, author)?;
        let mut doc = AutoCommit::new();
        new_identity(&mut doc, &actor, &author)?;
        with_registry(|r| { let id = r.id()?; r.docs.insert(id, doc); Ok(id) })
    })
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_open(
    mut env: JNIEnv<'_>, _: JClass<'_>, data: JByteArray<'_>,
    actor: JByteArray<'_>, author: JByteArray<'_>
) -> jlong {
    jni(&mut env, 0, |env| {
        let b = bytes(env, data)?;
        let actor = bytes(env, actor)?;
        let author = bytes(env, author)?;
        let mut doc = AutoCommit::load(&b).map_err(|e| format!("Load document: {e}"))?;
        new_identity(&mut doc, &actor, &author)?;
        with_registry(|r| { let id = r.id()?; r.docs.insert(id, doc); Ok(id) })
    })
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_dispose(
    mut env: JNIEnv<'_>, _: JClass<'_>, id: jlong
) {
    jni(&mut env, (), |_| with_registry(|r| {
        r.docs.remove(&id).ok_or(format!("Double free/unknown doc: {id}"))?;
        Ok(())
    }));
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_save(
    mut env: JNIEnv<'_>, _: JClass<'_>, id: jlong
) -> jbyteArray {
    jni(&mut env, ptr::null_mut(), |env| {
        let b = with_doc(id, |doc| Ok(doc.save()))?;
        make_bytes(env, &b)
    })
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_heads(
    mut env: JNIEnv<'_>, _: JClass<'_>, id: jlong
) -> jstring {
    jni(&mut env, ptr::null_mut(), |env| {
        let h = with_doc(id, |doc| Ok(json!(doc.get_heads().iter().map(ToString::to_string).collect::<Vec<_>>()).to_string()))?;
        make_string(env, &h)
    })
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_putString(
    mut env: JNIEnv<'_>, _: JClass<'_>, id: jlong, keys: JObjectArray<'_>, value: JString<'_>
) {
    jni(&mut env, (), |env| {
        let keys = path(env, keys)?;
        let value = string(env, value)?;
        with_doc(id, |doc| {let (obj, leaf)=parent(doc, &keys, true)?;
            doc.put(&obj, leaf, value).map_err(|e| e.to_string())
        })
    });
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_putInt(
    mut env: JNIEnv<'_>, _: JClass<'_>, id: jlong, keys: JObjectArray<'_>, value: jint
) {
    jni(&mut env, (), |env| {
        let keys = path(env, keys)?;
        with_doc(id, |doc| {let (obj, leaf)=parent(doc, &keys, true)?;
            doc.put(&obj, leaf, value as i64).map_err(|e| e.to_string())
        })
    });
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_putBool(
    mut env: JNIEnv<'_>, _: JClass<'_>, id: jlong, keys: JObjectArray<'_>, value: jni::sys::jboolean
) {
    jni(&mut env, (), |env| {
        let keys = path(env, keys)?;
        with_doc(id, |doc| {let (obj, leaf)=parent(doc, &keys, true)?;
            doc.put(&obj, leaf, value != 0).map_err(|e| e.to_string())
        })
    });
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_get(
    mut env: JNIEnv<'_>, _: JClass<'_>, id: jlong, keys: JObjectArray<'_>
) -> jstring {
    jni(&mut env, ptr::null_mut(), |env| {
        let keys = path(env, keys)?;
        let s=with_doc(id, |doc| get_json(doc, &keys))?;
        make_string(env, &s)
    })
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_conflicts(
    mut env: JNIEnv<'_>, _: JClass<'_>, id: jlong, keys: JObjectArray<'_>
) -> jstring {
    jni(&mut env, ptr::null_mut(), |env| {
        let keys=path(env, keys)?;
        let s=with_doc(id, |doc| conflicts_json(doc, &keys))?;
        make_string(env, &s)
    })
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_changes(
    mut env: JNIEnv<'_>, _: JClass<'_>, id: jlong
) -> jstring {
    jni(&mut env, ptr::null_mut(), |env| {
        let s=with_doc(id, |doc| Ok(changes_json(doc)))?;
        make_string(env, &s)
    })
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_exportChanges(
    mut env: JNIEnv<'_>, _: JClass<'_>, id: jlong, since: JString<'_>
) -> jbyteArray {
    jni(&mut env, ptr::null_mut(), |env| {
        let raw = string(env, since)?;
        let hashes: Vec<String> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let parsed: Vec<ChangeHash> = hashes.iter().map(|s| ChangeHash::from_str(s).map_err(|e| e.to_string())).collect::<Result<_>>()?;
        let b=with_doc(id, |doc| Ok(doc.save_after(&parsed)))?;
        make_bytes(env, &b)
    })
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_applyChanges(
    mut env: JNIEnv<'_>, _: JClass<'_>, id: jlong, data: JByteArray<'_>
) -> jint {
    jni(&mut env, 0, |env| {
        let data=bytes(env, data)?;
        with_doc(id, |doc| {
            // Failure must not leave a partially applied payload in the live document.
            let mut next=doc.clone();
            let applied=next.load_incremental(&data).map_err(|e| format!("Apply changes: {e}"))?;
            *doc=next;
            Ok(applied as jint)
        })
    })
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_newSession(
    mut env: JNIEnv<'_>, _: JClass<'_>
) -> jlong {
    jni(&mut env, 0, |_| with_registry(|r| {
        let id=r.id()?;
        r.sessions.insert(id, State::new());
        Ok(id)
    }))
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_endSession(
    mut env: JNIEnv<'_>, _: JClass<'_>, id: jlong
) {
    jni(&mut env, (), |_| with_registry(|r| {
        r.sessions.remove(&id).ok_or(format!("Double free/unknown session: {id}"))?;
        Ok(())
    }));
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_generate(
    mut env: JNIEnv<'_>, _: JClass<'_>, doc_id: jlong, session_id: jlong
) -> jbyteArray {
    jni(&mut env, ptr::null_mut(), |env| {
        let b=with_registry(|r| {
            let Registry{docs, sessions, ..}=&mut *r;
            let doc=docs.get_mut(&doc_id).ok_or(format!("Unknown doc: {doc_id}"))?;
            let state=sessions.get_mut(&session_id).ok_or(format!("Unknown session: {session_id}"))?;
            Ok(doc.sync().generate_sync_message(state).map(|m|m.encode()).unwrap_or_default())
        })?;
        make_bytes(env, &b)
    })
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_receive(
    mut env: JNIEnv<'_>, _: JClass<'_>, doc_id: jlong, session_id: jlong, message: JByteArray<'_>
) {
    jni(&mut env, (), |env| {
        let b=bytes(env, message)?;
        let message=Message::decode(&b).map_err(|e| format!("Sync message decode: {e}"))?;
        with_registry(|r| {
            let Registry{docs, sessions, ..}=&mut *r;
            let doc=docs.get_mut(&doc_id).ok_or(format!("Unknown doc: {doc_id}"))?;
            let state=sessions.get_mut(&session_id).ok_or(format!("Unknown session: {session_id}"))?;
            let mut next=doc.clone();
            let mut next_state=state.clone();
            next.sync().receive_sync_message(&mut next_state, message).map_err(|e| format!("Sync receive: {e}"))?;
            *doc=next;
            *state=next_state;
            Ok(())
        })
    });
}
#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreBridge_liveCounts(
    mut env: JNIEnv<'_>, _: JClass<'_>
) -> jstring {
    jni(&mut env, ptr::null_mut(), |env| {
        let s=with_registry(|r| Ok(json!({"documents":r.docs.len(),"sessions":r.sessions.len()}).to_string()))?;
        make_string(env, &s)
    })
}
