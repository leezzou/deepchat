package ai.deepseek.demo.shell;

import java.io.IOException;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import javax.net.ssl.HttpsURLConnection;

/** Derive one API operation from a saved profile. The bridge cannot supply an HTTP target or headers. */
final class ProfileChatTarget {
    final URL url;
    private final boolean messages, claude;
    private final String key;

    ProfileChatTarget(String origin, String protocol, String operation, String key, String digest) throws Exception {
        if (origin.length() > 8192 || key.length() > 8192 || !key.matches("[\\x20-\\x7e]*") || !digest(key).equals(digest)) throw new IOException();
        URI uri = new URI(origin);
        String path = uri.getRawPath();
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawFragment() != null
                || uri.getRawQuery() != null || path == null || !path.matches("[a-zA-Z0-9_~/.:@!$&'()+,=;-]*")
                || !uri.normalize().getRawPath().equals(path) || uri.getPort() > 65535) throw new IOException();
        String base = origin.replaceAll("/+$", "");
        boolean officialClaude = base.equals("https://api.anthropic.com") || base.equals("https://api.anthropic.com/v1");
        claude = officialClaude && (protocol.equals("openai") || protocol.equals("anthropic"));
        messages = operation.equals("messages");
        if (messages && claude) url = new URL("https://api.anthropic.com/v1/messages");
        else if (messages && protocol.equals("deepseek")) url = new URL(base + "/anthropic/v1/messages");
        else if (!claude && protocol.equals("openai") && operation.equals("chat")) url = new URL(base + "/chat/completions");
        else if (protocol.equals("openai") && base.equals("https://api.openai.com/v1") && operation.equals("responses")) url = new URL(base + "/responses");
        else throw new IOException();
        this.key = key;
    }

    static String digest(String key) throws Exception {
        StringBuilder hex = new StringBuilder(64);
        for (byte b : MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8))) {
            hex.append(Character.forDigit((b & 255) >> 4, 16)).append(Character.forDigit(b & 15, 16));
        }
        return hex.toString();
    }

    void configure(HttpsURLConnection http, int size, boolean json, boolean beta, String session) throws Exception {
        http.setInstanceFollowRedirects(false);
        http.setUseCaches(false);
        http.setConnectTimeout(15_000);
        http.setReadTimeout(150_000);
        http.setRequestMethod("POST");
        http.setDoOutput(true);
        http.setFixedLengthStreamingMode(size);
        http.setRequestProperty("Content-Type", "application/json");
        http.setRequestProperty("Accept", json ? "application/json" : "text/event-stream");
        if (messages) {
            if (!key.isEmpty()) http.setRequestProperty("x-api-key", key);
            if (claude) http.setRequestProperty("anthropic-version", "2026-10-21");
            if (beta) http.setRequestProperty("anthropic-beta", "files-api-2025-04-14");
        } else if (!key.isEmpty()) http.setRequestProperty("Authorization", "Bearer " + key);
        if (url.getHost().equals("opencode.ai") && session.matches("[A-Za-z0-9-]{1,64}")) http.setRequestProperty("x-opencode-session", session);
    }

    String safeError(String text) { return key.isEmpty() ? text : text.replace(key, "[redacted]"); }
}
