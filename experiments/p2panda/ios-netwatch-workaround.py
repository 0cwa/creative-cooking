#!/usr/bin/env python3
"""Experimental iOS compilation workaround for the pinned netwatch 0.19.3.

netwatch's BSD route-socket implementation currently compiles macOS-only
libc RTM_*/RTAX_* routing constants for iOS. On iOS, reuse its EXISTING
minimal no-OS-route-watcher implementation, but retain actual netdev-based
IP interface enumeration. This means no automatic OS route notifications,
no default-gateway lookup, and no background-change promise. Do not ship
or claim iOS network runtime feasibility from a successful link alone.

The smallest upstream-compatible fix is platform separation in netwatch
(or a real iOS Network.framework listener), not pinning private ioctl
constants. This script mutates Cargo registry files ONLY in isolated CI.
"""
from pathlib import Path
import os

home = Path(os.environ.get("CARGO_HOME", str(Path.home() / ".cargo")))
paths = list((home / "registry" / "src").glob("*/netwatch-0.19.3"))
if len(paths) != 1:
    raise SystemExit(f"Expected exactly one fetched netwatch 0.19.3: {paths}")
root = paths[0]

edits = {
    "build.rs": [
        ('posix_minimal: { target_os = "espidf" },',
         'posix_minimal: { any(target_os = "espidf", target_os = "ios") },'),
        ('bsd: { any(target_os = "freebsd", target_os = "openbsd", target_os = "netbsd", target_os = "macos", target_os = "ios") },',
         'bsd: { any(target_os = "freebsd", target_os = "openbsd", target_os = "netbsd", target_os = "macos") },'),
    ],
    "src/interfaces/posix_minimal.rs": [
        ("pub(super) async fn get_state() -> State {",
         '''// iOS can enumerate real IP interfaces with netdev, but the missing
// libc routing-socket constants prevent using the macOS default-route path.
#[cfg(target_os = "ios")]
pub(super) async fn get_state() -> State {
    super::netdev_impl::get_state().await
}

// ESP-IDF has neither netdev nor a route monitor.
#[cfg(not(target_os = "ios"))]
pub(super) async fn get_state() -> State {'''),
    ],
}
for filename, changes in edits.items():
    target = root / filename
    contents = target.read_text()
    for old, new in changes:
        if contents.count(old) != 1 or new in contents:
            raise SystemExit(f"Refusing unexpected/reapplied netwatch patch in {filename}: {old}")
        contents = contents.replace(old, new, 1)
    target.write_text(contents)
    print(f"EXPERIMENTAL netwatch iOS cfg fallback: {target}")

print("WARNING: iOS netwatch has no OS route monitoring/default gateway. "
      "Native link does not establish network/runtime functionality.")
