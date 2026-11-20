package ai.deepseek.demo.shell;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.json.JSONArray;
import org.json.JSONObject;

/** Offline JVM probe for the production Android catalog and wire-body builders. */
final class HunyuanNativeQa {
    private static final String[][] MODELS = {
            {"hy3", "Hy3", "x0.00 credits"}, {"hy3-x", "Hy3", "x0.05 credits"},
            {"hy4-preview", "Hy4 preview", "x0.29 credits"},
            {"hy4-preview-x", "Hy4 preview", "x0.29 credits"},
            {"hy3-preview", "Hy3 preview", ""}, {"hunyuan-chat", "Hunyuan-Turbos", ""},
            {"hunyuan-2.0-thinking", "Hunyuan-2.0-Thinking", ""},
            {"glm-5.3", "GLM-5.3", ""}, {"deepseek-v4-pro", "Deepseek-V4-Pro", ""},
    };

    private static void require(boolean condition, String reason) {
        if (!condition) throw new AssertionError(reason);
    }

    public static void main(String[] args) throws Exception {
        JSONArray rows = new JSONArray(), roster = new JSONArray();
        for (String[] model : MODELS) {
            roster.put(model[0]);
            rows.put(new JSONObject().put("id", model[0]).put("name", model[1]).put("credits", model[2]));
        }
        if (args.length > 0) {
            // Optional comparison against a packaged product catalog. No account state is read.
            rows = new JSONObject(Files.readString(Path.of(args[0]))).getJSONArray("models");
        }
        JSONObject data = new JSONObject().put("models", rows)
                .put("agents", new JSONArray().put(new JSONObject().put("name", "cli").put("models", roster)));
        JSONArray activeCatalog = WorkBuddyCatalog.parse(data);
        require(activeCatalog.length() == MODELS.length, "Fixture roster did not match product catalog IDs");
        for (int index = 0; index < MODELS.length; index++) {
            JSONObject row = activeCatalog.getJSONObject(index);
            String selected = row.getString("id");
            require(selected.equals(MODELS[index][0]), "Unexpected route ID " + selected);
            require(row.getString("name").equalsIgnoreCase(MODELS[index][1]), "Unexpected label for " + selected);
            JSONObject input = new JSONObject().put("model", selected).put("thinking", true)
                    .put("messages", new JSONArray().put(new JSONObject().put("role", "user").put("content", "离线测试")));
            JSONObject answer = WorkBuddyWire.body(input, false, activeCatalog);
            JSONObject plan = WorkBuddyWire.body(new JSONObject(input.toString()).put("purpose", "search_plan"), false, activeCatalog);
            require(answer.getBoolean("stream") && plan.getBoolean("stream"), "Expected streaming");
            require(answer.getString("model").equals(selected) && plan.getString("model").equals(selected),
                    "Chat/planner changed catalog ID " + selected);
            System.out.println(selected + " | " + row.getString("name") + " | chat=" + answer.getString("model")
                    + " | search-plan=" + plan.getString("model"));
        }
        JSONObject saved = new JSONObject(data.toString());
        JSONArray catalogRows = saved.getJSONArray("models");
        JSONObject paid = null;
        for (int index = 0; index < catalogRows.length(); index++) {
            JSONObject row = catalogRows.getJSONObject(index);
            if (row.getString("id").equals("hy3-x")) paid = row;
        }
        require(paid != null, "Paid fixture row missing");
        paid.put("modelId", "hy-deploy-qa");
        require("hy-deploy-qa".equals(WorkBuddyCatalog.originModel(WorkBuddyCatalog.parse(saved), "hy3-x")),
                "Unique serving ID must come from the selected catalog row");
        catalogRows.put(new JSONObject().put("id", "hidden-route").put("hidden", true).put("modelId", "hy-deploy-qa"));
        require(WorkBuddyCatalog.originModel(WorkBuddyCatalog.parse(saved), "hy3-x") == null,
                "Hidden sibling shares the serving ID and must disqualify it");
        paid.put("modelId", "hy3");
        require(WorkBuddyCatalog.originModel(WorkBuddyCatalog.parse(saved), "hy3-x") == null,
                "Another route ID must disqualify an origin hint");
        require(activeCatalog.getJSONObject(0).getJSONObject("rate").getBoolean("free"), "Expected explicit free rate");
        require(activeCatalog.getJSONObject(1).getJSONObject("rate").getDouble("multiplier") == 0.05,
                "Sibling route lost its separate rate");
        try {
            WorkBuddyWire.body(new JSONObject().put("model", "Hunyuan-Turbos"), false, activeCatalog);
            throw new AssertionError("Display label allowed for dispatch");
        } catch (IOException expected) {
            require("model".equals(expected.getMessage()), "Expected catalog validation failure");
        }
    }
}
