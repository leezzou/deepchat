package ai.deepseek.demo.shell;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;

/** Reads the data object of WorkBuddy's resource summary and check-in replies. */
final class WorkBuddyMeter {
    private WorkBuddyMeter() {}

    static Double balance(JSONObject data) {
        if (data == null) return null;
        BigDecimal total = credits(data, "TotalCredits");
        if (total != null) return total.doubleValue();
        // Groups and packages describe the same credits at different levels.
        Double groups = sum(data.optJSONArray("CreditGroups"));
        return groups != null ? groups : sum(data.optJSONArray("Packages"));
    }

    private static Double sum(JSONArray rows) {
        if (rows == null) return null;
        BigDecimal sum = null;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            String unit = row.optString("CapacityUnit", "");
            if (!unit.isEmpty() && !"credit".equalsIgnoreCase(unit) && !"credits".equalsIgnoreCase(unit)) continue;
            BigDecimal remaining = credits(row, "CycleRemainCapacity");
            if (remaining == null) {
                BigDecimal total = credits(row, "CycleTotalCapacity");
                BigDecimal used = credits(row, "CycleUsedCapacity");
                BigDecimal frozen = row.isNull("CycleFrozenCapacity")
                        ? BigDecimal.ZERO : credits(row, "CycleFrozenCapacity");
                if (total == null || used == null || frozen == null) continue;
                remaining = total.subtract(used).subtract(frozen).max(BigDecimal.ZERO);
            }
            sum = sum == null ? remaining : sum.add(remaining);
        }
        if (sum == null || Double.isInfinite(sum.doubleValue())) return null;
        return sum.doubleValue();
    }

    private static BigDecimal credits(JSONObject object, String field) {
        Object value = object.opt(field);
        if (!(value instanceof String) && !(value instanceof Number)) return null;
        try {
            BigDecimal parsed = new BigDecimal(value.toString().trim());
            double number = parsed.doubleValue();
            if (parsed.signum() == 0) return BigDecimal.ZERO;
            return number > 0 && !Double.isInfinite(number) ? parsed : null;
        } catch (NumberFormatException invalid) {
            return null;
        }
    }

    static String activity(int code, JSONObject data) {
        if (code != 0) return claimed(code);
        if (data == null) return "unknown";
        Object active = data.opt("active");
        if (Boolean.FALSE.equals(active)) return "inactive";
        Object checked = data.opt("todayCheckedIn");
        Object alternate = data.opt("today_checked_in");
        if (checked == null) checked = alternate;
        else if (alternate != null && !checked.equals(alternate)) return "unknown";
        if (Boolean.TRUE.equals(checked)) return "checked-in";
        if (Boolean.TRUE.equals(active) && Boolean.FALSE.equals(checked)) return "available";
        return "unknown";
    }

    static String claimed(int code) {
        switch (code) {
            case 0:
            case 1001: return "checked-in";
            case 1002: return "ineligible";
            case 1003: return "inactive";
            default: return "unknown";
        }
    }
}
