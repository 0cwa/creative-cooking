package expo.modules.subductionnative

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.io.File
import android.util.Base64
import android.util.Log
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
          // The optional test-only Intent carries a disposable fixture to a release APK.
          // Rust, not Kotlin or React Native, implements the Subduction wire protocol.
          val encodedInput = context.currentActivity?.intent?.getStringExtra("ccSubductionRequestB64")
          val request = if (encodedInput != null) {
            String(Base64.decode(encodedInput, Base64.NO_WRAP), Charsets.UTF_8)
          } else input.readText()
          val result = runNative(request)
          output.writeText(result)
          // Chunked base64 logcat is test-only runtime evidence, never for user data.
          val encoded = Base64.encodeToString(result.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
          val pieces = encoded.chunked(900)
          pieces.forEachIndexed { index, part ->
            Log.i("CCSubductionNative", "CC_NATIVE_RESULT_V1:" + (index + 1) +
              "/" + pieces.size + ":" + part)
          }
          promise.resolve(result)
        } catch (error: Exception) {
          promise.reject("CC_NATIVE_FAILURE", error.message ?: "native failure", error)
        }
      }
    }
  }
}
