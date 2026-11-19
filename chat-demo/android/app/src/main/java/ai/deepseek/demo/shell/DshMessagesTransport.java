package ai.deepseek.demo.shell;

import android.util.Base64;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Proxy;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;

/** Credential-bearing fetch for the bundled app's WebMessage bridge. Each operation owns its grant snapshot. */
final class DshMessagesTransport {
    interface Reply { void send(JSONObject frame); }

    private static final String ORIGIN = "https://api.deepseek.com";
    private static final String FILES_BETA = "files-api-2025-04-14";
    private static final int MIB = 1024 * 1024;
    private static final int ACTIVE_LIMIT = 4;
    static final int UPLOAD_CHUNK = 96 * 1024;
    private static final int UPLOAD_IDLE_MS = 10 * 60 * 1000;
    private static final Pattern DELETE_FILE = Pattern.compile("/anthropic/v1/files/[A-Za-z0-9_-]{1,192}");
    private static final Pattern MULTIPART_TYPE = Pattern.compile("multipart/form-data;\\s*boundary=(?:[A-Za-z0-9'()+_,./:=?-]{1,70}|\"[A-Za-z0-9'()+_,./:=?-]{1,70}\")", Pattern.CASE_INSENSITIVE);
    private static final Pattern JSON_TYPE = Pattern.compile("application/json(?:; *charset=UTF-8)?", Pattern.CASE_INSENSITIVE);
    private static final ThreadFactory WORKER = runnable -> {
        Thread t = new Thread(runnable, "deepchat-account-network");
        t.setDaemon(true);
        return t;
    };

    private final DshAccountHost account;
    private final Map<String,Call> calls = new HashMap<>();
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(0, ACTIVE_LIMIT, 30, TimeUnit.SECONDS, new SynchronousQueue<>(), WORKER);
    private final ScheduledThreadPoolExecutor monitor = new ScheduledThreadPoolExecutor(1, WORKER);
    private boolean closed;

    DshMessagesTransport(DshAccountHost account) {
        this.account = account;
        monitor.setRemoveOnCancelPolicy(true);
    }

    void start(String id, String urlPath, String method, String contentType, String base64Body, Reply sink) {
        start(id, urlPath, method, contentType, base64Body == null ? "" : base64Body, 0, sink);
    }

    void startUpload(String id, String path, String method, String media, long length, Reply sink) {
        start(id, path, method, media, null, length, sink);
    }

    private void start(String id, String urlPath, String method, String contentType, String body, long length, Reply sink) {
        Route route = Route.resolve(urlPath, method);
        boolean upload = body == null;
        if (route == null || upload != (route == Route.FILE_UPLOAD)) { httpError(sink, 403, "此账户连接仅支持应用中的官方接口。"); return; }
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,128}")) { httpError(sink, 400, "请求标识无效。"); return; }
        String media = contentType == null ? "" : contentType;
        if (upload ? length > route.requestLimit : body.length() > 4L * ((route.requestLimit + 2) / 3)) {
            httpError(sink, 413, "请求超过本机传输大小限制。"); return;
        }
        if (!route.accepts(media, upload ? length > 0 : !body.isEmpty())) { httpError(sink, 415, "请求内容格式不受支持。"); return; }
        String token = account.token();
        if (token == null || token.isEmpty()) { httpError(sink, 401, "请先在手机上的账户页登录。"); return; }
        Call call = new Call(token, sink, (int) length);
        synchronized (this) {
            if (closed) { error(sink, "账户连接已关闭。"); return; }
            if (calls.size() >= ACTIVE_LIMIT || calls.containsKey(id)) { httpError(sink, 429, "请等待正在进行的请求完成。"); return; }
            calls.put(id, call);
            try {
                call.watchdog = monitor.scheduleWithFixedDelay(call::checkLifetime, 1, 1, TimeUnit.SECONDS);
                workers.execute(() -> {
                    try { call.run(route, urlPath, method, media, body); }
                    finally {
                        call.dispose();
                        synchronized (DshMessagesTransport.this) { if (calls.get(id) == call) calls.remove(id); }
                    }
                });
            } catch (RejectedExecutionException full) {
                calls.remove(id);
                call.dispose();
                httpError(sink, 429, "请稍后重试。");
            }
        }
    }

    void chunk(String id, long offset, String body) {
        Call call;
        synchronized (this) { call = calls.get(id); }
        if (call != null && !call.offerChunk(offset, body)) call.abort("文件传输状态无效。");
    }

    void cancel(String id) {
        Call call;
        synchronized (this) { call = calls.get(id); }
        if (call != null) call.abort("请求已取消。");
    }

    void close() {
        ArrayList<Call> active;
        synchronized (this) {
            closed = true;
            active = new ArrayList<>(calls.values());
        }
        for (Call call : active) call.abort("账户连接已关闭。");
        workers.shutdownNow();
        monitor.shutdownNow();
    }

    private enum Route {
        // Attachment policy permits a 100 MiB file. Leave separate room for the MIME envelope.
        MESSAGES(4 * MIB, 16 * MIB), FILE_UPLOAD(100 * MIB + 64 * 1024, MIB), FILE_DELETE(0, MIB),
        ASR(8 * MIB + 8192, MIB), TTS(MIB, 32 * MIB);

        final int requestLimit, responseLimit;
        Route(int requestLimit, int responseLimit) { this.requestLimit = requestLimit; this.responseLimit = responseLimit; }

        static Route resolve(String path, String method) {
            if (path == null || path.length() > 256) return null;
            if ("DELETE".equals(method) && DELETE_FILE.matcher(path).matches()) return FILE_DELETE;
            if (!"POST".equals(method)) return null;
            switch (path) {
                case "/anthropic/v1/messages": return MESSAGES;
                case "/anthropic/v1/files": return FILE_UPLOAD;
                case "/v1/tools/asr": return ASR;
                case "/v1/tools/tts": return TTS;
                default: return null;
            }
        }

        boolean accepts(String type, boolean hasBody) {
            if (this == FILE_DELETE) return !hasBody;
            if (!hasBody || type.length() > 128 || type.indexOf('\r') >= 0 || type.indexOf('\n') >= 0) return false;
            return (this == FILE_UPLOAD || this == ASR ? MULTIPART_TYPE : JSON_TYPE).matcher(type).matches();
        }
    }

    /** The bundled app emits normal JSON.stringify keys. Match the key and colon outside string content. */
    private static boolean containsFileReference(byte[] json) {
        final byte[] key = "file_id".getBytes(StandardCharsets.US_ASCII);
        for (int i = 0; i < json.length; i++) {
            if (json[i] != '"') continue;
            int start = ++i;
            while (i < json.length && json[i] != '"') { if (json[i] == '\\') i++; i++; }
            if (i - start != key.length) continue;
            int part = 0;
            while (part < key.length && json[start + part] == key[part]) part++;
            if (part != key.length) continue;
            int next = i + 1;
            while (next < json.length && (json[next] & 0xff) <= 32) next++;
            if (next < json.length && json[next] == ':') return true;
        }
        return false;
    }

    private static JSONObject frame(String type, Object... fields) {
        try {
            JSONObject result = new JSONObject().put("type", type);
            for (int i = 0; i < fields.length; i += 2) result.put((String) fields[i], fields[i + 1]);
            return result;
        } catch (JSONException impossible) { throw new AssertionError(impossible); }
    }

    private static void error(Reply sink, String detail) { sink.send(frame("error", "message", detail)); }

    private static void httpError(Reply sink, int status, String detail) {
        // Provider error bodies can echo user content or credentials. Emit a local, status-specific diagnostic.
        byte[] payload = ("{\"error\":{\"message\":" + JSONObject.quote(detail) + "}}").getBytes(StandardCharsets.UTF_8);
        sink.send(frame("headers", "status", status, "contentType", "application/json"));
        sink.send(frame("data", "base64", Base64.encodeToString(payload, Base64.NO_WRAP)));
        sink.send(frame("end"));
    }

    private static String httpDetail(int status) {
        switch (status) {
            case 400: return "服务未接受请求参数。";
            case 401: return "授权已过期，请在账户页重新登录。";
            case 402: return "账户额度不足，请检查账户余额。";
            case 403: return "此账户没有该接口或模型的权限。";
            case 404: return "请求的模型、文件或接口不存在。";
            case 413: return "服务拒绝了过大的请求。";
            case 429: return "请求过于频繁，请稍后重试。";
            default: return "官方接口返回 HTTP " + status + "。";
        }
    }

    private final class Call {
        final String token;
        final Reply sink;
        final int uploadLength;
        // One pull is outstanding at a time. Only the worker decodes and writes its reply.
        private int expectedOffset = -1;
        private String pendingChunk;
        private volatile long lastProgress = android.os.SystemClock.elapsedRealtime();
        java.util.concurrent.ScheduledFuture<?> watchdog;
        private HttpsURLConnection connection;
        private boolean ended;

        Call(String token, Reply sink, int uploadLength) {
            this.token = token;
            this.sink = sink;
            this.uploadLength = uploadLength;
        }

        void checkLifetime() {
            if (!token.equals(account.token())) abort("登录状态已变更，请重试。");
            else if (android.os.SystemClock.elapsedRealtime() - lastProgress >= (uploadLength > 0 ? UPLOAD_IDLE_MS : 300000)) abort("账户请求已超时。");
        }

        synchronized boolean offerChunk(long offset, String encoded) {
            if (ended || expectedOffset < 0 || offset != expectedOffset || pendingChunk != null) return false;
            int size = Math.min(UPLOAD_CHUNK, uploadLength - expectedOffset);
            if (encoded.length() != 4 * ((size + 2) / 3)) return false;
            pendingChunk = encoded;
            notifyAll();
            return true;
        }

        private synchronized String pullChunk(int offset, int size) throws Exception {
            checkActive();
            expectedOffset = offset;
            send(frame("pull", "offset", offset, "length", size), false);
            while (pendingChunk == null) {
                checkActive();
                wait(); // cancel, account change and the inactivity watchdog all wake this worker
            }
            checkActive();
            String encoded = pendingChunk;
            pendingChunk = null;
            expectedOffset = -1;
            return encoded;
        }

        private void writeUpload(OutputStream out) throws Exception {
            for (int offset = 0; offset < uploadLength;) {
                int size = Math.min(UPLOAD_CHUNK, uploadLength - offset);
                byte[] chunk = Base64.decode(pullChunk(offset, size), Base64.NO_WRAP);
                if (chunk.length != size) throw new IOException();
                checkActive();
                out.write(chunk);
                offset += size;
                lastProgress = android.os.SystemClock.elapsedRealtime();
            }
        }

        private synchronized void send(JSONObject data, boolean terminal) throws IOException {
            if (ended || !token.equals(account.token())) throw new IOException();
            if (terminal) ended = true;
            sink.send(data);
        }

        void abort(String why) {
            HttpsURLConnection active;
            synchronized (this) {
                if (ended) return;
                ended = true;
                notifyAll();
                active = connection;
                try { error(sink, why); } catch (RuntimeException disposedBridge) { }
            }
            if (active != null) active.disconnect();
        }

        void dispose() {
            if (watchdog != null) watchdog.cancel(false);
            HttpsURLConnection active;
            synchronized (this) { active = connection; connection = null; }
            if (active != null) active.disconnect();
        }

        private synchronized void checkActive() throws IOException {
            if (ended || !token.equals(account.token())) throw new IOException();
        }

        private synchronized void reject(int status, String detail) {
            if (ended) return;
            ended = true;
            // Claim the response before expiry notification can replace this request's 401.
            if (status == 401) account.rejectToken(token);
            httpError(sink, status, detail);
        }

        void run(Route route, String path, String method, String media, String encoded) {
            try {
                byte[] body = null;
                if (encoded != null) {
                    try { body = Base64.decode(encoded, Base64.DEFAULT); }
                    catch (IllegalArgumentException invalid) { reject(400, "请求内容编码无效。"); return; }
                    if (body.length > route.requestLimit) { reject(413, "请求超过本机传输大小限制。"); return; }
                }
                boolean fileReferences = route == Route.MESSAGES && containsFileReference(body);
                checkActive();
                HttpsURLConnection http = (HttpsURLConnection)new URL(ORIGIN + path).openConnection(Proxy.NO_PROXY);
                synchronized (this) { checkActive(); connection = http; }
                http.setInstanceFollowRedirects(false);
                http.setUseCaches(false);
                http.setConnectTimeout(12000);
                http.setReadTimeout(route == Route.FILE_UPLOAD ? UPLOAD_IDLE_MS : 90000);
                http.setRequestMethod(method);
                http.setRequestProperty("User-Agent", account.userAgent);
                http.setRequestProperty("x-dsh-auth-token", token);
                if (route == Route.MESSAGES || route == Route.FILE_UPLOAD || route == Route.FILE_DELETE) {
                    http.setRequestProperty("anthropic-version", "2023-06-01");
                    if (route != Route.MESSAGES || fileReferences) {
                        http.setRequestProperty("anthropic-beta", FILES_BETA);
                    }
                }
                if (route == Route.MESSAGES) http.setRequestProperty("Accept", "text/event-stream, application/json");
                if (route != Route.FILE_DELETE) {
                    http.setRequestProperty("Content-Type", media);
                    http.setDoOutput(true);
                    http.setFixedLengthStreamingMode(route == Route.FILE_UPLOAD ? uploadLength : body.length);
                    checkActive();
                    try (OutputStream out = http.getOutputStream()) {
                        if (route == Route.FILE_UPLOAD) writeUpload(out);
                        else {
                            for (int offset = 0; offset < body.length; offset += 32768) {
                                checkActive();
                                out.write(body, offset, Math.min(32768, body.length - offset));
                            }
                        }
                    }
                }
                checkActive();
                int status = http.getResponseCode();
                if (status < 200 || status >= 300) {
                    if (status >= 300 && status < 400) reject(502, "官方接口返回了重定向。");
                    else if (status >= 400 && status <= 599) reject(status, DshFileErrors.detail(http, status, path, fileReferences, httpDetail(status)));
                    else reject(502, "官方接口返回了无效状态。");
                    return;
                }
                String raw = http.getContentType();
                String type = raw == null ? "" : raw.split(";", 2)[0].trim().toLowerCase(java.util.Locale.ROOT);
                if (type.length() > 96 || !type.matches("[a-z0-9.+-]+/[a-z0-9.+-]+")) type = "application/octet-stream";
                send(frame("headers", "status", status, "contentType", type), false);
                if (status != 204 && status != 205) {
                    try (InputStream input = http.getInputStream()) {
                        byte[] block = new byte[16 * 1024];
                        int total = 0;
                        for (int count; (count = input.read(block)) != -1;) {
                            if (count == 0) continue;
                            total += count;
                            if (total > route.responseLimit) { abort("服务响应超过本机传输大小限制。"); return; }
                            send(frame("data", "base64", Base64.encodeToString(block, 0, count, Base64.NO_WRAP)), false);
                        }
                    }
                }
                send(frame("end"), true);
            } catch (SocketTimeoutException timeout) { abort("账户请求已超时，请检查网络。"); }
              catch (Exception failure) { abort(token.equals(account.token()) ? "账户请求中断，请检查网络后重试。" : "登录状态已变更，请重试。"); }
        }
    }
}
