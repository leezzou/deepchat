package ai.deepseek.demo.shell;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.net.Uri;
import android.os.Build;
import android.os.CancellationSignal;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Owns the first visible frame and all authentication decisions, independently of JS startup. */
final class SecurityPlugin {
    private static final String PORT = "DeepChatSecurity";
    private static final int CONFIRM = 5841;
    private static volatile boolean unlocked;
    private final Activity activity;
    private final WebView web;
    private final SystemBars systemBars;
    private final SharedPreferences preferences;
    private final boolean hasPort;
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    private final ExecutorService modelNetwork = Executors.newFixedThreadPool(2);
    // Accessed on the WebView thread. Cancel outstanding calls on lock or profile changes.
    private final java.util.Map<String, ProfileModelRequest> modelCalls = new java.util.HashMap<>();
    private final AppLockCover cover;
    private boolean enabled, authorized, resumed, closed;
    private volatile long epoch;
    private JavaScriptReplyProxy page;
    private enum Action { UNLOCK, ENABLE, DISABLE }
    private Action pending;
    private String pendingId;
    private CancellationSignal prompt;

    SecurityPlugin(Activity activity, WebView web, SystemBars systemBars) {
        this.activity = activity;
        this.web = web;
        this.systemBars = systemBars;
        unlocked = false;
        preferences = activity.getSharedPreferences("deepchat-app-lock", Context.MODE_PRIVATE);
        enabled = preferences.getBoolean("enabled", false);
        hasPort = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
        cover = new AppLockCover(activity, preferences, () -> authenticate(Action.UNLOCK, null));
        ViewGroup content = activity.findViewById(android.R.id.content);
        content.addView(cover, new ViewGroup.LayoutParams(-1, -1));
        hint();
        update();
        if (hasPort) WebViewCompat.addWebMessageListener(web, PORT, Collections.singleton("https://localhost"),
                (view, message, origin, main, reply) -> {
                    if (!isPackagedPage(view, origin, main) || message.getType() != WebMessageCompat.TYPE_STRING) return;
                    String raw = message.getData();
                    if (raw == null || raw.length() > 3 * 1024 * 1024) return;
                    String id = "";
                    try {
                        JSONObject input = new JSONObject(raw);
                        id = input.getString("id");
                        if (!id.matches("[0-9]{1,16}")) return;
                        page = reply;
                        String op = input.getString("op");
                        if (op.equals("status")) { reply(id, state(), null); return; }
                        if (!isUnlocked()) { reply(id, null, "locked"); return; }
                        if (op.equals("appearance")) {
                            cover.saveAppearance(input.getString("theme"), input.getString("locale"));
                            reply(id, true, null);
                        } else if (op.equals("configure")) {
                            boolean next = input.getBoolean("enabled");
                            if (next == enabled) reply(id, state(), null);
                            else authenticate(next ? Action.ENABLE : Action.DISABLE, id);
                        } else if (op.equals("listModels")) {
                            listModels(id, reply, input);
                        } else if (op.equals("cancelModels")) {
                            ProfileModelRequest call = modelCalls.remove(input.getString("requestId"));
                            if (call != null) call.cancel();
                            reply(id, true, null);
                        } else if ((op.equals("read") || op.equals("write")) && Build.VERSION.SDK_INT >= 23) {
                            accessVault(id, reply, op.equals("write") ? input.getString("value") : null);
                        } else reply(id, null, "unavailable");
                    } catch (Exception invalid) { reply(id, null, "unavailable"); }
                });
    }

    static boolean isPackagedPage(WebView view, Uri origin, boolean main) {
        if (!main || origin == null || !"https://localhost".equals(origin.toString())) return false;
        String url = view.getUrl();
        if (url == null) return false;
        Uri page = Uri.parse(url);
        String path = page.getEncodedPath();
        return "https".equals(page.getScheme()) && "localhost".equals(page.getEncodedAuthority())
                && ("/".equals(path) || "/index.html".equals(path) || "".equals(path));
    }

    static boolean isUnlocked() { return unlocked; }
    boolean isEnabled() { return enabled; }
    private void hint() { cover.setHint(R.string.app_lock_hint); }
    private KeyguardManager keyguard() { return (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE); }
    private boolean available() { return Build.VERSION.SDK_INT >= 23 && keyguard() != null && keyguard().isDeviceSecure(); }
    private JSONObject state() throws Exception {
        return new JSONObject().put("enabled", enabled).put("unlocked", unlocked)
                .put("available", available()).put("vault", Build.VERSION.SDK_INT >= 23);
    }
    private void reply(String id, Object value, String error) {
        if (page == null || closed) return;
        try { page.postMessage(new JSONObject().put("id", id).put("value", value == null ? JSONObject.NULL : value).put("error", error).toString()); }
        catch (Exception detached) { /* page closed */ }
    }
    // A vault write or lock revokes requests bound to the old profile credentials.
    private int profileWrites;
    private Runnable profileInvalidated = () -> {};
    void onProfileInvalidated(Runnable callback) { profileInvalidated = callback; }
    boolean permitsProfileChat() { return isUnlocked() && profileWrites == 0; }
    private void update() {
        unlocked = resumed && (!enabled || authorized) && !closed;
        if (!unlocked) profileInvalidated.run();
        boolean hide = enabled && !unlocked;
        if (enabled) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        web.setVisibility(hide ? View.INVISIBLE : View.VISIBLE);
        cover.present(hide, resumed, authorized);
        if (hide) systemBars.setDark(cover.isDark());
        if (page != null && !closed) try { page.postMessage(new JSONObject().put("state", state()).toString()); }
        catch (Exception detached) { /* navigation */ }
    }

    private void listModels(String id, JavaScriptReplyProxy caller, JSONObject input) throws Exception {
        String requestId = input.getString("requestId");
        if (!requestId.matches("[0-9]{1,16}") || modelCalls.containsKey(requestId) || modelCalls.size() >= 4) {
            reply(id, null, "unavailable");
            return;
        }
        ProfileModelRequest request = new ProfileModelRequest();
        modelCalls.put(requestId, request);
        final long generation = epoch;
        modelNetwork.execute(() -> {
            JSONObject result = null;
            try {
                if (generation == epoch && isUnlocked()) result = request.fetch(input);
            } catch (Exception ignored) { /* Errors and URLs might contain secrets. */ }
            final JSONObject data = result;
            web.post(() -> {
                boolean current = modelCalls.get(requestId) == request;
                if (current) modelCalls.remove(requestId);
                if (page != caller || closed) return;
                if (generation != epoch || !isUnlocked() || !current) reply(id, null, "cancelled");
                else replyModels(id, data);
            });
        });
    }

    /** Keep a large aggregator catalog below Android WebView's individual IPC message budget. */
    private void replyModels(String id, JSONObject data) {
        if (data == null) { reply(id, null, "unavailable"); return; }
        String body = data.optString("body");
        if (body.length() <= 32768) { reply(id, data, null); return; }
        try {
            for (int start = 0; start < body.length();) {
                int end = Math.min(body.length(), start + 32768);
                if (end < body.length() && Character.isHighSurrogate(body.charAt(end - 1))) end--;
                page.postMessage(new JSONObject().put("id", id).put("modelChunk", body.substring(start, end)).toString());
                start = end;
            }
            reply(id, new JSONObject().put("status", data.getInt("status")).put("length", body.length()), null);
        } catch (Exception detached) { reply(id, null, "unavailable"); }
    }

    private void cancelModelCalls() {
        for (ProfileModelRequest request : modelCalls.values()) request.cancel();
        modelCalls.clear();
    }

    private void accessVault(String id, JavaScriptReplyProxy caller, String value) {
        if (value != null) { profileWrites++; profileInvalidated.run(); }
        final long generation = epoch;
        storage.execute(() -> {
            Object result = null;
            boolean success = false;
            try {
                if (!isUnlocked() || generation != epoch) throw new IllegalStateException();
                ProfileVault vault = new ProfileVault(activity);
                if (value == null) result = vault.read();
                else { vault.write(value); result = true; }
                success = true;
            } catch (Exception unavailable) { /* Never send exception details or key material to logs. */ }
            final boolean ok = success;
            final Object data = result;
            web.post(() -> {
                if (value != null) profileWrites--;
                if (page != caller || closed) return;
                if (generation != epoch || !isUnlocked()) reply(id, null, "locked");
                else reply(id, data, ok ? null : "storage");
            });
        });
    }

    @SuppressWarnings("deprecation")
    private void authenticate(Action action, String id) {
        if (pending != null || !resumed || !available()) {
            if (!available()) cover.setHint(R.string.app_lock_unavailable);
            reply(id, null, "unavailable");
            return;
        }
        pending = action;
        pendingId = id;
        cover.setBusy(true);
        String title = cover.promptTitle();
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                CancellationSignal signal = new CancellationSignal();
                prompt = signal;
                new BiometricPrompt.Builder(activity).setTitle(title)
                        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                        .build().authenticate(signal, activity.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                            @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                                if (prompt == signal) finishAuthentication(true, null);
                            }
                            @Override public void onAuthenticationError(int code, CharSequence message) {
                                if (prompt == signal) finishAuthentication(false, "cancelled");
                            }
                        });
            } else {
                Intent credential = keyguard().createConfirmDeviceCredentialIntent(title, null);
                if (credential == null) finishAuthentication(false, "unavailable");
                else activity.startActivityForResult(credential, CONFIRM);
            }
        } catch (RuntimeException unsupported) { finishAuthentication(false, "unavailable"); }
    }

    boolean onActivityResult(int code, int result) {
        if (code != CONFIRM) return false;
        if (pending != null && Build.VERSION.SDK_INT < 30) finishAuthentication(result == Activity.RESULT_OK, "cancelled");
        return true;
    }
    private void finishAuthentication(boolean ok, String error) {
        Action action = pending;
        String id = pendingId;
        pending = null; pendingId = null; prompt = null;
        cover.setBusy(false);
        if (action == null || closed) return;
        if (ok && action != Action.UNLOCK) {
            boolean next = action == Action.ENABLE;
            if (preferences.edit().putBoolean("enabled", next).commit()) enabled = next;
            else { ok = false; error = "storage"; }
        }
        if (ok) { authorized = true; hint(); }
        else cover.setHint(R.string.app_lock_cancelled);
        update();
        if (id != null) try { reply(id, ok ? state() : null, ok ? null : error); } catch (Exception ignored) {}
    }

    void onResume() { resumed = true; update(); }
    void onPause() { resumed = false; authorized = false; epoch++; cancelModelCalls(); update(); }
    void onIncomingShare() {
        if (!enabled) return;
        authorized = false; epoch++;
        if (pending != null) {
            CancellationSignal old = prompt;
            finishAuthentication(false, "cancelled");
            if (old != null) old.cancel();
        }
        hint(); update();
    }
    void close() {
        closed = true; unlocked = false; epoch++;
        if (prompt != null) prompt.cancel();
        cancelModelCalls();
        modelNetwork.shutdownNow();
        storage.shutdownNow();
        if (hasPort) WebViewCompat.removeWebMessageListener(web, PORT);
        page = null;
    }
}
