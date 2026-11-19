package ai.deepseek.demo.shell;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.PluginMethod;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import static org.junit.Assert.*;

/** Exercise the account wallet in its own instrumentation process with an isolated vault and HTTPS fixtures. */
@RunWith(AndroidJUnit4.class)
public final class WorkBuddyWalletTest {
    private static final String HOST = "https://copilot.tencent.com";
    private static final String SUMMARY = HOST + "/billing/meter/get-user-resource-summary";
    private static final String ACTIVITY = HOST + "/v2/billing/meter/checkin-activity-status";
    private final OfflineHttps net = new OfflineHttps();
    private Context context;
    private Field singleton;
    private Object previous;

    @BeforeClass public static void blockNetwork() throws Exception { OfflineHttps.install(); }

    @Before public void setUp() throws Exception {
        Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String id = "workbuddy-wallet-test-" + UUID.randomUUID();
        File vault = new File(base.getCacheDir(), id);
        assertTrue(vault.mkdir());
        context = new ContextWrapper(base) {
            @Override public File getNoBackupFilesDir() { return vault; }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) {
                return base.getSharedPreferences(id + name, mode);
            }
            @Override public Object getSystemService(String name) {
                return Context.JOB_SCHEDULER_SERVICE.equals(name) ? null : super.getSystemService(name);
            }
        };
        singleton = WorkBuddySession.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        previous = singleton.get(null);
        singleton.set(null, new WorkBuddySession(context));
        net.activate();
    }

    @After public void finish() {
        singleton.setAccessible(true);
        try { singleton.set(null, previous); } catch (IllegalAccessException e) { throw new AssertionError(e); }
        finally { net.finish(); }
    }

    private void signIn(String owner) throws Exception {
        JSONObject record = new JSONObject().put("access", "offline-fixture-credential").put("uid", "fixture-user")
                .put("model", "deepseek-v4.1-flash").put("revision", owner);
        ProfileVault.workBuddy(context).write(record.toString());
    }

    private JSONObject read(boolean refresh) throws Exception { return WorkBuddyWallet.run(context, refresh, null, false); }

    private void summary(double balance) { net.json("POST", SUMMARY, 200, "{\"code\":0,\"data\":{\"TotalCredits\":" + balance + "}}"); }
    private void offline(String url) {
        net.expect("POST", url, 200, "application/json", new InputStream() {
            @Override public int read() throws IOException { throw new IOException("offline fixture"); }
        });
    }

    @Test public void signedOutWalletClearsPriorAccountAndHasNoNavigationAction() throws Exception {
        Set<String> methods = new HashSet<>();
        for (Method method : WorkBuddyWalletPlugin.class.getDeclaredMethods()) {
            if (method.isAnnotationPresent(PluginMethod.class)) methods.add(method.getName());
        }
        assertEquals(new HashSet<>(Arrays.asList("status", "refresh", "setAuto")), methods);
        assertTrue(WorkBuddyWallet.prefs(context).edit().putString("owner", "prior")
                .putString("balance", "23.5").putLong("observedAt", 10).putBoolean("auto", true).commit());
        for (JSONObject result : new JSONObject[]{read(false), read(true), WorkBuddyWallet.run(context, false, true, false)}) {
            assertEquals("signed-out", result.getString("source"));
            assertEquals("login-required", result.getString("state"));
            assertTrue(result.isNull("balance"));
            assertTrue(result.isNull("observedAt"));
            assertFalse(result.getBoolean("canAutoCheckIn"));
            assertFalse(result.getBoolean("autoCheckIn"));
        }
    }

    @Test public void modelAndRevisionFollowTheNativeGrantWithoutAWebCache() throws Exception {
        signIn("first");
        JSONObject first = read(false);
        assertEquals("first", first.getString("revision"));
        assertEquals("deepseek-v4.1-flash", first.getString("model"));
        WorkBuddySession.forContext(context).changeModel("deepseek-v4-pro");
        assertEquals("deepseek-v4-pro", read(false).getString("model"));
        signIn("second");
        assertEquals("second", read(false).getString("revision"));
        WorkBuddySession.forContext(context).forget();
        JSONObject gone = read(false);
        assertTrue(gone.isNull("revision"));
        assertTrue(gone.isNull("model"));
    }

    @Test public void activityErrorsLeaveFreshBalanceAvailable() throws Exception {
        signIn("owner");
        summary(23.5);
        offline(ACTIVITY);
        JSONObject offline = read(true);
        assertEquals("account", offline.getString("source"));
        assertEquals("account-page", offline.getString("state"));
        assertEquals(23.5, offline.getDouble("balance"), 0);
        assertTrue(offline.getLong("observedAt") > 0);
        assertEquals(200, offline.getInt("httpStatus"));
        assertEquals("unknown", offline.getString("checkIn"));

        summary(0);
        net.json("POST", ACTIVITY, 403, "{}");
        JSONObject denied = read(true);
        assertEquals("account-page", denied.getString("state"));
        assertEquals(0, denied.getDouble("balance"), 0);
        assertEquals(200, denied.getInt("httpStatus"));
        assertEquals("ineligible", denied.getString("checkIn"));
    }

    @Test public void balanceFailuresPreserveAmountAndObservationForItsOwnerOnly() throws Exception {
        signIn("first");
        summary(31.75);
        offline(ACTIVITY);
        long observed = read(true).getLong("observedAt");
        net.json("POST", SUMMARY, 403, "{}");
        offline(ACTIVITY);
        JSONObject denied = read(true);
        assertEquals("access-denied", denied.getString("state"));
        assertEquals(403, denied.getInt("httpStatus"));
        assertEquals(31.75, denied.getDouble("balance"), 0);
        assertEquals(observed, denied.getLong("observedAt"));

        offline(SUMMARY);
        offline(ACTIVITY);
        JSONObject offline = read(true);
        assertEquals("unavailable", offline.getString("state"));
        assertTrue(offline.isNull("httpStatus"));
        assertEquals(31.75, offline.getDouble("balance"), 0);
        assertEquals(observed, offline.getLong("observedAt"));
        assertEquals(observed, read(false).getLong("observedAt"));

        signIn("second");
        JSONObject switched = read(false);
        assertTrue(switched.isNull("balance"));
        assertTrue(switched.isNull("observedAt"));
    }
}
