package ai.deepseek.demo.shell;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Set;
import java.util.TreeSet;
import javax.net.ssl.HttpsURLConnection;

/** Personal CN catalog. Only model metadata crosses the trusted Android bridge. */
final class WorkBuddyCatalog {
    private static final String CONFIG = "https://copilot.tencent.com/v3/config";
    private static final String PERSONAL = "https://copilot.tencent.com/v2/enterprises/personal/models";
    private static final Set<String> FALLBACK = new HashSet<>(Arrays.asList("deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-flash"));
    private static final Set<String> ROUTERS = new HashSet<>(Arrays.asList("default", "auto", "fast-model", "balanced-model", "deep-model"));
    private WorkBuddyCatalog() {}

    static boolean allows(JSONArray catalog, String id) {
        if (catalog == null) return FALLBACK.contains(id);
        for (int i = 0; i < catalog.length(); i++) {
            JSONObject model = catalog.optJSONObject(i);
            if (model != null && id.equals(model.optString("id"))) return true;
        }
        return false;
    }

    private static int tokens(Object raw) {
        if (!(raw instanceof Number)) return 0;
        double n = ((Number) raw).doubleValue();
        return n > 0 && n <= Integer.MAX_VALUE && n == Math.rint(n) ? (int)n : 0;
    }

    private static boolean contains(JSONArray list, String value) {
        if (list != null) for (int i = 0; i < list.length(); i++) if (value.equals(list.opt(i))) return true;
        return false;
    }

    private static JSONObject model(JSONObject row, String id) throws Exception {
        String name = row.optString("name", id);
        JSONObject entry = new JSONObject().put("id", id).put("name", name.isEmpty() || name.length() > 160 ? id : name);
        int max = tokens(row.opt("maxInputTokens"));
        JSONObject context = row.optJSONObject("contextWindow");
        JSONArray lengths = context == null ? null : context.optJSONArray("supportedLengths");
        TreeSet<Integer> tiers = new TreeSet<>();
        if (lengths != null && lengths.length() <= 128) for (int i = 0; i < lengths.length(); i++) {
            int n = tokens(lengths.opt(i));
            if (n > 0 && (max == 0 || n <= max)) tiers.add(n);
        }
        int budget = max;
        if (tiers.size() >= 2) {
            int def = tokens(context.opt("defaultLength"));
            budget = tiers.contains(def) ? def : tiers.first();
            entry.put("contextTiers", new JSONArray(tiers));
        }
        if (budget > 0) entry.put("contextWindow", budget);
        if (row.opt("supportsReasoning") instanceof Boolean) entry.put("reasoning", row.getBoolean("supportsReasoning"));
        return entry;
    }

    static JSONArray parse(JSONObject data) throws Exception {
        JSONArray rows = data.getJSONArray("models"), agents = data.getJSONArray("agents"), roster = null;
        if (rows.length() > 2048 || agents.length() > 1024) throw new IOException("invalid_catalog");
        for (int i = 0; i < agents.length(); i++) {
            JSONObject agent = agents.optJSONObject(i);
            if (agent != null && "cli".equals(agent.optString("name"))) { roster = agent.optJSONArray("models"); break; }
        }
        if (roster == null || roster.length() > 2048) throw new IOException("invalid_catalog");
        JSONArray available = data.optJSONArray("availableModels"), clean = new JSONArray();
        HashMap<String, JSONObject> byId = new HashMap<>();
        Set<String> duplicate = new HashSet<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null || !(row.opt("id") instanceof String)) continue;
            String id = row.getString("id");
            if (byId.put(id, row) != null) duplicate.add(id);
        }
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < roster.length(); i++) {
            if (!(roster.opt(i) instanceof String)) continue;
            String id = roster.getString(i);
            JSONObject row = byId.get(id);
            if (row == null || duplicate.contains(id) || !seen.add(id) || !id.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}") || ROUTERS.contains(id)
                    || row.optBoolean("disabled") || row.optBoolean("hidden") || Boolean.FALSE.equals(row.opt("enabled")) || "disabled".equals(row.optString("status"))
                    || !row.optString("url", "").isEmpty() || id.startsWith("custom:") || contains(row.optJSONArray("tags"), "custom")
                    || (available != null && !contains(available, id))) continue;
            JSONArray output = row.optJSONArray("outputModalities");
            if (output != null && !contains(output, "text")) continue;
            clean.put(model(row, id));
        }
        return clean;
    }

    static JSONArray fetch(JSONObject account) throws Exception {
        try { return request(CONFIG, account); }
        catch (IOException | org.json.JSONException unavailable) { return request(PERSONAL, account); }
    }

    private static JSONArray request(String url, JSONObject account) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(url).openConnection();
        try {
            connection.setUseCaches(false); connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(4500); connection.setReadTimeout(4500);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + account.getString("access"));
            connection.setRequestProperty("X-User-Id", account.getString("uid"));
            connection.setRequestProperty("X-Product", "SaaS");
            connection.setRequestProperty("Origin", "https://www.workbuddy.cn");
            connection.setRequestProperty("User-Agent", "WorkBuddy/5.11.3 WorkBuddy/5.11.3 CLI/2.176.0 DeepChat/Android");
            if (connection.getResponseCode() != 200) throw new IOException("catalog_unavailable");
            try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] buf = new byte[8192]; int n;
                while ((n = stream.read(buf)) != -1) {
                    if (bytes.size() + n > 2 * 1024 * 1024) throw new IOException("catalog_size");
                    bytes.write(buf, 0, n);
                }
                JSONObject envelope = new JSONObject(bytes.toString("UTF-8"));
                if (envelope.optInt("code", -1) != 0) throw new IOException("catalog_unavailable");
                return parse(envelope.getJSONObject("data"));
            }
        } finally { connection.disconnect(); }
    }
}
