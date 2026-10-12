package org.creativecooking.spike;

/** JNI ABI fixture ONLY, not an Expo native module. */
public final class P2pandaProbe {
    static {
        System.loadLibrary("creative_cooking_p2panda_spike");
    }
    private P2pandaProbe() {}
    public static native int nativeProbe();
}
