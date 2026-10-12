package expo.modules.subductionnative

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.io.File
import kotlin.concurrent.thread

class CcSubductionModule : Module() {
  private external fun runNative(json: String): String

  init {
    System.loadLibrary("cc_subduction_native")
  }

  override fun definition() = ModuleDefinition {
    Name("CcSubductionModule")
    AsyncFunction("runRequest") { promise: Promise ->
      thread(name = "cc-subduction-native-spike") {
        try {
          val context = appContext.reactContext
            ?: throw IllegalStateException("missing Android React context")
          val input = File(context.filesDir, "subduction-request.json")
          val output = File(context.filesDir, "subduction-result.json")
          val result = runNative(input.readText())
          output.writeText(result)
          promise.resolve(result)
        } catch (error: Exception) {
          promise.reject("CC_NATIVE_FAILURE", error.message ?: "native failure", error)
        }
      }
    }
  }
}
