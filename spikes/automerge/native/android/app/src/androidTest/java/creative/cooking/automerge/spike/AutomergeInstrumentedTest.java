package creative.cooking.automerge.spike;

import static org.junit.Assert.assertEquals;

import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import spike.AutomergeNativeScenarios;

@RunWith(AndroidJUnit4.class)
public final class AutomergeInstrumentedTest {
    @Test
    public void runsCompleteCommonContractInAndroidRuntime() {
        AutomergeNativeScenarios.ScenarioSummary summary = AutomergeNativeScenarios.runAll();
        String json = AutomergeNativeScenarios.toJson(summary);
        Log.i("AutomergeSpike", json);
        assertEquals("all 18 scenarios must execute", 18, summary.results().size());
        assertEquals("no native contract scenario may fail", 0, summary.fail());
    }
}
