package ai.deepseek.demo.shell;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Dialog;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.InsetDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ImageButton;
import android.widget.ImageView;
import androidx.core.view.WindowCompat;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleEventObserver;
import androidx.lifecycle.LifecycleOwner;
import androidx.webkit.ProfileStore;
import androidx.webkit.UserAgentMetadata;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/** Desktop browsing mode for Tencent's WorkBuddy consent page. No Capacitor, JS bridge or page scripts. */
final class WorkBuddyDesktopBrowser {
    private static final String PREFIX = "deepchat-wb-consent-";
    private static final Set<String> RESOURCE_HOSTS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            WorkBuddySession.AUTH_HOST, "assets.workbuddy.cn", "open.weixin.qq.com", "res.wx.qq.com",
            "lp.open.weixin.qq.com", "api.account.tencent.com", "oauth2.account.tencent.com",
            "browsertdidticket.m.qq.com", "gatherer.m.qq.com",
            "graph.qq.com", "xui.ptlogin2.qq.com", "ssl.ptlogin2.qq.com", "ssl.captcha.qq.com", "t.captcha.qq.com")));
    private final String profile = PREFIX + UUID.randomUUID();
    private final Dialog dialog;
    private final WebView browser;
    private final LinearLayout column;
    private final Lifecycle lifecycle;
    private final LifecycleEventObserver observer;
    private boolean released;

    static boolean supported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
                && WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA);
    }

    static UserAgentMetadata desktopMetadata(UserAgentMetadata engine) {
        return new UserAgentMetadata.Builder(engine).setMobile(false).setPlatform("Linux")
                .setPlatformVersion("").setModel("").build();
    }

    static boolean resourceAllowed(Uri url) {
        return url != null && "https".equals(url.getScheme()) && RESOURCE_HOSTS.contains(url.getEncodedAuthority());
    }

    static boolean documentAllowed(Uri url, boolean main, String state) {
        if (!resourceAllowed(url)) return false;
        String host = url.getEncodedAuthority();
        if (WorkBuddySession.AUTH_HOST.equals(host)) {
            String path = url.getEncodedPath();
            if ("/login".equals(path) || "/login/".equals(path)) return WorkBuddySession.validApproval(url.toString(), state);
            return true; // Includes Tencent's OAuth return page. Only the native poll completes the grant.
        }
        return !main && ("open.weixin.qq.com".equals(host) || "graph.qq.com".equals(host)
                || "xui.ptlogin2.qq.com".equals(host) || "ssl.ptlogin2.qq.com".equals(host)
                || "t.captcha.qq.com".equals(host) || "ssl.captcha.qq.com".equals(host));
    }

    static String desktopUserAgent(String engine) {
        // Keep the installed Chromium version. Desktop browsing mode changes device presentation only.
        return engine.replaceFirst("\\([^)]*\\)", "(X11; Linux x86_64)")
                .replace(" Mobile Safari/", " Safari/").replace(" Version/4.0 ", " ");
    }

    @SuppressLint("SetJavaScriptEnabled")
    WorkBuddyDesktopBrowser(Activity activity, Uri page) {
        String state = page.getQueryParameter("state");
        if (!WorkBuddySession.validApproval(page.toString(), state) || !supported()) throw new IllegalStateException();
        boolean zh = "zh".equals(Locale.getDefault().getLanguage());
        lifecycle = ((LifecycleOwner) activity).getLifecycle();
        boolean dark = !WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView()).isAppearanceLightStatusBars();
        int paper = dark ? 0xff1e1e1e : 0xfff8f8f8;
        int ink = dark ? 0xfff8f8f8 : 0xff0f0f0f;
        int muted = dark ? 0xffb1b3b6 : 0xff616366;
        dialog = new Dialog(activity, dark ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        dialog.getWindow().setStatusBarColor(paper);
        dialog.getWindow().setNavigationBarColor(paper);
        WindowCompat.getInsetsController(dialog.getWindow(), dialog.getWindow().getDecorView()).setAppearanceLightStatusBars(!dark);
        WindowCompat.getInsetsController(dialog.getWindow(), dialog.getWindow().getDecorView()).setAppearanceLightNavigationBars(!dark);
        dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        dialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setFitsSystemWindows(true);
        LinearLayout bar = new LinearLayout(activity);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        float density = activity.getResources().getDisplayMetrics().density;
        int gutter = Math.round(8 * density);
        int touch = Math.round(48 * density);
        bar.setBackgroundColor(paper);
        bar.setMinimumHeight(Math.round(56 * density));
        bar.setPaddingRelative(gutter, 0, gutter + touch, 0);
        ImageButton back = new ImageButton(activity);
        back.setImageResource(R.drawable.account_chevron);
        back.setScaleX(-1f);
        back.setScaleType(ImageView.ScaleType.CENTER);
        back.setColorFilter(ink);
        GradientDrawable disc = new GradientDrawable();
        disc.setShape(GradientDrawable.OVAL);
        disc.setColor(dark ? 0xff3c3c3d : 0xffededed);
        back.setBackground(new InsetDrawable(new RippleDrawable(ColorStateList.valueOf(dark ? 0x33ffffff : 0x22000000), disc, null), Math.round(4 * density)));
        back.setContentDescription(zh ? "返回 DeepChat" : "Return to DeepChat");
        back.setOnClickListener(v -> close());
        bar.addView(back, touch, touch);
        LinearLayout siteInfo = new LinearLayout(activity);
        siteInfo.setOrientation(LinearLayout.VERTICAL);
        siteInfo.setGravity(Gravity.CENTER);
        TextView title = new TextView(activity);
        title.setText(zh ? "WorkBuddy 授权" : "WorkBuddy sign-in");
        title.setTextSize(17);
        title.setTextColor(ink);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setGravity(Gravity.CENTER);
        siteInfo.addView(title);
        TextView site = new TextView(activity);
        site.setText(WorkBuddySession.AUTH_HOST);
        site.setTextSize(13);
        site.setTextColor(muted);
        site.setGravity(Gravity.CENTER);
        siteInfo.addView(site);
        bar.addView(siteInfo, new LinearLayout.LayoutParams(0, -2, 1));
        column.addView(bar, new LinearLayout.LayoutParams(-1, -2));
        browser = new WebView(activity);
        observer = (owner, event) -> {
            if (event == Lifecycle.Event.ON_PAUSE) { browser.onPause(); dialog.hide(); }
            if (event == Lifecycle.Event.ON_RESUME && !released) {
                if (SecurityPlugin.isUnlocked()) { browser.onResume(); dialog.show(); } else close();
            }
            if (event == Lifecycle.Event.ON_DESTROY) close();
        };
        try {
            // Recover any abandoned browser partitions after process death. Never touch the app's default profile.
            ProfileStore store = ProfileStore.getInstance();
            for (String name : store.getAllProfileNames()) if (name.startsWith(PREFIX)) deleteProfile(name);
            WebViewCompat.setProfile(browser, profile);
            WebSettings settings = browser.getSettings();
            UserAgentMetadata hints = desktopMetadata(WebSettingsCompat.getUserAgentMetadata(settings));
            settings.setUserAgentString(desktopUserAgent(settings.getUserAgentString()));
            WebSettingsCompat.setUserAgentMetadata(settings, hints);
            settings.setUseWideViewPort(true);
            settings.setLoadWithOverviewMode(true);
            settings.setSupportZoom(true);
            settings.setBuiltInZoomControls(true);
            settings.setDisplayZoomControls(false);
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setGeolocationEnabled(false);
            settings.setSupportMultipleWindows(true); // No popup handler. No external intents or app links.
            if (Build.VERSION.SDK_INT >= 26) browser.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
            browser.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                    boolean blocked = !documentAllowed(req.getUrl(), req.isForMainFrame(), state);
                    if (blocked && req.isForMainFrame()) Toast.makeText(activity, zh ? "请在 WorkBuddy 官方登录页完成授权" : "Continue on the WorkBuddy sign-in page", Toast.LENGTH_SHORT).show();
                    return blocked;
                }
                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                    boolean allow = req.isForMainFrame() ? documentAllowed(req.getUrl(), true, state) : resourceAllowed(req.getUrl());
                    return allow ? null : new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                }
            });
            column.addView(browser, new LinearLayout.LayoutParams(-1, 0, 1));
            dialog.setContentView(column);
            dialog.setOnDismissListener(d -> release());
            dialog.show();
            dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            lifecycle.addObserver(observer);
            browser.loadUrl(page.toString());
        } catch (RuntimeException failure) { close(); throw failure; }
    }
    void close() { dialog.dismiss(); release(); }
    private void release() {
        if (released) return;
        released = true;
        lifecycle.removeObserver(observer);
        browser.stopLoading();
        column.removeView(browser);
        browser.destroy();
        deleteProfile(profile);
    }
    private static void deleteProfile(String name) {
        try { ProfileStore.getInstance().deleteProfile(name); }
        catch (IllegalStateException stillInUse) { /* A subsequent cold start can reclaim this partition. */ }
    }
}
