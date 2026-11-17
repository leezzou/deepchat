package ai.deepseek.demo.shell;

import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 应用内更新：把 GitHub Release 里的 APK 下到缓存目录，再拉起系统安装器。
 * JS 侧见 src/shell/installer.ts（window.AndroidUpdater.installApk）。
 */
public class Updater {
    private static final String APK_NAME = "update.apk";

    private final MainActivity activity;
    private final AtomicBoolean downloading = new AtomicBoolean(false);
    private volatile boolean downloadedReady;

    public Updater(MainActivity activity) {
        this.activity = activity;
        this.downloadedReady = activity.getPreferences(0).getBoolean("updateReady", false)
                && new File(activity.getCacheDir(), APK_NAME).isFile();
    }

    private void setDownloadedReady(boolean ready) {
        downloadedReady = ready;
        activity.getPreferences(0).edit().putBoolean("updateReady", ready).apply();
    }

    private void notifyWeb(String event) {
        activity.runOnUiThread(() -> activity.getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new Event('" + event + "'))", null));
    }

    @JavascriptInterface
    public boolean isDownloadedUpdateReady() {
        return downloadedReady && new File(activity.getCacheDir(), APK_NAME).isFile();
    }

    /** Recheck immediately before leaving the WebView; a draft may have changed since the click. */
    @JavascriptInterface
    public void installDownloadedApk() {
        activity.runOnUiThread(() -> {
            if (!isDownloadedUpdateReady()) return;
            activity.getBridge().getWebView().evaluateJavascript(
                    "Boolean(window.__deepchatCanInstallUpdate && window.__deepchatCanInstallUpdate())",
                    allowed -> {
                        if ("true".equals(allowed)) launchInstaller();
                        else notifyWeb("deepchat:update-ready");
                    });
        });
    }

    @JavascriptInterface
    public void installApk(final String url) {
        installApkWithFallback(url, "");
    }

    /** 优先使用镜像地址；镜像失败时自动尝试 GitHub 原始地址。 */
    @JavascriptInterface
    public void installApkWithFallback(final String url, final String fallbackUrl) {
        activity.runOnUiThread(
                new Runnable() {
                    @Override
                    public void run() {
                        // Android 8+ 需要用户先允许「安装未知应用」，没有就先把用户带到开关页
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                                && !activity.getPackageManager().canRequestPackageInstalls()) {
                            toast("请先允许 DeepChat 安装应用，然后再试一次");
                            Intent settings =
                                    new Intent(
                                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                            Uri.parse("package:" + activity.getPackageName()));
                            activity.startActivity(settings);
                            notifyWeb("deepchat:update-permission");
                            return;
                        }
                        if (!downloading.compareAndSet(false, true)) return;
                        setDownloadedReady(false);
                        toast("开始下载更新…");
                        new Thread(() -> download(url, fallbackUrl)).start();
                    }
                });
    }

    private void download(String url, String fallbackUrl) {
        try {
            downloadFile(url);
            setDownloadedReady(true);
            downloading.set(false);
            notifyWeb("deepchat:update-ready");
        } catch (Exception error) {
            if (fallbackUrl != null
                    && !fallbackUrl.isEmpty()
                    && !fallbackUrl.equals(url)) {
                // 镜像不可用时不打扰用户，直接换 GitHub 原始地址再试一次
                download(fallbackUrl, "");
                return;
            }
            downloading.set(false);
            notifyWeb("deepchat:update-failed");
            fail("下载失败：" + error.getMessage());
        }
    }

    private void downloadFile(String url) throws Exception {
        File target = new File(activity.getCacheDir(), APK_NAME);
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(true);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setRequestProperty("User-Agent", "DeepChat-Updater");
        connection.connect();
        if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
            throw new Exception("HTTP " + connection.getResponseCode());
        }
        try (InputStream input = connection.getInputStream();
                FileOutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) > 0) {
                output.write(buffer, 0, read);
            }
        }
        // 代理可能返回 200 的 HTML 错误页；APK 是 ZIP，至少要以 PK 开头。
        try (FileInputStream input = new FileInputStream(target)) {
            byte[] magic = new byte[2];
            if (input.read(magic) != 2 || magic[0] != 'P' || magic[1] != 'K') {
                throw new Exception("下载内容不是 APK");
            }
        }
    }

    /** 找到系统「软件包安装程序」的包名，避免弹出「打开方式」选择框 */
    private String findSystemInstaller() {
        Intent probe = new Intent(Intent.ACTION_VIEW);
        probe.setType("application/vnd.android.package-archive");
        for (ResolveInfo info : activity.getPackageManager().queryIntentActivities(probe, 0)) {
            String pkg = info.activityInfo != null ? info.activityInfo.packageName : "";
            if (pkg.toLowerCase().contains("packageinstaller")) {
                return pkg;
            }
        }
        return null;
    }

    private void launchInstaller() {
        File apk = new File(activity.getCacheDir(), APK_NAME);
        try {
            Uri uri =
                    FileProvider.getUriForFile(
                            activity, activity.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            // 显式指定系统安装器；找不到时退回系统默认选择
            String installer = findSystemInstaller();
            if (installer != null) {
                intent.setPackage(installer);
            }
            activity.startActivity(intent);
            setDownloadedReady(false);
        } catch (Exception error) {
            notifyWeb("deepchat:update-ready");
            fail("无法打开安装器：" + error.getMessage());
        }
    }

    private void fail(String message) {
        activity.runOnUiThread(() -> toast(message));
    }

    private void toast(String message) {
        Toast.makeText(activity, message, Toast.LENGTH_SHORT).show();
    }
}
