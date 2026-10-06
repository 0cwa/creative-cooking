import Foundation
import XCTest
@testable import AutomergeBridgeProbe

final class BackendTests: XCTestCase {
    func testConflictPersistenceAndSyncInNativeRuntime() throws {
        let base = SwiftAutomergeBackend()
        try base.putRootString(key: "title", value: "Tomato toast")

        let phone = base.fork()
        let laptop = base.fork()
        try phone.putRootInt(key: "portions", value: 4)
        try laptop.putRootInt(key: "portions", value: 6)
        try phone.merge(laptop)

        XCTAssertEqual(Set(try phone.rootConflicts(key: "portions")), Set([.int(4), .int(6)]))

        let reloaded = try SwiftAutomergeBackend(data: phone.save())
        XCTAssertEqual(Set(try reloaded.rootConflicts(key: "portions")), Set([.int(4), .int(6)]))

        let phoneSession = phone.createSyncSession()
        let laptopSession = laptop.createSyncSession()
        for _ in 0..<8 {
            if let message = phone.generateSyncMessage(session: phoneSession) {
                try laptop.receiveSyncMessage(session: laptopSession, message: message)
            }
            if let message = laptop.generateSyncMessage(session: laptopSession) {
                try phone.receiveSyncMessage(session: phoneSession, message: message)
            }
        }

        XCTAssertEqual(Set(try phone.rootConflicts(key: "portions")), Set(try laptop.rootConflicts(key: "portions")))
    }
}
