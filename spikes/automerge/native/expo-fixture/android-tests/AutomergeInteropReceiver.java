package creative.cooking.automerge.spike.expo;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Base64;
import creative.cooking.automerge.spike.CurrentCoreBridge;

/**
 * EXPORTED ONLY IN GENERATED, THROWAWAY EXPO SPIKE FIXTURE.
 * Allows adb to exchange opaque *binary* Automerge frames with actual ART JNI.
 * Never bundle this test receiver in a production application.
 */
public final class AutomergeInteropReceiver extends BroadcastReceiver {
  private static final Object LOCK = new Object();
  private static long document = 0;
  private static long session = 0;
  private static byte[] decode(String s) { return Base64.decode(s, Base64.NO_WRAP); }
  private static String encode(byte[] b) { return Base64.encodeToString(b, Base64.NO_WRAP); }
  private static String required(Intent i, String name) {
    String v = i.getStringExtra(name);
    if (v == null) throw new IllegalArgumentException("Missing " + name);
    return v;
  }
  private static long doc() {
    if(document == 0) throw new IllegalStateException("No open test document");
    return document;
  }
  private static long state() {
    if(session == 0) throw new IllegalStateException("No open test SyncState");
    return session;
  }
  private static void cleanup() {
    if(session != 0) { CurrentCoreBridge.endSession(session); session=0; }
    if(document != 0) { CurrentCoreBridge.dispose(document); document=0; }
  }
  private static String[] key(Intent i) {
    return required(i,"path").split("/", -1);
  }
  private static String dispatch(Intent intent) throws Exception {
    String cmd = required(intent,"cmd");
    switch (cmd) {
      case "open":
        cleanup();
        document=CurrentCoreBridge.open(decode(required(intent,"data")),
            CurrentCoreBridge.fixedActor(203),
            "android-broadcast".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        session=CurrentCoreBridge.newSession();
        return "OPEN";
      case "save": return encode(CurrentCoreBridge.save(doc()));
      case "heads": return encode(CurrentCoreBridge.heads(doc()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
      case "get": return encode(CurrentCoreBridge.get(doc(),key(intent)).getBytes(java.nio.charset.StandardCharsets.UTF_8));
      case "conflicts": return encode(CurrentCoreBridge.conflicts(doc(),key(intent)).getBytes(java.nio.charset.StandardCharsets.UTF_8));
      case "changes": return encode(CurrentCoreBridge.changes(doc()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
      case "putInt":
        CurrentCoreBridge.putInt(doc(), key(intent), intent.getIntExtra("number",0));
        return "UPDATED";
      case "putString":
        CurrentCoreBridge.putString(doc(),key(intent),
            new String(decode(required(intent,"data")),java.nio.charset.StandardCharsets.UTF_8));
        return "UPDATED";
      case "receive":
        CurrentCoreBridge.receive(doc(),state(),decode(required(intent,"data")));
        return "RECEIVED";
      case "generate": return encode(CurrentCoreBridge.generate(doc(),state()));
      case "resetSession":
        if(session != 0) CurrentCoreBridge.endSession(session);
        session=CurrentCoreBridge.newSession();
        return "RESET";
      case "restart":
        byte[] persisted=CurrentCoreBridge.save(doc());
        cleanup();
        document=CurrentCoreBridge.open(persisted, CurrentCoreBridge.fixedActor(203),
            "android-broadcast".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        session=CurrentCoreBridge.newSession();
        return "RESTARTED";
      case "dispose":
        cleanup();
        return "CLOSED";
      case "counts": return encode(CurrentCoreBridge.liveCounts().getBytes(java.nio.charset.StandardCharsets.UTF_8));
      default: throw new IllegalArgumentException("Unknown command: " + cmd);
    }
  }
  @Override public void onReceive(Context context, Intent intent) {
    synchronized (LOCK) {
      try {
        setResultData(dispatch(intent));
        setResultCode(0);
      } catch (Throwable error) {
        setResultCode(1);
        setResultData("ERROR_" + encode(String.valueOf(error).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
      }
    }
  }
}
