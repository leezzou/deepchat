package ai.deepseek.demo.shell;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.Proxy;
import java.net.URL;

import javax.net.ssl.HttpsURLConnection;

/** Public profile images only. A failed or oversized download leaves the local monogram in place. */
final class AccountAvatar {
    private static final int MAX_BYTES = 1024 * 1024;
    private static final int MAX_SIDE = 192;

    static Bitmap load(String source) {
        String address = AccountProfileFields.avatar(source);
        if (address.isEmpty()) return null;
        Bitmap[] result = new Bitmap[1];
        WebDavCookies.isolate(() -> {
            HttpsURLConnection connection = null;
            try {
                connection = (HttpsURLConnection) new URL(address).openConnection(Proxy.NO_PROXY);
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                connection.setConnectTimeout(4000);
                connection.setReadTimeout(4000);
                connection.setRequestProperty("Accept", "image/png, image/jpeg, image/webp, image/gif");
                if (connection.getResponseCode() != 200 || connection.getContentLength() > MAX_BYTES) return;
                try (InputStream in = connection.getInputStream()) {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    byte[] buffer = new byte[8192];
                    for (int n; (n = in.read(buffer)) != -1;) {
                        if (Thread.currentThread().isInterrupted() || bytes.size() + n > MAX_BYTES) return;
                        bytes.write(buffer, 0, n);
                    }
                    result[0] = decode(bytes.toByteArray());
                }
            } catch (Exception ignored) {
                // The picture is optional and its URL must not appear in logs or the UI.
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
        return result[0];
    }

    static Bitmap decode(byte[] bytes) {
        if (bytes.length == 0 || bytes.length > MAX_BYTES) return null;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        int side = Math.max(options.outWidth, options.outHeight);
        if (options.outWidth <= 0 || options.outHeight <= 0 || side > 8192) return null;
        if (!("image/png".equals(options.outMimeType) || "image/jpeg".equals(options.outMimeType)
                || "image/webp".equals(options.outMimeType) || "image/gif".equals(options.outMimeType))) return null;
        options.inSampleSize = 1;
        while (side / options.inSampleSize > MAX_SIDE) options.inSampleSize *= 2;
        options.inJustDecodeBounds = false;
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
    }

    private AccountAvatar() { }
}
