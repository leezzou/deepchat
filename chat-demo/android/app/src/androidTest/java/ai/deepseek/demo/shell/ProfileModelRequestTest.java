package ai.deepseek.demo.shell;

import org.json.JSONObject;
import org.junit.Test;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import static org.junit.Assert.*;

/** Exercises real HttpURLConnection, not WebView CORS mocks. All credentials stay on loopback. */
public class ProfileModelRequestTest {
    @Test public void pinsOriginPathMethodAndAuthFamily() throws Exception {
        String base = "https://api.anthropic.com/v1";
        assertEquals("/v1/models", ProfileModelRequest.validate(base, base + "/models?after_id=a", "anthropic", false).getPath());
        for (String target : new String[]{"https://foreign.invalid/v1/models", "http://api.anthropic.com/v1/models", base + "/messages", base + "/models?key=x", base + "/%2e%2e/models"}) {
            try { ProfileModelRequest.validate(base, target, "anthropic", false); fail("accepted invalid route"); } catch (java.io.IOException expected) {}
        }
        try { ProfileModelRequest.validate(base, base + "/models", "bearer", true); fail("accepted write"); } catch (java.io.IOException expected) {}
        try { ProfileModelRequest.validate("https://edge.invalid/v1", "https://edge.invalid/v1/models", "anthropic", false); fail("accepted mismatched auth"); } catch (java.io.IOException expected) {}
    }

    @Test public void readsModelsWithSavedKeyAndRejectsCrossOriginRedirect() throws Exception {
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        try (ServerSocket fixture = new ServerSocket(0, 4, loopback); ServerSocket trap = new ServerSocket(0, 1, loopback)) {
            fixture.setSoTimeout(5000);
            trap.setSoTimeout(250);
            CompletableFuture<Void> server = CompletableFuture.runAsync(() -> {
                try {
                    for (int i = 0; i < 2; i++) {
                        try (Socket socket = fixture.accept()) {
                            socket.setSoTimeout(3000);
                            BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                            assertTrue(reader.readLine().startsWith("GET /v1/models "));
                            boolean authenticated = false;
                            for (String line; (line = reader.readLine()) != null && !line.isEmpty();) {
                                authenticated |= line.equalsIgnoreCase("Authorization: Bearer synthetic-saved-key");
                            }
                            assertTrue(authenticated);
                            String json = "{\"data\":[{\"id\":\"local\",\"context_window\":98304}]}";
                            String reply = i == 0 ? "200 OK\r\nContent-Length: " + json.length() + "\r\n\r\n" + json : "307 Temporary Redirect\r\nLocation: http://127.0.0.1:" + trap.getLocalPort() + "/models\r\nContent-Length: 0\r\n\r\n";
                            socket.getOutputStream().write(("HTTP/1.1 " + reply).getBytes(StandardCharsets.UTF_8));
                        }
                    }
                } catch (Exception e) { throw new RuntimeException(e); }
            });
            String base = "http://127.0.0.1:" + fixture.getLocalPort() + "/v1";
            JSONObject fields = new JSONObject().put("endpoint", base).put("url", base + "/models").put("auth", "bearer").put("key", "synthetic-saved-key");
            JSONObject ok = new ProfileModelRequest().fetch(fields);
            assertEquals(200, ok.getInt("status"));
            assertTrue(ok.getString("body").contains("98304"));
            JSONObject redirect = new ProfileModelRequest().fetch(fields);
            assertEquals(307, redirect.getInt("status"));
            assertEquals("", redirect.getString("body"));
            try (Socket ignored = trap.accept()) { fail("redirect contacted another origin"); } catch (SocketTimeoutException expected) {}
            server.get();
        }
    }
}
