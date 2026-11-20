package ai.deepseek.demo.shell;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Offline tests of the same native parser and grant ledger used by the WebView listener. */
public class WorkBuddyPageTest {
    private final WorkBuddyPage pages = new WorkBuddyPage();
    private int searchNumber;
    private static final String URL = "https://news.qq.com/a/story?a=1";
    private static final String MODEL = "deepseek-v4-pro", REV = "test-revision", BEARER = "native-fixture-key";

    private static byte[] bytes(JSONObject object) { return object.toString().getBytes(StandardCharsets.UTF_8); }
    private static JSONObject parse(byte[] raw) throws Exception { return new JSONObject(new String(raw, StandardCharsets.UTF_8)); }
    private static JSONObject request(String key) throws Exception {
        return new JSONObject().put("op", "read").put("id", "call").put("model", MODEL).put("revision", REV).put("readKey", key);
    }
    private JSONArray register(String... urls) throws Exception {
        JSONArray rows = new JSONArray();
        for (String url : urls) rows.put(new JSONObject().put("url", url).put("snippet", "搜索摘要"));
        WorkBuddyPage.Batch batch = new WorkBuddyPage.Batch(REV, MODEL, 100);
        byte[] result = batch.attachKeys(bytes(new JSONObject().put("results", rows)));
        pages.install("search-" + (++searchNumber), batch);
        return parse(result).getJSONArray("results");
    }
    private String issue() throws Exception { return register(URL).getJSONObject(0).getString("readKey"); }
    private WorkBuddyPage.Grant grant() throws Exception { return pages.take(request(issue()), REV, MODEL, 100); }
    private static JSONObject response() throws Exception {
        return new JSONObject().put("code", 0).put("url", URL).put("content_type", "text/html; charset=utf-8").put("content", "网页原文");
    }
    private static JSONObject read(JSONObject response, WorkBuddyPage.Grant grant) throws Exception {
        return parse(WorkBuddyPage.result(new ByteArrayInputStream(bytes(response)), grant, BEARER));
    }
    private interface Attempt { void run() throws Exception; }
    private static void denied(String reason, Attempt attempt) throws Exception {
        try { attempt.run(); fail("expected refusal: " + reason); }
        catch (IOException e) { assertEquals(reason, e.getMessage()); }
    }

    @Test public void grantsOnlyEligibleSearchHitsAndPreservesAllSnippets() throws Exception {
        String[] urls = { URL, "http://news.qq.com/a", "https://user:pwd@news.qq.com/a", "https://192.168.0.1/a",
                "https://127.1/a", "https://0x7f000001/a", "https://2130706433/a", "https://[::1]/a", "https://[fe80::1%25en0]/",
                "https://localhost/a", "https://a.localhost/", "https://files.home.arpa/", "https://metadata.google.internal/",
                "https://server.lan/", "https://news.qq.com:444/a", "https://news.qq.com/a#sensitive", "file:///a", "https://news.qq.com/%0D%0Afoo",
                "https://news.qq.com/?access%5ftoken=secret", "https://news.qq.com/?X-Amz-Signature=signature" };
        JSONArray rows = register(urls);
        assertEquals(urls.length, rows.length());
        for (int i = 0; i < rows.length(); i++) {
            assertEquals(urls[i], i == 0, rows.getJSONObject(i).has("readKey"));
            assertEquals("搜索摘要", rows.getJSONObject(i).getString("snippet"));
        }
        JSONObject denial = new JSONObject().put("error", new JSONObject().put("code", 15003));
        assertArrayEquals(bytes(denial), new WorkBuddyPage.Batch(REV, MODEL, 100).attachKeys(bytes(denial)));
    }

    @Test public void rejectsCallerUrlsWrongScopeReplayExpiryAndForgottenGrants() throws Exception {
        String key = issue();
        assertNotEquals(key, issue());
        denied("invalid_read_key", () -> pages.take(request(URL), REV, MODEL, 100));
        denied("invalid_read_key", () -> pages.take(request(key).put("url", URL), REV, MODEL, 100));
        denied("invalid_read_key", () -> pages.take(request(key).put("headers", new JSONObject()), REV, MODEL, 100));
        denied("invalid_read_key", () -> pages.take(request(key).put("revision", "other"), "other", MODEL, 100));
        denied("invalid_read_key", () -> pages.take(request(key).put("model", "other"), REV, "other", 100));
        assertEquals(URL, pages.take(request(key), REV, MODEL, 100).url);
        denied("invalid_read_key", () -> pages.take(request(key), REV, MODEL, 100));
        String expired = issue();
        denied("invalid_read_key", () -> pages.take(request(expired), REV, MODEL, 100 + WorkBuddyPage.TTL_MS));
        String cleared = issue();
        pages.clear();
        denied("invalid_read_key", () -> pages.take(request(cleared), REV, MODEL, 100));
        String oldest = issue();
        for (int i = 0; i < WorkBuddyPage.MAX_BATCHES; i++) issue();
        denied("invalid_read_key", () -> pages.take(request(oldest), REV, MODEL, 100));
    }

    @Test public void largeBatchKeepsItsFirstAndLastHitAndCanBeCancelledSeparately() throws Exception {
        String[] urls = new String[180];
        for (int i = 0; i < urls.length; i++) urls[i] = URL + "&n=" + i;
        JSONArray hits = register(urls);
        String other = issue();
        assertEquals(urls[0], pages.take(request(hits.getJSONObject(0).getString("readKey")), REV, MODEL, 100).url);
        assertEquals(urls[179], pages.take(request(hits.getJSONObject(179).getString("readKey")), REV, MODEL, 100).url);
        pages.revoke("search-1");
        denied("invalid_read_key", () -> pages.take(request(hits.getJSONObject(1).getString("readKey")), REV, MODEL, 100));
        assertEquals(URL, pages.take(request(other), REV, MODEL, 100).url);
    }

    @Test public void usesOfficialEndpointPayloadAndOnlyReturnsPageContent() throws Exception {
        WorkBuddyPage.Grant grant = grant();
        JSONObject body = grant.body();
        assertEquals("https://copilot.tencent.com/agenttool/v1/webfetch", WorkBuddyPage.ENDPOINT);
        assertEquals(6, body.length());
        assertEquals(URL, body.getString("url")); assertEquals(MODEL, body.getString("model_name"));
        assertEquals("markdown", body.getString("format")); assertTrue(body.getString("prompt").contains("verbatim"));
        assertEquals(20, body.getInt("timeout")); assertEquals(WorkBuddyPage.TEXT_LIMIT, body.getInt("max_length"));
        JSONObject result = read(response().put("context", "private").put("content", "网页原文\n" + BEARER), grant);
        assertEquals(1, result.length()); assertEquals("网页原文\n[redacted]", result.getString("text"));
    }

    @Test public void refusesDenialsRedirectsBinaryAndMissingContent() throws Exception {
        WorkBuddyPage.Grant grant = grant();
        for (JSONObject response : new JSONObject[]{response().put("code", 15003), response().put("error", "denied"),
                response().put("url", "http://10.0.0.1/private"), response().put("url", "https://www.qq.com/other"),
                response().put("url", JSONObject.NULL), response().put("content_type", "application/pdf"),
                response().put("content_type", "image/png"), response().put("content", "   "), response().put("content", new JSONArray()),
                response().put("content", JSONObject.NULL).put("summary", "fallback must stay a snippet")}) {
            denied("page_unavailable", () -> read(response, grant));
        }
    }

    @Test public void capsWireBytesAndPageTextWithoutBreakingUnicode() throws Exception {
        WorkBuddyPage.Grant grant = grant();
        byte[] oversized = new byte[WorkBuddyPage.RESPONSE_BYTES + 1];
        denied("page_too_large", () -> WorkBuddyPage.result(new ByteArrayInputStream(oversized), grant, BEARER));
        char[] prefix = new char[WorkBuddyPage.TEXT_LIMIT - 1]; Arrays.fill(prefix, '中');
        String text = new String(prefix);
        assertEquals(text, read(response().put("content", text + "🙂正文"), grant).getString("text"));
    }
}
