package ai.deepseek.demo.shell;

import android.content.ActivityNotFoundException;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.browser.customtabs.CustomTabsIntent;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/** Displays Tencent's own account page. The wallet WebView has a private profile and no app bridge. */
@CapacitorPlugin(name = "WorkBuddyWallet")
public final class WorkBuddyWalletPlugin extends Plugin {
    static final String USAGE = "https://www.workbuddy.cn/profile/usage";
    private static final String PROFILE = "deepchat-workbuddy-website";
    private static final String GUIDE = "在 WorkBuddy 官网查看积分。当前签到活动见官方客户端的「Buddy 加油站」。";
    private AccountWindow dialog;
    private WebView wallet;
    private String state = "unopened", detail = GUIDE;
    private Integer httpStatus;

    static boolean allowedPage(Uri url) {
        if (url == null || !"https".equals(url.getScheme())) return false;
        String authority = url.getEncodedAuthority();
        return "www.workbuddy.cn".equals(authority) || "www.codebuddy.cn".equals(authority)
                || "open.weixin.qq.com".equals(authority) || "open.work.weixin.qq.com".equals(authority)
                || "graph.qq.com".equals(authority) || "xui.ptlogin2.qq.com".equals(authority);
    }

    private JSObject snapshot() {
        JSObject result = new JSObject();
        result.put("source", "website");
        result.put("state", state);
        result.put("balance", JSONObject.NULL);
        result.put("observedAt", JSONObject.NULL);
        result.put("checkIn", "unknown");
        result.put("canAutoCheckIn", false);
        result.put("autoCheckIn", false);
        result.put("detail", detail);
        result.put("httpStatus", httpStatus == null ? JSONObject.NULL : httpStatus);
        return result;
    }

    private void readMeter(PluginCall call, boolean refresh, Boolean auto) {
        if (!SecurityPlugin.isUnlocked()) { call.reject("请先解锁应用。"); return; }
        WorkBuddyWallet.isolated(() -> {
            try {
                JSObject account = WorkBuddyWallet.run(getContext(), refresh, auto, false);
                getActivity().runOnUiThread(() -> {
                    if (!SecurityPlugin.isUnlocked()) call.reject("请先解锁应用。");
                    else if (account == null && Boolean.TRUE.equals(auto)) call.reject("请先登录 WorkBuddy。");
                    else call.resolve(account == null ? snapshot() : account);
                });
            } catch (Exception failure) { call.reject("无法更新 WorkBuddy 积分设置。"); }
        });
    }
    @PluginMethod public void status(PluginCall call) { readMeter(call, false, null); }
    @PluginMethod public void refresh(PluginCall call) { readMeter(call, true, null); }
    @PluginMethod public void setAuto(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) { call.reject("请指定签到设置。"); return; }
        readMeter(call, false, enabled);
    }
    @Override protected void handleOnResume() {
        WorkBuddyWallet.isolated(() -> {
            try { WorkBuddyWallet.run(getContext(), false, null, true); } catch (Exception ignored) { /* Check again on next resume. */ }
        });
    }

    @PluginMethod public void open(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!SecurityPlugin.isUnlocked() || getActivity().isFinishing() || getActivity().isDestroyed()) {
                call.reject("请先解锁应用。");
                return;
            }
            if (dialog != null) { call.reject("WorkBuddy 账户页已打开。"); return; }
            state = "unopened";
            detail = GUIDE;
            httpStatus = null;
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                try { openBrowser(); call.resolve(snapshot()); }
                catch (ActivityNotFoundException e) { call.reject("请安装支持 HTTPS 的浏览器。"); }
                return;
            }
            show(call);
        });
    }

    private void openBrowser() {
        new CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(getActivity(), Uri.parse(USAGE));
    }

    private int dp(int value) {
        return Math.round(value * getContext().getResources().getDisplayMetrics().density);
    }

    static WebView newWalletView(android.app.Activity activity) {
        WebView page = new WebView(activity);
        WebViewCompat.setProfile(page, PROFILE);
        WebSettings settings = page.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        return page;
    }

    private void show(PluginCall call) {
        android.app.Activity activity = getActivity();
        boolean dark = new SystemBars(activity).isAppDark();
        AccountWindow window = new AccountWindow(activity, dark, null);
        window.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        window.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        int background = dark ? 0xff1e1e1e : 0xffffffff;
        content.setBackgroundColor(background);
        window.getWindow().setStatusBarColor(!dark && Build.VERSION.SDK_INT < 23 ? 0xff28344e : background);
        window.getWindow().setNavigationBarColor(!dark && Build.VERSION.SDK_INT < 26 ? 0xff28344e : background);
        int barFlags = !dark && Build.VERSION.SDK_INT >= 23 ? View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR : 0;
        if (!dark && Build.VERSION.SDK_INT >= 26) barFlags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        window.getWindow().getDecorView().setSystemUiVisibility(barFlags);
        LinearLayout bar = new LinearLayout(activity);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        content.addView(bar, -1, -2);
        Button done = new Button(window.getContext(), null, android.R.attr.borderlessButtonStyle);
        done.setText("完成");
        done.setOnClickListener(v -> window.dismiss());
        bar.addView(done);
        TextView host = new TextView(window.getContext());
        host.setGravity(Gravity.CENTER);
        host.setTextSize(14);
        host.setText("www.workbuddy.cn");
        bar.addView(host, new LinearLayout.LayoutParams(0, -2, 1));
        Button browser = new Button(window.getContext(), null, android.R.attr.borderlessButtonStyle);
        browser.setText("浏览器");
        browser.setContentDescription("在浏览器中打开 WorkBuddy 积分页");
        bar.addView(browser);
        TextView feedback = new TextView(window.getContext());
        feedback.setPadding(dp(16), dp(8), dp(16), dp(8));
        feedback.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        feedback.setVisibility(View.GONE);
        content.addView(feedback, -1, -2);
        browser.setOnClickListener(v -> {
            try { openBrowser(); window.dismiss(); }
            catch (ActivityNotFoundException e) {
                feedback.setText("请先安装可打开网页的浏览器。");
                feedback.setVisibility(View.VISIBLE);
            }
        });
        ProgressBar progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        content.addView(progress, -1, dp(2));
        WebView page = newWalletView(activity);
        // The remote page receives only browser capabilities and its isolated website storage.
        page.setWebViewClient(new WebViewClient() {
            private boolean block(Uri url) {
                if (allowedPage(url)) return false;
                feedback.setText("请点右上角「浏览器」，在系统浏览器中继续。");
                feedback.setVisibility(View.VISIBLE);
                return true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return request.isForMainFrame() ? block(request.getUrl()) : !"https".equals(request.getUrl().getScheme());
            }
            @SuppressWarnings("deprecation")
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return block(Uri.parse(url)); }
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (wallet != view) return;
                Uri dest = Uri.parse(url);
                if (block(dest)) { view.stopLoading(); return; }
                host.setText(dest.getHost());
                feedback.setVisibility(View.GONE);
                httpStatus = null;
                // A profile URL may be a login redirect in flight. A page visit never establishes an account grant.
                state = "unopened";
                detail = GUIDE;
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (wallet != view || !url.equals(view.getUrl()) || httpStatus != null || state.equals("unavailable")) return;
                Uri dest = Uri.parse(url);
                if (!allowedPage(dest)) return;
                if (("www.workbuddy.cn".equals(dest.getHost()) || "www.codebuddy.cn".equals(dest.getHost()))
                        && ("/profile/usage".equals(dest.getPath()) || "/profile/usage/".equals(dest.getPath()))) {
                    state = "account-page";
                } else if ((dest.getPath() != null && (dest.getPath().equals("/login") || dest.getPath().startsWith("/login/")))
                        || dest.getHost().endsWith(".qq.com")) {
                    state = "login-required";
                    detail = "请在腾讯官方页面登录后查看积分。";
                }
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (wallet != view || !request.isForMainFrame()) return;
                httpStatus = response.getStatusCode();
                state = httpStatus == 401 ? "login-required" : httpStatus == 403 ? "access-denied" : "unavailable";
                detail = "WorkBuddy 官网返回 HTTP " + httpStatus + "。";
                feedback.setText(detail);
                feedback.setVisibility(View.VISIBLE);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (wallet != view || !request.isForMainFrame()) return;
                state = "unavailable";
                detail = "未能载入 WorkBuddy 官网，请检查网络或在浏览器中打开。";
                feedback.setText(detail);
                feedback.setVisibility(View.VISIBLE);
            }
        });
        page.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int percent) {
                progress.setProgress(percent);
                progress.setVisibility(percent == 100 ? View.INVISIBLE : View.VISIBLE);
            }
        });
        dialog = window;
        wallet = page;
        content.addView(page, -1, -1);
        window.setContentView(content);
        window.setOnDismissListener(ignored -> {
            page.stopLoading();
            ((ViewGroup) page.getParent()).removeView(page);
            page.destroy();
            dialog = null;
            wallet = null;
            call.resolve(snapshot());
        });
        window.reveal(false);
        page.loadUrl(USAGE);
    }

    @Override protected void handleOnPause() {
        if (dialog != null && (getActivity().getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0) {
            dialog.dismissNow();
        }
    }
    @Override protected void handleOnDestroy() {
        if (dialog != null) dialog.dismissNow();
    }
}
