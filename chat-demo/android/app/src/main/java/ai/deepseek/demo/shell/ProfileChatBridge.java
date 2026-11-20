package ai.deepseek.demo.shell;

import android.content.Context;
import android.os.SystemClock;
import android.util.Base64;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;

/** The packaged main page can request three operations against a profile already in its encrypted vault. */
final class ProfileChatBridge {
    private static final String PORT = "DeepChatProfile";
    private static final int CHUNK = 48 * 1024, MAX_BODY = 64 * 1024 * 1024, MAX_REPLY = 32 * 1024 * 1024;
    private final WebView web;
    private final ProfileVault vault;
    private final Map<String, Call> calls = new HashMap<>(); // main looper
    private final ExecutorService workers = Executors.newFixedThreadPool(3);
    private final java.util.concurrent.ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor();

    ProfileChatBridge(Context context, WebView web, SecurityPlugin security) {
        this.web = web;
        vault = new ProfileVault(context);
        security.onProfileInvalidated(this::cancelAll);
        WebViewCompat.addWebMessageListener(web, PORT, Collections.singleton("https://localhost"), (view, msg, origin, main, reply) -> {
            if (!SecurityPlugin.isPackagedPage(view, origin, main) || msg.getType() != WebMessageCompat.TYPE_STRING) return;
            String raw = msg.getData();
            if (raw == null || raw.length() > 70 * 1024) return;
            String id = "";
            try {
                JSONObject req = new JSONObject(raw);
                id = req.getString("id");
                if (!id.matches("[0-9]{1,16}")) return;
                String op = req.getString("op");
                Call current = calls.get(id);
                if (current != null && current.page != reply) return;
                if (op.equals("cancel")) { if (current != null) current.abort(); return; }
                if (!security.permitsProfileChat()) { error(reply, id, "Chat profile locked / 凭据库已锁定或正在更新"); return; }
                if (op.equals("chunk") && current != null) { current.offer(req.getInt("offset"), req.getString("data")); return; }
                int size = req.getInt("length");
                if (!op.equals("start") || size < 1 || size > MAX_BODY || calls.size() >= 3 || current != null) throw new IOException();
                Call call = new Call(id, reply, size);
                calls.put(id, call);
                call.deadline = deadlines.schedule(call::abort, 10, TimeUnit.MINUTES);
                workers.execute(() -> WebDavCookies.isolate(() -> call.run(req)));
            } catch (Exception refused) { error(reply, id, "Invalid or busy chat request / 请求无效或已有请求在运行"); }
        });
    }

    private static void error(JavaScriptReplyProxy page, String id, String reason) {
        try { page.postMessage(new JSONObject().put("id", id).put("type", "error").put("message", reason).toString()); }
        catch (Exception detached) { /* Document gone. */ }
    }
    void cancelAll() { for (Call c : calls.values()) c.abort(); }
    void close() {
        cancelAll(); workers.shutdownNow(); deadlines.shutdownNow();
        WebViewCompat.removeWebMessageListener(web, PORT);
    }

    private ProfileChatTarget target(JSONObject req) throws Exception {
        String saved = vault.read();
        if (saved == null) throw new IOException();
        JSONObject envelope = new JSONObject(saved);
        if (envelope.getInt("version") != 1) throw new IOException();
        JSONArray profiles = envelope.getJSONArray("profiles");
        JSONObject match = null;
        for (int i = 0; i < profiles.length(); i++) {
            JSONObject p = profiles.getJSONObject(i);
            if (!req.getString("profileId").equals(p.getString("id"))) continue;
            if (match != null) throw new IOException();
            match = p;
        }
        if (match == null || !req.getString("origin").equals(match.getString("origin")) || !req.getString("protocol").equals(match.getString("protocol"))) throw new IOException();
        return new ProfileChatTarget(match.getString("origin"), match.getString("protocol"), req.getString("operation"), match.getString("apiKey"), req.getString("digest"));
    }

    private final class Call {
        final String id;
        final JavaScriptReplyProxy page;
        final int length;
        private volatile boolean cancelled;
        private volatile HttpsURLConnection http;
        private java.util.concurrent.ScheduledFuture<?> deadline;
        private int wanted = -1;
        private byte[] chunk;
        Call(String id, JavaScriptReplyProxy page, int length) { this.id = id; this.page = page; this.length = length; }

        void abort() {
            synchronized (this) { cancelled = true; notifyAll(); }
            HttpsURLConnection active = http;
            if (active != null) active.disconnect();
        }
        void check() throws IOException { if (cancelled || !SecurityPlugin.isUnlocked()) throw new IOException(); }
        synchronized void offer(int offset, String text) throws IOException {
            check();
            int size = Math.min(CHUNK, length - offset);
            if (wanted < 0 || wanted != offset || chunk != null || text.length() != 4 * ((size + 2) / 3)) throw new IOException();
            byte[] bytes = Base64.decode(text, Base64.NO_WRAP);
            if (bytes.length != size) throw new IOException();
            chunk = bytes; notifyAll();
        }
        // At most one JS IPC frame waits in the UI queue for this transfer.
        void emit(JSONObject value) throws Exception {
            check();
            String raw = value.put("id", id).toString();
            CountDownLatch delivered = new CountDownLatch(1);
            web.post(() -> {
                try { if (!cancelled && SecurityPlugin.isUnlocked()) page.postMessage(raw); }
                catch (Exception detached) { abort(); }
                finally { delivered.countDown(); }
            });
            if (!delivered.await(10, TimeUnit.SECONDS)) throw new IOException();
            check();
        }
        byte[] pull(int offset) throws Exception {
            int size = Math.min(CHUNK, length - offset);
            synchronized (this) { wanted = offset; }
            emit(new JSONObject().put("type", "pull").put("offset", offset).put("length", size));
            long until = SystemClock.elapsedRealtime() + 15000;
            synchronized (this) {
                while (chunk == null) {
                    check(); long remaining = until - SystemClock.elapsedRealtime();
                    if (remaining <= 0) throw new IOException();
                    wait(remaining);
                }
                byte[] result = chunk; chunk = null; wanted = -1; check(); return result;
            }
        }
        void data(byte[] bytes, int size) throws Exception {
            for (int pos = 0; pos < size; pos += CHUNK) emit(new JSONObject().put("type", "data")
                    .put("data", Base64.encodeToString(bytes, pos, Math.min(CHUNK, size - pos), Base64.NO_WRAP)));
        }
        void receive(ProfileChatTarget target, int status) throws Exception {
            String type = http.getContentType();
            emit(new JSONObject().put("type", "headers").put("status", status).put("contentType", type == null ? "" : type));
            if (status < 300 || status >= 400) try (InputStream in = status >= 400 ? http.getErrorStream() : http.getInputStream()) {
                byte[] bytes = new byte[16384];
                int total = 0, n;
                ByteArrayOutputStream errorBody = status >= 400 ? new ByteArrayOutputStream() : null;
                while (in != null && (n = in.read(bytes)) != -1) {
                    check(); total += n;
                    if (errorBody != null) {
                        errorBody.write(bytes, 0, Math.min(n, 65536 - errorBody.size()));
                        if (total >= 65536) break;
                    } else { if (total > MAX_REPLY) throw new IOException(); data(bytes, n); }
                }
                if (errorBody != null) {
                    byte[] safe = target.safeError(errorBody.toString("UTF-8")).getBytes(StandardCharsets.UTF_8);
                    data(safe, safe.length);
                }
            }
            emit(new JSONObject().put("type", "end"));
        }
        void run(JSONObject req) {
            try {
                check();
                ProfileChatTarget target = target(req);
                // Pull the first chunk before connecting. An abandoned/changed selection sends zero bytes.
                byte[] first = pull(0);
                http = (HttpsURLConnection) target.url.openConnection();
                target.configure(http, length, req.optBoolean("json"), req.optBoolean("beta"), req.optString("openCodeSession"));
                check();
                try (OutputStream out = http.getOutputStream()) {
                    check(); out.write(first);
                    for (int pos = first.length; pos < length;) { byte[] bytes = pull(pos); check(); out.write(bytes); pos += bytes.length; }
                }
                check(); receive(target, http.getResponseCode());
            } catch (Exception failed) {
                web.post(() -> error(page, id, cancelled ? "Chat cancelled / 聊天已取消" : "Profile chat unavailable / 无法连接所选模型服务或凭据已更改"));
            } finally {
                if (deadline != null) deadline.cancel(false);
                if (http != null) http.disconnect();
                web.post(() -> { if (calls.get(id) == this) calls.remove(id); });
            }
        }
    }
}
