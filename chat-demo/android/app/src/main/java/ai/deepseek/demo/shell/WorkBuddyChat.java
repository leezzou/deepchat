package ai.deepseek.demo.shell;

import android.app.Activity;
import android.net.Uri;
import android.util.Base64;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import org.json.JSONObject;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;

/** Only the bundled main page may use the WorkBuddy account authorized on this device. The bridge takes no URL or headers. */
final class WorkBuddyChat {
    private static final String PORT = "WorkBuddyChat";
    private static final int MAX_BODY = 5 * 1024 * 1024, MAX_REPLY = 8 * 1024 * 1024;
    private final WebView web;
    private final WorkBuddySession session;
    private final Activity activity;
    private WorkBuddyDesktopBrowser browser; // Owned by the activity's main looper.
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    private final ExecutorService network = Executors.newFixedThreadPool(3);
    private final Map<String, Call> active = new HashMap<>();
    private volatile boolean closed;

    WorkBuddyChat(Activity context, WebView web) {
        this.web = web;
        activity = context;
        session = WorkBuddySession.forContext(context);
        WebViewCompat.addWebMessageListener(web, PORT, Collections.singleton("https://localhost"), (view, message, origin, main, reply) -> {
            if (!SecurityPlugin.isPackagedPage(view, origin, main) || message.getType() != WebMessageCompat.TYPE_STRING) return;
            String raw = message.getData();
            if (raw == null || raw.length() > MAX_BODY + 4096) return;
            try {
                JSONObject req = new JSONObject(raw);
                String id = req.getString("id"), op = req.getString("op");
                if (!id.matches("[a-zA-Z0-9-]{1,64}")) return;
                if (op.equals("cancel")) { cancel(id); return; }
                if (!SecurityPlugin.isUnlocked()) { error(reply, id, "locked"); return; }
                if (op.equals("chat") || op.equals("search")) start(id, req, reply);
                else storage.execute(() -> WebDavCookies.isolate(() -> manage(id, op, req, reply)));
            } catch (Exception invalid) { /* Malformed or detached caller. */ }
        });
    }

    static boolean allowedModel(String id) {
        return "deepseek-v4.1-flash".equals(id) || "deepseek-v4-pro".equals(id) || "deepseek-v4-flash".equals(id);
    }
    private void manage(String id, String op, JSONObject req, JavaScriptReplyProxy reply) {
        try {
            if (closed || !SecurityPlugin.isUnlocked()) { error(reply, id, "locked"); return; }
            switch (op) {
                case "begin": {
                    Uri page = session.begin();
                    JSONObject status = session.status();
                    web.post(() -> {
                        if (closed || !SecurityPlugin.isUnlocked()) { session.cancel(); error(reply, id, "locked"); return; }
                        try {
                            closeBrowser();
                            browser = new WorkBuddyDesktopBrowser(activity, page);
                            // The official page cannot signal success. The packaged UI polls our original state.
                            reply.postMessage(status.put("id", id).toString());
                        } catch (Exception noBrowser) { session.cancel(); error(reply, id, "desktop_browser_unavailable"); }
                    });
                    return;
                }
                case "poll": session.poll(); break;
                case "cancelLogin": session.cancel(); break;
                case "forget": cancelAll(); session.forget(); break;
                case "model": session.changeModel(req.getString("model")); break;
                case "status": break;
                default: error(reply, id, "operation"); return;
            }
            JSONObject status = session.status();
            if (!status.optBoolean("pending")) web.post(this::closeBrowser);
            emit(reply, id, status);
        } catch (Exception failure) {
            if (op.equals("poll") || op.equals("begin")) web.post(this::closeBrowser);
            error(reply, id, publicError(failure));
        }
    }
    private void closeBrowser() {
        if (browser != null) { browser.close(); browser = null; }
    }
    private static String publicError(Exception e) {
        if (e instanceof WorkBuddySession.Fault) return e.getMessage();
        String code = e.getMessage();
        if (code != null && code.matches("login_expired|invalid_consent|personal_account_required|account_missing|invalid_token|sign_in_required|sign_in_expired|model|empty|text_only|search_query_length|search_response_too_large|invalid_search_response")) return code;
        return "connection_or_storage";
    }

    private static final class Call { volatile boolean cancelled; volatile HttpsURLConnection connection; }
    private synchronized void start(String id, JSONObject req, JavaScriptReplyProxy reply) {
        if (active.containsKey(id) || active.size() >= 3) { error(reply, id, "busy"); return; }
        Call call = new Call();
        active.put(id, call);
        network.execute(() -> WebDavCookies.isolate(() -> send(call, id, req, reply)));
    }
    private synchronized void cancel(String id) {
        Call call = active.get(id);
        if (call != null) {
            call.cancelled = true;
            HttpsURLConnection conn = call.connection;
            if (conn != null) conn.disconnect();
        }
    }
    private synchronized void cancelAll() { for (String id : active.keySet()) cancel(id); }

    private void send(Call call, String id, JSONObject req, JavaScriptReplyProxy reply) {
        HttpsURLConnection conn = null;
        try {
            boolean isSearch = "search".equals(req.getString("op"));
            byte[] body = WorkBuddyWire.body(req, isSearch).toString().getBytes(StandardCharsets.UTF_8);
            if (body.length > MAX_BODY) { error(reply, id, "too_large"); return; }
            JSONObject saved = session.account();
            String bearer = saved.getString("access");
            synchronized (this) {
                if (!saved.getString("revision").equals(req.getString("revision"))) { error(reply, id, "account_changed"); return; }
                if (closed || call.cancelled || !SecurityPlugin.isUnlocked()) { error(reply, id, "locked"); return; }
                conn = (HttpsURLConnection) new URL(isSearch ? WorkBuddyWire.SEARCH : WorkBuddyWire.CHAT).openConnection();
                call.connection = conn;
            }
            conn.setRequestMethod("POST");
            conn.setUseCaches(false);
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(120000);
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(body.length);
            conn.setRequestProperty("User-Agent", "DeepChat/Android");
            conn.setRequestProperty("Authorization", "Bearer " + bearer);
            conn.setRequestProperty("X-User-Id", saved.getString("uid"));
            conn.setRequestProperty("Accept", isSearch ? "application/json" : "text/event-stream");
            conn.setRequestProperty("Content-Type", "application/json");
            if (call.cancelled || closed || !SecurityPlugin.isUnlocked()) { error(reply, id, "cancelled"); return; }
            try (OutputStream out = conn.getOutputStream()) { out.write(body); }
            int status = conn.getResponseCode();
            String media = conn.getContentType();
            emit(reply, id, new JSONObject().put("type", "headers").put("status", status).put("contentType", media == null ? "" : media));
            if (isSearch && status >= 200 && status < 300) {
                try (InputStream in = conn.getInputStream()) {
                    byte[] result = WorkBuddyWire.searchResults(in, bearer);
                    if (call.cancelled || closed || !SecurityPlugin.isUnlocked()) { error(reply, id, "cancelled"); return; }
                    emit(reply, id, new JSONObject().put("type", "data").put("data", Base64.encodeToString(result, Base64.NO_WRAP)));
                }
                emit(reply, id, new JSONObject().put("type", "end"));
                return;
            }
            // Return only the bounded service error message and code. An upstream error can echo request headers.
            if (status < 200 || status >= 300 || media == null || !media.toLowerCase(java.util.Locale.ROOT).contains("text/event-stream")) {
                try (InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream()) {
                    byte[] bytes = boundedError(in, bearer);
                    emit(reply, id, new JSONObject().put("type", "data").put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)));
                }
            } else try (InputStream in = conn.getInputStream()) {
                byte[] buffer = new byte[8192]; int n, total = 0;
                while ((n = in.read(buffer)) != -1) {
                    if (call.cancelled || closed || !SecurityPlugin.isUnlocked()) { error(reply, id, "cancelled"); return; }
                    if ((total += n) > MAX_REPLY) { error(reply, id, "reply_too_large"); return; }
                    emit(reply, id, new JSONObject().put("type", "data").put("data", Base64.encodeToString(buffer, 0, n, Base64.NO_WRAP)));
                }
            }
            emit(reply, id, new JSONObject().put("type", "end"));
        } catch (Exception failure) { error(reply, id, publicError(failure)); }
        finally {
            if (conn != null) conn.disconnect();
            synchronized (this) { active.remove(id); }
        }
    }
    private static byte[] boundedError(InputStream in, String bearer) throws Exception {
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[2048];
        while (in != null && bytes.size() < 16384) {
            int n = in.read(buffer, 0, Math.min(buffer.length, 16384 - bytes.size()));
            if (n < 0) break;
            bytes.write(buffer, 0, n);
        }
        String raw = bytes.toString("UTF-8");
        JSONObject summary = new JSONObject();
        try {
            JSONObject data = new JSONObject(raw);
            JSONObject nested = data.optJSONObject("error");
            if (nested == null) nested = data;
            for (String field : new String[]{"code", "message", "msg", "error_msg", "type"}) {
                Object value = nested.opt(field);
                if (value instanceof String || value instanceof Number) {
                    String redacted = value.toString().replace(bearer, "[redacted]");
                    summary.put(field, redacted.substring(0, Math.min(300, redacted.length())));
                }
            }
        } catch (Exception nonJson) { /* The status and response media type still explain the failure. */ }
        return summary.toString().getBytes(StandardCharsets.UTF_8);
    }
    private void emit(JavaScriptReplyProxy reply, String id, JSONObject frame) {
        try { String data = frame.put("id", id).toString(); web.post(() -> {
            if (closed) return;
            try {
                if (!SecurityPlugin.isUnlocked() && !"error".equals(frame.optString("type"))) {
                    cancel(id);
                    reply.postMessage(new JSONObject().put("id", id).put("type", "error").put("code", "locked").toString());
                } else {
                    reply.postMessage(data);
                }
            } catch (Exception detached) { cancel(id); }
        }); } catch (Exception ignored) { /* page closed */ }
    }
    private void error(JavaScriptReplyProxy reply, String id, String code) {
        try { emit(reply, id, new JSONObject().put("type", "error").put("code", code)); } catch (Exception ignored) { /* page closed */ }
    }
    synchronized void close() {
        closed = true;
        closeBrowser();
        cancelAll();
        storage.shutdownNow(); network.shutdownNow();
        WebViewCompat.removeWebMessageListener(web, PORT);
    }
}
