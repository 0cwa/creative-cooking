package creative.cooking.automerge.spike;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Objects;

/** JNI smoke harness for the current Automerge Rust core. */
public final class CurrentCoreNative {
  static {
    System.load(Objects.requireNonNull(System.getProperty("automerge.jni.path"),
        "Set -Dautomerge.jni.path to the JNI library"));
  }

  private static native byte[] setNativeModified(byte[] input, String label);
  private static native byte[] setCounter(byte[] input, int value);
  private static native byte[] mergeDocuments(byte[] left, byte[] right);
  private static native String counterConflicts(byte[] document);

  public static void main(String[] args) throws Exception {
    if (args.length < 2) throw new IllegalArgumentException("mutate|fork-conflict|merge|conflicts ...");
    byte[] input = Files.readAllBytes(Path.of(args[1]));
    switch (args[0]) {
      case "mutate" -> {
        if (args.length != 4) throw new IllegalArgumentException("mutate input output label");
        byte[] result = setNativeModified(input, args[3]);
        Files.write(Path.of(args[2]), result);
        System.out.println("{\"command\":\"mutate\",\"bytes\":" + result.length + "}");
      }
      case "fork-conflict" -> {
        if (args.length != 3) throw new IllegalArgumentException("fork-conflict input output");
        byte[] result = setCounter(input, 6);
        Files.write(Path.of(args[2]), result);
        System.out.println("{\"command\":\"fork-conflict\",\"bytes\":" + result.length + "}");
      }
      case "merge" -> {
        if (args.length != 4) throw new IllegalArgumentException("merge left right output");
        byte[] result = mergeDocuments(input, Files.readAllBytes(Path.of(args[2])));
        Files.write(Path.of(args[3]), result);
        System.out.println("{\"command\":\"merge\",\"bytes\":" + result.length + "}");
      }
      case "conflicts" -> System.out.println(counterConflicts(input));
      default -> throw new IllegalArgumentException("unknown command: " + args[0]);
    }
  }
}
