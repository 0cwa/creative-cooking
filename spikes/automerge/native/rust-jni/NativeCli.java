package creative.cooking.automerge.spike;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/** Persistent JVM peer used by the real Web JS <-> Rust/JNI protocol fixture. */
public final class NativeCli {
  private static final Base64.Decoder D = Base64.getDecoder();
  private static final Base64.Encoder E = Base64.getEncoder();

  private static byte[] b(String value) { return D.decode(value); }
  private static String b64(byte[] value) { return E.encodeToString(value); }
  private static long id(String s) { return Long.parseLong(s); }
  private static String[] path(String s) { return s.split("/", -1); }
  private static byte[] actor(String s) { return CurrentCoreBridge.fixedActor(Integer.parseInt(s)); }
  private static String string(String s) { return new String(b(s), StandardCharsets.UTF_8); }

  private static String dispatch(String[] a) {
    return switch (a[0]) {
      case "create" -> String.valueOf(CurrentCoreBridge.create(actor(a[1]), a[2].getBytes(StandardCharsets.UTF_8)));
      case "open" -> String.valueOf(CurrentCoreBridge.open(b(a[1]), actor(a[2]), a[3].getBytes(StandardCharsets.UTF_8)));
      case "dispose" -> { CurrentCoreBridge.dispose(id(a[1])); yield ""; }
      case "save" -> b64(CurrentCoreBridge.save(id(a[1])));
      case "heads" -> CurrentCoreBridge.heads(id(a[1]));
      case "putString" -> { CurrentCoreBridge.putString(id(a[1]), path(a[2]), string(a[3])); yield ""; }
      case "putInt" -> { CurrentCoreBridge.putInt(id(a[1]), path(a[2]), Integer.parseInt(a[3])); yield ""; }
      case "putBool" -> { CurrentCoreBridge.putBool(id(a[1]), path(a[2]), Boolean.parseBoolean(a[3])); yield ""; }
      case "get" -> CurrentCoreBridge.get(id(a[1]), path(a[2]));
      case "conflicts" -> CurrentCoreBridge.conflicts(id(a[1]), path(a[2]));
      case "changes" -> CurrentCoreBridge.changes(id(a[1]));
      case "export" -> b64(CurrentCoreBridge.exportChanges(id(a[1]), a[2]));
      case "apply" -> String.valueOf(CurrentCoreBridge.applyChanges(id(a[1]), b(a[2])));
      case "newSession" -> String.valueOf(CurrentCoreBridge.newSession());
      case "endSession" -> { CurrentCoreBridge.endSession(id(a[1])); yield ""; }
      case "generate" -> b64(CurrentCoreBridge.generate(id(a[1]), id(a[2])));
      case "receive" -> { CurrentCoreBridge.receive(id(a[1]), id(a[2]), b(a[3])); yield ""; }
      case "counts" -> CurrentCoreBridge.liveCounts();
      default -> throw new IllegalArgumentException("Unknown native CLI command: " + a[0]);
    };
  }
  public static void main(String[] args) throws Exception {
    // UTF-8 command/response framing only. Document/update/SyncState payloads
    // are actual Automerge binary bytes encoded as base64 over this test pipe.
    try (BufferedReader reader = new BufferedReader(
        new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
      String line;
      while ((line = reader.readLine()) != null) {
        if (line.equals("quit")) { System.out.println("OK\t"); break; }
        try {
          System.out.println("OK\t" + dispatch(line.split("\t", -1)));
        } catch (Throwable e) {
          System.out.println("ERR\t" + e.getClass().getSimpleName() + ": " +
              String.valueOf(e.getMessage()).replace("\n", " "));
        }
        System.out.flush();
      }
    }
  }
}
