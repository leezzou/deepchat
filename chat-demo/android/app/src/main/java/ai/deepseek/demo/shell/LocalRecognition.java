package ai.deepseek.demo.shell;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.speech.RecognitionListener;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import androidx.annotation.RequiresApi;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.ArrayList;

/** API 33 can distinguish installed language packs from pending, online and downloadable ones. */
@RequiresApi(33)
final class LocalRecognition {
    private final Context context;
    private final Handler ui;
    private SpeechRecognizer active;
    private PluginCall listening;

    LocalRecognition(Context context, Handler ui) { this.context = context; this.ui = ui; }

    private Intent intent(String lang) {
        return new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
                .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
    }

    private interface Checked { void accept(SpeechRecognizer engine, boolean installed); }

    /** Caller gets ownership of the checked on-device recognizer, including on failure. */
    private void check(String lang, Checked callback) {
        if (lang.isEmpty() || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
            callback.accept(null, false); return;
        }
        SpeechRecognizer engine;
        try { engine = SpeechRecognizer.createOnDeviceSpeechRecognizer(context); }
        catch (RuntimeException ex) { callback.accept(null, false); return; }
        class Probe implements RecognitionSupportCallback {
            boolean done;
            final Runnable timeout = () -> finish(false);
            void finish(boolean ok) {
                if (done) return;
                done = true; ui.removeCallbacks(timeout); callback.accept(engine, ok);
            }
            public void onSupportResult(RecognitionSupport result) {
                finish(result.getInstalledOnDeviceLanguages().stream().anyMatch(lang::equalsIgnoreCase));
            }
            public void onError(int error) { finish(false); }
        }
        Probe probe = new Probe();
        ui.postDelayed(probe.timeout, 4000);
        try { engine.checkRecognitionSupport(intent(lang), context.getMainExecutor(), probe); }
        catch (RuntimeException ex) { probe.finish(false); }
    }

    void probe(PluginCall call, String lang) {
        check(lang, (engine, installed) -> {
            if (engine != null) engine.destroy();
            DeviceVoicePlugin.resolveAvailable(call, installed);
        });
    }

    void start(PluginCall call, String lang) {
        close();
        if (call.getString("id", "").isEmpty()) { call.reject("unavailable"); return; }
        listening = call;
        check(lang, (engine, installed) -> {
            if (listening != call || !installed || !SecurityPlugin.isUnlocked()) {
                if (engine != null) engine.destroy();
                if (listening == call) close();
                return;
            }
            active = engine;
            try {
                engine.setRecognitionListener(new RecognitionListener() {
                    public void onResults(Bundle results) {
                        if (listening != call) return;
                        ArrayList<String> texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        String text = texts != null && !texts.isEmpty() ? texts.get(0) : "";
                        JSObject result = new JSObject(); result.put("text", text);
                        if (!SecurityPlugin.isUnlocked()) { close(); return; }
                        release(); call.resolve(result);
                    }
                    public void onError(int error) {
                        if (listening != call) return;
                        release();
                        if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                            JSObject result = new JSObject(); result.put("text", ""); call.resolve(result);
                        } else call.reject("unavailable");
                    }
                    public void onReadyForSpeech(Bundle p) { }
                    public void onBeginningOfSpeech() { }
                    public void onRmsChanged(float rms) { }
                    public void onBufferReceived(byte[] buffer) { }
                    public void onEndOfSpeech() { }
                    public void onPartialResults(Bundle p) { }
                    public void onEvent(int e, Bundle p) { }
                });
                engine.startListening(intent(lang));
                ui.postDelayed(() -> { if (listening == call) close(); }, 125000);
            } catch (RuntimeException ex) { close(); }
        });
    }

    void end(String id, boolean cancel) {
        if (listening == null || !id.equals(listening.getString("id"))) return;
        if (cancel || active == null) close();
        else {
            PluginCall call = listening;
            try { active.stopListening(); } catch (RuntimeException ex) { close(); }
            ui.postDelayed(() -> { if (listening == call) close(); }, 6000);
        }
    }

    private void release() {
        listening = null;
        if (active != null) { active.destroy(); active = null; }
    }

    void close() {
        PluginCall call = listening;
        release();
        if (call != null) call.reject("cancelled");
    }
}
