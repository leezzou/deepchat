package ai.deepseek.demo.shell;

import android.net.Uri;
import android.webkit.WebView;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import javax.net.ssl.HttpsURLConnection;

/** Transfers only the application's encrypted file and random connection probes. */
@CapacitorPlugin(name = "WebDav")
public class WebDavPlugin extends Plugin {
    private static final int LIMIT = 32 * 1024 * 1024;
    private static final String UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

    @PluginMethod
    public void transfer(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            WebView view = getBridge().getWebView();
            Uri page = Uri.parse(view.getUrl() == null ? "" : view.getUrl());
            Uri origin = new Uri.Builder().scheme(page.getScheme()).encodedAuthority(page.getEncodedAuthority()).build();
            // Capacitor's WebMessageListener delivers plugin calls only from the main frame.
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                    || getBridge().getConfig().isUsingLegacyBridge() || !SecurityPlugin.isUnlocked()
                    || !SecurityPlugin.isPackagedPage(view, origin, true)) {
                call.reject("Unavailable");
                return;
            }
            getBridge().execute(() -> WebDavCookies.isolate(() -> runTransfer(call)));
        });
    }

    private void runTransfer(PluginCall call) {
        HttpsURLConnection connection = null;
        try {
            if (!SecurityPlugin.isUnlocked()) throw new IOException();
            URI url = new URI(call.getString("url", ""));
            String method = call.getString("method", "");
            String name = call.getString("cacheFile", "");
            boolean probe = Boolean.TRUE.equals(call.getBoolean("probe", false));
            if (!"https".equals(url.getScheme()) || url.getHost() == null || url.getUserInfo() != null
                    || url.getQuery() != null || url.getFragment() != null || !name.matches("deepchat-dav-" + UUID_PATTERN + "\\.tmp")) throw new IOException();
            String path = url.getRawPath();
            String leaf = path.substring(path.lastIndexOf('/') + 1);
            if (probe ? !leaf.matches("\\.deepchat-probe-" + UUID_PATTERN) : !leaf.equals("deepchat-backup.dcb")) throw new IOException();
            if (!(method.equals("GET") || method.equals("PUT") || (probe && method.equals("DELETE")))) throw new IOException();
            File cache = new File(getContext().getCacheDir(), name);
            connection = (HttpsURLConnection) url.toURL().openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(60000);
            connection.setUseCaches(false);
            connection.setRequestMethod(method);
            String auth = call.getString("authorization", "");
            if (!auth.isEmpty()) {
                if (!auth.matches("Basic [A-Za-z0-9+/=]+")) throw new IOException();
                connection.setRequestProperty("Authorization", auth);
            }
            if (method.equals("PUT")) {
                long size = cache.length();
                if (!cache.isFile() || size > LIMIT) throw new IOException();
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode((int) size);
                connection.setRequestProperty("Content-Type", "application/octet-stream");
                if (probe) connection.setRequestProperty("If-None-Match", "*");
                try (InputStream input = new FileInputStream(cache); OutputStream output = connection.getOutputStream()) {
                    copy(input, output);
                }
            }
            int status = connection.getResponseCode();
            if (method.equals("GET") && status == 200) {
                if (connection.getContentLength() > LIMIT) status = 413;
                else try (InputStream input = connection.getInputStream(); OutputStream output = new FileOutputStream(cache)) {
                    copy(input, output);
                }
            }
            JSObject result = new JSObject();
            result.put("status", status);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Transfer failed"); // Never expose credentials, paths or response bodies to logs.
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[32768];
        int count, total = 0;
        while ((count = input.read(buffer)) != -1) {
            total += count;
            if (total > LIMIT || !SecurityPlugin.isUnlocked()) throw new IOException();
            output.write(buffer, 0, count);
        }
    }
}
