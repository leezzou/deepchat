package ai.deepseek.demo.shell;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.content.Intent;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import android.util.Log;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.Collections;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

public class DeviceVoiceTest {
    @Test public void restrictsVoicesToInstalledLocalLanguage() {
        assertTrue(DeviceVoicePlugin.eligible(voice(false, false, Locale.US), Locale.US));
        assertFalse(DeviceVoicePlugin.eligible(voice(false, false, Locale.SIMPLIFIED_CHINESE), Locale.US));
        assertFalse(DeviceVoicePlugin.eligible(voice(true, false, Locale.US), Locale.US));
        assertFalse(DeviceVoicePlugin.eligible(voice(false, true, Locale.US), Locale.US));
    }

    private Voice voice(boolean network, boolean missing, Locale lang) {
        return new Voice("test", lang, Voice.QUALITY_NORMAL, Voice.LATENCY_NORMAL, network,
                missing ? Collections.singleton(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) : Collections.emptySet());
    }

    private static class Call extends PluginCall {
        final CountDownLatch latch = new CountDownLatch(1);
        JSObject result;
        String error;
        Call(JSObject args) { super(null, "DeviceVoice", "test-call", "fixture", args); }
        @Override public void resolve(JSObject value) { result = value; latch.countDown(); }
        @Override public void resolve() { latch.countDown(); }
        @Override public void reject(String message) { error = message; latch.countDown(); }
        void success(int seconds) throws InterruptedException {
            assertTrue("device callback deadline", latch.await(seconds, TimeUnit.SECONDS));
            assertNull(error);
        }
    }

    /** Includes an actual short utterance when a matching voice is installed on the test device. */
    @Test public void queriesInstalledLanguagesAndSynthesizesWhenAvailable() throws Exception {
        Instrumentation inst = InstrumentationRegistry.getInstrumentation();
        MainActivity activity = (MainActivity) inst.startActivitySync(new Intent(inst.getTargetContext(), MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            DeviceVoicePlugin plugin = (DeviceVoicePlugin) activity.getBridge().getPlugin("DeviceVoice").getInstance();
            assertTrue(SecurityPlugin.isUnlocked());
            for (String lang : new String[]{ "en-US", "zh-CN" }) {
                JSObject args = new JSObject(); args.put("lang", lang);
                Call voice = new Call(args), mic = new Call(args);
                plugin.voiceAvailable(voice); plugin.recognitionAvailable(mic);
                voice.success(8); mic.success(8);
                assertTrue(voice.result.has("available")); assertTrue(mic.result.has("available"));
                Log.i("VoiceParityTest", lang + " offlineTts=" + voice.result.getBoolean("available")
                        + " installedAsr=" + mic.result.getBoolean("available"));
                if (voice.result.getBoolean("available")) {
                    args.put("id", "fixture-" + lang);
                    args.put("text", lang.equals("en-US") ? "Offline device test." : "设备离线测试。");
                    Call speak = new Call(args); plugin.speak(speak); speak.success(20);
                    Log.i("VoiceParityTest", lang + " utterance completed");
                }
            }
        } finally { inst.runOnMainSync(activity::finish); }
    }
}
