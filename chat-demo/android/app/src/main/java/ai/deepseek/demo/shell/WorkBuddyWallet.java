package ai.deepseek.demo.shell;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import javax.net.ssl.HttpsURLConnection;

/** Cached observations and opt-in belong to one login grant. No credentials are kept here. */
final class WorkBuddyWallet {
    static final ExecutorService serial = Executors.newSingleThreadExecutor();
    private static final String SUMMARY = "/billing/meter/get-user-resource-summary";
    private static final String ACTIVITY = "/v2/billing/meter/checkin-activity-status";
    private static final String CLAIM = "/v2/billing/meter/daily-checkin";
    private WorkBuddyWallet() {}

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("workbuddy-meter-v1", Context.MODE_PRIVATE); }
    static String day() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
        return format.format(new Date());
    }
    static void isolated(Runnable work) { serial.execute(() -> WebDavCookies.isolate(work)); }

    private static String revision(Context ctx) throws Exception {
        String revision = WorkBuddySession.forContext(ctx).status().optString("revision");
        return revision.isEmpty() ? null : revision;
    }

    private static final class Result {
        int http, code = -1;
        JSONObject data;
        boolean ok() { return http >= 200 && http < 300 && code == 0; }
        boolean denied() { return http == 401 || http == 403 || code == 11004 || code == 10085; }
    }
    private static Result post(JSONObject grant, String path) throws Exception {
        HttpsURLConnection conn = (HttpsURLConnection) new URL("https://copilot.tencent.com" + path).openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setInstanceFollowRedirects(false);
            conn.setUseCaches(false);
            conn.setConnectTimeout(9000);
            conn.setReadTimeout(12000);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("User-Agent", "DeepChat (Android)");
            conn.setRequestProperty("Authorization", "Bearer " + grant.getString("access"));
            if (!grant.optString("uid").isEmpty()) conn.setRequestProperty("X-User-Id", grant.getString("uid"));
            conn.setDoOutput(true);
            byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = conn.getOutputStream()) { out.write(body); }
            Result r = new Result();
            r.http = conn.getResponseCode();
            if (r.http < 200 || r.http >= 300) return r;
            try (InputStream in = conn.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[4096];
                for (int n; (n = in.read(buf)) != -1;) {
                    if (out.size() + n > 512 * 1024) throw new IOException("Size limit");
                    out.write(buf, 0, n);
                }
                JSONObject env = new JSONObject(out.toString("UTF-8"));
                r.code = env.optInt("code", -1);
                r.data = env.optJSONObject("data");
            }
            return r;
        } finally { conn.disconnect(); }
    }

    private static JSObject signedOut() {
        JSObject s = new JSObject();
        s.put("source", "signed-out");
        s.put("state", "login-required");
        s.put("balance", JSONObject.NULL);
        s.put("observedAt", JSONObject.NULL);
        s.put("checkIn", "unknown");
        s.put("canAutoCheckIn", false);
        s.put("autoCheckIn", false);
        s.put("httpStatus", JSONObject.NULL);
        s.put("detail", "");
        return s;
    }

    static JSObject run(Context ctx, boolean refresh, Boolean toggle, boolean scheduled) throws Exception {
        SharedPreferences store = prefs(ctx);
        if (scheduled && !store.getBoolean("auto", false)) return null;
        String owner = revision(ctx);
        if (owner == null || !owner.equals(store.getString("owner", ""))) {
            store.edit().clear().putString("owner", owner).commit();
            WorkBuddyCheckInJob.cancel(ctx);
        }
        if (owner == null) return scheduled ? null : signedOut();
        String today = day();
        if (toggle != null) {
            if (!store.edit().putBoolean("auto", toggle).commit()) throw new IOException("Preference unavailable");
            if (toggle) {
                try { WorkBuddyCheckInJob.schedule(ctx); } catch (RuntimeException denied) { store.edit().putBoolean("auto", false).commit(); throw denied; }
            } else WorkBuddyCheckInJob.cancel(ctx);
        }
        if (scheduled && (!store.getBoolean("auto", false) || today.equals(store.getString("finishedDay", ""))
                || System.currentTimeMillis() - store.getLong("attemptTime", 0) < 900_000L)) return null;
        if (refresh || scheduled || Boolean.TRUE.equals(toggle)) {
            store.edit().putLong("attemptTime", System.currentTimeMillis()).apply();
            try {
                JSONObject grant = WorkBuddySession.forContext(ctx).account();
                if (!owner.equals(grant.optString("revision")) || !owner.equals(revision(ctx))) return scheduled ? null : signedOut();
                refresh(ctx, store, owner, grant, today);
            } catch (WorkBuddySession.Fault fault) {
                store.edit().putString("state", fault.status == 401 || fault.status == 403 ? "access-denied" : "unavailable")
                        .putInt("http", fault.status).apply();
            } catch (Exception unavailable) {
                store.edit().putString("state", "unavailable").remove("http").apply();
            }
        }
        if (!owner.equals(revision(ctx))) return scheduled ? null : signedOut();
        JSObject s = new JSObject();
        s.put("source", "account");
        s.put("state", store.getString("state", "account-page"));
        s.put("balance", store.contains("balance") ? Double.valueOf(store.getString("balance", "0")) : JSONObject.NULL);
        s.put("observedAt", store.contains("observedAt") ? store.getLong("observedAt", 0) : JSONObject.NULL);
        s.put("checkIn", today.equals(store.getString("stateDay", "")) ? store.getString("checkIn", "unknown") : "unknown");
        s.put("canAutoCheckIn", true);
        s.put("autoCheckIn", store.getBoolean("auto", false));
        s.put("detail", store.getString("detail", ""));
        s.put("httpStatus", store.contains("http") ? store.getInt("http", 0) : JSONObject.NULL);
        return s;
    }
    private static void balance(SharedPreferences store, JSONObject grant) {
        SharedPreferences.Editor edit = store.edit();
        try {
            Result r = post(grant, SUMMARY);
            Double amount = r.ok() && r.data != null ? WorkBuddyMeter.balance(r.data) : null;
            edit.putInt("http", r.http);
            if (amount != null) {
                edit.putString("state", "account-page").putString("balance", amount.toString())
                        .putLong("observedAt", System.currentTimeMillis());
            } else {
                edit.putString("state", r.denied() ? "access-denied" : "unavailable");
            }
        } catch (Exception unavailable) {
            edit.putString("state", "unavailable").remove("http");
        }
        edit.apply();
    }

    private static String activityStatus(JSONObject grant) {
        try {
            Result status = post(grant, ACTIVITY);
            if (status.denied()) return "ineligible";
            if (status.http / 100 == 2) return WorkBuddyMeter.activity(status.code, status.data);
        } catch (Exception unavailable) { /* Activity and balance are independent observations. */ }
        return "unknown";
    }

    private static void refresh(Context ctx, SharedPreferences store, String owner, JSONObject grant, String today) throws Exception {
        balance(store, grant);
        if (!owner.equals(revision(ctx))) return;
        String activity = activityStatus(grant);
        if ("available".equals(activity) && store.getBoolean("auto", false)
                && today.equals(day()) && owner.equals(revision(ctx))) {
            // Persist before POST. An interrupted response may still have granted the reward.
            if (today.equals(store.getString("claimDay", ""))) activity = "pending-confirmation";
            else if (store.edit().putString("claimDay", today).commit()) {
                activity = "pending-confirmation";
                try {
                    Result claim = post(grant, CLAIM);
                    if (claim.denied()) activity = "ineligible";
                    else if (claim.http / 100 == 2) {
                        String confirmed = WorkBuddyMeter.claimed(claim.code);
                        if (!"unknown".equals(confirmed)) activity = confirmed;
                    }
                    if ("checked-in".equals(activity)) balance(store, grant);
                } catch (Exception interrupted) { /* The next check reads the server's status first. */ }
            }
        }
        SharedPreferences.Editor edit = store.edit().putString("checkIn", activity).putString("stateDay", today);
        if ("checked-in".equals(activity) || "ineligible".equals(activity) || "inactive".equals(activity)) edit.putString("finishedDay", today);
        edit.apply();
    }
}
