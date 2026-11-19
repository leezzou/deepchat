package ai.deepseek.demo.shell;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.lang.reflect.Field;
import java.util.UUID;

/** Run in its own instrumentation process: OfflineHttps intercepts every HTTP(S) connection. */
@RunWith(AndroidJUnit4.class)
public final class WorkBuddyMeterFlowTest {
    private static final String HOST = "https://copilot.tencent.com";
    private static final String STATE = "offline-meter-flow-state";
    private static final String ACCESS = "offline-meter-flow-access";
    private static final String SUMMARY = "/billing/meter/get-user-resource-summary";
    private static final String STATUS = "/v2/billing/meter/checkin-activity-status";
    private static final String CLAIM = "/v2/billing/meter/daily-checkin";
    private final OfflineHttps net = new OfflineHttps();

    private OfflineHttps.Exchange response(String method, String path, String data) {
        return net.json(method, HOST + path, 200, "{\"code\":0,\"data\":" + data + "}");
    }

    private void assertWalletRequest(OfflineHttps.Exchange exchange) throws Exception {
        OfflineHttps.Connection request = exchange.await();
        assertEquals("Bearer " + ACCESS, request.getRequestProperty("Authorization"));
        assertEquals("fixture-uid", request.getRequestProperty("X-User-Id"));
        assertEquals(0, request.requestJson().length());
        assertFalse(request.getInstanceFollowRedirects());
    }

    @Test public void authorizationClaimDuplicateReadAndDisabledScheduledRun() throws Exception {
        OfflineHttps.install();
        Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String id = "workbuddy-meter-flow-" + UUID.randomUUID();
        File vault = new File(base.getCacheDir(), id);
        assertTrue(vault.mkdir());
        Context context = new ContextWrapper(base) {
            @Override public File getNoBackupFilesDir() { return vault; }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) {
                return base.getSharedPreferences(id + "-" + name, mode);
            }
            @Override public Object getSystemService(String name) {
                // A transport fixture has no real device jobs to schedule or cancel.
                return Context.JOB_SCHEDULER_SERVICE.equals(name) ? null : super.getSystemService(name);
            }
        };
        WorkBuddySession session = new WorkBuddySession(context);
        Field singleton = WorkBuddySession.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        Object previous = singleton.get(null);
        singleton.set(null, session);
        net.activate();
        try {
            String approval = HOST + "/login?platform=deepchat&state=" + STATE;
            response("POST", "/v2/plugin/auth/state?platform=deepchat",
                    new JSONObject().put("state", STATE).put("authUrl", approval).toString());
            assertEquals(approval, session.begin().toString());
            response("GET", "/v2/plugin/auth/token?state=" + STATE,
                    new JSONObject().put("accessToken", ACCESS).put("expiresIn", 3600).toString());
            OfflineHttps.Exchange account = response("GET", "/v2/plugin/login/account?state=" + STATE,
                    "{\"uid\":\"fixture-uid\",\"type\":\"personal\"}");
            session.poll();
            assertEquals("Bearer " + ACCESS, account.await().getRequestProperty("Authorization"));
            assertTrue(session.status().has("revision"));

            // Model a previously enabled account without registering a background job on the device.
            assertTrue(WorkBuddyWallet.prefs(context).edit().putString("owner", session.status().getString("revision"))
                    .putBoolean("auto", true).commit());
            OfflineHttps.Exchange before = response("POST", SUMMARY, "{\"TotalCredits\":\"12.5\"}");
            OfflineHttps.Exchange available = response("POST", STATUS, "{\"active\":true,\"todayCheckedIn\":false}");
            OfflineHttps.Exchange claim = response("POST", CLAIM, "{}");
            OfflineHttps.Exchange after = response("POST", SUMMARY, "{\"TotalCredits\":\"112.5\"}");
            JSONObject result = WorkBuddyWallet.run(context, false, null, true);
            assertEquals("checked-in", result.getString("checkIn"));
            assertEquals(112.5, result.getDouble("balance"), 0);
            for (OfflineHttps.Exchange exchange : new OfflineHttps.Exchange[]{before, available, claim, after}) {
                assertWalletRequest(exchange);
            }

            // Even a stale status saying "available" cannot replay today's claim.
            response("POST", SUMMARY, "{\"TotalCredits\":112.5}");
            response("POST", STATUS, "{\"active\":true,\"todayCheckedIn\":false}");
            assertEquals("pending-confirmation", WorkBuddyWallet.run(context, true, null, false).getString("checkIn"));
            response("POST", SUMMARY, "{\"TotalCredits\":112.5}");
            response("POST", STATUS, "{\"active\":true,\"today_checked_in\":true}");
            assertEquals("checked-in", WorkBuddyWallet.run(context, true, null, false).getString("checkIn"));

            assertFalse(WorkBuddyWallet.run(context, false, false, false).getBoolean("autoCheckIn"));
            // Clear the completion/throttle markers to prove the disabled preference alone stops network I/O.
            assertTrue(WorkBuddyWallet.prefs(context).edit().remove("finishedDay").remove("attemptTime").commit());
            assertNull(WorkBuddyWallet.run(context, false, null, true));
        } finally {
            singleton.set(null, previous);
            try { session.forget(); WorkBuddyWallet.prefs(context).edit().clear().commit(); }
            finally { net.finish(); }
        }
    }
}
