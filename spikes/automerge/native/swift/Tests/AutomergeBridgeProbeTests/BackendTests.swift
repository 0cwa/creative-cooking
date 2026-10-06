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

        var phoneState: Data?
        var laptopState: Data?
        for _ in 0..<8 {
            let fromPhone = try phone.generateSyncMessage(encodedState: phoneState)
            phoneState = fromPhone.state
            if let message = fromPhone.message {
                laptopState = try laptop.receiveSyncMessage(encodedState: laptopState, message: message)
            }
            let fromLaptop = try laptop.generateSyncMessage(encodedState: laptopState)
            laptopState = fromLaptop.state
            if let message = fromLaptop.message {
                phoneState = try phone.receiveSyncMessage(encodedState: phoneState, message: message)
            }
        }

        XCTAssertEqual(Set(try phone.rootConflicts(key: "portions")), Set(try laptop.rootConflicts(key: "portions")))
    }
}
