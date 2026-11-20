package ai.deepseek.demo.shell;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class WorkBuddyRouteTest {
    private static JSONObject row(String id, String origin) throws Exception {
        return new JSONObject().put("id", id).put("name", "Hy3").put("modelId", origin);
    }
    private static JSONArray parse(JSONObject... models) throws Exception {
        JSONArray rows = new JSONArray(), roster = new JSONArray();
        for (JSONObject model : models) {
            rows.put(model);
            if (!model.optBoolean("hidden")) roster.put(model.getString("id"));
        }
        return WorkBuddyCatalog.parse(new JSONObject().put("models", rows).put("agents",
                new JSONArray().put(new JSONObject().put("name", "cli").put("models", roster))));
    }
    @Test public void uniqueOriginIsPerRouteAndCannotBeDispatched() throws Exception {
        JSONArray catalog = parse(row("hy3", "hy-deployment-123"), row("hy3-x", null));
        assertEquals("hy-deployment-123", WorkBuddyCatalog.originModel(catalog, "hy3"));
        assertNull(WorkBuddyCatalog.originModel(catalog, "hy3-x"));
        assertFalse(WorkBuddyCatalog.allows(catalog, "hy-deployment-123"));
        JSONObject chat = new JSONObject().put("model", "hy3").put("originModel", "injected")
                .put("thinking", false).put("messages", new JSONArray("[{role:'user',content:'hi'}]"));
        for (String purpose : new String[]{"chat", "title", "search_plan"}) {
            if ("title".equals(purpose)) chat.put("max_tokens", 48);
            JSONObject body = WorkBuddyWire.body(chat.put("purpose", purpose), false, catalog);
            assertEquals("hy3", body.getString("model"));
            if ("title".equals(purpose)) assertEquals(48, body.getInt("max_tokens"));
            if ("search_plan".equals(purpose)) assertEquals(256, body.getInt("max_tokens"));
            assertFalse(body.has("originModel"));
        }
    }
    @Test public void anotherRouteOrSharedDeploymentCannotAuthorizeAnAlias() throws Exception {
        assertNull(WorkBuddyCatalog.originModel(parse(row("hy3", "hy3-x"), row("hy3-x", null)), "hy3"));
        assertNull(WorkBuddyCatalog.originModel(parse(row("hy3", "shared"), row("hy3-x", "shared")
                .put("hidden", true)), "hy3"));
        for (Object invalid : new Object[]{"", "bad\nheader", "https://example.invalid/id", 42, JSONObject.NULL}) {
            assertNull(WorkBuddyCatalog.originModel(parse(row("hy3", null).put("modelId", invalid)), "hy3"));
        }
        assertNull(WorkBuddyCatalog.originModel(parse(row("hy3-x", null).put("vendor", "j")
                .put("relatedModels", new JSONObject().put("reasoning", "hy3"))), "hy3-x"));
        assertNull(WorkBuddyCatalog.originModel(null, "hy3"));
    }
}
