package ai.deepseek.demo.shell;

import android.Manifest;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.util.ArrayList;
import java.util.Locale;
import java.util.Set;

/** Only explicitly installed, embedded voices are eligible. No download/install intents. */
@CapacitorPlugin(name = "DeviceVoice", permissions = {
    @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public final class DeviceVoicePlugin extends Plugin {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ArrayList<PluginCall> probes = new ArrayList<>();
    private TextToSpeech tts;
    private boolean ready;
    private int generation;
    private PluginCall utterance;
    private LocalRecognition recognition;

    private static String language(PluginCall call) {
        String lang = call.getString("lang", "");
        return "en-US".equals(lang) || "zh-CN".equals(lang) ? lang : "";
    }

    static boolean eligible(Voice voice, Locale wanted) {
        if (voice == null || voice.isNetworkConnectionRequired() || voice.getLocale() == null) return false;
        Set<String> features = voice.getFeatures();
        return features != null && !features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)
                && wanted.getLanguage().equals(voice.getLocale().getLanguage());
    }

    private Voice localVoice(String lang) {
        if (!ready || lang.isEmpty()) return null;
        Locale locale = Locale.forLanguageTag(lang);
        Voice fallback = null;
        Set<Voice> voices = tts.getVoices();
        if (voices != null) for (Voice voice : voices) {
            if (!eligible(voice, locale)) continue;
            if (locale.equals(voice.getLocale())) return voice;
            if (fallback == null || voice.getQuality() > fallback.getQuality()) fallback = voice;
        }
        return fallback;
    }

    @PluginMethod public void voiceAvailable(PluginCall call) {
        ui.post(() -> {
            if (!SecurityPlugin.isUnlocked() || probes.size() >= 8) { resolveAvailable(call, false); return; }
            if (ready) { resolveVoice(call); return; }
            probes.add(call);
            if (tts != null) return;
            int ticket = ++generation;
            try {
                tts = new TextToSpeech(getContext(), status -> ui.post(() -> {
                    if (generation != ticket) return;
                    if (status != TextToSpeech.SUCCESS) { closeEngine(); return; }
                    ready = true;
                    tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        @Override public void onStart(String id) { }
                        @Override public void onDone(String id) { ui.post(() -> settle(id, true)); }
                        @Override public void onError(String id) { ui.post(() -> settle(id, false)); }
                    });
                    flushProbes();
                }));
                ui.postDelayed(() -> { if (generation == ticket && !ready) closeEngine(); }, 4000);
            } catch (RuntimeException ex) { closeEngine(); }
        });
    }

    static void resolveAvailable(PluginCall call, boolean value) {
        JSObject result = new JSObject(); result.put("available", value); call.resolve(result);
    }

    private void resolveVoice(PluginCall call) {
        try { resolveAvailable(call, localVoice(language(call)) != null); }
        catch (RuntimeException ex) { resolveAvailable(call, false); }
    }

    private void flushProbes() {
        for (PluginCall call : probes) resolveVoice(call);
        probes.clear();
    }

    @PluginMethod public void speak(PluginCall call) {
        ui.post(() -> {
            String id = call.getString("id", "");
            String text = call.getString("text", "");
            if (!SecurityPlugin.isUnlocked() || id.isEmpty() || id.length() > 80 || text.isEmpty()
                    || text.length() > Math.min(512, TextToSpeech.getMaxSpeechInputLength())) {
                call.reject("unavailable"); return;
            }
            try {
                Voice voice = localVoice(language(call));
                if (voice == null || tts.setVoice(voice) != TextToSpeech.SUCCESS || !voice.equals(tts.getVoice())) {
                    call.reject("unavailable"); return;
                }
                cancelUtterance();
                Bundle params = new Bundle();
                params.putString(TextToSpeech.Engine.KEY_FEATURE_EMBEDDED_SYNTHESIS, "true");
                utterance = call;
                if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, id) != TextToSpeech.SUCCESS) settle(id, false);
                else ui.postDelayed(() -> { if (utterance == call) cancelUtterance(); }, 60000);
            } catch (RuntimeException ex) {
                if (utterance == call) utterance = null;
                call.reject("unavailable");
            }
        });
    }

    private void settle(String id, boolean ok) {
        if (utterance == null || !id.equals(utterance.getString("id"))) return;
        PluginCall done = utterance; utterance = null;
        if (ok && SecurityPlugin.isUnlocked()) done.resolve(); else done.reject("unavailable");
    }

    private void cancelUtterance() {
        if (utterance == null) return;
        PluginCall old = utterance; utterance = null;
        try { tts.stop(); } finally { old.reject("cancelled"); }
    }

    @PluginMethod public void cancelSpeech(PluginCall call) {
        ui.post(() -> {
            if (utterance != null && call.getString("id", "").equals(utterance.getString("id"))) cancelUtterance();
            call.resolve();
        });
    }

    private LocalRecognition recognizer() {
        if (recognition == null) recognition = new LocalRecognition(getContext(), ui);
        return recognition;
    }

    @PluginMethod public void recognitionAvailable(PluginCall call) {
        ui.post(() -> {
            if (android.os.Build.VERSION.SDK_INT < 33 || !SecurityPlugin.isUnlocked()) resolveAvailable(call, false);
            else recognizer().probe(call, language(call));
        });
    }

    @PluginMethod public void recognize(PluginCall call) {
        ui.post(() -> {
            if (android.os.Build.VERSION.SDK_INT < 33 || !SecurityPlugin.isUnlocked()
                    || getPermissionState("microphone") != PermissionState.GRANTED) { call.reject("unavailable"); return; }
            recognizer().start(call, language(call));
        });
    }

    @PluginMethod public void endRecognition(PluginCall call) {
        ui.post(() -> {
            if (recognition != null) recognition.end(call.getString("id", ""), call.getBoolean("cancel", true));
            call.resolve();
        });
    }

    private void closeEngine() {
        generation++;
        ready = false;
        cancelUtterance();
        if (tts != null) { tts.shutdown(); tts = null; }
        flushProbes();
    }

    @Override protected void handleOnPause() {
        cancelUtterance();
        if (recognition != null) recognition.close();
    }

    @Override protected void handleOnDestroy() {
        closeEngine();
        if (recognition != null) recognition.close();
        ui.removeCallbacksAndMessages(null);
    }
}
