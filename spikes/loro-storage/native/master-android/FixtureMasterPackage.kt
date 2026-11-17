package dev.creativecooking.loro.storagefixture

import android.util.Base64
import android.content.ContentValues
import android.provider.MediaStore
import android.os.Environment
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

// Fixture candidate: the master never leaves AndroidKeyStore. The file lock serializes
// get-or-create across processes; a missing key after catalog completion must fail closed.
class FixtureMaster(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
 override fun getName() = "FixtureMaster"
 private fun alias(id: String): String {
  require(id.isNotEmpty() && id.length <= 256)
  return "cc.fixture.master." + MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
 }
 private fun <T> locked(block: () -> T): T = synchronized(FixtureMaster::class.java) {
  RandomAccessFile(context.filesDir.resolve("fixture-master.lock"), "rw").use { f -> f.channel.lock().use { block() } }
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
class FixtureMasterPackage : ReactPackage {
 override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> = listOf(FixtureMaster(reactContext), ProofKeyInvalidator(reactContext))
 override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

// Test-only: invalidate exactly the fixture workspace key, never production aliases.
class ProofKeyInvalidator(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
 override fun getName() = "ProofKeyInvalidator"
 @ReactMethod fun publishFixture(data: String, promise: Promise) { try {
  val bytes=Base64.decode(data,Base64.NO_WRAP);require(bytes.size in 1..3300000)
  val values=ContentValues().apply {put(MediaStore.Downloads.DISPLAY_NAME,"cc-picker-fixture.json");put(MediaStore.Downloads.MIME_TYPE,"application/json");put(MediaStore.Downloads.RELATIVE_PATH,Environment.DIRECTORY_DOWNLOADS)}
  val uri=context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI,values) ?: error("cannot create fixture")
  try {context.contentResolver.openOutputStream(uri)?.use{it.write(bytes)} ?: error("cannot write fixture")} catch (e:Exception) {context.contentResolver.delete(uri,null,null);throw e}
  promise.resolve(null)
 } catch(e:Exception) {promise.reject("FIXTURE_FAILED","Could not create picker fixture")}}
 @ReactMethod fun invalidate(promise: Promise) { try {
  val id="[\"creative-cooking/master/v1\",\"proof-missing-master\",\"workspace-master\"]"
  val digest=MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
  val store=KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
  store.deleteEntry("creative-cooking.loro.master.v1."+digest);promise.resolve(null)
 } catch (e: Exception) {promise.reject("INVALIDATION_FAILED", "Fixture key invalidation failed")}}
}
