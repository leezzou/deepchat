package ai.deepseek.demo.shell;

import android.net.Uri;
import android.util.Base64;
import android.webkit.WebView;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;

/** The packaged page can seek within a single named import in private cache storage. */
@CapacitorPlugin(name = "HistoryArchive")
public class HistoryArchivePlugin extends Plugin {
    @Override public void load() {
        HistoryArchiveCache.sweepAtProcessStart(getContext().getCacheDir());
    }

    @PluginMethod public void readRange(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            WebView web = getBridge().getWebView();
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                    || getBridge().getConfig().isUsingLegacyBridge() || !SecurityPlugin.isUnlocked()
                    || !SecurityPlugin.isPackagedPage(web, Uri.parse("https://localhost"), true)) {
                call.reject("Local cache read unavailable");
                return;
            }
            getBridge().execute(() -> readOnWorker(call));
        });
    }

    private void readOnWorker(PluginCall call) {
        try {
            if (!SecurityPlugin.isUnlocked()) throw new IOException();
            byte[] bytes = HistoryArchiveCache.readRange(getContext().getCacheDir(), call.getString("id"),
                    integer(call, "size"), integer(call, "offset"), integer(call, "length"));
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception ignored) {
            call.reject("Local cache read failed");
        }
    }

    // JSON integers may be Integer or Long, including the inclusive 2 GiB size boundary.
    private static long integer(PluginCall call, String key) throws IOException {
        Object value = call.getData().opt(key);
        if (!(value instanceof Integer || value instanceof Long)) throw new IOException();
        return ((Number) value).longValue();
    }
}
