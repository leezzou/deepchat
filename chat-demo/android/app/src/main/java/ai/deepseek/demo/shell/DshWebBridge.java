package ai.deepseek.demo.shell;

import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;
import org.json.JSONObject;

/** Only the packaged Capacitor main document may request inference or open native account controls. */
final class DshWebBridge {
    private final WebView web;
    private final DshAccountHost host;
    private final DshMessagesTransport transport;
    private JavaScriptReplyProxy page;
    interface AccountOpener { void show(boolean fromUsage, boolean confirmLogout); }
    DshWebBridge(WebView web, DshAccountHost host, AccountOpener openAccount) {
        this.web = web;
        this.host = host;
        transport = new DshMessagesTransport(host);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(web, "DshNative", Collections.singleton("https://localhost"),
                (view, message, origin, mainFrame, reply) -> {
                    if (!SecurityPlugin.isPackagedPage(view, origin, mainFrame) || !SecurityPlugin.isUnlocked()
                            || message.getType() != androidx.webkit.WebMessageCompat.TYPE_STRING) return;
                    String text = message.getData();
                    // The largest inline body is ASR (8 MiB + MIME). Upload chunks are 128 KiB of base64.
                    if (text == null || text.length() > 12 * 1024 * 1024) return;
                    String id = "";
                    try {
                        JSONObject request = new JSONObject(text);
                        page = reply;
                        switch (request.getString("op")) {
                            case "status": changed(); return;
                            case "account": openAccount.show(Boolean.TRUE.equals(request.opt("fromUsage")), false); return;
                            case "confirmAccountLogout": openAccount.show(false, true); return;
                        }
                        id = request.getString("id");
                        if (!id.matches("[a-zA-Z0-9-]{1,64}")) return;
                        final String call = id;
                        DshMessagesTransport.Reply sink = frame -> web.post(() -> {
                            if (page != reply) { transport.cancel(call); return; }
                            if (frame.optInt("status") == 401) changed();
                            try { reply.postMessage(frame.put("id", call).toString()); } catch (Exception gone) { transport.cancel(call); }
                        });
                        switch (request.getString("op")) {
                            case "cancel": transport.cancel(id); return;
                            case "chunk": transport.chunk(id, request.getLong("offset"), request.getString("body")); return;
                            case "upload":
                                transport.startUpload(id, request.getString("path"), request.getString("method"), request.getString("contentType"), request.getLong("length"), sink);
                                return;
                            case "request":
                                transport.start(id, request.getString("path"), request.getString("method"), request.optString("contentType"), request.optString("body"), sink);
                        }
                    } catch (Exception invalid) {
                        try { reply.postMessage(new JSONObject().put("type", "error").put("id", id).put("message", "请求未能发送，请稍后重试。").toString()); } catch (Exception ignored) {}
                    }
                });
    }
    void changed() {
        if (page == null || !SecurityPlugin.isUnlocked()) return;
        try {
            JSONObject status = host.status();
            status.put("type", "account");
            page.postMessage(status.toString());
        } catch (Exception ignored) {}
    }
    void close() {
        WebViewCompat.removeWebMessageListener(web, "DshNative");
        page = null;
        transport.close();
    }
}
