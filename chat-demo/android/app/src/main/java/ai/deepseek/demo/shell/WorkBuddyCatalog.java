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

    static String originModel(JSONArray catalog, String id) {
        if (catalog != null) for (int i = 0; i < catalog.length(); i++) {
            JSONObject row = catalog.optJSONObject(i);
            if (row != null && id.equals(row.optString("id")) && row.opt("originModel") instanceof String)
                return row.optString("originModel");
        }
        return null;
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

    // Tencent's personal model configuration exposes a display multiplier, e.g. "x0.79 credits".
    // Empty strings occur on real model rows. Only an explicit zero multiplier denotes free use.
    private static final String DECIMAL = "([0-9]{1,5}(?:\\.[0-9]{1,8})?)";
    private static final java.util.regex.Pattern CREDITS = java.util.regex.Pattern.compile(
            "(?:[x×]\\s*" + DECIMAL + "|" + DECIMAL + "(?:\\s*[x×])?)(?:\\s+credits)?",
            java.util.regex.Pattern.CASE_INSENSITIVE);

    // Both credits and discount.discountedCredits are display strings in the vendor client.
    static Double multiplier(Object raw) {
        if (!(raw instanceof String)) return null;
        java.util.regex.Matcher match = CREDITS.matcher(((String) raw).trim());
        if (!match.matches()) return null;
        return Double.parseDouble(match.group(1) != null ? match.group(1) : match.group(2));
    }

    static JSONObject creditRate(Object raw) throws Exception {
        Double multiplier = multiplier(raw);
        if (multiplier == null) return null;
        JSONObject rate = new JSONObject().put("multiplier", multiplier);
        if (multiplier == 0) rate.put("free", true);
        return rate;
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
        if (!tiers.isEmpty()) {
            budget = tiers.last();
            entry.put("contextTiers", new JSONArray(tiers));
        }
        if (max > 0) entry.put("maxInputTokens", max);
        if (budget > 0) entry.put("contextWindow", budget);
        if (row.opt("supportsReasoning") instanceof Boolean) entry.put("reasoning", row.getBoolean("supportsReasoning"));
        entry.put("rate", creditRate(row.opt("credits")));
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
        // Full catalog, including hidden and out-of-roster rows: a serving model
        // shared by two products cannot identify a separately priced route.
        Set<String> origins = new HashSet<>(), sharedOrigins = new HashSet<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null || !(row.opt("id") instanceof String)) continue;
            String id = row.getString("id");
            if (byId.put(id, row) != null) duplicate.add(id);
            if (row.opt("modelId") instanceof String) {
                String origin = row.getString("modelId");
                if (!origins.add(origin)) sharedOrigins.add(origin);
            }
        }
        java.util.Map<String, JSONArray> promotions = WorkBuddyPromotion.byModel(data.optJSONArray("modelPromotions"));
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
            JSONObject entry = model(row, id).put("promotions", promotions.get(id));
            // The official SDK calls a catalog row's modelId the originModel in telemetry.
            // A display name, provider letter, price or relatedModels entry is insufficient.
            String origin = row.optString("modelId", "");
            if (row.opt("modelId") instanceof String && !sharedOrigins.contains(origin) && !byId.containsKey(origin)
                    && origin.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,79}")) entry.put("originModel", origin);
            clean.put(entry);
        }
        return clean;
    }

    static void describeCache(JSONObject saved, JSONObject status, long now) throws org.json.JSONException {
        long updatedAt = saved.optLong("catalogUpdatedAt");
        boolean failed = saved.optBoolean("catalogError");
        long age = now - updatedAt, sinceCheck = now - saved.optLong("catalogCheckedAt");
        boolean stale = failed || updatedAt <= 0 || age < 0 || age >= 300_000;
        status.put("catalog", saved.optJSONArray("catalog")).put("catalogUpdatedAt", updatedAt)
                .put("catalogError", failed).put("catalogStale", stale)
                .put("catalogRefresh", stale && (!failed || sinceCheck < 0 || sinceCheck >= 30_000));
    }

    static void recordAttempt(JSONObject saved, JSONArray catalog, long now) throws org.json.JSONException {
        // A successful empty roster revokes every model. A failed attempt retains the last good snapshot.
        if (catalog != null) saved.put("catalog", catalog).put("catalogUpdatedAt", now);
        saved.put("catalogError", catalog == null).put("catalogCheckedAt", now);
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
            connection.setRequestProperty("X-Requested-With", "XMLHttpRequest");
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
