//! Host preflight: genuine Rust process, NOT evidence for an iOS/Android runtime.
use std::{env,fs,process};
fn main() {
    let filename = env::args().nth(1).expect("Usage: cc-subduction-host-probe <request.json> [result.json]");
    let request = fs::read_to_string(filename).expect("read native request");
    let output = cc_subduction_native::execute(&request);
    if let Some(target) = env::args().nth(2) {
        fs::write(target, &output).expect("write native result");
    }
    println!("CC_NATIVE_RESULT={output}");
    let result: serde_json::Value = serde_json::from_str(&output).unwrap();
    if result["status"] != "PASS" { process::exit(1); }
}
