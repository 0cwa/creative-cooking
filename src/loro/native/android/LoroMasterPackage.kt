package expo.modules.creativecookingloro

import android.util.Base64
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.KeyInfo
import android.os.Build
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.uimanager.ViewManager
import java.io.RandomAccessFile
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

// Candidate: the master never leaves AndroidKeyStore. The file lock serializes
// get-or-create across processes; a missing key after catalog completion must fail closed.
class LoroMaster(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
 override fun getName() = "LoroMaster"
 private fun alias(id: String): String {
  require(id.isNotEmpty() && id.length <= 256)
  return "creative-cooking.loro.master.v1." + MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
 }
 private fun <T> locked(block: () -> T): T = synchronized(LoroMaster::class.java) {
  RandomAccessFile(context.filesDir.resolve("creative-cooking-loro-master.lock"), "rw").use { f -> f.channel.lock().use { block() } }
 }
 private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
 private fun key(s: KeyStore, id: String): SecretKey = (s.getKey(alias(id), null) as? SecretKey) ?: error("LOCKED")
 private fun decode(value: String) = Base64.decode(value, Base64.NO_WRAP)
 private fun encode(value: ByteArray) = Base64.encodeToString(value, Base64.NO_WRAP)
 private fun result(promise: Promise, body: () -> Any?) { try { promise.resolve(body()) } catch (_: Exception) { promise.reject("LOCKED", "Master operation failed") } }
 private fun ensureKey(id: String, mustBeNew: Boolean) {
  val s=store(); val a=alias(id)
  if (mustBeNew && s.containsAlias(a)) error("LOCKED")
  if (!s.containsAlias(a)) {
   val generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore")
   generator.init(KeyGenParameterSpec.Builder(a,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
    .setKeySize(256).setRandomizedEncryptionRequired(true).build())
   generator.generateKey()
  }
  key(s,id)
 }
 @ReactMethod fun exists(id: String, promise: Promise) = result(promise) { locked { store().containsAlias(alias(id)) } }
 @ReactMethod fun ensure(id: String, promise: Promise) = result(promise) { locked { ensureKey(id,false); null } }
 @ReactMethod fun provision(id: String, promise: Promise) = result(promise) { locked { ensureKey(id,true); null } }
 @ReactMethod fun describe(id: String, promise: Promise) = result(promise) { locked {
  val k=key(store(),id);val info=SecretKeyFactory.getInstance(k.algorithm,"AndroidKeyStore").getKeySpec(k,KeyInfo::class.java) as KeyInfo
  Arguments.createMap().apply {putBoolean("encodedNull",k.encoded==null);putInt("keySize",info.keySize);putBoolean("insideSecureHardware",info.isInsideSecureHardware);if(Build.VERSION.SDK_INT>=31)putInt("securityLevel",info.securityLevel)}
 } }
 @ReactMethod fun wrap(id: String, plain: String, aad: String, promise: Promise) = result(promise) { locked {
  val c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE,key(store(),id));c.updateAAD(decode(aad))
  require(c.iv.size==12);val input=decode(plain);try {encode(c.iv + c.doFinal(input))} finally {input.fill(0)}
 } }
 @ReactMethod fun unwrap(id: String, wrapped: String, aad: String, promise: Promise) = result(promise) { locked {
  val input=decode(wrapped);require(input.size>=28)
  val c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(store(),id),GCMParameterSpec(128,input.copyOfRange(0,12)));c.updateAAD(decode(aad))
  val plain=c.doFinal(input,12,input.size-12);try {encode(plain)} finally {plain.fill(0)}
 } }
}
class LoroMasterPackage : ReactPackage {
 override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> = listOf(LoroMaster(reactContext))
 override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
