package ai.deepseek.demo.shell;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class WorkBuddyCatalogTest {
    private JSONObject data(JSONArray models, String... ids) throws Exception {
        JSONArray roster = new JSONArray();
        for (String id : ids) roster.put(id);
        return new JSONObject().put("models", models).put("agents", new JSONArray().put(new JSONObject().put("name", "cli").put("models", roster)));
    }
    @Test public void rosterLimitsDispatchAndSuppliesRealDefaultAndTiers() throws Exception {
        JSONObject kimi = new JSONObject().put("id", "kimi-k3-2").put("name", "Kimi K3").put("maxInputTokens", 1000000)
                .put("contextWindow", new JSONObject().put("supportedLengths", new JSONArray("[1000000,-3,200000,128000,1000001,200000]"))
                        .put("defaultLength", 200000));
        JSONArray rows = new JSONArray().put(kimi).put(new JSONObject().put("id", "glm-5.3").put("disabled", true))
                .put(new JSONObject().put("id", "hy4-preview-f")).put(new JSONObject().put("id", "auto"))
                .put(new JSONObject().put("id", "vision").put("outputModalities", new JSONArray("['image']")));
        JSONArray catalog = WorkBuddyCatalog.parse(data(rows, "auto", "glm-5.3", "kimi-k3-2", "vision", "missing", "kimi-k3-2"));
        assertEquals(1, catalog.length());
        assertTrue(WorkBuddyCatalog.allows(catalog, "kimi-k3-2"));
        assertFalse(WorkBuddyCatalog.allows(catalog, "deepseek-v4-pro"));
        JSONObject allowed = catalog.getJSONObject(0);
        assertEquals(200000, allowed.getInt("contextWindow"));
        assertEquals("[128000,200000,1000000]", allowed.getJSONArray("contextTiers").toString());
    }
    @Test public void explicitEmptyAndLegacyFallbackStayDistinct() throws Exception {
        JSONArray rows = new JSONArray().put(new JSONObject().put("id", "deepseek-v4-pro"));
        JSONArray empty = WorkBuddyCatalog.parse(data(rows, "deepseek-v4-pro").put("availableModels", new JSONArray()));
        assertEquals(0, empty.length());
        assertFalse(WorkBuddyCatalog.allows(empty, "deepseek-v4-pro"));
        assertTrue(WorkBuddyCatalog.allows(null, "deepseek-v4-pro"));
        assertFalse(WorkBuddyCatalog.allows(null, "custom-model"));
        assertFalse(WorkBuddyCatalog.allows(null, "auto"));
    }
}
