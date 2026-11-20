package ai.deepseek.demo.shell;

import android.content.Context;
import android.net.Uri;
import android.os.SystemClock;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.util.UUID;
import javax.net.ssl.HttpsURLConnection;

/** User-initiated CN plugin authorization. The opaque state and all credentials stay native. */
final class WorkBuddySession {
    static final String AUTH_HOST = "www.workbuddy.cn";
    private static final String ORIGIN = "https://" + AUTH_HOST;
    private static final String LEGACY_ORIGIN = "https://copilot.tencent.com";
    private static final String START = "/v2/plugin/auth/state?platform=deepchat";
    private static WorkBuddySession instance;
    private final ProfileVault vault;
    private String state, pendingAccess, pendingRefresh;
    private long deadline, nextPoll, pendingExpiry, pendingRefreshExpiry;

    static synchronized WorkBuddySession forContext(Context context) {
        if (instance == null) instance = new WorkBuddySession(context.getApplicationContext());
        return instance;
    }
    WorkBuddySession(Context context) { vault = ProfileVault.workBuddy(context); }

    static final class Fault extends IOException {
        final int status, code;
        Fault(int status, int code) { super("HTTP " + status + (code == 0 ? "" : " · " + code)); this.status = status; this.code = code; }
    }
    private static JSONObject call(String path, boolean post, String bearer) throws Exception {
        return call(ORIGIN, path, post, bearer, null);
    }
    private static JSONObject call(String origin, String path, boolean post, String bearer, String refresh) throws Exception {
        HttpsURLConnection conn = (HttpsURLConnection) new URL(origin + path).openConnection();
        try {
            conn.setInstanceFollowRedirects(false);
            conn.setUseCaches(false);
            conn.setConnectTimeout(10000); conn.setReadTimeout(10000);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("User-Agent", "DeepChat/Android");
            if (bearer != null) conn.setRequestProperty("Authorization", "Bearer " + bearer);
            if (refresh != null) conn.setRequestProperty("X-Refresh-Token", refresh);
            if (post) {
                conn.setRequestMethod("POST"); conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json"); conn.setFixedLengthStreamingMode(2);
                try (OutputStream out = conn.getOutputStream()) { out.write(new byte[]{'{', '}'}); }
            }
            int status = conn.getResponseCode();
            JSONObject env = new JSONObject();
            try (InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] chunk = new byte[4096]; int n;
                while (in != null && (n = in.read(chunk)) != -1) {
                    if (bytes.size() + n > 128 * 1024) throw new IOException("response_too_large");
                    bytes.write(chunk, 0, n);
                }
                try { env = new JSONObject(bytes.toString("UTF-8")); } catch (Exception invalid) { /* status below */ }
            } catch (IOException incomplete) {
                // A refusal is terminal even when its error body never arrives.
                if (status != 200) throw new Fault(status, -1);
                throw incomplete;
            }
            if (status != 200 || env.optInt("code", -1) != 0) throw new Fault(status, env.optInt("code", -1));
            return env.getJSONObject("data");
        } finally { conn.disconnect(); }
    }

    static boolean validApproval(String raw, String state) {
        if (raw == null || state == null) return false;
        Uri url = Uri.parse(raw);
        String query = url.getEncodedQuery();
        return "https".equals(url.getScheme()) && AUTH_HOST.equals(url.getEncodedAuthority())
                && ("/login".equals(url.getEncodedPath()) || "/login/".equals(url.getEncodedPath()))
                && url.getEncodedFragment() == null && query != null && query.split("&", -1).length == 2
                && url.getQueryParameters("platform").equals(java.util.Collections.singletonList("deepchat"))
                && url.getQueryParameters("state").equals(java.util.Collections.singletonList(state));
    }
    synchronized Uri begin() throws Exception {
        cancel();
        JSONObject response = call(START, true, null);
        String binding = response.getString("state"), page = response.getString("authUrl");
        if (binding.length() < 16 || binding.length() > 1024 || !validApproval(page, binding)) throw new IOException("invalid_consent");
        state = binding; deadline = SystemClock.elapsedRealtime() + 300_000; nextPoll = 0;
        return Uri.parse(page);
    }
    synchronized void cancel() { state = null; pendingAccess = null; pendingRefresh = null; pendingExpiry = pendingRefreshExpiry = 0; deadline = nextPoll = 0; }
    private boolean pending() { return state != null && SystemClock.elapsedRealtime() < deadline; }

    synchronized void poll() throws Exception {
        if (!pending()) { cancel(); throw new IOException("login_expired"); }
        long now = SystemClock.elapsedRealtime();
        if (now < nextPoll) return;
        nextPoll = now + 2500;
        String query = "?state=" + Uri.encode(state);
        try {
            if (pendingAccess == null) {
                JSONObject token = call("/v2/plugin/auth/token" + query, false, null);
                pendingAccess = credential(token.getString("accessToken"));
                pendingRefresh = token.has("refreshToken") && !token.isNull("refreshToken") ? credential(token.getString("refreshToken")) : null;
                pendingExpiry = expiresAt(token, "expiresAt", "expiresIn");
                pendingRefreshExpiry = expiresAt(token, "refreshExpiresAt", "refreshExpiresIn");
            }
            JSONObject who = call("/v2/plugin/login/account" + query, false, pendingAccess);
            String uid = who.getString("uid");
            String type = who.isNull("type") ? "" : who.optString("type");
            String enterprise = who.isNull("enterpriseId") ? "" : who.optString("enterpriseId");
            if ((!type.isEmpty() && !"personal".equalsIgnoreCase(type)) || !enterprise.isEmpty()) throw new IOException("personal_account_required");
            if (uid.isEmpty() || uid.equals("null") || uid.length() > 256 || !uid.matches("[!-~]+")) throw new IOException("account_missing");
            JSONObject record = new JSONObject().put("uid", uid).put("name", who.optString("nickname"))
                    .put("issuer", AUTH_HOST).put("access", pendingAccess).put("refresh", pendingRefresh).put("expiresAt", pendingExpiry)
                    .put("refreshExpiresAt", pendingRefreshExpiry).put("revision", UUID.randomUUID().toString()).put("model", "deepseek-v4.1-flash");
            vault.write(record.toString()); cancel();
        } catch (Fault denied) {
            if (denied.status == 200 && ((denied.code == 11217 && pendingAccess == null) || (denied.code == 12151 && pendingAccess != null))) return;
            cancel(); throw denied;
        } catch (java.net.SocketTimeoutException | java.net.SocketException | java.net.UnknownHostException interrupted) {
            // A dropped connection says nothing about consent. Keep polling the same state until its original deadline.
            if (!pending()) { cancel(); throw new IOException("login_expired"); }
            nextPoll = SystemClock.elapsedRealtime() + 2500;
        } catch (Exception e) { cancel(); throw e; }
    }
    private static String credential(String value) throws IOException {
        if (value.length() < 16 || value.length() > 65536 || !value.matches("[!-~]+")) throw new IOException("invalid_token");
        return value;
    }
    private static long expiresAt(JSONObject token, String absoluteField, String relativeField) {
        long absolute = token.optLong(absoluteField);
        if (absolute > 0) return absolute < 10_000_000_000L ? absolute * 1000 : absolute;
        long seconds = token.optLong(relativeField);
        long now = System.currentTimeMillis();
        return seconds > 0 && seconds <= (Long.MAX_VALUE - now) / 1000 ? now + seconds * 1000 : 0;
    }
    private static boolean usableRefresh(JSONObject saved) {
        long until = saved.optLong("refreshExpiresAt");
        return saved.has("refresh") && (until <= 0 || until > System.currentTimeMillis());
    }
    private JSONObject record() throws Exception {
        String raw = vault.read();
        return raw == null || raw.isEmpty() ? new JSONObject() : new JSONObject(raw);
    }
    synchronized JSONObject account() throws Exception {
        JSONObject saved = record();
        if (!saved.has("access")) throw new IOException("sign_in_required");
        long expiry = saved.optLong("expiresAt");
        if (expiry > 0 && expiry <= System.currentTimeMillis() && !usableRefresh(saved)) throw new IOException("sign_in_expired");
        if (expiry > 0 && expiry <= System.currentTimeMillis() + 15000 && usableRefresh(saved)) {
            // Called inside the isolated native network context. Refresh at most once for concurrent readers.
            try {
                // v1.0.48 and earlier obtained grants from the original Tencent issuer.
                String issuer = AUTH_HOST.equals(saved.optString("issuer")) ? ORIGIN : LEGACY_ORIGIN;
                JSONObject next = call(issuer, "/v2/plugin/auth/token/refresh", true, null, saved.getString("refresh"));
                saved.put("access", credential(next.getString("accessToken"))).put("expiresAt", expiresAt(next, "expiresAt", "expiresIn"));
                long refreshUntil = expiresAt(next, "refreshExpiresAt", "refreshExpiresIn");
                if (refreshUntil > 0) saved.put("refreshExpiresAt", refreshUntil);
                if (!next.isNull("refreshToken")) saved.put("refresh", credential(next.getString("refreshToken")));
                vault.write(saved.toString());
            } catch (Fault rejected) {
                if (rejected.status == 401) vault.write("");
                throw rejected;
            }
        }
        saved.remove("refresh");
        return saved;
    }
    synchronized JSONObject status() throws Exception {
        JSONObject saved = record(), result = new JSONObject().put("type", "status").put("pending", pending());
        if (saved.has("access") && (usableRefresh(saved) || saved.optLong("expiresAt") <= 0 || saved.getLong("expiresAt") > System.currentTimeMillis())) {
            result.put("model", saved.getString("model")).put("revision", saved.getString("revision")).put("name", saved.optString("name"));
            result.put("catalog", saved.optJSONArray("catalog"));
            long age = System.currentTimeMillis() - saved.optLong("catalogCheckedAt");
            result.put("catalogRefresh", age < 0 || age >= (saved.has("catalog") ? 300_000 : 30_000));
        }
        return result;
    }
    private JSONObject checkedRecord(String revision) throws Exception {
        JSONObject saved = record();
        if (!saved.has("access")) throw new IOException("sign_in_required");
        if (!saved.getString("revision").equals(revision)) throw new IOException("account_changed");
        return saved;
    }
    void refreshCatalog(String revision) throws Exception {
        JSONObject account;
        synchronized (this) {
            checkedRecord(revision);
            account = account();
        }
        org.json.JSONArray catalog;
        try { catalog = WorkBuddyCatalog.fetch(account); }
        catch (IOException | org.json.JSONException unavailable) { catalog = null; }
        synchronized (this) {
            JSONObject saved = checkedRecord(revision);
            // An explicitly restricted account must not gain fallback IDs on a transient failure.
            if (catalog == null && saved.has("catalog")) {
                org.json.JSONArray previous = saved.getJSONArray("catalog"), conservative = new org.json.JSONArray();
                for (int i = 0; i < previous.length(); i++) {
                    JSONObject entry = previous.getJSONObject(i);
                    if (WorkBuddyCatalog.allows(null, entry.getString("id"))) conservative.put(entry);
                }
                catalog = conservative;
            }
            saved.put("catalog", catalog).put("catalogCheckedAt", System.currentTimeMillis());
            vault.write(saved.toString());
        }
    }
    synchronized void changeModel(String model, String revision) throws Exception {
        JSONObject saved = checkedRecord(revision);
        if (!WorkBuddyCatalog.allows(saved.optJSONArray("catalog"), model)) throw new IOException("model");
        vault.write(saved.put("model", model).toString());
    }
    synchronized void changeModel(String model) throws Exception {
        changeModel(model, record().optString("revision"));
    }
    synchronized void forget() throws Exception { cancel(); vault.write(""); }
}
