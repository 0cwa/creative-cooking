package creative.cooking.automerge.spike;

import static org.junit.Assert.*;
import android.os.Debug;
import android.os.SystemClock;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.InputStream;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual Android ART/JNI tests inside the generated Expo 57 test APK. */
@RunWith(AndroidJUnit4.class)
public class AutomergeBridgeInstrumentedTest {
  private static byte[] fixture(String name) throws Exception {
    try (InputStream input = InstrumentationRegistry.getInstrumentation()
        .getContext().getAssets().open(name)) {
      return input.readAllBytes();
    }
  }
  private static String[] key(String... segments) { return segments; }
  private static long open(byte[] source, int actor, String author) {
    return CurrentCoreBridge.open(source, CurrentCoreBridge.fixedActor(actor),
        author.getBytes(java.nio.charset.StandardCharsets.UTF_8));
  }
  private static JSONArray heads(long id) throws Exception {
    return new JSONArray(CurrentCoreBridge.heads(id));
  }
  private static void equalHeads(long left, long right) throws Exception {
    assertEquals(new java.util.HashSet<>(Arrays.asList(
        CurrentCoreBridge.heads(left).replace("[","").replace("]","").split(","))),
        new java.util.HashSet<>(Arrays.asList(
        CurrentCoreBridge.heads(right).replace("[","").replace("]","").split(","))));
  }
  @Test public void actualWebDocumentRoundTripAndNativeTimings() throws Exception {
    byte[] seed = fixture("web-seed.am");
    long start = SystemClock.elapsedRealtimeNanos();
    long id = open(seed, 108, "android-runtime");
    double coldMs=(SystemClock.elapsedRealtimeNanos()-start)/1e6;
    try {
      assertEquals("\"Tomato toast\"",
          CurrentCoreBridge.get(id, key("recipesById","recipe-1","title")));
      assertEquals("\"tomatoes\"",
          CurrentCoreBridge.get(id, key("pantryById","item-1","name")));
      start = SystemClock.elapsedRealtimeNanos();
      CurrentCoreBridge.putInt(id, key("recipesById","recipe-1","portions"), 5);
      double updateMs=(SystemClock.elapsedRealtimeNanos()-start)/1e6;
      CurrentCoreBridge.putString(id, key("conversationsById","conversation-1",
          "messagesById","message-1","content"), "Cook more creatively");
      byte[] serialized=CurrentCoreBridge.save(id);
      long roundtrip=open(serialized, 109, "android-restart");
      try {
        assertEquals("5", CurrentCoreBridge.get(roundtrip,
            key("recipesById","recipe-1","portions")));
        assertEquals("\"Cook more creatively\"", CurrentCoreBridge.get(roundtrip,
            key("conversationsById","conversation-1","messagesById","message-1","content")));
        Log.i("AutomergeSpike", "ANDROID_NATIVE_METRICS " + new JSONObject()
            .put("webSeedBytes",seed.length)
            .put("savedBytes",serialized.length).put("coldLoadMs",coldMs)
            .put("updateMs",updateMs).put("pssKb",Debug.getPss()).toString());
      } finally { CurrentCoreBridge.dispose(roundtrip); }
    } finally { CurrentCoreBridge.dispose(id); }
  }
  @Test public void realWebNativeConflictsAndCausalMetadata() throws Exception {
    long id = open(fixture("conflicted.am"), 110, "android-check");
    try {
      JSONArray alternatives = new JSONObject(CurrentCoreBridge.conflicts(
          id,key("recipesById","recipe-1","portions"))).getJSONArray("alternatives");
      assertEquals(2, alternatives.length());
      boolean four=false, six=false;
      for (int n=0;n<alternatives.length();n++) {
        JSONObject a=alternatives.getJSONObject(n);
        assertTrue(a.getString("opId").contains("@"));
        four |= a.getInt("value")==4;
        six |= a.getInt("value")==6;
      }
      assertTrue(four && six);
      JSONArray changes=new JSONObject(CurrentCoreBridge.changes(id)).getJSONArray("changes");
      assertTrue(changes.length()>=3);
      String metadata=changes.toString();
      assertTrue(metadata.contains("7765622d646576696365")); // "web-device" hex
      assertTrue(metadata.contains("616e64726f6964")); // "android" hex
      CurrentCoreBridge.putInt(id,key("recipesById","recipe-1","portions"),5);
      assertEquals("5",CurrentCoreBridge.get(id,key("recipesById","recipe-1","portions")));
      assertEquals(1,new JSONObject(CurrentCoreBridge.conflicts(
          id,key("recipesById","recipe-1","portions"))).getJSONArray("alternatives").length());
    } finally { CurrentCoreBridge.dispose(id); }
  }
  @Test public void nativeSyncStatesConvergeAfterOfflineForks() throws Exception {
    byte[] base=fixture("web-seed.am");
    long a=open(base,111,"phone"), b=open(base,112,"tablet");
    long sa=CurrentCoreBridge.newSession(),sb=CurrentCoreBridge.newSession();
    try {
      CurrentCoreBridge.putInt(a,key("recipesById","recipe-1","portions"),4);
      CurrentCoreBridge.putInt(b,key("recipesById","recipe-1","portions"),6);
      CurrentCoreBridge.putString(a,key("pantryById","item-1","name"),"roma tomatoes");
      int messages=0;
      for (int round=0;round<40;round++) {
        byte[] m1=CurrentCoreBridge.generate(a,sa);
        if(m1.length>0) {CurrentCoreBridge.receive(b,sb,m1);messages++;}
        byte[] m2=CurrentCoreBridge.generate(b,sb);
        if(m2.length>0) {CurrentCoreBridge.receive(a,sa,m2);messages++;}
        if(m1.length==0 && m2.length==0) break;
        if(round==39) fail("Native sync did not quiesce");
      }
      assertTrue(messages>0);
      equalHeads(a,b);
      assertEquals("\"roma tomatoes\"",CurrentCoreBridge.get(b,
          key("pantryById","item-1","name")));
      assertEquals(2,new JSONObject(CurrentCoreBridge.conflicts(a,
          key("recipesById","recipe-1","portions"))).getJSONArray("alternatives").length());
      long c=open(base,113,"third");
      long sc=CurrentCoreBridge.newSession(),sa2=CurrentCoreBridge.newSession();
      try {
        CurrentCoreBridge.putString(c,key("recipesById","recipe-1","title"),"Three-way toast");
        for(int round=0;round<40;round++) {
          byte[] m1=CurrentCoreBridge.generate(a,sa2);
          if(m1.length>0) CurrentCoreBridge.receive(c,sc,m1);
          byte[] m2=CurrentCoreBridge.generate(c,sc);
          if(m2.length>0) CurrentCoreBridge.receive(a,sa2,m2);
          if(m1.length==0 && m2.length==0) break;
          if(round==39) fail("Three-replica sync did not quiesce");
        }
        equalHeads(a,c);
        assertEquals("\"Three-way toast\"",CurrentCoreBridge.get(a,
            key("recipesById","recipe-1","title")));
      } finally {
        CurrentCoreBridge.endSession(sa2);CurrentCoreBridge.endSession(sc);
        CurrentCoreBridge.dispose(c);
      }
    } finally {
      CurrentCoreBridge.endSession(sa);CurrentCoreBridge.endSession(sb);
      CurrentCoreBridge.dispose(a);CurrentCoreBridge.dispose(b);
    }
  }
  @Test public void invalidBytesAndRepeatedResourceLifetimes() throws Exception {
    for(int n=0;n<80;n++){
      long id=open(fixture("web-seed.am"),120,"native-cycle");
      long session=CurrentCoreBridge.newSession();
      CurrentCoreBridge.save(id);
      CurrentCoreBridge.endSession(session);
      CurrentCoreBridge.dispose(id);
    }
    try {open(new byte[]{1,2,3},121,"invalid");fail("Invalid load accepted");}
    catch (IllegalStateException expected) {assertTrue(expected.getMessage().length()>0);}
    assertEquals(0,new JSONObject(CurrentCoreBridge.liveCounts()).getInt("documents"));
    assertEquals(0,new JSONObject(CurrentCoreBridge.liveCounts()).getInt("sessions"));
  }
}
