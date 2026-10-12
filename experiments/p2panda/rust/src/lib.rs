//! Opaque CRDT update carrier. Does not parse or merge cooking state.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplicatedFrame {
    pub document_id: String,
    pub bytes: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use p2panda::network::MdnsDiscoveryMode;
    use p2panda::streams::StreamEvent;
    use std::time::Duration;

    #[tokio::test]
    async fn local_publish_preserves_bytes_inside_p2panda_operations() {
        let node = p2panda::builder().mdns_mode(MdnsDiscoveryMode::Disabled)
            .spawn().await.unwrap();
        let (tx, mut rx) = node.stream::<ReplicatedFrame>(p2panda::Topic::random())
            .await.unwrap();
        let frame = ReplicatedFrame {
            document_id: "opaque/random/1".into(),
            bytes: (0..16384).map(|i| ((i * 73) % 256) as u8).collect(),
        };
        tx.publish(frame.clone()).await.unwrap();
        let found = tokio::time::timeout(Duration::from_secs(12), async {
            loop {
                match rx.next().await {
                    Some(StreamEvent::Processed { operation, .. }) => break operation.message().clone(),
                    Some(StreamEvent::ProcessingFailed { error, .. }) => panic!("processing: {error:?}"),
                    Some(StreamEvent::DecodeFailed { error, .. }) => panic!("decode: {error:?}"),
                    Some(_) => continue,
                    None => panic!("topic stream ended"),
                }
            }
        }).await.expect("local event timed out");
        assert_eq!(found, frame);
    }
}


/// Real p2panda Node local publish/receive probe exported via stable C ABI.
/// Linking the native library is NOT proof of an Expo/JNI/Swift device runtime.
/// Call only in an experiment; 0 means one real signed operation round-tripped.
#[unsafe(no_mangle)]
pub extern "C" fn cc_p2panda_self_probe() -> i32 {
    use futures_util::StreamExt;
    use p2panda::network::MdnsDiscoveryMode;
    use p2panda::streams::StreamEvent;
    use std::time::Duration;
    std::panic::catch_unwind(|| {
        let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build()
            else { return 10 };
        rt.block_on(async {
            let Ok(node) = p2panda::builder().mdns_mode(MdnsDiscoveryMode::Disabled)
                .spawn().await else { return 20 };
            let Ok((tx, mut rx)) = node.stream::<ReplicatedFrame>(p2panda::Topic::random())
                .await else { return 21 };
            let expected = ReplicatedFrame {
                document_id: "ffi/native-probe".into(),
                bytes: vec![0u8, 255, 7, 129, 0, 42],
            };
            if tx.publish(expected.clone()).await.is_err() { return 22; }
            let result = tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    match rx.next().await {
                        Some(StreamEvent::Processed { operation, .. }) =>
                            return if operation.message() == &expected { 0 } else { 24 },
                        Some(StreamEvent::ProcessingFailed { .. } |
                             StreamEvent::DecodeFailed { .. }) => return 25,
                        Some(_) => continue,
                        None => return 26,
                    }
                }
            }).await;
            result.unwrap_or(27)
        })
    }).unwrap_or(99)
}

/// JNI symbol without requiring a whole Expo app to build to link an .so.
/// Android System.loadLibrary must name creative_cooking_p2panda_spike.
#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_org_creativecooking_spike_P2pandaProbe_nativeProbe(
    _env: *mut core::ffi::c_void,
    _class: *mut core::ffi::c_void,
) -> i32 {
    cc_p2panda_self_probe()
}
