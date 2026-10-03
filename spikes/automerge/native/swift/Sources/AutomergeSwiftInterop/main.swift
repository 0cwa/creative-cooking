import Automerge
import AutomergeBridgeProbe
import Foundation

enum InteropError: Error, CustomStringConvertible {
    case usage
    case missing(String)
    case unexpected(String)

    var description: String {
        switch self {
        case .usage: return "usage: AutomergeSwiftInterop mutate|fork-edit|sync-generate|sync-receive|verify-authored ..."
        case let .missing(value): return "missing \(value)"
        case let .unexpected(value): return "unexpected \(value)"
        }
    }
}

func fileData(_ path: String) throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: path))
}

func write(_ data: Data, _ path: String) throws {
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url)
}

func load(_ path: String) throws -> Document {
    try Document(fileData(path))
}

func loadWritable(_ path: String) throws -> Document {
    try Document(fileData(path)).fork()
}

func map(_ doc: Document, parent: ObjId, key: String) throws -> ObjId {
    guard let value = try doc.get(obj: parent, key: key) else {
        throw InteropError.missing(key)
    }
    guard case let .Object(id, type) = value, type == .Map else {
        throw InteropError.unexpected("\(key)=\(value)")
    }
    return id
}

func bool(_ doc: Document, object: ObjId, key: String) throws -> Bool {
    guard let value = try doc.get(obj: object, key: key) else {
        throw InteropError.missing(key)
    }
    guard case let .Scalar(.Boolean(result)) = value else {
        throw InteropError.unexpected("\(key)=\(value)")
    }
    return result
}

func state(_ path: String) throws -> SyncState {
    if FileManager.default.fileExists(atPath: path) {
        let data = try fileData(path)
        if !data.isEmpty { return try SyncState(bytes: data) }
    }
    return SyncState()
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { throw InteropError.usage }

switch command {
case "mutate":
    guard args.count == 4 else { throw InteropError.usage }
    let doc = try loadWritable(args[1])
    let interop = try map(doc, parent: .ROOT, key: "interop")
    try doc.put(obj: interop, key: "nativeModified", value: .String(args[3]))
    try write(doc.save(), args[2])
    print(#"{"command":"mutate","native":"swift-0.7.2"}"#)

case "fork-edit":
    guard args.count == 3 else { throw InteropError.usage }
    let doc = try loadWritable(args[1])
    let interop = try map(doc, parent: .ROOT, key: "interop")
    try doc.put(obj: interop, key: "nativeConcurrent", value: .String("native-edit-survived"))
    try write(doc.save(), args[2])
    print(#"{"command":"fork-edit","native":"swift-0.7.2"}"#)

case "sync-generate":
    guard args.count == 4 else { throw InteropError.usage }
    let doc = try load(args[1])
    let sync = try state(args[2])
    let message = doc.generateSyncMessage(state: sync)
    try write(sync.encode(), args[2])
    try write(message ?? Data(), args[3])
    print(#"{"command":"sync-generate","native":"swift-0.7.2","messageBytes":\#(message?.count ?? 0)}"#)

case "sync-receive":
    guard args.count == 4 else { throw InteropError.usage }
    let doc = try load(args[1])
    let sync = try state(args[2])
    let message = try fileData(args[3])
    if !message.isEmpty {
        try doc.receiveSyncMessage(state: sync, message: message)
    }
    try write(doc.save(), args[1])
    try write(sync.encode(), args[2])
    print(#"{"command":"sync-receive","native":"swift-0.7.2","messageBytes":\#(message.count)}"#)

case "verify-authored":
    guard args.count == 2 else { throw InteropError.usage }
    let doc = try load(args[1])
    let interop = try map(doc, parent: .ROOT, key: "interop")
    guard try bool(doc, object: interop, key: "webCreated") else {
        throw InteropError.unexpected("webCreated=false")
    }
    print(#"{"command":"verify-authored","native":"swift-0.7.2","loaded":true}"#)

case "backend-smoke":
    let left = SwiftAutomergeBackend()
    try left.putRootString(key: "title", value: "phone")
    let right = left.fork()
    try left.putRootInt(key: "portions", value: 4)
    try right.putRootInt(key: "portions", value: 6)
    try left.merge(right)
    let conflicts = try left.rootConflicts(key: "portions")
    guard Set(conflicts) == Set([.int(4), .int(6)]) else {
        throw InteropError.unexpected("conflicts=\(conflicts)")
    }
    let saved = left.save()
    let reloaded = try SwiftAutomergeBackend(data: saved)
    guard try reloaded.rootConflicts(key: "portions").count == 2 else {
        throw InteropError.unexpected("conflicts did not survive reload")
    }
    print(#"{"command":"backend-smoke","native":"swift-0.7.2","conflicts":2,"savedBytes":\#(saved.count)}"#)

default:
    throw InteropError.usage
}
