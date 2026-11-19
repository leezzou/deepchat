package ai.deepseek.demo.shell;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class WorkBuddyWireTest {
    private static JSONObject chat(String model, boolean thinking) throws Exception {
        return new JSONObject().put("model", model).put("thinking", thinking).put("messages", new JSONArray()
                .put(new JSONObject().put("role", "user").put("content", "原始问题")));
    }
    private static JSONObject parseResult(JSONObject server) throws Exception {
        byte[] raw = server.toString().getBytes(StandardCharsets.UTF_8);
        return new JSONObject(new String(WorkBuddyWire.searchResults(new ByteArrayInputStream(raw), "offline-bearer"), StandardCharsets.UTF_8));
    }
    @Test public void wirePreservesModelAndSetsEffortInBothDirections() throws Exception {
        assertEquals("https://copilot.tencent.com/v2/chat/completions", WorkBuddyWire.CHAT);
        for (String model : new String[]{"deepseek-v4.1-flash", "deepseek-v4-flash", "deepseek-v4-pro"}) {
            for (boolean enabled : new boolean[]{false, true}) {
                JSONObject body = WorkBuddyWire.body(chat(model, enabled), false);
                assertEquals(model, body.getString("model"));
                if ("deepseek-v4.1-flash".equals(model)) assertTrue(body.getJSONObject("stream_options").getBoolean("include_usage"));
                else assertFalse(body.has("stream_options"));
                assertEquals(enabled ? "high" : "none", body.getString("reasoning_effort"));
                assertEquals(enabled ? "enabled" : "disabled", body.getJSONObject("thinking").getString("type"));
                assertEquals("原始问题", body.getJSONArray("messages").getJSONObject(0).getString("content"));
            }
        }
    }
    @Test public void searchSendsOnlyQueryAndPermittedLimits() throws Exception {
        assertEquals("https://copilot.tencent.com/agenttool/v1/search", WorkBuddyWire.SEARCH);
        JSONObject search = WorkBuddyWire.body(chat("deepseek-v4.1-flash", true).put("query", "今日新闻"), true);
        assertEquals(3, search.length());
        assertEquals("今日新闻", search.getString("query"));
        assertEquals("text2text", search.getString("type"));
        assertEquals(5, search.getInt("max_results"));
        try { WorkBuddyWire.body(chat("auto", true).put("query", "news"), true); fail(); }
        catch (java.io.IOException refused) { assertEquals("model", refused.getMessage()); }
    }
    @Test public void searchRetainsRealSnippetsAndProviderDenials() throws Exception {
        JSONObject row = new JSONObject().put("title", "新闻").put("url", "https://news.example/story").put("snippet", "今日摘要").put("ignored", "private");
        JSONArray found = parseResult(new JSONObject().put("results", new JSONArray().put(row)
                .put(new JSONObject().put("url", "javascript:alert(1)")))).getJSONArray("results");
        assertEquals(1, found.length());
        assertEquals("今日摘要", found.getJSONObject(0).getString("snippet"));
        assertFalse(found.toString().contains("private"));
        assertEquals(0, parseResult(new JSONObject().put("results", new JSONArray())).getJSONArray("results").length());
        JSONObject denial = parseResult(new JSONObject().put("code", 15003).put("msg", "quota denied")).getJSONObject("error");
        assertEquals(15003, denial.getInt("code")); assertEquals("quota denied", denial.getString("message"));
    }
}
