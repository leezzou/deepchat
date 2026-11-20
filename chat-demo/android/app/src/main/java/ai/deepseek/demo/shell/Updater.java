package ai.deepseek.demo.shell;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import android.webkit.JavascriptInterface;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;

/** Download into the private cache. Only the explicit, safety-checked install action leaves the app. */
public class Updater {
    private static final String APK_NAME = "update.apk";
    private final MainActivity activity;
    private final AtomicBoolean downloading = new AtomicBoolean(false);
    private volatile String downloadedVersion = "";

    public Updater(MainActivity activity) {
        this.activity = activity;
        if (activity.getPreferences(0).getBoolean("updateReady", false)) {
            try {
                downloadedVersion = inspectArchive("");
            } catch (Exception stale) {
                setDownloadedVersion("");
            }
        }
    }

    private void setDownloadedVersion(String version) {
        downloadedVersion = version;
        activity.getPreferences(0).edit().putBoolean("updateReady", !version.isEmpty()).apply();
    }

    @JavascriptInterface
    public String getInstalledVersion() {
        try {
            return installedPackage().versionName;
        } catch (Exception unavailable) {
            return "";
        }
    }

    private PackageInfo installedPackage() throws Exception {
        return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
    }

    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    // Also validates an older shell's ready flag on startup, after package replacement or cache eviction.
    private String inspectArchive(String expectedVersion) throws Exception {
        File apk = new File(activity.getCacheDir(), APK_NAME);
        PackageInfo candidate = activity.getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
        if (candidate == null || !activity.getPackageName().equals(candidate.packageName)
                || candidate.versionName == null || candidate.versionName.isEmpty()
                || (!expectedVersion.isEmpty() && !expectedVersion.equals(candidate.versionName))
                || versionCode(candidate) <= versionCode(installedPackage())) {
            throw new Exception("安装包与待更新版本不符");
        }
        return candidate.versionName;
    }

    private void dispatch(String eventExpression) {
        activity.runOnUiThread(() -> {
            if (!activity.isDestroyed() && activity.getBridge() != null) {
                activity.getBridge().getWebView().evaluateJavascript("window.dispatchEvent(" + eventExpression + ")", null);
            }
        });
    }

    private void notifyWeb(String event) {
        dispatch("new Event('deepchat:update-" + event + "')");
    }

    @JavascriptInterface
    public boolean isDownloadedUpdateReady() {
        return !downloadedVersion.isEmpty() && new File(activity.getCacheDir(), APK_NAME).isFile();
    }

    @JavascriptInterface
    public String getDownloadedVersion() {
        return isDownloadedUpdateReady() ? downloadedVersion : "";
    }

    @JavascriptInterface
    public void installDownloadedApk() {
        activity.runOnUiThread(() -> {
            if (!isDownloadedUpdateReady()) {
                notifyWeb("install-failed");
                return;
            }
            activity.getBridge().getWebView().evaluateJavascript(
                    "Boolean(window.__deepchatCanInstallUpdate && window.__deepchatCanInstallUpdate())",
                    allowed -> {
                        if ("true".equals(allowed)) launchInstaller();
                        else notifyWeb("ready");
                    });
        });
    }

    @JavascriptInterface
    public void installApk(String url) {
        installApkWithFallback(url, "");
    }

    @JavascriptInterface
    public void installApkWithFallback(String url, String fallbackUrl) {
        installApkForVersion(url, fallbackUrl, "");
    }

    @JavascriptInterface
    public void installApkForVersion(String url, String fallbackUrl, String version) {
        activity.runOnUiThread(() -> {
            if (!downloading.compareAndSet(false, true)) return;
            setDownloadedVersion("");
            new Thread(() -> download(url, fallbackUrl, version == null ? "" : version), "deepchat-update").start();
        });
    }

    private void download(String url, String fallbackUrl, String version) {
        try {
            String actualVersion;
            try {
                downloadFile(url);
                actualVersion = inspectArchive(version);
            } catch (Exception mirrorFailed) {
                if (fallbackUrl == null || fallbackUrl.isEmpty() || fallbackUrl.equals(url)) throw mirrorFailed;
                downloadFile(fallbackUrl);
                actualVersion = inspectArchive(version);
            }
            setDownloadedVersion(actualVersion);
            notifyWeb("ready");
        } catch (Exception failed) {
            notifyWeb("failed");
        } finally {
            downloading.set(false);
        }
    }

    private void downloadFile(String url) throws Exception {
        File target = new File(activity.getCacheDir(), APK_NAME);
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setRequestProperty("User-Agent", "DeepChat-Updater");
            connection.setRequestProperty("Accept-Encoding", "identity");
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                throw new Exception("HTTP " + connection.getResponseCode());
            }
            long total = connection.getContentLength();
            long received = 0;
            long nextReport = 0;
            try (InputStream input = connection.getInputStream();
                    FileOutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[16384];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                    received += read;
                    if (SystemClock.elapsedRealtime() >= nextReport || received == total) {
                        dispatch("new CustomEvent('deepchat:update-progress',{detail:{received:" + received + ",total:" + total + "}})");
                        nextReport = SystemClock.elapsedRealtime() + 250;
                    }
                }
            }
            if (total > 0 && received != total) throw new Exception("下载不完整");
        } finally {
            connection.disconnect();
        }
    }

    private String findSystemInstaller() {
        Intent probe = new Intent(Intent.ACTION_VIEW);
        probe.setType("application/vnd.android.package-archive");
        for (ResolveInfo info : activity.getPackageManager().queryIntentActivities(probe, 0)) {
            String pkg = info.activityInfo != null ? info.activityInfo.packageName : "";
            if (pkg.toLowerCase().contains("packageinstaller")) return pkg;
        }
        return null;
    }

    private void launchInstaller() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !activity.getPackageManager().canRequestPackageInstalls()) {
                notifyWeb("permission");
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName())));
                return;
            }
            File apk = new File(activity.getCacheDir(), APK_NAME);
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            String installer = findSystemInstaller();
            if (installer != null) intent.setPackage(installer);
            activity.startActivity(intent);
            // Cancellation and permission changes retain the verified file for the next explicit install.
        } catch (Exception error) {
            notifyWeb("install-failed");
        }
    }
}
