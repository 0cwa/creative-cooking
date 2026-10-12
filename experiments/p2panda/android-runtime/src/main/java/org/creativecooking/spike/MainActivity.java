package org.creativecooking.spike;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.widget.TextView;

/** Real Rust JNI probe starts p2panda Node; NOT an Expo integration. */
public final class MainActivity extends Activity {
    private static final String TAG = "CCPANDA";
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView view = new TextView(this);
        view.setText("p2panda native JNI proof in progress...");
        setContentView(view);
        new Thread(() -> {
            try {
                final int code = P2pandaProbe.nativeProbe();
                final String outcome = code == 0 ? "PASS" : "FAIL_CODE_" + code;
                Log.i(TAG, "CC_P2PANDA_ANDROID_NATIVE_RUNTIME=" + outcome);
                runOnUiThread(() -> view.setText(outcome));
            } catch (Throwable ex) {
                Log.e(TAG, "CC_P2PANDA_ANDROID_NATIVE_RUNTIME=FAIL_EXCEPTION:" +
                        ex.getClass().getName(), ex);
                runOnUiThread(() -> view.setText("FAIL"));
            }
        }, "p2panda-spike-probe").start();
    }
}
