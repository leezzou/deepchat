package ai.deepseek.demo.shell;

import android.net.Uri;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.webkit.Profile;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

@RunWith(AndroidJUnit4.class)
public final class WorkBuddyWalletTest {
    @Test public void onlyExactHttpsWebsiteAndSignInOriginsAreEmbedded() {
        assertTrue(WorkBuddyWalletPlugin.allowedPage(Uri.parse(WorkBuddyWalletPlugin.USAGE)));
        assertTrue(WorkBuddyWalletPlugin.allowedPage(Uri.parse("https://www.workbuddy.cn/login/?state=sample")));
        assertTrue(WorkBuddyWalletPlugin.allowedPage(Uri.parse("https://open.weixin.qq.com/connect")));
        assertFalse(WorkBuddyWalletPlugin.allowedPage(null));
        for (String url : new String[] {
                "http://www.workbuddy.cn/profile/usage", "https://www.workbuddy.cn.example.org/",
                "https://www.workbuddy.cn@other.example/", "https://other.example@www.workbuddy.cn/",
                "https://www.workbuddy.cn:443/", "https://%77ww.workbuddy.cn/", "https://localhost/",
                "file:///android_asset/public/index.html", "intent://wallet", "javascript:void(0)"
        }) assertFalse(url, WorkBuddyWalletPlugin.allowedPage(Uri.parse(url)));
    }

    @Test public void accountPageRunsInSeparateBrowserProfileWithoutAppBridges() throws Exception {
        assumeTrue(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE));
        AtomicReference<WebView> wallet = new AtomicReference<>();
        LinkedBlockingQueue<String> answer = new LinkedBlockingQueue<>();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            try {
                scenario.onActivity(activity -> {
                    WebView page = WorkBuddyWalletPlugin.newWalletView(activity);
                    wallet.set(page);
                    Profile profile = WebViewCompat.getProfile(page);
                    assertNotEquals(WebViewCompat.getProfile(activity.getBridge().getWebView()).getName(), profile.getName());
                    assertFalse(page.getSettings().getAllowFileAccess());
                    assertFalse(page.getSettings().getAllowContentAccess());
                    assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, page.getSettings().getMixedContentMode());
                    page.getSettings().setBlockNetworkLoads(true);
                    page.setWebViewClient(new WebViewClient() {
                        @Override public void onPageFinished(WebView view, String url) {
                            view.evaluateJavascript("[typeof AndroidUpdater,typeof AndroidSystemBars,typeof DshNative,"
                                    + "typeof DeepChatSecurity,typeof Capacitor].every(v=>v==='undefined')", answer::add);
                        }
                    });
                    page.loadDataWithBaseURL(WorkBuddyWalletPlugin.USAGE, "<html lang='zh'><body>账户测试</body></html>",
                            "text/html", "UTF-8", null);
                });
                assertEquals("true", answer.poll(15, TimeUnit.SECONDS));
            } finally {
                scenario.onActivity(activity -> { if (wallet.get() != null) wallet.get().destroy(); });
            }
        }
    }
}
