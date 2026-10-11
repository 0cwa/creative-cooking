//! Current-core JNI proof, not a production Expo/native module.
use automerge::{transaction::Transactable, ActorId, AutoCommit, ReadDoc, ROOT, ScalarValue, Value};
use jni::objects::{JByteArray, JClass, JString};
use jni::sys::{jbyteArray, jint, jstring};
use jni::JNIEnv;
use serde_json::json;
use std::ptr;

type Result<T> = std::result::Result<T, String>;

fn load(bytes: &[u8]) -> Result<AutoCommit> {
    AutoCommit::load(bytes).map_err(|error| format!("Automerge load: {error}"))
}

fn interop_object(doc: &AutoCommit) -> Result<automerge::ObjId> {
    doc.get(ROOT, "interop")
        .map_err(|error| error.to_string())?
        .map(|(_, id)| id)
        .ok_or_else(|| "Missing interop map".to_owned())
}

fn update(bytes: &[u8], key: &str, value: Mutation) -> Result<Vec<u8>> {
    let mut doc = load(bytes)?;
    // Research-only identity; production needs independently generated stable IDs.
    doc.set_actor(ActorId::from(vec![0x88; 16]));
    let object = interop_object(&doc)?;
    let change = match value {
        Mutation::Text(text) => doc.put(&object, key, text),
        Mutation::Integer(value) => doc.put(&object, key, value as i64),
    };
    change.map_err(|error| format!("Automerge put: {error}"))?;
    Ok(doc.save())
}

enum Mutation {
    Text(String),
    Integer(i32),
}

fn merge(left: &[u8], right: &[u8]) -> Result<Vec<u8>> {
    let mut a = load(left)?;
    let mut b = load(right)?;
    a.merge(&mut b).map_err(|error| format!("Automerge merge: {error}"))?;
    Ok(a.save())
}

fn conflict_json(bytes: &[u8]) -> Result<String> {
    let doc = load(bytes)?;
    let object = interop_object(&doc)?;
    let mut alternatives = Vec::new();
    for (value, id) in doc.get_all(&object, "counter").map_err(|error| error.to_string())? {
        if let Value::Scalar(scalar) = value {
            if let ScalarValue::Int(value) = scalar.as_ref() {
                alternatives.push(json!({"value": value, "opId": id.to_string()}));
            }
        }
    }
    alternatives.sort_by_key(|item| item["value"].as_i64().unwrap_or(0));
    serde_json::to_string(&json!({"alternatives": alternatives})).map_err(|error| error.to_string())
}

fn get_bytes(env: &mut JNIEnv<'_>, input: JByteArray<'_>) -> Result<Vec<u8>> {
    env.convert_byte_array(input).map_err(|error| error.to_string())
}

fn make_bytes(env: &mut JNIEnv<'_>, bytes: Vec<u8>) -> Result<jbyteArray> {
    env.byte_array_from_slice(&bytes)
        .map(|value| value.into_raw())
        .map_err(|error| error.to_string())
}

fn report_error(env: &mut JNIEnv<'_>, error: String) {
    let _ = env.throw_new("java/lang/IllegalStateException", error);
}

#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreNative_setNativeModified(
    mut env: JNIEnv<'_>, _class: JClass<'_>, input: JByteArray<'_>, label: JString<'_>
) -> jbyteArray {
    let result = (|| -> Result<jbyteArray> {
        let input = get_bytes(&mut env, input)?;
        let label: String = env.get_string(&label).map_err(|error| error.to_string())?.into();
        make_bytes(&mut env, update(&input, "nativeModified", Mutation::Text(label))?)
    })();
    match result {
        Ok(bytes) => bytes,
        Err(error) => { report_error(&mut env, error); ptr::null_mut() }
    }
}

#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreNative_setCounter(
    mut env: JNIEnv<'_>, _class: JClass<'_>, input: JByteArray<'_>, value: jint
) -> jbyteArray {
    let result = (|| -> Result<jbyteArray> {
        let input = get_bytes(&mut env, input)?;
        make_bytes(&mut env, update(&input, "counter", Mutation::Integer(value))?)
    })();
    match result {
        Ok(bytes) => bytes,
        Err(error) => { report_error(&mut env, error); ptr::null_mut() }
    }
}

#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreNative_mergeDocuments(
    mut env: JNIEnv<'_>, _class: JClass<'_>, left: JByteArray<'_>, right: JByteArray<'_>
) -> jbyteArray {
    let result = (|| -> Result<jbyteArray> {
        let left = get_bytes(&mut env, left)?;
        let right = get_bytes(&mut env, right)?;
        make_bytes(&mut env, merge(&left, &right)?)
    })();
    match result {
        Ok(bytes) => bytes,
        Err(error) => { report_error(&mut env, error); ptr::null_mut() }
    }
}

#[no_mangle]
pub extern "system" fn Java_creative_cooking_automerge_spike_CurrentCoreNative_counterConflicts(
    mut env: JNIEnv<'_>, _class: JClass<'_>, input: JByteArray<'_>
) -> jstring {
    let result = (|| -> Result<jstring> {
        let input = get_bytes(&mut env, input)?;
        env.new_string(conflict_json(&input)?)
            .map(|value| value.into_raw())
            .map_err(|error| error.to_string())
    })();
    match result {
        Ok(value) => value,
        Err(error) => { report_error(&mut env, error); ptr::null_mut() }
    }
}
