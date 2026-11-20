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
        assertEquals(1000000, allowed.getInt("contextWindow"));
        assertEquals(1000000, allowed.getInt("maxInputTokens"));
        assertEquals("[128000,200000,1000000]", allowed.getJSONArray("contextTiers").toString());
    }
    @Test public void ratesComeFromExplicitCreditsForTheExactModelId() throws Exception {
        // The bundled CN CLI uses the same name for these two IDs and publishes distinct credit multipliers.
        JSONArray models = new JSONArray().put(new JSONObject().put("id", "hy3").put("name", "Hy3").put("credits", "x0.00 credits"))
                .put(new JSONObject().put("id", "hy3-x").put("name", "Hy3").put("credits", "x0.05 credits"))
                .put(new JSONObject().put("id", "unknown").put("credits", "").put("cost", 0));
        JSONArray rows = WorkBuddyCatalog.parse(data(models, "hy3", "hy3-x", "unknown"));
        assertTrue(rows.getJSONObject(0).getJSONObject("rate").getBoolean("free"));
        assertEquals(0.05, rows.getJSONObject(1).getJSONObject("rate").getDouble("multiplier"), 0);
        assertFalse(rows.getJSONObject(1).getJSONObject("rate").has("free"));
        assertFalse(rows.getJSONObject(2).has("rate"));
        assertEquals(0.29, WorkBuddyCatalog.creditRate("0.29x").getDouble("multiplier"), 0);
        assertEquals(0.29, WorkBuddyCatalog.creditRate("x0.29").getDouble("multiplier"), 0);
        assertEquals(0.29, WorkBuddyCatalog.creditRate("0.29").getDouble("multiplier"), 0);
        for (Object unknown : new Object[]{JSONObject.NULL, 0, "", "x-1 credits", "0.0 RMB", "x0.00 credits extra", "0–0.29x", "Free trial"})
            assertNull(WorkBuddyCatalog.creditRate(unknown));
    }

    @Test public void exactModelPromotionsExposeOnlyRateAndSchedule() throws Exception {
        JSONArray rows = new JSONArray().put(new JSONObject().put("id", "hy3").put("credits", "x0.29 credits"))
                .put(new JSONObject().put("id", "hy3-x"));
        JSONObject data = data(rows, "hy3", "hy3-x").put("modelPromotions", new JSONArray()
                .put(new JSONObject("{id:'p',modelIds:['hy3-x'],kind:'discount',priority:3,discount:{discountedCredits:'0.00x'},schedule:{timezone:'Asia/Shanghai',daily:[{start:'23:00',end:'08:00'}]},hover:{textZh:'private'}}"))
                .put(new JSONObject("{id:'disabled',modelIds:['hy3'],enabled:false,kind:'discount',discount:{factor:0}}")));
        JSONArray result = WorkBuddyCatalog.parse(data);
        assertFalse(result.getJSONObject(0).has("promotions"));
        JSONObject promo = result.getJSONObject(1).getJSONArray("promotions").getJSONObject(0);
        assertEquals(0, promo.getDouble("price"), 0);
        assertEquals(3, promo.getInt("priority"));
        assertEquals("[[1380,480]]", promo.getJSONArray("daily").toString());
        assertFalse(promo.has("hover"));
    }

    @Test public void discountedCreditsAcceptVendorDisplayFormatsAndRequireExplicitZero() throws Exception {
        JSONObject discount = new JSONObject(), promo = new JSONObject().put("id", "offer")
                .put("kind", "discount").put("modelIds", new JSONArray().put("hy3-x")).put("discount", discount);
        JSONArray offers = new JSONArray().put(promo);
        for (String explicit : new String[]{"x0.05", "0.05x", "0.05", "x0.05 credits"}) {
            discount.put("discountedCredits", explicit);
            assertEquals(0.05, WorkBuddyPromotion.byModel(offers).get("hy3-x").getJSONObject(0).getDouble("price"), 0);
        }
        discount.put("discountedCredits", "×0.00");
        assertEquals(0, WorkBuddyPromotion.byModel(offers).get("hy3-x").getJSONObject(0).getDouble("price"), 0);
        discount.put("discountedCredits", "").put("factor", 0);
        JSONObject unset = WorkBuddyPromotion.byModel(offers).get("hy3-x").getJSONObject(0);
        assertFalse(unset.has("factor"));
        assertFalse(unset.has("price"));
        discount.put("discountedCredits", "0.00 USD").put("factor", 0.5);
        JSONObject unsupported = WorkBuddyPromotion.byModel(offers).get("hy3-x").getJSONObject(0);
        assertFalse(unsupported.has("factor"));
        assertFalse(unsupported.has("price"));
    }

    @Test public void failureKeepsLastSuccessfulRatesUntilNextSuccessEvenForAnEmptyRoster() throws Exception {
        long now = 880_000L;
        JSONObject record = new JSONObject(), status = new JSONObject();
        JSONArray roster = new JSONArray().put(new JSONObject().put("id", "hy3-x").put("rate", WorkBuddyCatalog.creditRate("x0.05 credits")));
        WorkBuddyCatalog.recordAttempt(record, roster, now);
        WorkBuddyCatalog.describeCache(record, status, now + 299_999);
        assertFalse(status.getBoolean("catalogStale"));
        WorkBuddyCatalog.describeCache(record, status, now + 300_000);
        assertTrue(status.getBoolean("catalogRefresh"));
        WorkBuddyCatalog.recordAttempt(record, null, now + 300_000);
        WorkBuddyCatalog.describeCache(record, status, now + 300_000);
        assertEquals(roster.toString(), status.getJSONArray("catalog").toString());
        assertEquals(now, status.getLong("catalogUpdatedAt"));
        assertTrue(status.getBoolean("catalogError"));
        assertFalse(status.getBoolean("catalogRefresh"));
        WorkBuddyCatalog.describeCache(record, status, now + 330_000);
        assertTrue(status.getBoolean("catalogRefresh"));
        WorkBuddyCatalog.recordAttempt(record, new JSONArray(), now + 330_000);
        WorkBuddyCatalog.recordAttempt(record, null, now + 330_100);
        WorkBuddyCatalog.describeCache(record, status, now + 330_100);
        assertEquals(0, status.getJSONArray("catalog").length());
        assertEquals(now + 330_000, status.getLong("catalogUpdatedAt"));
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
