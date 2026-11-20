package ai.deepseek.demo.shell;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Read-only discovery for an explicitly configured profile. This transport has no account/vault access. */
final class ProfileModelRequest {
    private static final int MAX_BYTES = 8 * 1024 * 1024;

    private volatile HttpURLConnection active;
    private volatile boolean cancelled;

    void cancel() {
        cancelled = true;
        HttpURLConnection conn = active;
        if (conn != null) conn.disconnect();
    }

    JSONObject fetch(JSONObject input) throws Exception {
        String endpoint = input.getString("endpoint");
        String target = input.getString("url");
        String auth = input.getString("auth");
        boolean show = input.has("model");
        URL url = validate(endpoint, target, auth, show);
        String key = input.optString("key");
        if (key.length() > 8192 || key.contains("\n") || key.contains("\r")) throw new IOException();
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        try {
            active = conn;
            if (cancelled) throw new IOException();
            conn.setInstanceFollowRedirects(false);
            conn.setUseCaches(false);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(12000);
            conn.setRequestProperty("Accept", "application/json");
            if ("anthropic".equals(auth)) {
                conn.setRequestProperty("anthropic-version", "2026-10-21");
                conn.setRequestProperty("x-api-key", key);
            } else if ("gemini".equals(auth)) {
                conn.setRequestProperty("x-goog-api-key", key);
            } else if (!key.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + key);
            if (show) {
                String model = input.getString("model");
                if (model.isEmpty() || model.length() > 4096) throw new IOException();
                byte[] body = new JSONObject().put("model", model).toString().getBytes(StandardCharsets.UTF_8);
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(body.length);
                try (OutputStream os = conn.getOutputStream()) { os.write(body); }
            }
            int code = conn.getResponseCode();
            JSONObject result = new JSONObject().put("status", code);
            if (code < 200 || code >= 300) return result.put("body", "");
            if (conn.getContentLength() > MAX_BYTES) throw new IOException();
            try (InputStream stream = conn.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[16384];
                int n;
                while ((n = stream.read(buffer)) != -1) {
                    if (out.size() + n > MAX_BYTES) throw new IOException();
                    out.write(buffer, 0, n);
                }
                return result.put("body", out.toString("UTF-8"));
            }
        } finally { conn.disconnect(); }
    }

    static URL validate(String endpoint, String target, String auth, boolean show) throws Exception {
        URI base = safeUri(endpoint), uri = safeUri(target);
        URL url = uri.toURL(), origin = base.toURL();
        if (base.getRawQuery() != null || !uri.getScheme().equals(base.getScheme())
                || !uri.getHost().equalsIgnoreCase(base.getHost())
                || effectivePort(url) != effectivePort(origin)) throw new IOException();
        String path = uri.getRawPath(), prefix = base.getRawPath().replaceAll("/+$", "");
        String root = prefix.replaceFirst("/v1$", "");
        boolean officialHttps = "https".equals(url.getProtocol()) && effectivePort(url) == 443;
        boolean allowed;
        switch (auth) {
            case "anthropic":
                allowed = !show && officialHttps && "api.anthropic.com".equals(uri.getHost()) && (prefix.isEmpty() || prefix.equals("/v1")) && path.equals("/v1/models");
                break;
            case "gemini":
                allowed = !show && officialHttps && "generativelanguage.googleapis.com".equals(uri.getHost()) && prefix.equals("/v1beta/openai") && path.equals("/v1beta/models");
                break;
            case "bearer":
                allowed = show ? path.equals(root + "/api/show") :
                        Arrays.asList(prefix + "/models", root + "/api/tags", root + "/api/ps", root + "/api/v1/models", root + "/api/v0/models").contains(path)
                        || officialHttps && "api.sensenova.cn".equals(uri.getHost()) && prefix.matches("/compatible-mode/v[12]") && path.equals("/v1/llm/models")
                        || officialHttps && "opencode.ai".equals(uri.getHost()) && prefix.matches("/inference(/go)?/openai/v1") && path.equals(prefix.replace("/openai/v1", "/v1/models"))
                        || officialHttps && "api.cohere.ai".equals(uri.getHost()) && prefix.equals("/compatibility/v1") && path.equals("/v1/models")
                        || officialHttps && "openrouter.ai".equals(uri.getHost()) && prefix.equals("/api/v1") && path.equals("/api/v1/models/user");
                break;
            default: allowed = false;
        }
        if (!allowed) throw new IOException();
        if (uri.getRawQuery() != null) for (String param : uri.getRawQuery().split("&")) {
            String[] pair = param.split("=", 2);
            if (show || pair.length != 2 || !Arrays.asList("limit", "after_id", "pageSize", "pageToken", "page_size", "page_token", "output_modalities").contains(pair[0])) throw new IOException();
        }
        return url;
    }

    private static URI safeUri(String value) throws Exception {
        if (value.length() > 16384 || value.contains("\\")) throw new IOException();
        URI uri = new URI(value);
        if (uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawFragment() != null
                || !uri.normalize().getRawPath().equals(uri.getRawPath())
                || uri.getRawPath().matches("(?i).*%(?:2f|5c|2e).*")) throw new IOException();
        String host = uri.getHost();
        if (!"https".equals(uri.getScheme()) && !("http".equals(uri.getScheme()) &&
                host.matches("localhost|\\[::1\\]|127\\.\\d+\\.\\d+\\.\\d+|10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+"))) throw new IOException();
        return uri;
    }

    private static int effectivePort(URL url) { return url.getPort() == -1 ? url.getDefaultPort() : url.getPort(); }
}
