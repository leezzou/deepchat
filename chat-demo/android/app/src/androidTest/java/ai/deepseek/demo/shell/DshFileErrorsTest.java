package ai.deepseek.demo.shell;

import static org.junit.Assert.*;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.cert.Certificate;
import javax.net.ssl.HttpsURLConnection;

@RunWith(AndroidJUnit4.class)
public class DshFileErrorsTest {
    private static final String MESSAGES = "/anthropic/v1/messages", FILES = "/anthropic/v1/files";
    private static final String REQUEST = "979a2778-5144-48e9-92e1-3b07e9c92934";
    private static final String TRACE = "43564764ef51237ab3749ef649c37954";
    private static final String SECRET = "private-file-content-秘密 sk-fixture test@example.invalid";

    private static final class Response extends HttpsURLConnection {
        String requestId, traceId;
        final ByteArrayInputStream input;
        Response(String body) throws Exception {
            super(new URL("https://offline.invalid/"));
            input = body == null ? null : new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8));
        }
        @Override public String getHeaderField(String key) {
            if ("x-request-id".equals(key)) return requestId;
            if ("x-ds-trace-id".equals(key)) return traceId;
            throw new AssertionError("Unexpected header read: " + key);
        }
        @Override public InputStream getErrorStream() { return input; }
        @Override public void connect() { throw new AssertionError(); }
        @Override public void disconnect() { }
        @Override public boolean usingProxy() { return false; }
        @Override public String getCipherSuite() { throw new AssertionError(); }
        @Override public Certificate[] getLocalCertificates() { throw new AssertionError(); }
        @Override public Certificate[] getServerCertificates() { throw new AssertionError(); }
    }

    private static String envelope(JSONObject error) throws Exception {
        return new JSONObject().put("type", "error").put("error", error).put("request_id", SECRET).toString();
    }

    @Test public void unknownMessageCarriesOnlySafeStatusPathTypeAndOpaqueRequestId() throws Exception {
        JSONObject error = new JSONObject().put("type", "invalid_request_error").put("code", "invalid_request_error")
                .put("message", "messages[13].content[0].source.media_type: rejected value \"" + SECRET + "\"");
        Response http = new Response(envelope(error));
        http.requestId = REQUEST;
        http.traceId = TRACE;
        JSONObject local = DshFileErrors.detail(http, 422, MESSAGES, true, SECRET);
        assertEquals(2, local.length());
        assertEquals("DS_FILE_MESSAGE_REJECTED", local.getString("message"));
        JSONObject diagnostic = local.getJSONObject("diagnostic");
        assertEquals(6, diagnostic.length());
        assertEquals(422, diagnostic.getInt("status"));
        assertEquals("messages", diagnostic.getString("stage"));
        assertEquals("invalid_request_error", diagnostic.getString("type"));
        assertEquals("invalid_request_error", diagnostic.getString("code"));
        assertEquals("media_type", diagnostic.getString("param"));
        assertEquals(REQUEST, diagnostic.getString("requestId"));
        assertFalse(local.toString().contains(SECRET));
    }

    @Test public void uploadDropsUnknownMetadataAndEchoedCredentials() throws Exception {
        JSONObject error = new JSONObject().put("type", "sk-example").put("code", 1234567)
                .put("param", "company.private_email").put("message", SECRET);
        Response http = new Response(envelope(error));
        http.requestId = "sk-" + REQUEST;
        http.traceId = TRACE;
        JSONObject local = DshFileErrors.detail(http, 400, FILES, false, SECRET);
        assertEquals("DS_FILE_UPLOAD_REJECTED", local.getString("message"));
        JSONObject diagnostic = local.getJSONObject("diagnostic");
        assertEquals(3, diagnostic.length());
        assertEquals("upload", diagnostic.getString("stage"));
        assertEquals(400, diagnostic.getInt("status"));
        assertEquals(TRACE, diagnostic.getString("traceId"));
        assertFalse(local.toString().contains(SECRET));
        http = new Response(null);
        http.requestId = "private@example.invalid";
        http.traceId = TRACE;
        assertEquals(2, DshFileErrors.detail(http, 400, FILES, false, "sk-" + TRACE).getJSONObject("diagnostic").length());
    }

    @Test public void malformedMissingAndOversizedBodiesStayBoundedAndPreserveTheStage() throws Exception {
        String large = new String(new char[10000]).replace('\0', 'X');
        for (String body : new String[]{null, "", "<html>" + SECRET, "{\"error\":{\"message\":", "{\"error\": \"" + SECRET + "\"}", large}) {
            Response http = new Response(body);
            http.requestId = REQUEST;
            JSONObject local = DshFileErrors.detail(http, 422, MESSAGES, true, SECRET);
            assertEquals("DS_FILE_MESSAGE_REJECTED", local.getString("message"));
            assertEquals(3, local.getJSONObject("diagnostic").length());
            assertEquals(REQUEST, local.getJSONObject("diagnostic").getString("requestId"));
            if (body == large) assertEquals(10000 - 8192, http.input.available());
        }
        Response other = new Response("unread");
        assertNull(DshFileErrors.detail(other, 400, MESSAGES, false, SECRET));
        assertNull(DshFileErrors.detail(other, 401, FILES, false, SECRET));
        assertNull(DshFileErrors.detail(other, 422, "/v1/tools/tts", true, SECRET));
        assertEquals(6, other.input.available());
    }

    @Test public void classifyOnlySpecificCausesInTheApplicableStage() throws Exception {
        String[][] examples = {
            {FILES, "purpose: unsupported for this file", "DS_FILE_PURPOSE"},
            {FILES, "Failed to recognize the file", "DS_FILE_PARSE_FAILED"},
            {FILES, "User file count limit exceeded", "DS_FILE_COUNT_LIMIT"},
            {FILES, "User storage quota exceeded", "DS_FILE_STORAGE_LIMIT"},
            {FILES, "This is a password-protected document", "DS_FILE_ENCRYPTED"},
            {MESSAGES, "This model does not support image input", "DS_FILE_MODEL"},
            {MESSAGES, "Document cannot be used as an image", "DS_FILE_BLOCK_TYPE"},
            {MESSAGES, "Requires anthropic-beta: files-api-2025-04-14", "DS_FILE_BETA"},
            {MESSAGES, "messages.0.content.0.source.file_id: invalid file_id", "DS_FILE_REFERENCE_EXPIRED"},
            {MESSAGES, "Document text exceeds 8 MiB", "DS_FILE_TEXT_LIMIT"},
            {MESSAGES, "At most 20 documents are allowed", "DS_FILE_DOCUMENT_COUNT"},
            {MESSAGES, "Maximum context length exceeded", "DS_FILE_CONTEXT_LIMIT"},
            {MESSAGES, "Invalid file purpose", "DS_FILE_MESSAGE_REJECTED"},
            {FILES, "All file_ids do not exist", "DS_FILE_UPLOAD_REJECTED"},
        };
        for (String[] example : examples) {
            Response http = new Response(envelope(new JSONObject().put("message", example[1] + ": " + SECRET)));
            JSONObject local = DshFileErrors.detail(http, 422, example[0], MESSAGES.equals(example[0]), SECRET);
            assertEquals(example[1], example[2], local.getString("message"));
            assertFalse(local.toString().contains(SECRET));
        }
    }
}
