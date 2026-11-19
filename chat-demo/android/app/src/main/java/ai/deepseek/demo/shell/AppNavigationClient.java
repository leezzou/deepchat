package ai.deepseek.demo.shell;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/** Only the bundled document may navigate inside the WebView that hosts private native bridges. */
final class AppNavigationClient extends BridgeWebViewClient {
    private final Bridge bridge;

    AppNavigationClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    private boolean navigate(Uri url) {
        String scheme = url.getScheme();
        if (!"https".equals(scheme) && !"http".equals(scheme)) return true;
        if ("localhost".equalsIgnoreCase(url.getHost())) {
            String path = url.getEncodedPath();
            return !("https".equals(scheme) && "localhost".equals(url.getEncodedAuthority())
                    && ("/".equals(path) || "/index.html".equals(path) || "".equals(path)));
        }
        return bridge.launchIntent(url);
    }

    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return !request.isForMainFrame() || navigate(request.getUrl());
    }

    @SuppressWarnings("deprecation")
    @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return navigate(Uri.parse(url));
    }
}
