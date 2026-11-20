package ai.deepseek.demo.shell;

import java.net.URI;
import java.util.Locale;

/** The only provider-supplied fields used for display. */
final class AccountProfileFields {
    private AccountProfileFields() { }

    static String name(Object raw) {
        if (!(raw instanceof String)) return "";
        String clean = ((String) raw).replaceAll("[\\p{Cc}\\u202a-\\u202e\\u2066-\\u2069]", "").trim();
        int count = clean.codePointCount(0, clean.length());
        return count <= 80 ? clean : clean.substring(0, clean.offsetByCodePoints(0, 80));
    }

    static String avatar(Object raw) {
        if (!(raw instanceof String)) return "";
        String value = ((String) raw).trim();
        if (value.startsWith("//")) value = "https:" + value;
        if (value.length() > 2048 || value.indexOf('\\') >= 0) return "";
        try {
            URI url = new URI(value);
            String host = url.getHost();
            if (host == null || url.getRawUserInfo() != null || url.getRawFragment() != null
                    || (url.getPort() != -1 && url.getPort() != 443)) return "";
            String query = url.getQuery();
            if (query != null) for (String pair : query.split("[&;]")) {
                String key = pair.split("=", 2)[0].toLowerCase(Locale.ROOT).replace("_", "").replace("-", "");
                if (key.matches("(?:access|refresh|id|auth|xdshauth)?token|authorization|apikey|password")) return "";
            }
            host = host.toLowerCase(Locale.ROOT);
            // Profile pictures live on public CDNs. Reject literal IPs and local names.
            if (!host.matches("[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z]{2,}") || host.endsWith(".local") || host.endsWith(".localhost")) return "";
            if ("https".equals(url.getScheme())) return value;
            // Some older WeChat accounts return an HTTP URL on the official avatar CDN.
            if ("http".equals(url.getScheme()) && (host.endsWith(".qlogo.cn") || host.endsWith(".qpic.cn")))
                return "https" + value.substring(4);
        } catch (java.net.URISyntaxException invalid) { /* Unsupported picture. */ }
        return "";
    }
}
