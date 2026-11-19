package ai.deepseek.demo.shell;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContextWrapper;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.util.UUID;

/** All HTTPS is handled in-process. The test vault directory is independent of the user's grant. */
@RunWith(AndroidJUnit4.class)
public final class WorkBuddyAuthTest {
    private static final String HOST = "https://copilot.tencent.com";
    private static final String STATE = "offline-test-state-442188";
    private static final String START = HOST + "/v2/plugin/auth/state?platform=deepchat";
    private static final String PAGE = HOST + "/login?platform=deepchat&state=" + STATE;
    private static final String ACCESS = "offline-access-training-fixture";
    private static final String REFRESH = "offline-refresh-training-fixture";
    private final OfflineHttps net = new OfflineHttps();
    private WorkBuddySession session;

    @BeforeClass public static void installNetwork() throws Exception { OfflineHttps.install(); }
    @Before public void setUp() {
        net.activate();
        Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File folder = new File(base.getCacheDir(), "workbuddy-test-" + UUID.randomUUID());
        assertTrue(folder.mkdir());
        session = new WorkBuddySession(new ContextWrapper(base) {
            @Override public File getNoBackupFilesDir() { return folder; }
        });
    }
    @After public void finish() throws Exception { try { session.forget(); } finally { net.finish(); } }
    private OfflineHttps.Exchange start() throws Exception {
        OfflineHttps.Exchange exchange = net.json("POST", START, 200, new JSONObject().put("code", 0)
                .put("data", new JSONObject().put("authUrl", PAGE).put("state", STATE)).toString());
        assertEquals(Uri.parse(PAGE), session.begin());
        return exchange;
    }
    @Test public void authorizationIsBoundToDeepChatAndItsOwnPendingState() {
        assertTrue(WorkBuddySession.validApproval(PAGE, STATE));
        for (String invalid : new String[]{PAGE.replace("deepchat", "workbuddy"), PAGE.replace("https:", "http:"),
                PAGE.replace("copilot.tencent.com", "copilot.tencent.com.example.org"), PAGE.replace("/login?", "/other?"),
                PAGE + "&platform=other", PAGE + "&state=another", PAGE + "#unwanted"}) {
            assertFalse(WorkBuddySession.validApproval(invalid, STATE));
        }
        assertFalse(WorkBuddySession.validApproval(PAGE, "different-state"));
        assertTrue(WorkBuddyChat.allowedModel("deepseek-v4.1-flash"));
        for (String model : new String[]{"auto", "deepseek-v4-pro ", "provider/deepseek-v4-pro", "other"}) assertFalse(WorkBuddyChat.allowedModel(model));
    }
    @Test public void accountAndRefreshTokensNeverAppearInWebStatus() throws Exception {
        OfflineHttps.Connection init = start().await();
        assertNull(init.getRequestProperty("Authorization"));
        assertEquals("DeepChat/Android", init.getRequestProperty("User-Agent"));
        assertNull(init.getRequestProperty("X-IDE-Type"));
        assertFalse(init.getInstanceFollowRedirects());
        assertTrue(session.status().getBoolean("pending"));
        net.json("GET", HOST + "/v2/plugin/auth/token?state=" + STATE, 200, new JSONObject().put("code", 0)
                .put("data", new JSONObject().put("accessToken", ACCESS).put("refreshToken", REFRESH).put("expiresIn", 1)).toString());
        OfflineHttps.Exchange who = net.json("GET", HOST + "/v2/plugin/login/account?state=" + STATE, 200,
                "{\"code\":0,\"data\":{\"uid\":\"fixture-person\",\"nickname\":\"测试\",\"type\":\"personal\"}}");
        session.poll();
        assertEquals("Bearer " + ACCESS, who.await().getRequestProperty("Authorization"));
        JSONObject publicState = session.status();
        assertFalse(publicState.toString().contains(ACCESS));
        assertFalse(publicState.toString().contains(REFRESH));
        assertFalse(publicState.has("uid"));
        assertFalse(publicState.getBoolean("pending"));
        assertEquals("测试", publicState.getString("name"));
        assertEquals("deepseek-v4.1-flash", publicState.getString("model"));
        OfflineHttps.Exchange refresh = net.json("POST", HOST + "/v2/plugin/auth/token/refresh", 200,
                "{\"code\":0,\"data\":{\"accessToken\":\"offline-rotated-access-fixture\",\"expiresIn\":3600}}");
        session.changeModel("deepseek-v4-pro");
        JSONObject account = session.account();
        assertEquals(REFRESH, refresh.await().getRequestProperty("X-Refresh-Token"));
        assertEquals("offline-rotated-access-fixture", account.getString("access"));
        assertEquals(publicState.getString("revision"), account.getString("revision"));
        assertEquals("deepseek-v4-pro", account.getString("model"));
        assertFalse(account.has("refresh"));
        session.forget();
        assertFalse(session.status().has("revision"));
    }
    @Test public void waitingAndRefusedAuthorizationNeverPublishAccount() throws Exception {
        start();
        net.json("GET", HOST + "/v2/plugin/auth/token?state=" + STATE, 200, "{\"code\":11217,\"msg\":\"login ing...\"}");
        session.poll();
        assertTrue(session.status().getBoolean("pending"));
        assertFalse(session.status().has("revision"));
        session.cancel();
        start();
        net.json("GET", HOST + "/v2/plugin/auth/token?state=" + STATE, 403, "{\"code\":11004}");
        try { session.poll(); fail(); } catch (WorkBuddySession.Fault e) { assertEquals(403, e.status); }
        assertFalse(session.status().getBoolean("pending"));
        assertFalse(session.status().has("revision"));
    }
}
