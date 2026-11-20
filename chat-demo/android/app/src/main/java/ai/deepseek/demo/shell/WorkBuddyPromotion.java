package ai.deepseek.demo.shell;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.HashMap;
import java.util.Map;

/** Only the rate and scheduling fields of Tencent's modelPromotions can cross the bridge. */
final class WorkBuddyPromotion {
    private WorkBuddyPromotion() {}

    static Map<String, JSONArray> byModel(JSONArray promotions) throws JSONException {
        Map<String, JSONArray> result = new HashMap<>();
        if (promotions == null || promotions.length() > 256) return result;
        int attached = 0;
        for (int i = 0; i < promotions.length(); i++) {
            JSONObject promo = promotions.optJSONObject(i);
            if (promo == null || !(promo.opt("id") instanceof String) || !promo.optBoolean("enabled", true)) continue;
            JSONArray ids = promo.optJSONArray("modelIds");
            if (ids == null || ids.length() > 128) continue;
            JSONObject rule = rule(promo);
            if (rule == null) continue;
            for (int j = 0; j < ids.length(); j++) {
                Object value = ids.opt(j);
                if (!(value instanceof String) || !((String)value).matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")) continue;
                String id = (String)value;
                JSONArray rules = result.get(id);
                if (rules == null) { rules = new JSONArray(); result.put(id, rules); }
                if (++attached > 1024) return new HashMap<>();
                rules.put(rule);
            }
        }
        return result;
    }

    private static JSONObject rule(JSONObject promo) throws JSONException {
        JSONObject rule = new JSONObject().put("priority", promo.optInt("priority"));
        JSONObject schedule = promo.optJSONObject("schedule");
        if (promo.has("schedule") && !promo.isNull("schedule") && schedule == null) return null;
        if (schedule != null) {
            for (String key : new String[]{"validFrom", "validUntil", "timezone"}) {
                if (schedule.isNull(key)) continue;
                Object value = schedule.opt(key);
                if (!(value instanceof String) || ((String)value).length() > 64) return null;
                rule.put(key, value);
            }
            JSONArray daily = schedule.optJSONArray("daily");
            if (!schedule.isNull("daily") && (daily == null || daily.length() > 32)) return null;
            if (daily != null && daily.length() > 0) {
                JSONArray windows = new JSONArray();
                for (int i = 0; i < daily.length(); i++) {
                    JSONObject window = daily.optJSONObject(i);
                    if (window == null) continue;
                    int start = minute(window.optString("start")), end = minute(window.optString("end"));
                    if (start >= 0 && end >= 0) windows.put(new JSONArray().put(start).put(end));
                }
                if (windows.length() == 0) return null;
                rule.put("daily", windows);
            }
        }
        // Announcements participate in upstream priority but carry no price, even with a 'free' badge.
        JSONObject discount = promo.optJSONObject("discount");
        if ("discount".equals(promo.optString("kind")) && discount != null) {
            Object explicit = discount.opt("discountedCredits");
            if (explicit instanceof String && !((String) explicit).trim().isEmpty()) {
                Double price = WorkBuddyCatalog.multiplier(explicit);
                if (price != null) rule.put("price", price);
            } else if (discount.opt("factor") instanceof Number) {
                double factor = discount.getDouble("factor");
                if (factor > 0 && factor < 1) rule.put("factor", factor);
            }
        }
        return rule;
    }

    private static int minute(String hhmm) {
        if (!hhmm.matches("[0-9]{1,2}:[0-9]{2}")) return -1;
        int colon = hhmm.indexOf(':'), hour = Integer.parseInt(hhmm.substring(0, colon)), minute = Integer.parseInt(hhmm.substring(colon + 1));
        return hour < 24 && minute < 60 ? hour * 60 + minute : -1;
    }
}
