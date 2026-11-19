package ai.deepseek.demo.shell;

import android.util.JsonReader;
import android.util.JsonToken;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;

/** Classify official attachment errors before any bytes cross the WebView bridge. */
final class DshFileErrors {
    private static final int BODY_LIMIT = 8192;
    private static final Pattern TEXT_LIMIT = Pattern.compile("\\b(?:8\\s*(?:mib|mb)|8388608)\\b");
    private static final Pattern REQUEST_ID = Pattern.compile("[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}");
    private static final Pattern TRACE_ID = Pattern.compile("[0-9a-fA-F]{32}");
    // Normalize an indexed schema path to its last known field. Never emit an index or arbitrary path.
    private static final String INDEX = "(?:\\[[0-9]{1,6}\\]|\\.[0-9]{1,6})";
    private static final Pattern CONTENT_FIELD = Pattern.compile("messages" + INDEX + "\\.(role|content)(?:" + INDEX
            + "\\.(type|source)(?:\\.(file_id|media_type|type))?)?");

    /** Null for routes/statuses that use the ordinary local HTTP error. */
    static JSONObject detail(HttpsURLConnection http, int status, String path, boolean fileReferences, String token) throws JSONException {
        boolean upload = "/anthropic/v1/files".equals(path);
        boolean message = "/anthropic/v1/messages".equals(path) && fileReferences;
        if ((!upload && !message) || (status != 400 && status != 422)) return null;

        JSONObject diagnostic = new JSONObject().put("stage", upload ? "upload" : "messages").put("status", status);
        // Only the official response header, never a request header or a request ID quoted in the body.
        String requestId = http.getHeaderField("x-request-id");
        if (safeId(requestId, REQUEST_ID, token)) diagnostic.put("requestId", requestId);
        else {
            String traceId = http.getHeaderField("x-ds-trace-id");
            if (safeId(traceId, TRACE_ID, token)) diagnostic.put("traceId", traceId);
        }
        String result = upload ? "DS_FILE_UPLOAD_REJECTED" : "DS_FILE_MESSAGE_REJECTED";
        try (InputStream stream = http.getErrorStream()) {
            Fields fields = readError(stream);
            if (fields != null) {
                if ("invalid_request_error".equals(fields.type)) diagnostic.put("type", fields.type);
                if ("invalid_request_error".equals(fields.code) || "context_length_exceeded".equals(fields.code)) {
                    diagnostic.put("code", fields.code);
                }
                String param = knownField(fields.param);
                // Anthropic errors generally have only error.type and error.message. The documented
                // form "messages: at least one message is required" names a useful schema field.
                int colon = fields.message.indexOf(':');
                if (param == null && colon > 0 && colon <= 96) param = knownField(fields.message.substring(0, colon));
                if (param != null) diagnostic.put("param", param);
                result = classify(upload, fields.message.toLowerCase(Locale.ROOT), fields.code, param, result);
            }
        } catch (IOException | IllegalStateException ignored) {
            // Empty, non-JSON, malformed and truncated bodies retain route, status and correlation ID.
        }
        return new JSONObject().put("message", result).put("diagnostic", diagnostic);
    }

    private static boolean safeId(String id, Pattern format, String token) {
        return id != null && id.length() <= 36 && format.matcher(id).matches()
                && (token == null || !token.toLowerCase(Locale.ROOT).contains(id.toLowerCase(Locale.ROOT)));
    }

    private static String knownField(String field) {
        if (field == null || field.length() > 96) return null;
        Matcher nested = CONTENT_FIELD.matcher(field);
        if (nested.matches()) {
            for (int i = nested.groupCount(); i > 0; i--) if (nested.group(i) != null) return nested.group(i);
        }
        switch (field) {
            case "purpose": case "file": case "file_id": case "model": case "messages": case "content":
            case "source": case "type": case "media_type": case "anthropic-beta": case "max_tokens":
            case "thinking": case "output_config": case "tools": case "tool_choice": case "role": case "system":
                return field;
            default: return null;
        }
    }

    private static String classify(boolean upload, String msg, String code, String param, String fallback) {
        if (!upload) {
            if (msg.startsWith("file_ids do not exist or are not created under your account")
                    || msg.startsWith("file data not found for file_id") || msg.contains(".source.file_id: invalid file_id")) {
                return "DS_FILE_REFERENCE_EXPIRED";
            }
            if ("context_length_exceeded".equals(code) || msg.contains("context_length_exceeded") || msg.contains("context length")
                    || msg.contains("context window") || msg.contains("too many tokens") || msg.contains("prompt is too long")) return "DS_FILE_CONTEXT_LIMIT";
            if (msg.contains("too many documents") || msg.contains("at most 20 documents")) return "DS_FILE_DOCUMENT_COUNT";
            if (msg.contains("cannot be used as an image") || msg.contains("cannot be referenced as an image")) return "DS_FILE_BLOCK_TYPE";
            if (msg.contains("does not support image input") || msg.contains("does not support file input")
                    || msg.contains("does not support document input")) return "DS_FILE_MODEL";
        }
        if (msg.contains("text") && (TEXT_LIMIT.matcher(msg).find() || msg.contains("document text is too long"))) return "DS_FILE_TEXT_LIMIT";
        if (msg.contains("anthropic-beta") && msg.contains("files-api-2025-04-14")) return "DS_FILE_BETA";
        if (upload) {
            if (msg.contains("password-protected") || msg.contains("encrypted file")) return "DS_FILE_ENCRYPTED";
            if (msg.startsWith("user file count limit exceeded")) return "DS_FILE_COUNT_LIMIT";
            if (msg.startsWith("user storage quota exceeded")) return "DS_FILE_STORAGE_LIMIT";
            if ("purpose".equals(param) || msg.contains("invalid purpose") || msg.contains("purpose must")) return "DS_FILE_PURPOSE";
            if (msg.startsWith("you have uploaded an unsupported") || msg.startsWith("you have uploaded an invalid")
                    || msg.contains("failed to recognize the file") || msg.contains("the image is too large to process")) return "DS_FILE_PARSE_FAILED";
        }
        return fallback;
    }

    private static final class Fields { String type, code, param, message = ""; }

    private static Fields readError(InputStream stream) throws IOException {
        if (stream == null) return null;
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        byte[] chunk = new byte[1024];
        while (data.size() < BODY_LIMIT) {
            int count = stream.read(chunk, 0, Math.min(chunk.length, BODY_LIMIT - data.size()));
            if (count < 0) break;
            if (count == 0) return null;
            data.write(chunk, 0, count);
        }
        if (data.size() == BODY_LIMIT || data.size() == 0) return null;
        try (JsonReader reader = new JsonReader(new StringReader(data.toString(StandardCharsets.UTF_8.name())))) {
            reader.beginObject();
            Fields fields = null;
            while (reader.hasNext()) {
                if (!"error".equals(reader.nextName()) || reader.peek() != JsonToken.BEGIN_OBJECT) {
                    reader.skipValue();
                    continue;
                }
                fields = new Fields();
                reader.beginObject();
                while (reader.hasNext()) {
                    String name = reader.nextName();
                    if (reader.peek() != JsonToken.STRING) { reader.skipValue(); continue; }
                    switch (name) {
                        case "type": fields.type = reader.nextString(); break;
                        case "message": fields.message = reader.nextString(); break;
                        case "code": fields.code = reader.nextString(); break;
                        case "param": fields.param = reader.nextString(); break;
                        default: reader.skipValue();
                    }
                }
                reader.endObject();
            }
            reader.endObject();
            return reader.peek() == JsonToken.END_DOCUMENT ? fields : null;
        }
    }

    private DshFileErrors() { }
}
