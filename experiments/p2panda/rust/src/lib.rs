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
