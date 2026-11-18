package ai.deepseek.demo.shell;

import android.util.Base64;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.Objects;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;

/** An explicitly started, process-local service for native clients on the same phone. */
final class DshLocalProxy {
    private static final String MESSAGES = "https://api.deepseek.com/anthropic/v1/messages";
    private static final int MAX_ACTIVE = 4;
    private static final int MAX_BODY = 512 * 1024;
    private final DshAccountHost account;
    private final Set<Call> calls = new HashSet<>();
    private ServerSocket listener;
    private ScheduledThreadPoolExecutor clock;
    private String key = "";
    private String enabledFor;

    DshLocalProxy(DshAccountHost account) { this.account = account; }

    synchronized JSONObject start() {
        String owner = account.token();
        if (owner == null) throw new IllegalStateException("请先登录账户。");
        if (listener != null && owner.equals(enabledFor)) return status();
        if (listener != null) stop();
        ServerSocket server = null;
        try {
            byte[] secret = new byte[32];
            new SecureRandom().nextBytes(secret);
            server = new ServerSocket();
            server.bind(new InetSocketAddress(InetAddress.getByAddress(new byte[]{127, 0, 0, 1}), 0), 8);
            key = Base64.encodeToString(secret, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            final ServerSocket active = server;
            listener = active;
            enabledFor = owner;
            clock = new ScheduledThreadPoolExecutor(1, r -> daemon(r, "dsh-local-deadline"));
            clock.setRemoveOnCancelPolicy(true);
            clock.scheduleWithFixedDelay(() -> {
                if (!Objects.equals(owner, account.token())) {
                    synchronized (DshLocalProxy.this) { if (listener == active) stop(); }
                }
            }, 1, 1, TimeUnit.SECONDS);
            daemon(() -> accept(active), "dsh-local-listener").start();
            return status();
        } catch (IOException | RuntimeException failure) {
            close(server);
            stop();
            throw new IllegalStateException("Could not start the local endpoint");
        }
    }

    synchronized JSONObject status() {
        try {
            return new JSONObject().put("running", listener != null).put("key", key)
                .put("baseURL", listener == null ? "" : "http://127.0.0.1:" + listener.getLocalPort() + "/v1");
        } catch (JSONException impossible) { throw new AssertionError(impossible); }
    }

    void stop() {
        ArrayList<Call> active;
        synchronized (this) {
            key = "";
            enabledFor = null;
            close(listener);
            listener = null;
            if (clock != null) clock.shutdownNow();
            clock = null;
            active = new ArrayList<>(calls);
            calls.clear();
        }
        for (Call call : active) call.cancel();
    }

    private void accept(ServerSocket server) {
        try {
            while (!server.isClosed()) {
                Socket socket = server.accept();
                synchronized (this) {
                    if (listener != server || calls.size() >= MAX_ACTIVE || !socket.getInetAddress().isLoopbackAddress()) {
                        close(socket);
                        continue;
                    }
                    Call call = new Call(socket, key);
                    calls.add(call);
                    ScheduledFuture<?> deadline = clock.schedule(call::cancel, 180, TimeUnit.SECONDS);
                    daemon(() -> {
                        try { call.serve(); }
                        finally {
                            deadline.cancel(false);
                            call.cancel();
                            synchronized (DshLocalProxy.this) { calls.remove(call); }
                        }
                    }, "dsh-local-client").start();
                }
            }
        } catch (IOException failure) {
            synchronized (this) { if (listener == server) stop(); }
        }
    }

    private static Thread daemon(Runnable run, String name) {
        Thread thread = new Thread(run, name);
        thread.setDaemon(true);
        return thread;
    }

    private static void close(java.io.Closeable resource) {
        if (resource != null) try { resource.close(); } catch (IOException ignored) { }
    }

    static class Problem extends IOException {
        final int status;
        Problem(int status, String detail) { super(detail); this.status = status; }
    }

    private final class Call {
        final Socket socket;
        final String assignedKey;
        HttpsURLConnection upstream;
        boolean cancelled;
        boolean committed;
        boolean streaming;
        OutputStream client;

        Call(Socket socket, String key) { this.socket = socket; assignedKey = key; }

        void cancel() {
            HttpsURLConnection connection;
            synchronized (this) {
                cancelled = true;
                connection = upstream;
                upstream = null;
            }
            close(socket);
            if (connection != null) connection.disconnect();
        }

        void serve() {
            try {
                socket.setSoTimeout(8000);
                client = socket.getOutputStream();
                BufferedInputStream input = new BufferedInputStream(socket.getInputStream());
                String[] request = line(input, 2048).split(" ", -1);
                if (request.length != 3 || !(request[2].equals("HTTP/1.1") || request[2].equals("HTTP/1.0")))
                    throw new Problem(400, "Invalid HTTP request");
                Map<String,String> headers = headers(input);
                String host = headers.get("host");
                if (host == null || !host.matches("(?i)(127\\.0\\.0\\.1|localhost)(:[0-9]{1,5})?"))
                    throw new Problem(403, "Loopback host required");
                // Browsers are outside the local-key client interface. Do not issue CORS grants.
                if (headers.containsKey("origin")) throw new Problem(403, "Browser origins are not supported");
                String auth = headers.get("authorization");
                if (auth == null || !MessageDigest.isEqual(("Bearer " + assignedKey).getBytes(StandardCharsets.US_ASCII), auth.getBytes(StandardCharsets.US_ASCII)))
                    throw new Problem(401, "A valid local bearer key is required");
                if (headers.containsKey("transfer-encoding")) throw new Problem(400, "Content-Length framing required");
                if ("/v1/models".equals(request[1]) && "GET".equals(request[0])) {
                    json(200, DshProxyMessages.models());
                } else if ("/v1/chat/completions".equals(request[1]) && "POST".equals(request[0])) {
                    String media = headers.get("content-type");
                    if (media == null || !media.split(";", 2)[0].trim().equalsIgnoreCase("application/json"))
                        throw new Problem(415, "Expected application/json");
                    String length = headers.get("content-length");
                    if (length == null || !length.matches("[0-9]{1,9}")) throw new Problem(411, "Content-Length required");
                    int size = Integer.parseInt(length);
                    if (size > MAX_BODY) throw new Problem(413, "Request body exceeds the local limit");
                    byte[] body = new byte[size];
                    new java.io.DataInputStream(input).readFully(body);
                    DshProxyMessages messages = new DshProxyMessages(new String(body, StandardCharsets.UTF_8));
                    relay(messages);
                } else throw new Problem(404, "Unknown endpoint or method");
            } catch (Problem e) { fail(e.status, e.getMessage()); }
              catch (SocketTimeoutException timeout) { fail(504, "Request timed out"); }
              catch (Exception failure) { fail(502, "Could not complete this request"); }
        }

        private void relay(DshProxyMessages messages) throws Exception {
            String token;
            synchronized (DshLocalProxy.this) {
                token = enabledFor;
                if (!assignedKey.equals(key) || token == null || token.isEmpty() || !token.equals(account.token())) {
                    throw new Problem(401, "Sign in and enable the local endpoint for this account");
                }
            }
            HttpsURLConnection connection = (HttpsURLConnection) new URL(MESSAGES).openConnection(Proxy.NO_PROXY);
            synchronized (this) {
                if (cancelled) { connection.disconnect(); throw new IOException(); }
                upstream = connection;
            }
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(90000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("x-dsh-auth-token", token);
            connection.setRequestProperty("anthropic-version", "2023-06-01");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "text/event-stream");
            connection.setRequestProperty("User-Agent", account.userAgent);
            byte[] body = messages.upstream.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            int code = connection.getResponseCode();
            if (code == 401) { account.rejectToken(token); throw new Problem(401, "Account authorization expired"); }
            if (code == 402 || code == 429 || code == 403 || code == 400)
                throw new Problem(code, code == 402 ? "Account quota unavailable" : "The model service declined the request");
            if (code != 200) throw new Problem(502, "The model service is unavailable");
            String contentType = connection.getContentType();
            if (contentType == null || !contentType.toLowerCase(Locale.ROOT).startsWith("text/event-stream"))
                throw new Problem(502, "Unexpected model response format");
            try (InputStream input = new BufferedInputStream(connection.getInputStream())) {
                if (messages.stream) {
                    head(200, "text/event-stream; charset=utf-8", -1);
                    streaming = true;
                }
                JSONObject result = messages.receive(input, messages.stream ? client : null);
                if (!messages.stream) json(200, result);
            }
        }

        private void head(int code, String type, int length) throws IOException {
            committed = true;
            String headers = "HTTP/1.1 " + code + (code == 200 ? " OK" : " Error") + "\r\nContent-Type: " + type
                + "\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
                + (length < 0 ? "" : "Content-Length: " + length + "\r\n") + "\r\n";
            client.write(headers.getBytes(StandardCharsets.US_ASCII));
            client.flush();
        }

        private void json(int code, JSONObject data) throws IOException {
            byte[] bytes = data.toString().getBytes(StandardCharsets.UTF_8);
            head(code, "application/json; charset=utf-8", bytes.length);
            client.write(bytes);
            client.flush();
        }

        private void fail(int code, String detail) {
            if (client == null) return;
            try {
                JSONObject error = new JSONObject().put("error", new JSONObject().put("message", detail).put("type", "local_proxy_error").put("code", code));
                if (!committed) json(code, error);
                else if (streaming) DshProxyMessages.event(client, error.toString());
            } catch (Exception ignored) { }
        }
    }

    private static Map<String,String> headers(InputStream input) throws IOException {
        Map<String,String> headers = new HashMap<>();
        int total = 0;
        while (true) {
            String header = line(input, 8192);
            if (header.isEmpty()) return headers;
            total += header.length() + 2;
            int split = header.indexOf(':');
            if (total > 16384 || headers.size() >= 64 || split < 1) throw new Problem(400, "Invalid request headers");
            String name = header.substring(0, split).toLowerCase(Locale.ROOT);
            if (!name.matches("[!#$%&'*+.^_`|~a-z0-9-]+") || headers.put(name, header.substring(split + 1).trim()) != null)
                throw new Problem(400, "Invalid or duplicate header");
        }
    }

    static String line(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(128);
        for (int value; (value = input.read()) >= 0; ) {
            if (value == '\n') {
                String text = buffer.toString("UTF-8");
                return text.endsWith("\r") ? text.substring(0, text.length() - 1) : text;
            }
            if (buffer.size() >= limit) throw new Problem(limit > 8192 ? 502 : 400, "Input line exceeds the limit");
            buffer.write(value);
        }
        throw new EOFException();
    }
}
