//! Interactive two-process p2panda test. Direct LAN paths must be separately
//! verified with packet captures; a delivered frame does NOT establish locality.
use creative_cooking_p2panda_spike::ReplicatedFrame;
use futures_util::StreamExt;
use p2panda::network::MdnsDiscoveryMode;
use p2panda::streams::StreamEvent;
use p2panda::{RelayUrl, SigningKey, Topic};
use std::io::BufRead;
use std::str::FromStr;
use tokio::sync::mpsc;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn parse_seed(hex: &str) -> Result<SigningKey> {
    if hex.len() != 64 { return Err("seed must be 64 hex digits".into()); }
    let mut bytes = [0u8; 32];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)?;
    }
    Ok(SigningKey::from_bytes(&bytes))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("Usage: peer <topic-hex|new> <sqlite-path> <64-hex-device-seed> [relay-url] [bootstrap-node-id]");
        eprintln!("Debug seeds are sensitive; do not reuse published test seeds.");
        std::process::exit(2);
    }
    let topic = if args[1] == "new" { Topic::random() } else { Topic::from_str(&args[1])? };
    let mut builder = p2panda::builder()
        .signing_key(parse_seed(&args[3])?)
        .database_url(&args[2])
        .mdns_mode(MdnsDiscoveryMode::Active);
    if args.len() >= 5 {
        let relay: RelayUrl = args[4].parse()?;
        if args.len() >= 6 { builder = builder.bootstrap(args[5].parse()?, relay.clone()); }
        builder = builder.relay_url(relay);
    }
    let node = builder.spawn().await?;
    println!("topic={} node={} db={}", topic, node.id(), args[2]);
    println!("Write lines to publish fixture bytes; Ctrl+C exits.");
    let (tx, mut rx) = node.stream::<ReplicatedFrame>(topic).await?;
    let (input_tx, mut input_rx) = mpsc::channel::<String>(8);
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            if let Ok(line) = line {
                if input_tx.blocking_send(line).is_err() { break; }
            }
        }
    });
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            Some(line) = input_rx.recv() => {
                tx.publish(ReplicatedFrame {
                    document_id: "test/native-peer".into(),
                    bytes: line.into_bytes()
                }).await?;
            }
            event = rx.next() => match event {
                Some(StreamEvent::Processed { operation, .. }) => println!(
                    "received from={} doc={} bytes={:?}", operation.author(),
                    operation.message().document_id, operation.message().bytes
                ),
                Some(StreamEvent::SyncStarted { remote_node_id, incoming_bytes, .. }) =>
                    println!("sync_started node={} incoming_bytes={}", remote_node_id, incoming_bytes),
                Some(StreamEvent::SyncEnded { remote_node_id, error, .. }) =>
                    println!("sync_ended node={} error={:?}", remote_node_id, error),
                Some(StreamEvent::ProcessingFailed { error, .. }) => eprintln!("processing_failed={error:?}"),
                Some(StreamEvent::DecodeFailed { error, .. }) => eprintln!("decode_failed={error:?}"),
                Some(_) => {}
                None => break
            }
        }
    }
    drop(node);
    Ok(())
}
