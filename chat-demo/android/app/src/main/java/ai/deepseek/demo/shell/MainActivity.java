package ai.deepseek.demo.shell;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private SecurityPlugin security;
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
        security = new SecurityPlugin(this, web, systemBars);
        web.addJavascriptInterface(systemBars, "AndroidSystemBars");
        web.addJavascriptInterface(new Updater(this), "AndroidUpdater");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N
                && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            account = new DshAccountHost(this);
            proxy = new DshLocalProxy(account);
            screen = new AccountScreen(this, account, proxy, systemBars, () -> web.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('deepchat:open-api-usage',{detail:{fromAccount:true}}))", null));
            systemBars.onThemeChanged(screen::updateTheme);
            accountBridge = new DshWebBridge(web, account, screen::show);
            account.setSessionListener(() -> web.post(() -> {
                if (accountBridge == null || isDestroyed()) return;
                if (!account.signedIn()) proxy.stop();
                screen.accountChanged();
                accountBridge.changed();
            }));
        }
        super.load();
        bridge.setWebViewClient(new AppNavigationClient(bridge));
    }

    @Override public void onResume() {
        super.onResume();
        if (security != null) security.onResume();
        if (screen != null && SecurityPlugin.isUnlocked()) screen.onResume();
        if (accountBridge != null) accountBridge.changed();
    }

    @Override public void onPause() {
        if (security != null) security.onPause();
        if (security != null && security.isEnabled() && screen != null) screen.hideForLock();
        super.onPause();
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        if (security != null && security.onActivityResult(code, result)) return;
        super.onActivityResult(code, result, data);
    }

    @Override public void onDestroy() {
        if (security != null) security.close();
        if (screen != null) screen.dismiss();
        if (accountBridge != null) accountBridge.close();
        if (proxy != null) proxy.stop();
        if (account != null) account.close();
        super.onDestroy();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        IncomingSharePlugin.restoreLaunch(this, savedInstanceState);
        registerPlugin(IncomingSharePlugin.class);
        registerPlugin(WebDavPlugin.class);
        super.onCreate(savedInstanceState);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            WebView.setWebContentsDebuggingEnabled(false);
        }
    }

    @Override protected void onNewIntent(Intent intent) {
        if (security != null && intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
            security.onIncomingShare();
            if (security.isEnabled() && screen != null) screen.hideForLock();
        }
        super.onNewIntent(intent);
    }

    @Override public void onSaveInstanceState(Bundle state) {
        IncomingSharePlugin.saveLaunch(this, state);
        super.onSaveInstanceState(state);
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
