package ai.deepseek.demo.shell;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Exposes the account's credit observation and daily check-in preference to the packaged UI. */
@CapacitorPlugin(name = "WorkBuddyWallet")
public final class WorkBuddyWalletPlugin extends Plugin {
    private void readMeter(PluginCall call, boolean refresh, Boolean auto) {
        if (!SecurityPlugin.isUnlocked()) { call.reject("请先解锁应用。"); return; }
        WorkBuddyWallet.isolated(() -> {
            try {
                JSObject account = WorkBuddyWallet.run(getContext(), refresh, auto, false);
                getActivity().runOnUiThread(() -> {
                    if (!SecurityPlugin.isUnlocked()) call.reject("请先解锁应用。");
                    else call.resolve(account);
                });
            } catch (Exception failure) { call.reject("无法更新 WorkBuddy 积分设置。"); }
        });
    }

    @PluginMethod public void status(PluginCall call) { readMeter(call, false, null); }
    @PluginMethod public void refresh(PluginCall call) { readMeter(call, true, null); }
    @PluginMethod public void setAuto(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) { call.reject("请指定签到设置。"); return; }
        readMeter(call, false, enabled);
    }

    @Override protected void handleOnResume() {
        WorkBuddyWallet.isolated(() -> {
            try { WorkBuddyWallet.run(getContext(), false, null, true); }
            catch (Exception ignored) { /* Recheck on the next scheduled run or resume. */ }
        });
    }
}
