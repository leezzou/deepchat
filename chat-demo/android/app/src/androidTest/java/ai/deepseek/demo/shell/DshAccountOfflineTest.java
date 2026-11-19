package ai.deepseek.demo.shell;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/** Instrument the native account path using the emulator's loopback, keystore and main looper. */
@RunWith(AndroidJUnit4.class)
@androidx.test.filters.SdkSuppress(minSdkVersion = 24)
public class DshAccountOfflineTest {
    private static final String PLATFORM = "https://platform.deepseek.com";
    private static final String AUTH = PLATFORM + "/auth-api/v0/dsh/";
    private static final String BALANCE = PLATFORM + "/api/v0/users/get_user_summary";
    private static final String AUTHORIZE = PLATFORM + "/dsh/authorize?fixture=1";
    private static final String MESSAGES = "https://api.deepseek.com/anthropic/v1/messages";
    private static final String GRANT = "offline-grant-for-instrumentation-only";
    private static final String NAME = "Offline Tester";
    private static final String PREFS = "instrumentation-only-dsh-account";
    private static final int TIMEOUT_MS = 15000;

    private final OfflineHttps net = new OfflineHttps();
    private Context context;
    private CapturingActivity activity;
    private DshAccountHost host;
    private DshMessagesTransport transport;
    private DshLocalProxy proxy;

    // Construct on the main looper for Activity.runOnUiThread(). Neither launch overload forwards.
    private static final class CapturingActivity extends Activity {
        final BlockingQueue<Intent> launches = new LinkedBlockingQueue<>();

        CapturingActivity(Context base) { attachBaseContext(base); }

        @Override public SharedPreferences getSharedPreferences(String name, int mode) {
            return getBaseContext().getSharedPreferences(PREFS, mode);
        }
        @Override public void startActivity(Intent intent) { launches.add(new Intent(intent)); }
        @Override public void startActivity(Intent intent, Bundle options) { startActivity(intent); }
    }

    @BeforeClass public static void installOfflineNetwork() throws Exception { OfflineHttps.install(); }

    @Before public void setUp() {
        net.activate();
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        context = instrumentation.getTargetContext();
        context.deleteSharedPreferences(PREFS);
        instrumentation.runOnMainSync(() -> activity = new CapturingActivity(context));
        host = new DshAccountHost(activity);
    }

    @After public void tearDown() {
        try {
            if (transport != null) transport.close();
            if (proxy != null) proxy.stop();
            if (host != null) host.close();
            if (context != null) context.deleteSharedPreferences(PREFS);
        } finally { net.finish(); }
    }

    private static String success(JSONObject data) throws Exception {
        return new JSONObject().put("code", 0).put("data",
            new JSONObject().put("biz_code", 0).put("biz_data", data)).toString();
    }

    private static <T> T next(BlockingQueue<T> queue, String description) throws InterruptedException {
        T item = queue.poll(TIMEOUT_MS, TimeUnit.MILLISECONDS);
        assertNotNull("Timed out waiting for " + description, item);
        return item;
    }

    // Even a regressed redirect/base URL cannot make these clients dial a non-loopback address.
    private static Socket loopback(URI uri) throws IOException {
        assertEquals("http", uri.getScheme());
        assertEquals("127.0.0.1", uri.getHost());
        assertTrue(uri.getPort() > 0);
        Socket socket = new Socket(Proxy.NO_PROXY);
        socket.connect(new InetSocketAddress(InetAddress.getByAddress(new byte[]{127, 0, 0, 1}), uri.getPort()), TIMEOUT_MS);
        socket.setSoTimeout(TIMEOUT_MS);
        return socket;
    }

    private static BufferedReader reader(Socket socket) throws IOException {
        return new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
    }

    private static void callback(URI redirect, String state, int expectedStatus) throws Exception {
        try (Socket socket = loopback(redirect)) {
            String request = "GET " + redirect.getRawPath() + "?state=" + state + "&code=offline-code HTTP/1.1\r\n"
                + "Host: " + redirect.getRawAuthority() + "\r\nConnection: close\r\n\r\n";
            socket.getOutputStream().write(request.getBytes(StandardCharsets.US_ASCII));
            InputStream in = socket.getInputStream();
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[2048];
            for (int count; (count = in.read(buffer)) != -1; ) {
                assertTrue("Callback page too large", bytes.size() + count <= 32768);
                bytes.write(buffer, 0, count);
            }
            String response = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
            String[] parts = response.split("\r\n\r\n", 2);
            assertEquals("Expected callback headers and a page body", 2, parts.length);
            assertTrue(parts[0], parts[0].startsWith("HTTP/1.1 " + expectedStatus + " "));
            assertTrue(parts[0], parts[0].contains("Content-Type: text/html"));
            assertTrue(parts[0], parts[0].contains("Cache-Control: no-store"));
            assertTrue(parts[1], parts[1].contains("<html"));
            assertTrue("Expected visible return instructions", parts[1].contains("DeepChat"));
            assertFalse(response.contains("offline-code"));
            assertFalse(response.contains(state));
            assertFalse(response.contains(GRANT));
        }
    }

    private void assertSignedIn() throws Exception {
        JSONObject status = host.status();
        assertTrue(status.toString(), status.getBoolean("signedIn"));
        assertFalse(status.getBoolean("pending"));
        assertEquals("", status.getString("error"));
        assertEquals(NAME, status.getString("name"));
        assertEquals("https://offline.invalid/fixture.png", status.getString("avatar"));
        assertFalse(status.toString().contains(GRANT));
    }

    private void reopenHost() {
        host.close();
        host = new DshAccountHost(activity);
    }

    private static String grantResponse() throws Exception {
        return success(new JSONObject().put("token", GRANT)
            .put("user", new JSONObject().put("id_profile", new JSONObject()
                .put("name", NAME).put("picture", "https://offline.invalid/fixture.png"))));
    }

    private JSONObject beginAuthorization() throws Exception {
        OfflineHttps.Exchange init = net.json("POST", AUTH + "auth_init", 200, success(new JSONObject()
            .put("authorize_id", "fixture-id").put("authorize_url", AUTHORIZE).put("expires_in", 300)));
        assertFalse(host.status().getBoolean("signedIn"));
        assertTrue(host.beginLogin().getBoolean("pending"));
        Intent tab = next(activity.launches, "intercepted Custom Tab");
        assertEquals(Intent.ACTION_VIEW, tab.getAction());
        assertEquals(AUTHORIZE, tab.getDataString());
        assertTrue(tab.hasExtra("android.support.customtabs.extra.SESSION"));
        OfflineHttps.Connection initRequest = init.await();
        assertBrowserClient(initRequest);
        assertNull(initRequest.getRequestProperty("x-dsh-auth-token"));
        assertFalse(initRequest.getInstanceFollowRedirects());
        JSONObject challenge = initRequest.requestJson();
        assertFalse(challenge.has("code_verifier"));
        assertEquals("S256", challenge.getString("code_challenge_method"));
        assertTrue(challenge.getString("state").matches("[A-Za-z0-9_-]{43,128}"));
        assertEquals("/oauth/callback", new URI(challenge.getString("redirect_uri")).getRawPath());
        assertFalse(host.status().getBoolean("exchanging"));
        return challenge;
    }

    private static void assertBrowserClient(OfflineHttps.Connection request) {
        assertEquals("web", request.getRequestProperty("x-client-platform"));
        assertEquals("", request.getRequestProperty("x-client-bundle-id"));
    }

    private JSONObject awaitCompletion() throws Exception {
        long deadline = SystemClock.elapsedRealtime() + TIMEOUT_MS;
        JSONObject status = host.status();
        while (status.getBoolean("pending") && SystemClock.elapsedRealtime() < deadline) {
            Thread.sleep(20);
            status = host.status();
        }
        assertFalse("Login still pending: " + status, status.getBoolean("pending"));
        assertFalse(status.getBoolean("exchanging"));
        return status;
    }

    private void signIn() throws Exception {
        JSONObject challenge = beginAuthorization();
        OfflineHttps.Exchange exchange = net.json("POST", AUTH + "auth_exchange", 200, grantResponse());
        URI redirect = new URI(challenge.getString("redirect_uri"));
        callback(redirect, "wrong-state", 400);
        assertTrue(host.status().getBoolean("pending"));
        assertFalse(host.signedIn());
        callback(redirect, challenge.getString("state"), 200);
        OfflineHttps.Connection tokenRequest = exchange.await();
        assertBrowserClient(tokenRequest);
        assertNull(tokenRequest.getRequestProperty("x-dsh-auth-token"));
        JSONObject proof = tokenRequest.requestJson();
        assertEquals("offline-code", proof.getString("code"));
        assertEquals(redirect.toString(), proof.getString("redirect_uri"));
        String verifier = proof.getString("code_verifier");
        assertTrue(verifier.matches("[A-Za-z0-9._~-]{43,128}"));
        String digest = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(
            verifier.getBytes(StandardCharsets.US_ASCII)), Base64.NO_WRAP | Base64.NO_PADDING | Base64.URL_SAFE);
        assertEquals(digest, challenge.getString("code_challenge"));
        awaitCompletion();
        assertSignedIn();
        // Exercise encrypted persistence. Later logout/expiry operates on the restored host.
        reopenHost();
        assertSignedIn();
    }

    @Test public void browserGetsHtmlBeforeFailedExchangeAndHostShowsSafeReason() throws Exception {
        JSONObject challenge = beginAuthorization();
        String state = challenge.getString("state");
        try (PipedInputStream source = new PipedInputStream(); PipedOutputStream producer = new PipedOutputStream(source)) {
            OfflineHttps.Exchange exchange = net.expect("POST", AUTH + "auth_exchange", 200, "application/json", source);
            OfflineHttps.Exchange cancel = net.json("POST", AUTH + "auth_cancel", 200, success(new JSONObject()));
            callback(new URI(challenge.getString("redirect_uri")), state, 200);
            JSONObject proof = exchange.await().requestJson();
            assertTrue(host.status().getBoolean("exchanging"));
            assertFalse(host.signedIn());
            // The browser already received the full, nonempty page. Only now can exchange finish.
            String rejected = "{\"code\":48001,\"msg\":\"private-provider-detail\"}";
            producer.write(rejected.getBytes(StandardCharsets.UTF_8));
            producer.close();
            JSONObject status = awaitCompletion();
            assertFalse(status.getBoolean("signedIn"));
            String reason = status.getString("error");
            assertTrue(reason, reason.contains("48001"));
            for (String secret : new String[]{"private-provider-detail", "offline-code", state, proof.getString("code_verifier")}) {
                assertFalse(reason.contains(secret));
            }
            assertEquals("fixture-id", cancel.await().requestJson().getString("authorize_id"));
            reopenHost();
            assertNull(host.token());
        }
    }

    private void assertManualRejected(String url) throws Exception {
        try {
            host.submitCallback(url);
            fail("Expected manual callback rejection");
        } catch (IOException rejected) {
            assertFalse(rejected.getMessage().isEmpty());
            assertFalse(rejected.getMessage().contains("manual-code"));
        }
    }

    @Test public void manualCallbackChecksOriginAndStateAndExchangesOnlyOnce() throws Exception {
        JSONObject challenge = beginAuthorization();
        String redirect = challenge.getString("redirect_uri");
        String query = "?state=" + challenge.getString("state") + "&code=manual-code";
        String valid = redirect + query;
        assertManualRejected("https://offline.invalid/oauth/callback" + query);
        assertManualRejected(redirect + "?state=incorrect&code=manual-code");
        assertTrue(host.status().getBoolean("pending"));
        assertFalse(host.status().getBoolean("exchanging"));
        try (PipedInputStream source = new PipedInputStream(); PipedOutputStream producer = new PipedOutputStream(source)) {
            OfflineHttps.Exchange exchange = net.expect("POST", AUTH + "auth_exchange", 200, "application/json", source);
            host.submitCallback(valid);
            JSONObject proof = exchange.await().requestJson();
            assertEquals("manual-code", proof.getString("code"));
            assertEquals(redirect, proof.getString("redirect_uri"));
            assertTrue(host.status().getBoolean("exchanging"));
            assertManualRejected(valid);
            producer.write(grantResponse().getBytes(StandardCharsets.UTF_8));
            producer.close();
            awaitCompletion();
            assertSignedIn();
            assertManualRejected(valid);
        }
    }

    @Test public void callbackBypassesIdleBrowserConnections() throws Exception {
        JSONObject init = beginAuthorization();
        URI redirect = new URI(init.getString("redirect_uri"));
        net.json("POST", AUTH + "auth_exchange", 200, grantResponse());
        try (Socket idle = loopback(redirect); Socket partial = loopback(redirect)) {
            partial.getOutputStream().write('G');
            long start = SystemClock.elapsedRealtime();
            callback(redirect, init.getString("state"), 200);
            long elapsed = SystemClock.elapsedRealtime() - start;
            assertTrue("Callback stalled for " + elapsed + " ms", elapsed < 3000);
            awaitCompletion();
            assertSignedIn();
        }
    }

    @Test public void recreatedHostAcceptsOriginalBrowserCallback() throws Exception {
        JSONObject init = beginAuthorization();
        URI redirect = new URI(init.getString("redirect_uri"));
        reopenHost();
        assertTrue("The pending attempt survives host recreation", host.status().getBoolean("pending"));
        assertTrue("Recovery must not open a second browser", activity.launches.isEmpty());
        callback(redirect, "invalid", 400);
        OfflineHttps.Exchange exchange = net.json("POST", AUTH + "auth_exchange", 200, grantResponse());
        callback(redirect, init.getString("state"), 200);
        JSONObject proof = exchange.await().requestJson();
        String digest = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(
                proof.getString("code_verifier").getBytes(StandardCharsets.US_ASCII)), Base64.NO_WRAP | Base64.NO_PADDING | Base64.URL_SAFE);
        assertTrue("PKCE proof matches the first attempt", digest.equals(init.getString("code_challenge")));
        assertTrue("Redirect URI must stay identical", redirect.toString().equals(proof.getString("redirect_uri")));
        awaitCompletion();
        assertSignedIn();
    }

    @Test public void restoredAttemptWithPortInUseCanCompleteManually() throws Exception {
        JSONObject init = beginAuthorization();
        URI redirect = new URI(init.getString("redirect_uri"));
        host.close();
        try (java.net.ServerSocket busy = new java.net.ServerSocket()) {
            busy.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), redirect.getPort()));
            host = new DshAccountHost(activity);
            assertTrue(host.status().getBoolean("pending"));
            assertTrue(host.status().getString("error").contains("手动完成授权"));
            net.json("POST", AUTH + "auth_exchange", 200, grantResponse());
            host.submitCallback(redirect + "?state=" + init.getString("state") + "&code=manual-code");
            awaitCompletion();
            assertSignedIn();
        }
    }

    @Test public void cancelledAttemptDoesNotRecover() throws Exception {
        JSONObject init = beginAuthorization();
        OfflineHttps.Exchange cancel = net.json("POST", AUTH + "auth_cancel", 200, success(new JSONObject()));
        host.cancelLogin();
        cancel.await();
        reopenHost();
        assertFalse(host.status().getBoolean("pending"));
        assertManualRejected(init.getString("redirect_uri") + "?state=" + init.getString("state") + "&code=manual-code");
    }

    @Test public void loginMapsWalletsAndLogoutRevokesTheGrant() throws Exception {
        signIn();
        JSONObject summary = new JSONObject("{\"normal_wallets\":[{\"currency\":\"USD\",\"balance\":\"12.3400\",\"private\":1}],"
            + "\"bonus_wallets\":[{\"currency\":\"CNY\",\"balance\":\"0.005\",\"private\":2}],\"account_id\":42}");
        OfflineHttps.Exchange balance = net.json("GET", BALANCE, 200, success(summary));
        JSONObject mapped = host.balance();
        assertEquals(GRANT, balance.await().getRequestProperty("x-dsh-auth-token"));
        assertEquals(2, mapped.length());
        assertWallet(mapped.getJSONArray("wallets"), "USD", "12.3400");
        assertWallet(mapped.getJSONArray("bonusWallets"), "CNY", "0.005");
        OfflineHttps.Exchange revoke = net.json("POST", PLATFORM + "/auth-api/v0/users/logout", 200, success(new JSONObject()));
        host.logout();
        assertFalse(host.status().getBoolean("signedIn"));
        assertEquals("", host.status().getString("name"));
        assertEquals(GRANT, revoke.await().getRequestProperty("x-dsh-auth-token"));
        reopenHost();
        assertNull(host.token());
    }

    private static void assertWallet(JSONArray wallets, String currency, String amount) throws Exception {
        assertEquals(1, wallets.length());
        JSONObject wallet = wallets.getJSONObject(0);
        assertEquals(2, wallet.length());
        assertEquals(currency, wallet.get("currency"));
        assertEquals(amount, wallet.get("balance"));
    }

    @Test public void platformExpiredCodeClearsPersistedLogin() throws Exception {
        signIn();
        net.json("GET", BALANCE, 200, "{\"code\":40003}");
        try {
            host.balance();
            fail("Expected an expired-grant failure");
        } catch (IOException expired) {
            assertTrue(expired.getMessage(), expired.getMessage().contains("40003"));
        }
        assertExpired();
    }

    private void assertExpired() throws Exception {
        JSONObject status = host.status();
        assertFalse(status.getBoolean("signedIn"));
        assertEquals("", status.getString("name"));
        assertTrue(status.getString("error"), status.getString("error").contains("过期"));
        reopenHost();
        assertNull(host.token());
    }

    private static JSONObject frame(BlockingQueue<JSONObject> frames, String type) throws Exception {
        JSONObject result = next(frames, type + " frame");
        assertEquals(result.toString(), type, result.getString("type"));
        return result;
    }

    private static String data(BlockingQueue<JSONObject> frames) throws Exception {
        return new String(Base64.decode(frame(frames, "data").getString("base64"), Base64.DEFAULT), StandardCharsets.UTF_8);
    }

    @Test public void messagesDeliversDataBeforeEofAndExpiresOn401() throws Exception {
        signIn();
        transport = new DshMessagesTransport(host);
        BlockingQueue<JSONObject> frames = new LinkedBlockingQueue<>();
        String path = "/anthropic/v1/messages";
        String json = "{\"model\":\"deepseek-flash\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"fixture\"}]}";
        String body = Base64.encodeToString(json.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        try (PipedInputStream source = new PipedInputStream(); PipedOutputStream producer = new PipedOutputStream(source)) {
            OfflineHttps.Exchange upstream = net.expect("POST", MESSAGES, 200, "text/event-stream; charset=utf-8", source);
            transport.start("stream", path, "POST", "application/json", body, frames::add);
            OfflineHttps.Connection request = upstream.await();
            assertEquals(Proxy.NO_PROXY, request.proxy);
            assertEquals(GRANT, request.getRequestProperty("x-dsh-auth-token"));
            assertEquals("2023-06-01", request.getRequestProperty("anthropic-version"));
            assertTrue(request.getRequestProperty("Accept").contains("text/event-stream"));
            assertTrue(request.requestJson().getBoolean("stream"));
            JSONObject headers = frame(frames, "headers");
            assertEquals(200, headers.getInt("status"));
            assertEquals("text/event-stream", headers.getString("contentType"));
            for (String part : new String[]{"data: {\"type\":\"ping\"}\n\n", "data: {\"type\":\"message_stop\"}\n\n"}) {
                producer.write(part.getBytes(StandardCharsets.UTF_8));
                producer.flush();
                assertEquals(part, data(frames)); // Consumer gets each burst while producer stays open.
            }
            producer.close();
            frame(frames, "end");
        }
        net.json("POST", MESSAGES, 401, "{\"private\":\"provider-secret\"}");
        transport.start("expired", path, "POST", "application/json", body, frames::add);
        assertEquals(401, frame(frames, "headers").getInt("status"));
        String detail = data(frames);
        assertFalse(detail.contains("provider-secret"));
        assertFalse(detail.contains(GRANT));
        frame(frames, "end");
        assertExpired();
    }

    private static String event(String json) { return "data: " + json + "\n\n"; }

    private static JSONObject proxyEvent(BufferedReader client) throws Exception {
        String line = client.readLine();
        assertNotNull("Expected an SSE event", line);
        assertTrue(line, line.startsWith("data: "));
        assertEquals("", client.readLine());
        return new JSONObject(line.substring(6));
    }

    private static JSONObject choice(BufferedReader client) throws Exception {
        JSONObject chunk = proxyEvent(client);
        assertEquals("chat.completion.chunk", chunk.getString("object"));
        assertEquals("deepseek-flash", chunk.getString("model"));
        return chunk.getJSONArray("choices").getJSONObject(0);
    }

    @Test public void proxyUsesAnIndependentOptInLocalKey() throws Exception {
        proxy = new DshLocalProxy(host);
        assertFalse(proxy.status().getBoolean("running"));
        try { proxy.start(); fail("Proxy requires a signed-in account"); }
        catch (IllegalStateException expected) { assertFalse(proxy.status().getBoolean("running")); }

        signIn();
        assertFalse(proxy.status().getBoolean("running"));
        JSONObject enabled = proxy.start();
        assertFalse(enabled.toString().contains(GRANT));
        assertFalse(enabled.getString("key").isEmpty());
        URI base = new URI(enabled.getString("baseURL"));
        try (Socket socket = loopback(base)) {
            // A DeepSeek account credential does not authenticate a loopback client.
            String request = "GET /v1/models HTTP/1.1\r\nHost: " + base.getAuthority()
                + "\r\nAuthorization: Bearer " + GRANT + "\r\n\r\n";
            socket.getOutputStream().write(request.getBytes(StandardCharsets.US_ASCII));
            assertTrue(reader(socket).readLine().startsWith("HTTP/1.1 401 "));
        }
        proxy.stop();
        assertEquals("", proxy.status().getString("key"));
    }

    @Test public void loopbackV1TranslatesLiveMessagesStream() throws Exception {
        signIn();
        proxy = new DshLocalProxy(host);
        JSONObject status = proxy.start();
        URI base = new URI(status.getString("baseURL"));
        assertEquals("/v1", base.getPath());
        String key = status.getString("key");
        String json = "{\"model\":\"deepseek-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"fixture\"}],"
            + "\"stream\":true,\"stream_options\":{\"include_usage\":true},\"max_completion_tokens\":9}";
        try (PipedInputStream source = new PipedInputStream(4096); PipedOutputStream producer = new PipedOutputStream(source);
             Socket socket = loopback(base)) {
            OfflineHttps.Exchange upstream = net.expect("POST", MESSAGES, 200, "text/event-stream", source);
            String request = "POST " + base.getPath() + "/chat/completions HTTP/1.1\r\nHost: " + base.getAuthority()
                + "\r\nAuthorization: Bearer " + key + "\r\nContent-Type: application/json\r\nContent-Length: "
                + json.getBytes(StandardCharsets.UTF_8).length + "\r\n\r\n" + json;
            socket.getOutputStream().write(request.getBytes(StandardCharsets.UTF_8));
            OfflineHttps.Connection actual = upstream.await();
            assertEquals(Proxy.NO_PROXY, actual.proxy);
            assertEquals(GRANT, actual.getRequestProperty("x-dsh-auth-token"));
            assertNull(actual.getRequestProperty("Authorization"));
            JSONObject translated = actual.requestJson();
            assertEquals(9, translated.getInt("max_tokens"));
            assertEquals("fixture", translated.getJSONArray("messages").getJSONObject(0).getString("content"));
            assertTrue(translated.getBoolean("stream"));
            BufferedReader client = reader(socket);
            assertEquals("HTTP/1.1 200 OK", client.readLine());
            StringBuilder headers = new StringBuilder();
            for (String line; (line = client.readLine()) != null && !line.isEmpty(); ) headers.append(line).append('\n');
            assertTrue(headers.toString(), headers.toString().contains("Content-Type: text/event-stream"));
            producer.write(event("{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3}}}").getBytes(StandardCharsets.UTF_8));
            producer.flush();
            assertEquals("assistant", choice(client).getJSONObject("delta").getString("role"));
            String remaining = event("{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}")
                + event("{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"你好\"}}")
                + event("{\"type\":\"content_block_stop\",\"index\":0}")
                + event("{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}")
                + event("{\"type\":\"message_stop\"}");
            producer.write(remaining.getBytes(StandardCharsets.UTF_8));
            producer.flush();
            assertEquals("你好", choice(client).getJSONObject("delta").getString("content"));
            assertEquals("stop", choice(client).getString("finish_reason"));
            JSONObject usageFrame = proxyEvent(client);
            assertEquals(0, usageFrame.getJSONArray("choices").length());
            JSONObject usage = usageFrame.getJSONObject("usage");
            assertEquals(3, usage.getInt("prompt_tokens"));
            assertEquals(2, usage.getInt("completion_tokens"));
            assertEquals(5, usage.getInt("total_tokens"));
            assertEquals("data: [DONE]", client.readLine());
            assertEquals("", client.readLine());
            assertNull(client.readLine());
        }
    }
}
