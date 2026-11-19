package ai.deepseek.demo.shell;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/** Offline fixtures in the shapes published by magpie-community/plugins, packages/workbuddy. */
public final class WorkBuddyMeterTest {
    private static Double balance(String json) throws Exception {
        return WorkBuddyMeter.balance(new JSONObject(json));
    }

    @Test public void authoritativeTotalPreservesFractionsAndZero() throws Exception {
        String duplicate = ",\"CreditGroups\":[{\"CycleRemainCapacity\":9500}],\"Packages\":[{\"CycleRemainCapacity\":9500}]}";
        assertEquals(Double.valueOf(1910.80000003), balance("{\"TotalCredits\":\"1910.80000003\"" + duplicate));
        assertEquals(Double.valueOf(0), balance("{\"TotalCredits\":0" + duplicate));
    }

    @Test public void measuredGroupsTakePrecedenceOverPackages() throws Exception {
        String rows = "{\"TotalCredits\":\"\",\"CreditGroups\":["
                + "{\"CycleRemainCapacity\":\"99.81\",\"CapacityUnit\":\"credits\"},"
                + "{\"CycleRemainCapacity\":0.19,\"CapacityUnit\":\"credit\"},"
                + "{\"CycleRemainCapacity\":19,\"CapacityUnit\":\"requests\"},null,{}],"
                + "\"Packages\":[{\"CycleRemainCapacity\":200}]}";
        assertEquals(Double.valueOf(100), balance(rows));
        assertEquals(Double.valueOf(0), balance("{\"CreditGroups\":[{\"CycleRemainCapacity\":\"0\"}],"
                + "\"Packages\":[{\"CycleRemainCapacity\":200}]}"));
    }

    @Test public void packageFallbackRespectsRemainingAndFrozenAmounts() throws Exception {
        String rows = "{\"CreditGroups\":[{}],\"Packages\":["
                + "{\"CycleTotalCapacity\":1000,\"CycleUsedCapacity\":\"89.19999997\",\"CycleFrozenCapacity\":\"10.8\"},"
                + "{\"CycleRemainCapacity\":\"50\",\"CycleFrozenCapacity\":5},"
                + "{\"CycleTotalCapacity\":10,\"CycleUsedCapacity\":12},{}]}";
        assertEquals(Double.valueOf(950.00000003), balance(rows));
        assertEquals(Double.valueOf(750), balance("{\"Packages\":[{\"CycleRemainCapacity\":\"750\"}]}"));
    }

    @Test public void malformedRepliesDoNotProduceZeroBalances() throws Exception {
        assertNull(WorkBuddyMeter.balance(null));
        for (String value : new String[]{"{}", "{\"TotalCredits\":null}", "{\"TotalCredits\":true}",
                "{\"TotalCredits\":\"NaN\"}", "{\"TotalCredits\":\"1e9999\"}", "{\"TotalCredits\":-1}",
                "{\"Packages\":[]}", "{\"Packages\":[{\"CycleTotalCapacity\":9}]}",
                "{\"Packages\":[{\"CycleTotalCapacity\":10,\"CycleUsedCapacity\":1,\"CycleFrozenCapacity\":\"?\"}]}"}) {
            assertNull(value, balance(value));
        }
    }

    @Test public void onlyActiveExplicitlyUncheckedCanClaim() throws Exception {
        assertEquals("available", WorkBuddyMeter.activity(0, new JSONObject("{\"active\":true,\"todayCheckedIn\":false}")));
        assertEquals("checked-in", WorkBuddyMeter.activity(0, new JSONObject("{\"active\":true,\"today_checked_in\":true}")));
        assertEquals("inactive", WorkBuddyMeter.activity(0, new JSONObject("{\"active\":false,\"todayCheckedIn\":false}")));
        assertEquals("unknown", WorkBuddyMeter.activity(0, null));
        for (String value : new String[]{"{}", "{\"active\":true}", "{\"todayCheckedIn\":false}",
                "{\"active\":true,\"todayCheckedIn\":\"false\"}",
                "{\"active\":true,\"todayCheckedIn\":false,\"today_checked_in\":true}"}) {
            assertEquals(value, "unknown", WorkBuddyMeter.activity(0, new JSONObject(value)));
        }
    }

    @Test public void businessCodesAreIdempotentAndOverridePayload() throws Exception {
        JSONObject active = new JSONObject("{\"active\":true,\"todayCheckedIn\":false}");
        assertEquals("checked-in", WorkBuddyMeter.claimed(0));
        int[] codes = {1001, 1002, 1003, 1004, -1};
        String[] outcomes = {"checked-in", "ineligible", "inactive", "unknown", "unknown"};
        for (int i = 0; i < codes.length; i++) {
            assertEquals(outcomes[i], WorkBuddyMeter.claimed(codes[i]));
            assertEquals(outcomes[i], WorkBuddyMeter.activity(codes[i], active));
        }
    }
}
