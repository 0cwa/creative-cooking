#!/usr/bin/env python3
"""Spikeware ONLY. Patch the exact upstream netdev 0.46.3 registry source after cargo fetch.

On iOS libc has no in6_ifreq, but netdev compiles its macOS ioctl path on all
Apple targets. The minimal upstream-compatible fix uses a conservative iOS
unknown-flags fallback and preserves the existing macOS implementation.
This DOES NOT patch Creative Cooking production dependencies or make a security
or physical-iPhone runtime claim. Remove when upstream releases a fix.
"""
from pathlib import Path
import os

home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
matches = list((home / "registry" / "src").glob("*/netdev-0.46.3/src/os/darwin/ipv6_addr_flags.rs"))
if len(matches) != 1:
    raise SystemExit(f"Expected exactly one netdev 0.46.3 source after cargo fetch; got {matches}")
source = matches[0]
code = source.read_text()
signature = "pub(crate) fn get_ipv6_addr_flags(ifname: &str, addr: &Ipv6Addr) -> Ipv6AddrFlags {"
if code.count(signature) != 1 or code.count("let mut req: libc::in6_ifreq = std::mem::zeroed();") != 1:
    raise SystemExit("Unknown netdev source structure. Refuse an unreviewed patch.")
if "#[cfg(target_os = \"ios\")]" in code:
    raise SystemExit("netdev source was already patched; refuse ambiguous second patch")
ios = """#[cfg(target_os = "ios")]
pub(crate) fn get_ipv6_addr_flags(_ifname: &str, _addr: &Ipv6Addr) -> Ipv6AddrFlags {
    // iOS libc lacks in6_ifreq. Do not guess a private kernel ABI.
    Ipv6AddrFlags::default()
}

#[cfg(target_os = "macos")]
"""
source.write_text(code.replace(signature, ios + signature, 1))
print(f"EXPERIMENTAL NETDEV iOS patch: {source}; original macOS ioctl untouched")
