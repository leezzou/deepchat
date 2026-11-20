package ai.deepseek.demo.shell;

import static org.junit.Assert.*;
import org.junit.Test;
import javax.net.ssl.HttpsURLConnection;

/** Exercise the same immutable target and connection used by real profile transfers, without network access. */
public class ProfileChatTargetTest {
    private static final String KEY = "fixture-key";
    private ProfileChatTarget target(String base, String protocol, String op) throws Exception {
        return new ProfileChatTarget(base, protocol, op, KEY, ProfileChatTarget.digest(KEY));
    }
    private HttpsURLConnection configured(ProfileChatTarget target) throws Exception {
        HttpsURLConnection c = (HttpsURLConnection) target.url.openConnection();
        target.configure(c, 14, false, true, "test-id");
        assertEquals("POST", c.getRequestMethod());
        assertFalse(c.getInstanceFollowRedirects());
        assertNull(c.getRequestProperty("Cookie"));
        assertEquals("application/json", c.getRequestProperty("Content-Type"));
        return c;
    }
    @Test public void derivesOnlyTheSelectedProtocolAndExactBasePath() throws Exception {
        ProfileChatTarget proxy = target("https://gateway.example:8443/custom/v1", "openai", "chat");
        assertEquals("https://gateway.example:8443/custom/v1/chat/completions", proxy.url.toString());
        HttpsURLConnection c = configured(proxy);
        // The JDK intentionally hides Authorization on getRequestProperty().
        assertNull(c.getRequestProperty("x-api-key"));
        assertNull(c.getRequestProperty("x-opencode-session"));
        assertEquals("https://api.openai.com/v1/responses", target("https://api.openai.com/v1", "openai", "responses").url.toString());
        for (String base : new String[]{"https://api.anthropic.com", "https://api.anthropic.com/v1"}) for (String protocol : new String[]{"openai", "anthropic"}) {
            ProfileChatTarget claude = target(base, protocol, "messages");
            assertEquals("https://api.anthropic.com/v1/messages", claude.url.toString());
            assertEquals(KEY, configured(claude).getRequestProperty("x-api-key"));
            assertNotNull(configured(claude).getRequestProperty("anthropic-version"));
        }
        assertEquals("https://api.deepseek.com/anthropic/v1/messages", target("https://api.deepseek.com", "deepseek", "messages").url.toString());
        assertEquals("test-id", configured(target("https://opencode.ai/inference/openai/v1", "openai", "chat")).getRequestProperty("x-opencode-session"));
    }
    @Test public void rejectsArbitraryTargetsAliasesAndStaleCredentials() throws Exception {
        for (String base : new String[]{"http://localhost:8080/v1", "https://user@example.com", "https://gateway.example/?url=x", "https://gateway.example/v1#f",
                "https://gateway.example/v1/../internal", "https://gateway.example/%2fpath", "https://gateway.example/%252e/internal", "https://gateway.example/v1\\admin"}) {
            assertThrows(Exception.class, () -> target(base, "openai", "chat"));
        }
        for (String op : new String[]{"responses", "messages", "files", "https://other.example/chat/completions", "../chat"}) {
            assertThrows(Exception.class, () -> target("https://api.openai.com.invalid/v1", "openai", op));
        }
        for (String proto : new String[]{"anthropic", "deepseek", "unknown"}) assertThrows(Exception.class, () -> target("https://example.com", proto, "chat"));
        assertThrows(Exception.class, () -> new ProfileChatTarget("https://example.com", "openai", "chat", "rotated", ProfileChatTarget.digest(KEY)));
        assertEquals("model denied [redacted]", target("https://example.com", "openai", "chat").safeError("model denied " + KEY));
    }
}
