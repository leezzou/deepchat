package ai.deepseek.demo.shell;

import java.net.CookieHandler;
import java.net.CookieManager;
import java.net.URI;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/** Standalone JVM check; no Android device, Gradle or application packaging required. */
public final class WebDavCookiesTest {
    private static final URI SITE = URI.create("https://example.invalid/dav/");
    private static String cookies() {
        try { return CookieHandler.getDefault().get(SITE, Collections.emptyMap()).toString(); }
        catch (Exception failure) { throw new AssertionError(failure); }
    }
    private static void write(String value) {
        try { CookieHandler.getDefault().put(SITE, Map.of("Set-Cookie", List.of(value + "; Path=/"))); }
        catch (Exception failure) { throw new AssertionError(failure); }
    }
    private static void check(boolean condition) { if (!condition) throw new AssertionError(); }
    public static void main(String[] args) {
        CookieHandler.setDefault(new CookieManager());
        write("account=fixture");
        try {
            WebDavCookies.isolate(() -> {
                check(cookies().equals("{}"));
                write("dav=fixture");
                WebDavCookies.isolate(() -> check(cookies().equals("{}")));
                check(cookies().equals("{}"));
                check(CompletableFuture.supplyAsync(WebDavCookiesTest::cookies).join().contains("account=fixture"));
                throw new IllegalStateException("simulated network failure");
            });
        } catch (IllegalStateException expected) { check(expected.getMessage().startsWith("simulated")); }
        check(cookies().contains("account=fixture") && !cookies().contains("dav=fixture"));
        CookieHandler.setDefault(new CookieManager());
        write("next=fixture");
        WebDavCookies.isolate(() -> check(cookies().equals("{}")));
        check(cookies().contains("next=fixture"));
        System.out.println("PASS: native cookie scope blocks send/receive, delegates concurrently, restores after failure and wraps replacement jar");
    }
}
