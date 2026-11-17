package ai.deepseek.demo.shell;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 应用内更新：把 GitHub Release 里的 APK 下到缓存目录，再拉起系统安装器。
 * JS 侧见 src/shell/installer.ts（window.AndroidUpdater.installApk）。
 */
public class Updater {
    private static final String APK_NAME = "update.apk";

    private final MainActivity activity;

    public Updater(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public void installApk(final String url) {
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
                            return;
                        }
                        toast("开始下载更新…");
                        new Thread(() -> download(url)).start();
                    }
                });
    }

    private void download(String url) {
        File target = new File(activity.getCacheDir(), APK_NAME);
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.connect();
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                fail("下载失败：HTTP " + connection.getResponseCode());
                return;
            }
            try (InputStream input = connection.getInputStream();
                    FileOutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) > 0) {
                    output.write(buffer, 0, read);
                }
            }
            activity.runOnUiThread(this::launchInstaller);
        } catch (Exception error) {
            fail("下载失败：" + error.getMessage());
        }
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
            activity.startActivity(intent);
        } catch (Exception error) {
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
