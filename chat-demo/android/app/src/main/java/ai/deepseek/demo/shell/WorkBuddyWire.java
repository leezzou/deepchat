package ai.deepseek.demo.shell;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Fixed Tencent operations. The web layer cannot supply a destination, provider, headers or credentials. */
final class WorkBuddyWire {
    static final String CHAT = "https://copilot.tencent.com/v2/chat/completions";
    static final String SEARCH = "https://copilot.tencent.com/agenttool/v1/search";
    // Search result count is chosen by Tencent. Bound the response by bytes before parsing it.
    static final int SEARCH_RESPONSE_BYTES = 512 * 1024;
    private WorkBuddyWire() {}

    static JSONObject body(JSONObject req, boolean search) throws Exception {
        return body(req, search, null);
    }

    static JSONObject body(JSONObject req, boolean search, JSONArray catalog) throws Exception {
        String model = req.getString("model");
        if (!WorkBuddyCatalog.allows(catalog, model)) throw new IOException("model");
        if (search) {
            String query = req.getString("query").trim();
            if (query.isEmpty() || query.length() > 2048) throw new IOException("search_query_length");
            return new JSONObject().put("query", query).put("type", "text2text");
        }
        JSONArray input = req.getJSONArray("messages"), messages = new JSONArray();
        if (input.length() == 0) throw new IOException("empty");
        for (int i = 0; i < input.length(); i++) {
            JSONObject row = input.getJSONObject(i);
            String role = row.getString("role");
            if (!("system".equals(role) || "user".equals(role) || "assistant".equals(role)) || !(row.opt("content") instanceof String)) {
                throw new IOException("text_only");
            }
            messages.put(new JSONObject().put("role", role).put("content", row.getString("content")));
        }
        boolean planning = "search_plan".equals(req.optString("purpose"));
        boolean thinking = !planning && req.getBoolean("thinking");
        JSONObject body = new JSONObject();
        if (planning) body.put("max_tokens", 256);
        else if (req.has("max_tokens")) body.put("max_tokens", Math.max(1, Math.min(48, req.getInt("max_tokens"))));
        return body.put("model", model).put("messages", messages).put("stream", true)
                .put("reasoning_effort", thinking ? "high" : "none")
                .put("thinking", new JSONObject().put("type", thinking ? "enabled" : "disabled"));
    }

    private static String field(JSONObject row, String key, int limit, String bearer) {
        Object raw = row.opt(key);
        if (!(raw instanceof String)) return "";
        String value = ((String) raw).replace(bearer, "[redacted]");
        return value.substring(0, Math.min(limit, value.length()));
    }

    /** Publish only public result fields. A successful empty result is different from a malformed response. */
    static byte[] searchResults(InputStream in, String bearer) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        for (int n; (n = in.read(buf)) != -1;) {
            if (out.size() + n > SEARCH_RESPONSE_BYTES) throw new IOException("search_response_too_large");
            out.write(buf, 0, n);
        }
        JSONObject data = new JSONObject(out.toString("UTF-8"));
        JSONObject result = new JSONObject();
        if ((data.has("code") && data.optInt("code", -1) != 0) || !data.isNull("error")) {
            JSONObject error = data.optJSONObject("error");
            if (error == null) error = data;
            String message = field(error, "message", 300, bearer);
            if (message.isEmpty()) message = field(error, "msg", 300, bearer);
            result.put("error", new JSONObject().put("message", message).put("code", error.optInt("code", -1)));
        } else {
            JSONArray rows = data.optJSONArray("results"), clean = new JSONArray();
            if (rows == null) throw new IOException("invalid_search_response");
            Set<URI> seen = new HashSet<>();
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.optJSONObject(i);
                if (row == null) continue;
                Object raw = row.opt("url");
                if (!(raw instanceof String)) continue;
                String url = (String) raw;
                if (url.length() > 2048 || (!bearer.isEmpty() && url.contains(bearer))) continue;
                URI address;
                try { address = new URI(url); } catch (Exception invalid) { continue; }
                if (!("https".equalsIgnoreCase(address.getScheme()) || "http".equalsIgnoreCase(address.getScheme()))
                        || address.getHost() == null || address.getRawUserInfo() != null) continue;
                String host = address.getHost().toLowerCase(Locale.ROOT).replaceFirst("\\.$", "");
                if (!host.contains(".") || host.contains(":") || host.matches("[0-9.]+")
                        || host.matches(".*\\.(localhost|local|lan|internal|corp|home|intranet)") || !seen.add(address)) continue;
                clean.put(new JSONObject().put("url", url).put("title", field(row, "title", 500, bearer))
                        .put("snippet", field(row, "snippet", 2000, bearer)).put("date", field(row, "date", 64, bearer)));
            }
            if (rows.length() != 0 && clean.length() == 0) throw new IOException("invalid_search_response");
            result.put("results", clean);
        }
        return result.toString().getBytes(StandardCharsets.UTF_8);
    }
}
