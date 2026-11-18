package ai.deepseek.demo.shell;

import static org.junit.Assert.assertTrue;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Proxy;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.nio.charset.StandardCharsets;
import java.security.cert.Certificate;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.Queue;
import java.util.TreeMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.HttpsURLConnection;

/** The URL handler lives for one instrumentation process. Run the account test class on its own. */
final class OfflineHttps {
    private static volatile OfflineHttps active;
    private final Queue<Exchange> expected = new ArrayDeque<>();
    private final Queue<String> unexpected = new ArrayDeque<>();

    private static boolean installed;

    static synchronized void install() throws Exception {
        if (installed) return;
        URLStreamHandler handler = new URLStreamHandler() {
            @Override protected URLConnection openConnection(URL url) throws IOException {
                return openConnection(url, null);
            }

            @Override protected URLConnection openConnection(URL url, Proxy proxy) throws IOException {
                if (!"https".equals(url.getProtocol())) throw new IOException("HTTP disabled in this test process");
                return new Connection(url, proxy, active);
            }
        };
        URL.setURLStreamHandlerFactory(protocol ->
            "https".equals(protocol) || "http".equals(protocol) ? handler : null);
        // Check both URL entry points before any account code runs. Opening alone sends no request.
        URL probe = new URL("https://offline.invalid/");
        assertTrue(probe.openConnection() instanceof Connection);
        assertTrue(probe.openConnection(Proxy.NO_PROXY) instanceof Connection);
        installed = true;
    }

    void activate() { active = this; }

    synchronized Exchange expect(String method, String url, int status, String type, InputStream body) {
        Exchange exchange = new Exchange(method, url, status, type, body);
        expected.add(exchange);
        return exchange;
    }

    Exchange json(String method, String url, int status, String body) {
        return expect(method, url, status, "application/json", bytes(body));
    }

    static InputStream bytes(String text) {
        return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
    }

    synchronized void finish() {
        active = null;
        assertTrue("Unexpected HTTPS requests: " + unexpected, unexpected.isEmpty());
        assertTrue("Missing HTTPS requests: " + expected, expected.isEmpty());
    }

    private synchronized Exchange match(Connection request) throws IOException {
        Exchange next = expected.peek();
        String address = request.getURL().toExternalForm();
        if (next == null || !next.url.equals(address) || !next.method.equals(request.getRequestMethod())) {
            String detail = request.getRequestMethod() + " " + address;
            unexpected.add(detail);
            throw new IOException("Unscripted HTTPS request: " + detail);
        }
        expected.remove();
        next.request = request;
        next.received.countDown();
        return next;
    }

    static final class Exchange {
        final String method, url, type;
        final int status;
        final InputStream body;
        final CountDownLatch received = new CountDownLatch(1);
        private Connection request;

        Exchange(String method, String url, int status, String type, InputStream body) {
            this.method = method;
            this.url = url;
            this.status = status;
            this.type = type;
            this.body = body;
        }

        Connection await() throws InterruptedException {
            assertTrue("Timed out waiting for " + this, received.await(15, TimeUnit.SECONDS));
            return request;
        }

        @Override public String toString() { return method + " " + url; }
    }

    static final class Connection extends HttpsURLConnection {
        private final OfflineHttps script;
        final Proxy proxy;
        private final ByteArrayOutputStream outgoing = new ByteArrayOutputStream();
        private final Map<String, String> headers = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        private Exchange response;

        Connection(URL url, Proxy proxy, OfflineHttps script) {
            super(url);
            this.proxy = proxy;
            this.script = script;
        }

        JSONObject requestJson() throws JSONException {
            return new JSONObject(new String(outgoing.toByteArray(), StandardCharsets.UTF_8));
        }

        @Override public void setRequestProperty(String name, String value) { headers.put(name, value); }
        @Override public String getRequestProperty(String name) { return headers.get(name); }
        @Override public void connect() throws IOException {
            if (script == null) throw new IOException("No active HTTPS fixture");
            if (response == null) response = script.match(this);
        }
        @Override public int getResponseCode() throws IOException { connect(); return response.status; }
        @Override public String getContentType() { return response.type; }
        @Override public InputStream getInputStream() throws IOException { connect(); return response.body; }
        @Override public OutputStream getOutputStream() { return outgoing; }
        @Override public void disconnect() { }
        @Override public boolean usingProxy() { return false; }
        @Override public String getCipherSuite() { throw new UnsupportedOperationException(); }
        @Override public Certificate[] getLocalCertificates() { throw new UnsupportedOperationException(); }
        @Override public Certificate[] getServerCertificates() { throw new UnsupportedOperationException(); }
    }
}
