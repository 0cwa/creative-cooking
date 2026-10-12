package creative.cooking.automerge.spike.expo

import android.util.Base64
import creative.cooking.automerge.spike.CurrentCoreBridge
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Research-only Expo Module: Hermes crosses a small typed native boundary.
 * Binary messages are base64 encoded at this Expo call boundary, not JSON
 * document snapshots. No network, credentials, production storage or UI.
 *
 * A production performance pass should replace base64 with an ArrayBuffer/JSI
 * backed codec after native runtime qualification.
 */
class AutomergeSpikeModule : Module() {
  private fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
  private fun decode(bytes: String): ByteArray = Base64.decode(bytes, Base64.NO_WRAP)
  private fun actor(byteValue: Int): ByteArray {
    require(byteValue in 0..255) { "Actor byte must be 0..255" }
    return CurrentCoreBridge.fixedActor(byteValue)
  }
  override fun definition() = ModuleDefinition {
    Name("CreativeCookingAutomergeSpike")

    AsyncFunction("create") { actorByte: Int, author: String ->
      CurrentCoreBridge.create(actor(actorByte), author.toByteArray(Charsets.UTF_8)).toInt()
    }
    AsyncFunction("open") { binaryBase64: String, actorByte: Int, author: String ->
      CurrentCoreBridge.open(decode(binaryBase64), actor(actorByte),
        author.toByteArray(Charsets.UTF_8)).toInt()
    }
    AsyncFunction("save") { handle: Int -> encode(CurrentCoreBridge.save(handle.toLong())) }
    AsyncFunction("dispose") { handle: Int -> CurrentCoreBridge.dispose(handle.toLong()) }
    AsyncFunction("heads") { handle: Int -> CurrentCoreBridge.heads(handle.toLong()) }
    AsyncFunction("putString") { handle: Int, path: List<String>, value: String ->
      CurrentCoreBridge.putString(handle.toLong(), path.toTypedArray(), value)
    }
    AsyncFunction("putInt") { handle: Int, path: List<String>, value: Int ->
      CurrentCoreBridge.putInt(handle.toLong(), path.toTypedArray(), value)
    }
    AsyncFunction("putBool") { handle: Int, path: List<String>, value: Boolean ->
      CurrentCoreBridge.putBool(handle.toLong(), path.toTypedArray(), value)
    }
    AsyncFunction("get") { handle: Int, path: List<String> ->
      CurrentCoreBridge.get(handle.toLong(), path.toTypedArray())
    }
    AsyncFunction("conflicts") { handle: Int, path: List<String> ->
      CurrentCoreBridge.conflicts(handle.toLong(), path.toTypedArray())
    }
    AsyncFunction("changes") { handle: Int -> CurrentCoreBridge.changes(handle.toLong()) }
    AsyncFunction("exportChanges") { handle: Int, sinceHeadsJson: String ->
      encode(CurrentCoreBridge.exportChanges(handle.toLong(), sinceHeadsJson))
    }
    AsyncFunction("applyChanges") { handle: Int, bytesBase64: String ->
      CurrentCoreBridge.applyChanges(handle.toLong(), decode(bytesBase64))
    }
    AsyncFunction("newSession") { CurrentCoreBridge.newSession().toInt() }
    AsyncFunction("endSession") { id: Int -> CurrentCoreBridge.endSession(id.toLong()) }
    AsyncFunction("generate") { handle: Int, sessionId: Int ->
      encode(CurrentCoreBridge.generate(handle.toLong(), sessionId.toLong()))
    }
    AsyncFunction("receive") { handle: Int, sessionId: Int, bytesBase64: String ->
      CurrentCoreBridge.receive(handle.toLong(), sessionId.toLong(), decode(bytesBase64))
    }
    AsyncFunction("liveCounts") { CurrentCoreBridge.liveCounts() }
  }
}
