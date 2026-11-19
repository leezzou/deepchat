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
    private static final String HOST = "https://www.workbuddy.cn";
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
                PAGE.replace("www.workbuddy.cn", "www.workbuddy.cn.example.org"), PAGE.replace("/login?", "/other?"),
                PAGE.replace("www.workbuddy.cn", "copilot.tencent.com"), PAGE + "&redirect_uri=https://example.org",
                PAGE.replace("www.workbuddy.cn", "www.workbuddy.cn@evil.example"),
                PAGE + "&platform=other", PAGE + "&state=another", PAGE + "#unwanted"}) {
            assertFalse(WorkBuddySession.validApproval(invalid, STATE));
        }
        assertFalse(WorkBuddySession.validApproval(PAGE, "different-state"));
        assertTrue(WorkBuddyChat.allowedModel("deepseek-v4.1-flash"));
        for (String model : new String[]{"auto", "deepseek-v4-pro ", "provider/deepseek-v4-pro", "other"}) assertFalse(WorkBuddyChat.allowedModel(model));
    }
    @Test public void desktopPresentationCannotOpenMiniProgramsOrReplaceThePendingRequest() {
        String ua = WorkBuddyDesktopBrowser.desktopUserAgent("Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Version/4.0 Chrome/159.0.0.0 Mobile Safari/537.36");
        assertTrue(ua.contains("Chrome/159.0.0.0"));
        assertFalse(ua.matches(".*(Android|Mobile|; wv).*"));
        assertTrue(WorkBuddyDesktopBrowser.documentAllowed(Uri.parse(PAGE), true, STATE));
        assertTrue(WorkBuddyDesktopBrowser.documentAllowed(Uri.parse(PAGE.replace("/login?", "/login/?")), true, STATE));
        assertFalse(WorkBuddyDesktopBrowser.documentAllowed(Uri.parse(PAGE), true, "other"));
        for (String raw : new String[]{"weixin://dl/business", "intent://open", "file:///data", "content://x", "http://www.workbuddy.cn/login", "https://localhost", "https://www.workbuddy.cn@evil.example", "https://localhost.weixin.qq.com/"}) {
            assertFalse(WorkBuddyDesktopBrowser.resourceAllowed(Uri.parse(raw)));
            assertFalse(WorkBuddyDesktopBrowser.documentAllowed(Uri.parse(raw), false, STATE));
        }
        Uri wechat = Uri.parse("https://open.weixin.qq.com/connect/qrconnect");
        assertTrue(WorkBuddyDesktopBrowser.documentAllowed(wechat, false, STATE));
        assertFalse(WorkBuddyDesktopBrowser.documentAllowed(wechat, true, STATE));
        assertFalse(WorkBuddyDesktopBrowser.documentAllowed(Uri.parse("https://assets.workbuddy.cn/example"), true, STATE));
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
