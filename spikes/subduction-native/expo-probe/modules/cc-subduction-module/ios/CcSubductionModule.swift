import ExpoModulesCore
import Foundation

// Symbols provided by the experiment's Rust staticlib, NOT reimplemented in Swift.
@_silgen_name("cc_subduction_run")
private func cc_subduction_run(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
@_silgen_name("cc_subduction_free")
private func cc_subduction_free(_ output: UnsafeMutablePointer<CChar>)

public class CcSubductionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CcSubductionModule")
    AsyncFunction("runRequest") { (promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let requestFile = documents.appendingPathComponent("subduction-request.json")
        let resultFile = documents.appendingPathComponent("subduction-result.json")
        do {
          let request = try String(contentsOf: requestFile, encoding: .utf8)
          guard let bytes = request.withCString({ cc_subduction_run($0) }) else {
            throw NSError(domain: "CcSubductionModule", code: 1,
              userInfo: [NSLocalizedDescriptionKey: "Rust returned a null pointer"])
          }
          let result = String(cString: bytes)
          cc_subduction_free(bytes)
          try result.write(to: resultFile, atomically: true, encoding: .utf8)
          promise.resolve(result)
        } catch {
          // Always output useful native-process evidence on failure.
          let failure = "{\"status\":\"FAIL\",\"runtime\":\"ios-expo-ffi\",\"error\":\"native request or bridge failure\"}"
          try? failure.write(to: resultFile, atomically: true, encoding: .utf8)
          promise.reject("CC_NATIVE_FAILURE", error.localizedDescription)
        }
      }
    }
  }
}
