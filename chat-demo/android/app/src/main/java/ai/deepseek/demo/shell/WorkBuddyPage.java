package ai.deepseek.demo.shell;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native, memory-only grants for URLs returned by Tencent WebSearch. */
final class WorkBuddyPage {
    static final String ENDPOINT = "https://copilot.tencent.com/agenttool/v1/webfetch";
    static final int TEXT_LIMIT = 12000, RESPONSE_BYTES = 256 * 1024, MAX_BATCHES = 6;
    static final long TTL_MS = 5 * 60_000L;
    private static final Pattern CREDENTIAL_PARAM = Pattern.compile(
            "(?i)(?:^|[&;])(?:[^&;=]*(?:token|password|passwd|credential|signature|api[_-]?key)|key|secret|sig|auth|authorization|session(?:id)?|code)=" );
    private static final Pattern LOCAL_DOMAIN = Pattern.compile(
            "(?:.*\\.)?(?:localhost|localdomain|local|lan|home|home\\.arpa|internal|intranet|corp|onion|invalid|test|example|arpa)");
    // Keep whole bounded WebSearch responses together so a long result list cannot evict its first hit.
    private final LinkedHashMap<String, Batch> batches = new LinkedHashMap<>();

    static final class Grant {
        final String model, url;
        private Grant(String model, String url) {
            this.model = model;
            this.url = url;
        }
        JSONObject body() throws Exception {
            // Fixed task: never send the user's question, chat history, or a caller-supplied prompt.
            return new JSONObject().put("url", url).put("format", "markdown")
                    .put("prompt", "Extract the main page text verbatim in its original language.")
                    .put("timeout", 20).put("max_length", TEXT_LIMIT).put("model_name", model);
        }
    }

    /** Validate syntax without resolving source names on the device. Only the Tencent endpoint is contacted. */
    static boolean eligible(String url) {
        if (url == null || url.length() > 4096) return false;
        try {
            URI uri = new URI(url);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null
                    || (uri.getPort() != -1 && uri.getPort() != 443) || uri.getRawFragment() != null) return false;
            String host = uri.getHost();
            if (host == null || host.length() > 253) return false;
            host = host.toLowerCase(Locale.ROOT);
            // Require a DNS name with an alphabetic (or IDN) TLD. This also excludes IP literals,
            // shorthand IPv4, single-number and hexadecimal address forms, and IPv6 zone identifiers.
            int dot = host.lastIndexOf('.');
            if (dot <= 0 || !host.substring(dot + 1).matches("(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})")
                    || LOCAL_DOMAIN.matcher(host).matches()) return false;
            String query = uri.getQuery();
            return !unsafeComponent(uri.getPath()) && (query == null
                    || (!unsafeComponent(query) && !CREDENTIAL_PARAM.matcher(query).find()));
        } catch (Exception invalid) { return false; }
    }

    private static boolean unsafeComponent(String value) {
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch == '\\' || Character.isISOControl(ch)) return true;
        }
        return false;
    }

    static final class Batch {
        final String revision, model;
        final long expiresAt;
        private final Map<String, String> urls = new HashMap<>();

        Batch(String revision, String model, long now) {
            this.revision = revision;
            this.model = model;
            this.expiresAt = now + TTL_MS;
        }

        /** Prepare on the network worker. The caller installs the batch after its final cancellation check. */
        byte[] attachKeys(byte[] sanitizedSearch) throws Exception {
            JSONObject response = new JSONObject(new String(sanitizedSearch, StandardCharsets.UTF_8));
            JSONArray rows = response.optJSONArray("results");
            if (rows == null) return sanitizedSearch;
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                String url = row.getString("url");
                if (!eligible(url)) continue;
                String key = UUID.randomUUID().toString();
                urls.put(key, url);
                row.put("readKey", key);
            }
            return response.toString().getBytes(StandardCharsets.UTF_8);
        }
    }

    synchronized void install(String searchId, Batch batch) {
        if (batch.urls.isEmpty()) return;
        batches.remove(searchId);
        if (batches.size() >= MAX_BATCHES) batches.remove(batches.keySet().iterator().next());
        batches.put(searchId, batch);
    }

    synchronized Grant take(JSONObject req, String revision, String model, long now) throws Exception {
        // id/op/model/revision/readKey form the complete bridge protocol; no URLs, headers, or payload overrides.
        Object key = req.opt("readKey");
        if (req.length() != 5 || !(req.opt("id") instanceof String) || !"read".equals(req.opt("op"))
                || !revision.equals(req.opt("revision")) || !model.equals(req.opt("model"))
                || !(key instanceof String) || ((String) key).length() != 36) throw new IOException("invalid_read_key");
        for (Batch batch : batches.values()) {
            if (now >= batch.expiresAt || !revision.equals(batch.revision) || !model.equals(batch.model)) continue;
            String url = batch.urls.remove(key);
            if (url != null) return new Grant(model, url);
        }
        throw new IOException("invalid_read_key");
    }

    synchronized void revoke(String searchId) { batches.remove(searchId); }
    synchronized void clear() { batches.clear(); }

    /** The official CLI reads top-level url (final URL), content_type and content after checking code. */
    static byte[] result(InputStream in, Grant grant, String bearer) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        for (int n; (n = in.read(buffer)) != -1;) {
            if (out.size() + n > RESPONSE_BYTES) throw new IOException("page_too_large");
            out.write(buffer, 0, n);
        }
        JSONObject response = new JSONObject(out.toString("UTF-8"));
        if ((response.has("code") && response.optInt("code", -1) != 0) || !response.isNull("error")) throw new IOException("page_unavailable");
        // Reading a different resource, even a public redirect, requires its own search result.
        if (!grant.url.equals(response.opt("url"))) throw new IOException("page_unavailable");
        String media = response.optString("content_type").split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        if (!(media.equals("text/html") || media.equals("text/plain") || media.equals("text/markdown") || media.equals("application/xhtml+xml"))) {
            throw new IOException("page_unavailable");
        }
        Object content = response.opt("content");
        if (!(content instanceof String)) throw new IOException("page_unavailable");
        String text = ((String) content).replace(bearer, "[redacted]").trim();
        if (text.isEmpty() || text.indexOf('\u0000') >= 0) throw new IOException("page_unavailable");
        int end = Math.min(TEXT_LIMIT, text.length());
        if (end < text.length() && Character.isHighSurrogate(text.charAt(end - 1))) end--;
        return new JSONObject().put("text", text.substring(0, end)).toString().getBytes(StandardCharsets.UTF_8);
    }
}
