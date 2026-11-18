package ai.deepseek.demo.shell;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/**
 * Web 与原生之间的两块小桥：
 * 1) 状态栏/导航栏跟随主题 —— 两条系统栏都不透明、颜色 = 页面底色（浅色 #FFFFFF / 深色 #0F0F0F），
 *    图标深浅随主题翻转。JS 侧由 src/shell/native.ts 调用 window.AndroidSystemBars.setDark()。
 * 2) 录音权限 —— WebView 的 getUserMedia 在原生权限未授予时必然失败，
 *    点语音输入时由 JS 调 requestMicrophone()，结果通过 window.__onMicPermission(granted) 回传。
 */
public class SystemBars {
    static final int MIC_REQUEST_CODE = 1001;

    private static final int LIGHT_BG = Color.parseColor("#FFFFFF");
    private static final int DARK_BG = Color.parseColor("#0F0F0F");

    private final Activity activity;
    private Boolean appDark;
    private Runnable themeChanged;

    void onThemeChanged(Runnable listener) { themeChanged = listener; }

    boolean isAppDark() {
        if (appDark != null) return appDark;
        int mode = activity.getResources().getConfiguration().uiMode;
        return (mode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
    }

    public SystemBars(Activity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public void setDark(final boolean dark) {
        activity.runOnUiThread(
                new Runnable() {
                    @Override
                    public void run() {
                        apply(dark);
                    }
                });
    }

    @JavascriptInterface
    public void requestMicrophone() {
        activity.runOnUiThread(
                new Runnable() {
                    @Override
                    public void run() {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                                && activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                                        != PackageManager.PERMISSION_GRANTED) {
                            activity.requestPermissions(
                                    new String[] {Manifest.permission.RECORD_AUDIO},
                                    MIC_REQUEST_CODE);
                            return;
                        }
                        notifyMicrophone(true);
                    }
                });
    }

    /** 由 MainActivity.onRequestPermissionsResult 调用，把最终结果回传 Web */
    void notifyMicrophone(final boolean granted) {
        final WebView webView = ((MainActivity) activity).getBridge().getWebView();
        webView.post(
                new Runnable() {
                    @Override
                    public void run() {
                        webView.evaluateJavascript(
                                "window.__onMicPermission&&window.__onMicPermission(" + granted + ")",
                                null);
                    }
                });
    }

    private void apply(boolean dark) {
        boolean changed = appDark == null || appDark != dark;
        appDark = dark;
        if (changed && themeChanged != null) themeChanged.run();
        Window window = activity.getWindow();
        int background = dark ? DARK_BG : LIGHT_BG;
        window.setStatusBarColor(background);
        window.setNavigationBarColor(background);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // 三键导航的分隔线也要跟着底色走，否则深色下会留一条浅线
            window.setNavigationBarDividerColor(background);
        }

        View decor = window.getDecorView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = decor.getWindowInsetsController();
            if (controller != null) {
                int mask =
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(dark ? 0 : mask, mask);
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            int flags =
                    View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            decor.setSystemUiVisibility(dark ? 0 : flags);
        }
    }
}
