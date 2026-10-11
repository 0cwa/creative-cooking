package creative.cooking.automerge.spike;

import java.util.Objects;

/**
 * Research-only native Automerge handle facade. Returned byte[] are owned by Java.
 * Handles are opaque monotonically increasing IDs, never raw pointers; dispose
 * documents and close SyncState sessions explicitly. Errors are Java exceptions.
 */
public final class CurrentCoreBridge {
  static {
    String path = System.getProperty("automerge.jni.path");
    if (path != null && !path.isEmpty()) {
      System.load(path);
    } else {
      System.loadLibrary("creative_cooking_automerge_jni");
    }
  }

  private CurrentCoreBridge() {}
  public static native long create(byte[] actorId, byte[] authorId);
  public static native long open(byte[] document, byte[] actorId, byte[] authorId);
  public static native void dispose(long document);
  public static native byte[] save(long document);
  public static native String heads(long document);
  public static native void putString(long document, String[] path, String value);
  public static native void putInt(long document, String[] path, int value);
  public static native void putBool(long document, String[] path, boolean value);
  /** JSON scalar value or null; not a whole-document snapshot. */
  public static native String get(long document, String[] path);
  /** JSON with op IDs and all concurrently visible alternatives. */
  public static native String conflicts(long document, String[] path);
  /** Change hashes, actors, author IDs, dependencies, messages and time. */
  public static native String changes(long document);
  /** Automerge incremental binary since the supplied heads JSON string. */
  public static native byte[] exportChanges(long document, String sinceHeadsJson);
  public static native int applyChanges(long document, byte[] binary);
  public static native long newSession();
  public static native void endSession(long session);
  /** Actual Automerge SyncState message; zero-length means no message. */
  public static native byte[] generate(long document, long session);
  public static native void receive(long document, long session, byte[] message);
  /** JSON live handle counts for lifecycle qualification. */
  public static native String liveCounts();

  public static byte[] fixedActor(int fill) {
    byte[] bytes = new byte[16];
    java.util.Arrays.fill(bytes, (byte) fill);
    return bytes;
  }
}
