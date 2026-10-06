import Automerge
import Foundation

public enum BridgeScalar: Equatable, Hashable, Sendable {
    case string(String)
    case int(Int64)
    case bool(Bool)
    case null
    case unsupported(String)
}

public final class SwiftAutomergeBackend: @unchecked Sendable {
    public let document: Document

    public init() {
        self.document = Document()
    }

    public init(data: Data) throws {
        self.document = try Document(data)
    }

    public init(document: Document) {
        self.document = document
    }

    public func fork() -> SwiftAutomergeBackend {
        SwiftAutomergeBackend(document: document.fork())
    }

    public func save() -> Data {
        document.save()
    }

    public func heads() -> [String] {
        document.heads().map { String(describing: $0) }.sorted()
    }

    public func putRootString(key: String, value: String) throws {
        try document.put(obj: .ROOT, key: key, value: .String(value))
    }

    public func putRootInt(key: String, value: Int64) throws {
        try document.put(obj: .ROOT, key: key, value: .Int(value))
    }

    public func readRoot(key: String) throws -> BridgeScalar? {
        guard let value = try document.get(obj: .ROOT, key: key) else { return nil }
        return Self.scalar(value)
    }

    public func rootConflicts(key: String) throws -> [BridgeScalar] {
        try document.getAll(obj: .ROOT, key: key)
            .map(Self.scalar)
            .sorted { String(describing: $0) < String(describing: $1) }
    }

    public func merge(_ other: SwiftAutomergeBackend) throws {
        try document.merge(other: other.document)
    }

    public func generateSyncMessage(encodedState: Data?) throws -> (state: Data, message: Data?) {
        let state = try encodedState.map { try SyncState(bytes: $0) } ?? SyncState()
        let message = document.generateSyncMessage(state: state)
        return (state.encode(), message)
    }

    public func receiveSyncMessage(encodedState: Data?, message: Data) throws -> Data {
        let state = try encodedState.map { try SyncState(bytes: $0) } ?? SyncState()
        try document.receiveSyncMessage(state: state, message: message)
        return state.encode()
    }

    private static func scalar(_ value: Value) -> BridgeScalar {
        switch value {
        case let .Scalar(.String(value)):
            return .string(value)
        case let .Scalar(.Int(value)):
            return .int(value)
        case let .Scalar(.Boolean(value)):
            return .bool(value)
        case .Scalar(.Null):
            return .null
        default:
            return .unsupported(String(describing: value))
        }
    }
}
