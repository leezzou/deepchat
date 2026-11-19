package ai.deepseek.demo.shell;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import android.provider.OpenableColumns;
import android.text.Html;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** Intent intake is independent of React readiness. Only an unlocked packaged main frame can pull data. */
@CapacitorPlugin(name = "IncomingShare")
public final class IncomingSharePlugin extends Plugin {
    private static final String PORT = "DeepChatIncoming";
    private static final String LAUNCH_KEY = "deepchat.incoming.launch";
    private static final int MAX_IMAGES = 1, MAX_TEXT = 128 * 1024, CHUNK = 128 * 1024;
    private static final long MAX_BYTES = 64L * 1024 * 1024;
    private static final WeakHashMap<Activity, String> launchIds = new WeakHashMap<>();
    private static final ArrayDeque<Entry> queue = new ArrayDeque<>();
    private static int overflow;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean closed;
    private WebView web;
    // These fields are accessed only on the worker. No WebView or JS-supplied path can open a URI.
    private List<Uri> images = Collections.emptyList();
    private String describedId;
    private InputStream stream;
    private long offset, total;
    private int imageIndex;

    private static final class Entry {
        final String id;
        final Intent intent;
        Entry(String id, Intent intent) { this.id = id; this.intent = intent; }
    }

    public static void restoreLaunch(Activity activity, Bundle state) {
        String id = state == null ? null : state.getString(LAUNCH_KEY);
        launchIds.put(activity, id != null ? id : UUID.randomUUID().toString());
    }
    public static void saveLaunch(Activity activity, Bundle state) {
        state.putString(LAUNCH_KEY, launchIds.get(activity));
    }

    @Override protected void handleOnNewIntent(Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action)) return;
        String id = intent == getActivity().getIntent() ? launchIds.get(getActivity()) : null;
        if (id != null && id.isEmpty()) return; // This activity's saved launch was already acknowledged.
        if (id == null) id = UUID.randomUUID().toString();
        synchronized (queue) {
            for (Entry pending : queue) if (pending.id.equals(id)) return;
            if (queue.size() >= 16) overflow++;
            else queue.addLast(new Entry(id, intent));
        }
        signal();
    }

    private void signal() {
        if (web != null && SecurityPlugin.isUnlocked()) {
            web.evaluateJavascript("window.dispatchEvent(new Event('deepchat:incoming-share'))", null);
        }
    }
    @Override protected void handleOnResume() { signal(); }

    @Override public void load() {
        web = bridge.getWebView();
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(web, PORT, Collections.singleton("https://localhost"),
            (view, message, origin, main, reply) -> {
                if (!SecurityPlugin.isPackagedPage(view, origin, main) || !SecurityPlugin.isUnlocked()
                        || message.getType() != WebMessageCompat.TYPE_STRING) return;
                String data = message.getData();
                if (data == null || data.length() > 512 || closed) return;
                worker.execute(() -> {
                    JSONObject result = new JSONObject();
                    try {
                        if (closed || !SecurityPlugin.isUnlocked()) return;
                        JSONObject request = new JSONObject(data);
                        result.put("request", request.getString("request"));
                        try { result.put("value", dispatch(request)); }
                        catch (Exception unreadable) { closeStream(); result.put("error", true); }
                        web.post(() -> {
                            if (closed || !SecurityPlugin.isUnlocked() || !SecurityPlugin.isPackagedPage(view, origin, main)) return;
                            try { reply.postMessage(result.toString()); } catch (RuntimeException detached) { /* document gone */ }
                        });
                    } catch (Exception invalidRequest) { /* malformed frames have no reply */ }
                });
            });
    }

    private JSONObject dispatch(JSONObject request) throws Exception {
        String op = request.getString("op");
        Entry head;
        synchronized (queue) {
            head = queue.peekFirst();
            if ("peek".equals(op)) {
                JSONObject value = new JSONObject().put("overflow", overflow > 0);
                overflow = 0;
                return head == null ? value : value.put("id", head.id);
            }
            if (head == null || !head.id.equals(request.getString("id"))) throw new IOException();
            if ("ack".equals(op)) {
                if (!SecurityPlugin.isUnlocked()) throw new IOException();
                queue.removeFirst();
                web.post(() -> {
                    if (head.id.equals(launchIds.get(getActivity()))) launchIds.put(getActivity(), "");
                });
                closeStream();
                images = Collections.emptyList(); describedId = null;
                return new JSONObject();
            }
        }
        if ("describe".equals(op)) return describe(head);
        if ("read".equals(op) && head.id.equals(describedId)) return read(request);
        throw new IOException();
    }

    private String text(CharSequence value) throws IOException {
        if (value == null) return "";
        if (value.length() > MAX_TEXT) throw new IOException();
        return value.toString();
    }
    @SuppressWarnings("deprecation")
    private JSONObject describe(Entry entry) throws Exception {
        closeStream(); images = Collections.emptyList(); describedId = null;
        Intent intent = entry.intent;
        String mime = intent.getType();
        if (mime == null || !(mime.startsWith("image/") || "text/plain".equals(mime) || "text/html".equals(mime))) throw new IOException();
        ClipData clip = intent.getClipData();
        if (clip != null && clip.getItemCount() > MAX_IMAGES) throw new IOException();
        String content = text(intent.getCharSequenceExtra(Intent.EXTRA_TEXT));
        if (content.isEmpty() && clip != null && clip.getItemCount() > 0) content = text(clip.getItemAt(0).getText());
        String html = text(intent.getStringExtra(Intent.EXTRA_HTML_TEXT));
        if (content.isEmpty() && !html.isEmpty()) content = Html.fromHtml(html).toString();
        else if ("text/html".equals(mime) && html.isEmpty()) content = Html.fromHtml(content).toString();
        if (content.isEmpty() && clip != null && clip.getItemCount() > 0) {
            Uri link = clip.getItemAt(0).getUri();
            if (link != null && ("https".equals(link.getScheme()) || "http".equals(link.getScheme()))) content = text(link.toString());
        }
        LinkedHashSet<Uri> sources = new LinkedHashSet<>();
        if (mime.startsWith("image/")) {
            Uri streamUri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (streamUri != null) sources.add(streamUri);
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri(); if (uri != null) sources.add(uri);
            }
            if (sources.isEmpty() || sources.size() > MAX_IMAGES) throw new IOException();
        }
        if (sources.isEmpty() && content.trim().isEmpty()) throw new IOException();
        JSONArray files = new JSONArray();
        long claimedSize = 0;
        ContentResolver resolver = getContext().getContentResolver();
        for (Uri uri : sources) {
            if (!SecurityPlugin.isUnlocked() || uri == null || !"content".equals(uri.getScheme()) || uri.getAuthority() == null
                    || uri.getAuthority().contains("@") || uri.getAuthority().startsWith(getContext().getPackageName() + ".")
                    || (intent.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0
                    || getContext().checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) throw new IOException();
            String type = resolver.getType(uri);
            if (type == null || !type.startsWith("image/")) throw new IOException();
            String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(type.toLowerCase(Locale.ROOT));
            String name = "shared-" + (files.length() + 1) + "." + (ext == null ? "img" : ext);
            try (Cursor c = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int col = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (col >= 0 && !c.isNull(col)) {
                        String n = c.getString(col).replaceAll("[\\p{Cntrl}/\\\\]", "_");
                        if (!n.trim().isEmpty() && n.length() <= 220) name = n.contains(".") || ext == null ? n : n + "." + ext;
                    }
                    int size = c.getColumnIndex(OpenableColumns.SIZE);
                    if (size >= 0 && !c.isNull(size)) {
                        long n = c.getLong(size);
                        if (n > MAX_BYTES - claimedSize) throw new IOException();
                        claimedSize += Math.max(n, 0);
                    }
                }
            }
            files.put(new JSONObject().put("name", name).put("type", type));
        }
        images = new ArrayList<>(sources); describedId = entry.id;
        imageIndex = 0; offset = 0; total = 0;
        return new JSONObject().put("text", content).put("images", files);
    }

    private JSONObject read(JSONObject request) throws Exception {
        if (request.getInt("index") != imageIndex || imageIndex >= images.size() || request.getLong("offset") != offset) throw new IOException();
        if (stream == null) stream = getContext().getContentResolver().openInputStream(images.get(imageIndex));
        if (stream == null) throw new IOException();
        byte[] bytes = new byte[CHUNK];
        int size = 0;
        while (size < bytes.length) {
            if (!SecurityPlugin.isUnlocked() || closed) throw new IOException();
            int n = stream.read(bytes, size, bytes.length - size);
            if (n < 0) break;
            if (n == 0 || total + size + n > MAX_BYTES) throw new IOException();
            size += n;
        }
        total += size; offset += size;
        boolean done = size < bytes.length;
        if (done) { if (offset == 0) throw new IOException(); closeStream(); imageIndex++; offset = 0; }
        return new JSONObject().put("data", Base64.encodeToString(bytes, 0, size, Base64.NO_WRAP)).put("done", done);
    }
    private void closeStream() {
        if (stream != null) { try { stream.close(); } catch (IOException ignored) {} stream = null; }
    }
    @Override protected void handleOnDestroy() {
        closed = true;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) WebViewCompat.removeWebMessageListener(web, PORT);
        worker.execute(this::closeStream);
        worker.shutdown();
    }
}
