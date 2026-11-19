package ai.deepseek.demo.shell;

import java.io.IOException;
import java.net.CookieHandler;
import java.net.URI;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** Capacitor installs its WebView cookie jar as the process default. Scope the synchronous
 * URLConnection exchange to an anonymous cookie context while other threads keep their jar. */
final class WebDavCookies extends CookieHandler {
    private final CookieHandler delegate;
    private static final ThreadLocal<Boolean> isolated = new ThreadLocal<>();

    private WebDavCookies(CookieHandler delegate) { this.delegate = delegate; }

    static void isolate(Runnable transfer) {
        synchronized (CookieHandler.class) {
            CookieHandler current = getDefault();
            if (!(current instanceof WebDavCookies)) setDefault(new WebDavCookies(current));
        }
        Boolean previous = isolated.get();
        isolated.set(true);
        try {
            transfer.run();
        } finally {
            if (previous == null) isolated.remove();
            else isolated.set(previous);
        }
    }

    @Override public Map<String, List<String>> get(URI uri, Map<String, List<String>> headers) throws IOException {
        if (Boolean.TRUE.equals(isolated.get()) || delegate == null) return Collections.emptyMap();
        return delegate.get(uri, headers);
    }

    @Override public void put(URI uri, Map<String, List<String>> headers) throws IOException {
        if (!Boolean.TRUE.equals(isolated.get()) && delegate != null) delegate.put(uri, headers);
    }
}
