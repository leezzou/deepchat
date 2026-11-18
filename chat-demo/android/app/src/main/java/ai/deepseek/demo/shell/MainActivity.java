package ai.deepseek.demo.shell;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private SystemBars systemBars;
    private DshAccountHost account;
    private DshLocalProxy proxy;
    private AccountScreen screen;
    private DshWebBridge accountBridge;

    @Override
    protected void load() {
        // Install all bridges before Capacitor loads the packaged page.
        WebView web = findViewById(com.getcapacitor.android.R.id.webview);
        systemBars = new SystemBars(this);
        web.addJavascriptInterface(systemBars, "AndroidSystemBars");
        web.addJavascriptInterface(new Updater(this), "AndroidUpdater");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N
                && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            account = new DshAccountHost(this);
            proxy = new DshLocalProxy(account);
            screen = new AccountScreen(this, account, proxy);
            accountBridge = new DshWebBridge(web, account, screen::show);
            account.setSessionListener(() -> web.post(() -> {
                if (accountBridge == null || isDestroyed()) return;
                if (!account.signedIn()) proxy.stop();
                accountBridge.changed();
            }));
        }
        super.load();
    }

    @Override public void onResume() {
        super.onResume();
        if (screen != null) screen.onResume();
        if (accountBridge != null) accountBridge.changed();
    }

    @Override public void onDestroy() {
        if (screen != null) screen.dismiss();
        if (accountBridge != null) accountBridge.close();
        if (proxy != null) proxy.stop();
        if (account != null) account.close();
        super.onDestroy();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            WebView.setWebContentsDebuggingEnabled(false);
        }
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == SystemBars.MIC_REQUEST_CODE && systemBars != null) {
            boolean granted =
                    grantResults.length > 0
                            && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            systemBars.notifyMicrophone(granted);
        }
    }
}
