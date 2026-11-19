package ai.deepseek.demo.shell;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import javax.net.ssl.HttpsURLConnection;

/** Classify attachment rejections locally. Never forward upstream text or quoted user data over the bridge. */
final class DshFileErrors {
    private static final java.util.regex.Pattern TEXT_LIMIT = java.util.regex.Pattern.compile("\\b(?:8\\s*(?:mib|mb)|8388608)\\b");

    static String detail(HttpsURLConnection http, int status, String path, boolean fileReferences, String fallback) {
        boolean upload = "/anthropic/v1/files".equals(path);
        if ((!upload && !fileReferences) || (status != 400 && status != 422)) return fallback;
        String generic = upload ? "DS_FILE_UPLOAD_REJECTED" : "DS_FILE_MESSAGE_REJECTED";
        try (InputStream stream = http.getErrorStream()) {
            if (stream == null) return generic;
            ByteArrayOutputStream data = new ByteArrayOutputStream();
            byte[] chunk = new byte[1024];
            int count;
            while (data.size() < 8192 && (count = stream.read(chunk, 0, Math.min(chunk.length, 8192 - data.size()))) != -1) {
                data.write(chunk, 0, count);
            }
            JSONObject error = new JSONObject(data.toString(StandardCharsets.UTF_8.name())).optJSONObject("error");
            if (error == null) return generic;
            String detail = (error.optString("code") + " " + error.optString("message")).toLowerCase(Locale.ROOT);
            if (!upload) {
                if (detail.contains("file_ids do not exist or are not created under your account")
                        || detail.contains("file data not found for file_id") || detail.contains(".source.file_id: invalid file_id")) {
                    return "DS_FILE_REFERENCE_EXPIRED";
                }
                if (detail.contains("context_length") || detail.contains("context length") || detail.contains("context window")
                        || detail.contains("too many tokens") || detail.contains("prompt is too long")) return "DS_FILE_CONTEXT_LIMIT";
                if (detail.contains("too many documents") || detail.contains("at most 20 documents")) return "DS_FILE_DOCUMENT_COUNT";
            }
            if (detail.contains("text") && (TEXT_LIMIT.matcher(detail).find() || detail.contains("document text is too long"))) {
                return "DS_FILE_TEXT_LIMIT";
            }
            if (upload && (detail.contains("password-protected") || detail.contains("encrypted file"))) return "DS_FILE_ENCRYPTED";
        } catch (Exception ignored) {
            // HTML errors, truncated JSON and transport failures receive the same bounded fallback.
        }
        return generic;
    }

    private DshFileErrors() { }
}
