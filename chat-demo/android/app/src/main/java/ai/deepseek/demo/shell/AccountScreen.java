package ai.deepseek.demo.shell;

import static ai.deepseek.demo.shell.AccountPage.Style.DANGER;
import static ai.deepseek.demo.shell.AccountPage.Style.PLAIN;
import static ai.deepseek.demo.shell.AccountPage.Style.PRIMARY;
import static ai.deepseek.demo.shell.AccountPage.Style.TONAL;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;
import android.text.InputType;
import android.text.format.DateFormat;
import android.view.inputmethod.EditorInfo;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.browser.customtabs.CustomTabsIntent;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native account surface. Construct and call lifecycle methods on the activity's main thread. */
public final class AccountScreen {
    private static final Uri TOP_UP = Uri.parse("https://platform.deepseek.com/top_up");
    private enum Session { UNKNOWN, SIGNED_OUT, PENDING, SIGNED_IN }
    private enum Action { NONE, LOGIN, CALLBACK, CANCEL, LOGOUT, PROXY }

    private final Activity activity;
    private final DshAccountHost host;
    private final DshLocalProxy proxy;
    private final Runnable openUsage;
    private final SystemBars theme;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService accountWorker = Executors.newSingleThreadExecutor();
    // A slow wallet request must not hold up a confirmed logout or keep the proxy enabled.
    private final ExecutorService walletWorker = Executors.newSingleThreadExecutor();
    private int walletGeneration;
    private final Runnable poll = () -> checkStatus(false);
    private Dialog dialog;
    private AlertDialog confirmation, manualPrompt;
    private boolean exchanging;
    private AccountPage page;
    private volatile boolean destroyed;
    private boolean checking, refreshing, refreshAgain, returningFromPayment;
    private boolean proxyExpanded, proxyRunning;
    private String proxyAddress = "";
    private Session session = Session.UNKNOWN;
    private Action action = Action.NONE;
    private String name = "", statusError = "", actionError = "", walletError = "", proxyError = "";
    private Wallets wallets;
    private Date updated;

    public AccountScreen(Activity activity, DshAccountHost host, DshLocalProxy proxy, SystemBars theme, Runnable openUsage) {
        this.activity = activity;
        this.host = host;
        this.proxy = proxy;
        this.theme = theme;
        this.openUsage = openUsage;
    }

    public boolean isShowing() { return dialog != null && dialog.isShowing(); }

    void updateTheme() {
        if (page != null && page.dark != theme.isAppDark()) {
            page.updateTheme();
            render();
        }
    }

    public void show() {
        if (destroyed || activity.isFinishing() || activity.isDestroyed() || isShowing()) return;
        session = Session.UNKNOWN;
        exchanging = false;
        action = Action.NONE;
        name = statusError = actionError = walletError = proxyError = "";
        checking = refreshing = refreshAgain = returningFromPayment = proxyExpanded = proxyRunning = false;
        proxyAddress = "";
        wallets = null;
        updated = null;
        boolean dark = theme.isAppDark();
        Dialog opened = new Dialog(activity, dark ? android.R.style.Theme_Material_NoActionBar
                : android.R.style.Theme_Material_Light_NoActionBar) {
            @Override public void onWindowFocusChanged(boolean focus) {
                super.onWindowFocusChanged(focus);
                if (dialog == this) schedulePoll();
            }
        };
        dialog = opened;
        opened.requestWindowFeature(Window.FEATURE_NO_TITLE);
        Window window = opened.getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        page = new AccountPage(activity, window, theme, opened::dismiss, this::render);
        opened.setContentView(page);
        opened.setTitle("DeepChat 账户");
        opened.setOnDismissListener(ignored -> {
            if (dialog != opened) return;
            main.removeCallbacks(poll);
            closeConfirmation();
            dialog = null;
            page = null;
            wallets = null;
            proxyAddress = "";
        });
        opened.show();
        window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
        render();
        checkStatus(true);
    }

    /** Payment has no success callback. Fetch balances once on the first resume after a launch. */
    public void onResume() {
        if (!isShowing()) return;
        if (returningFromPayment) {
            returningFromPayment = false;
            refreshWallets();
        } else if (session == Session.PENDING) {
            checkStatus(false);
        }
    }

    /** Host destruction. Normal Back / Continue only close the dialog, so it can be reopened. */
    public void dismiss() {
        destroyed = true;
        main.removeCallbacks(poll);
        closeConfirmation();
        if (dialog != null) dialog.dismiss();
        accountWorker.shutdownNow();
        walletWorker.shutdownNow();
    }

    private void closeConfirmation() {
        if (manualPrompt != null) manualPrompt.dismiss();
        manualPrompt = null;
        if (confirmation != null) confirmation.dismiss();
        confirmation = null;
    }

    private void schedulePoll() {
        main.removeCallbacks(poll);
        Dialog front = manualPrompt != null && manualPrompt.isShowing() ? manualPrompt : dialog;
        if (isShowing() && session == Session.PENDING && front.getWindow().getDecorView().hasWindowFocus()
                && action == Action.NONE && !checking) {
            main.postDelayed(poll, statusError.isEmpty() ? 1500 : 4000);
        }
    }

    // A late result from a closed dialog must never update a reopened dialog or its clipboard.
    private interface Result<T> { void complete(T value, Exception failure); }
    private <T> void submit(ExecutorService worker, Callable<T> job, Result<T> result) {
        Dialog owner = dialog;
        if (destroyed || owner == null) return;
        worker.execute(() -> {
            T value = null;
            Exception error = null;
            try { value = job.call(); } catch (Exception ex) { error = ex; }
            final T done = value;
            final Exception failed = error;
            main.post(() -> {
                if (!destroyed && dialog == owner && owner.isShowing()) result.complete(done, failed);
            });
        });
    }

    private void checkStatus(boolean alsoBalance) {
        if (!isShowing() || checking || action != Action.NONE) return;
        checking = true;
        main.removeCallbacks(poll);
        if (session == Session.UNKNOWN) render();
        submit(accountWorker, () -> new Status(host.status()), (result, failure) -> {
            checking = false;
            if (action != Action.NONE) return; // cancellation already queued behind this check
            if (failure != null) {
                String message = failure("无法读取账户状态", failure);
                boolean changed = !message.equals(statusError);
                statusError = message;
                if (changed || session == Session.UNKNOWN) render();
                schedulePoll();
                return;
            }
            Session previous = session;
            boolean changed = previous != result.session || !statusError.equals(result.error)
                    || exchanging != result.exchanging || !name.equals(result.name);
            session = result.session;
            exchanging = result.exchanging;
            if (exchanging || session != Session.PENDING) {
                if (manualPrompt != null) manualPrompt.dismiss();
            }
            statusError = result.error;
            name = result.name;
            if (previous != session) {
                actionError = "";
                if (session != Session.SIGNED_IN) {
                    wallets = null;
                    updated = null;
                    walletError = "";
                    proxyExpanded = false;
                    proxyAddress = "";
                }
                page.scrollToStart();
            }
            if (changed) render();
            if (session == Session.SIGNED_IN && (alsoBalance || previous != session)) refreshWallets();
            schedulePoll();
        });
    }

    private static final class Status {
        final Session session;
        final boolean exchanging;
        final String name, error;
        Status(JSONObject json) throws JSONException {
            boolean signed = json.getBoolean("signedIn");
            boolean pending = json.getBoolean("pending");
            session = signed ? Session.SIGNED_IN : pending ? Session.PENDING : Session.SIGNED_OUT;
            exchanging = session == Session.PENDING && json.optBoolean("exchanging", false);
            name = json.isNull("name") ? "" : json.getString("name");
            error = json.isNull("error") ? "" : json.getString("error");
        }
    }

    private static final class Wallets {
        final List<String[]> cash, bonus;
        Wallets(JSONObject json) throws JSONException {
            cash = rows(json.getJSONArray("wallets"));
            bonus = rows(json.getJSONArray("bonusWallets"));
        }
        private static List<String[]> rows(JSONArray wallets) throws JSONException {
            List<String[]> result = new ArrayList<>();
            for (int i = 0; i < wallets.length(); i++) {
                JSONObject wallet = wallets.getJSONObject(i);
                String currency = wallet.isNull("currency") ? "" : wallet.getString("currency").trim();
                String balance = wallet.isNull("balance") ? "" : wallet.getString("balance").trim();
                if (currency.isEmpty() || balance.isEmpty()) throw new JSONException("Missing wallet fields");
                result.add(new String[]{currency, balance});
            }
            return result;
        }
    }

    private void refreshWallets() {
        if (!isShowing() || session != Session.SIGNED_IN || action == Action.LOGOUT) return;
        if (refreshing) { refreshAgain = true; return; }
        refreshing = true;
        walletError = "";
        render();
        final int generation = walletGeneration;
        submit(walletWorker, () -> new Wallets(host.balance()), (value, ex) -> {
            if (walletGeneration != generation) return;
            refreshing = false;
            if (session != Session.SIGNED_IN || action == Action.LOGOUT) return;
            if (ex == null) {
                wallets = value;
                updated = new Date();
            } else {
                walletError = failure("无法更新余额", ex);
            }
            if (refreshAgain) {
                refreshAgain = false;
                refreshWallets();
            } else {
                render();
                // The host can invalidate an expired session as part of the balance request.
                if (ex != null) checkStatus(false);
            }
        });
    }

    private void accountAction(Action next) {
        if (action != Action.NONE) return;
        action = next;
        if (next == Action.LOGOUT) {
            walletGeneration++;
            refreshing = refreshAgain = false;
        }
        main.removeCallbacks(poll);
        statusError = actionError = "";
        render();
        submit(accountWorker, () -> {
            if (next == Action.LOGIN) host.beginLogin();
            else if (next == Action.CANCEL) host.cancelLogin();
            else {
                proxy.stop();
                host.logout();
            }
            return null;
        }, (unused, ex) -> {
            action = Action.NONE;
            if (ex != null) {
                String label = next == Action.LOGIN ? "无法开始登录" : next == Action.CANCEL ? "未能取消登录" : "退出登录失败";
                actionError = failure(label, ex);
                if (next == Action.LOGOUT && proxyExpanded) readProxyState();
            } else if (next == Action.LOGOUT) {
                session = Session.UNKNOWN;
                name = proxyAddress = "";
                wallets = null;
                updated = null;
                proxyExpanded = proxyRunning = false;
            }
            render();
            checkStatus(false);
        });
    }

    /** Host exceptions and status.error are user-displayable by contract; never display JSON or URLs from a response. */
    private static String failure(String context, Exception ex) {
        if (ex instanceof JSONException) return context + "：返回的数据不完整，请重试。";
        String detail = ex.getMessage();
        return detail == null || detail.trim().isEmpty() ? context + "，请重试。" : context + "：" + detail;
    }

    private void openPayment() {
        if (returningFromPayment || session != Session.SIGNED_IN) return;
        try {
            new CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, TOP_UP);
        } catch (RuntimeException tabFailure) {
            try {
                activity.startActivity(new Intent(Intent.ACTION_VIEW, TOP_UP));
            } catch (RuntimeException viewFailure) {
                walletError = "无法打开充值页面。请确认手机已安装可用的浏览器，再重试。";
                render();
                return;
            }
        }
        returningFromPayment = true;
    }

    private void openManualPrompt() {
        if (!isShowing() || session != Session.PENDING || exchanging || action != Action.NONE || manualPrompt != null) return;
        AlertDialog.Builder builder = new AlertDialog.Builder(activity, page.dark
                ? android.R.style.Theme_Material_Dialog_Alert : android.R.style.Theme_Material_Light_Dialog_Alert);
        Context context = builder.getContext();
        ScrollView scroll = new ScrollView(context);
        LinearLayout content = new LinearLayout(context);
        content.setOrientation(LinearLayout.VERTICAL);
        int pad = Math.round(24 * activity.getResources().getDisplayMetrics().density);
        content.setPadding(pad, pad / 2, pad, 0);
        scroll.addView(content);
        page.label(content, "仅当浏览器授权后无法返回时，复制地址栏里完整的本机回调网址（以 http://127.0.0.1: 开头），再粘贴到下方。此网址仅供本次登录使用，请勿分享。", 15, page.ink, false, 0);
        EditText input = new EditText(context);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setHint("粘贴完整的回调网址");
        input.setTextColor(page.ink);
        input.setHintTextColor(page.muted);
        input.setSaveEnabled(false);
        int imeFlags = EditorInfo.IME_ACTION_DONE | EditorInfo.IME_FLAG_NO_EXTRACT_UI;
        if (Build.VERSION.SDK_INT >= 26) {
            input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
            imeFlags |= EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING;
        }
        if (Build.VERSION.SDK_INT >= 29) input.setImportantForContentCapture(View.IMPORTANT_FOR_CONTENT_CAPTURE_NO);
        input.setImeOptions(imeFlags);
        content.addView(input, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        AlertDialog prompt = builder.setTitle("手动完成授权").setView(scroll)
                .setNegativeButton("返回", null).setPositiveButton("提交网址", null).create();
        manualPrompt = prompt;
        prompt.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        prompt.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        prompt.setOnDismissListener(ignored -> {
            input.getText().clear();
            if (manualPrompt == prompt) manualPrompt = null;
            schedulePoll();
        });
        prompt.show();
        prompt.getWindow().getDecorView().getViewTreeObserver().addOnWindowFocusChangeListener(focus -> schedulePoll());
        prompt.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(page.blue);
        prompt.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(page.blue);
        prompt.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            if (session != Session.PENDING || exchanging || action != Action.NONE || manualPrompt != prompt) return;
            String url = input.getText().toString().trim();
            if (url.isEmpty()) {
                input.setError("请先粘贴回调网址。");
                return;
            }
            action = Action.CALLBACK;
            actionError = "";
            v.setEnabled(false);
            submit(accountWorker, () -> {
                try { host.submitCallback(url); return true; }
                catch (Exception rejected) { return false; } // Never propagate an exception containing the URL.
            }, (accepted, failure) -> {
                action = Action.NONE;
                if (Boolean.TRUE.equals(accepted)) {
                    exchanging = true;
                    prompt.dismiss();
                } else {
                    String error = "未能接收此网址。请确认已复制本次授权的完整回调网址，再重试。";
                    if (manualPrompt == prompt && prompt.isShowing()) {
                        input.setError(error);
                        v.setEnabled(true);
                    } else actionError = error;
                }
                render();
                checkStatus(false);
            });
        });
        schedulePoll();
    }

    private void confirmLogout() {
        if (action != Action.NONE || confirmation != null) return;
        confirmation = new AlertDialog.Builder(activity, page.dark ? android.R.style.Theme_Material_Dialog_Alert
                : android.R.style.Theme_Material_Light_Dialog_Alert)
                .setTitle("退出 DeepSeek 账号？")
                .setMessage("此手机将停止使用该账号聊天，并关闭本机 API。")
                .setNegativeButton("取消", null)
                .setPositiveButton("退出登录", (ignored, which) -> accountAction(Action.LOGOUT)).create();
        confirmation.setOnDismissListener(ignored -> confirmation = null);
        confirmation.show();
        confirmation.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(page.error);
        confirmation.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(page.blue);
    }

    private void toggleProxyDetails() {
        proxyExpanded = !proxyExpanded;
        proxyError = "";
        if (proxyExpanded) readProxyState();
        else proxyAddress = "";
        render();
    }

    // status() is an in-memory snapshot. Keep just the address while the user has details open.
    private void readProxyState() {
        JSONObject info = proxy.status();
        proxyRunning = info.optBoolean("running");
        proxyAddress = proxyRunning ? info.optString("baseURL") : "";
    }

    private void toggleProxy() {
        if (action != Action.NONE || session != Session.SIGNED_IN) return;
        boolean enable = !proxyRunning;
        action = Action.PROXY;
        proxyError = "";
        render();
        submit(accountWorker, () -> {
            if (enable) {
                if (destroyed || new Status(host.status()).session != Session.SIGNED_IN) throw new IllegalStateException();
                proxy.start();
                if (destroyed) proxy.stop();
            } else proxy.stop();
            return null;
        }, (ignored, ex) -> {
            action = Action.NONE;
            readProxyState();
            if (ex != null) proxyError = enable ? "未能启用本机 API。请确认仍已登录，然后重试。" : "未能关闭本机 API，请重试。";
            render();
        });
    }

    private void copyLocal(boolean key) {
        if (!isShowing() || !proxyExpanded || session != Session.SIGNED_IN) return;
        JSONObject info = proxy.status();
        if (!info.optBoolean("running")) {
            readProxyState();
            proxyError = "本机 API 已关闭，请重新启用。";
            render();
            return;
        }
        String value = info.optString(key ? "key" : "baseURL");
        try {
            ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (value.isEmpty() || clipboard == null) throw new IllegalStateException();
            ClipData clip = ClipData.newPlainText(key ? "DeepChat 本机密钥" : "DeepChat 本机地址", value);
            if (key && Build.VERSION.SDK_INT >= 24) {
                PersistableBundle extras = new PersistableBundle();
                extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
                clip.getDescription().setExtras(extras);
            }
            clipboard.setPrimaryClip(clip);
            if (Build.VERSION.SDK_INT < 33) Toast.makeText(activity, key ? "已复制本机密钥" : "已复制地址", Toast.LENGTH_SHORT).show();
        } catch (RuntimeException ex) {
            proxyError = "未能复制到剪贴板，请重试。";
            render();
        }
    }

    private void render() {
        if (!isShowing() || page == null) return;
        boolean welcome = session != Session.SIGNED_IN;
        page.reset(welcome);
        if (welcome) page.logo();
        switch (session) {
            case SIGNED_OUT:
                page.heading("登录 DeepSeek 账号", 24);
                body("使用浏览器授权后，你可以用账户余额聊天、查看余额或充值。", 12);
                errors();
                page.button(page.body, action == Action.LOGIN ? "正在打开授权页…" : "使用 DeepSeek 账号登录", PRIMARY, 28,
                        action == Action.NONE ? () -> accountAction(Action.LOGIN) : null);
                page.button(page.body, "暂不登录，返回聊天", PLAIN, 8, dialog::dismiss);
                break;
            case PENDING:
                page.heading(exchanging ? "正在完成登录" : "等待授权", 24);
                body(exchanging ? "已收到授权回调，正在确认账户状态。" : "请在浏览器中完成 DeepSeek 账号授权。返回这里后会自动检查结果。", 12);
                errors();
                if (!exchanging) page.button(page.body, "手动完成授权", TONAL, 24,
                        action == Action.NONE ? this::openManualPrompt : null);
                page.button(page.body, action == Action.CANCEL ? "正在取消…" : "取消登录", PLAIN, exchanging ? 24 : 8,
                        action == Action.NONE ? () -> accountAction(Action.CANCEL) : null);
                break;
            case SIGNED_IN:
                renderSignedIn();
                break;
            default:
                page.heading(checking ? "正在读取账户…" : "账户状态未确认", 24);
                errors();
                if (!checking) page.button(page.body, "重新读取", TONAL, 20, () -> checkStatus(true));
                break;
        }
    }

    private void renderSignedIn() {
        page.heading(name.isEmpty() ? "DeepSeek 账号" : name, 0);
        body(name.isEmpty() ? "已登录" : "已登录 DeepSeek 账号", 4);
        errors();
        LinearLayout box = page.walletPanel();
        group(box, "钱包余额", wallets == null ? null : wallets.cash, "暂无钱包", 0);
        page.divider(box, 14);
        group(box, "赠送余额", wallets == null ? null : wallets.bonus, "暂无赠送钱包", 14);
        if (updated != null) page.label(box, "上次更新 " + DateFormat.getTimeFormat(activity).format(updated), 13, page.muted, false, 14);
        error(box, walletError);
        LinearLayout row = page.actionRow(box, 16);
        boolean available = action == Action.NONE;
        page.button(row, "前往充值", TONAL, 0, available ? this::openPayment : null);
        page.button(row, refreshing ? "正在刷新…" : "刷新余额", PLAIN, 8, available && !refreshing ? this::refreshWallets : null);
        page.navigationRow("API 使用情况", 16, available ? () -> {
            dialog.dismiss();
            openUsage.run();
        } : null);
        page.button(page.body, "继续聊天", PRIMARY, 8, dialog::dismiss);
        page.divider(page.body, 28);
        page.navigationRow(proxyExpanded ? "收起本机 API 设置" : "本机 API 设置", 8,
                available ? this::toggleProxyDetails : null);
        if (proxyExpanded) renderProxy();
        page.button(page.body, action == Action.LOGOUT ? "正在退出…" : "退出登录", DANGER, 8, available ? this::confirmLogout : null);
    }

    private void group(LinearLayout parent, String title, List<String[]> rows, String empty, int top) {
        page.label(parent, title, 16, page.ink, true, top);
        if (rows == null || rows.isEmpty()) {
            String label = rows != null ? empty : refreshing ? "正在读取…" : "尚未获取";
            page.label(parent, label, 15, page.muted, false, 6);
            return;
        }
        for (String[] wallet : rows) page.walletRow(parent, wallet[0], wallet[1]);
    }

    private void renderProxy() {
        body("仅限本机访问。持有本机密钥的应用可以使用你的账户余额。", 8);
        if (proxyRunning) {
            page.label(page.body, "连接地址", 15, page.ink, true, 16);
            body(proxyAddress, 4);
            page.label(page.body, "本机密钥  ••••••••", 15, page.ink, true, 12);
            LinearLayout row = page.actionRow(page.body, 12);
            boolean enabled = action == Action.NONE;
            page.button(row, "复制地址", TONAL, 0, enabled ? () -> copyLocal(false) : null);
            page.button(row, "复制本机密钥", TONAL, 8, enabled ? () -> copyLocal(true) : null);
        }
        error(page.body, proxyError);
        page.button(page.body, action == Action.PROXY ? "正在处理…" : proxyRunning ? "关闭本机 API" : "启用本机 API",
                proxyRunning ? PLAIN : TONAL, 12, action == Action.NONE ? this::toggleProxy : null);
    }

    private void body(String value, int top) { page.label(page.body, value, 16, page.muted, false, top); }
    private void errors() {
        error(page.body, statusError);
        error(page.body, actionError);
    }
    private void error(LinearLayout parent, String message) {
        if (message.isEmpty()) return;
        TextView text = page.label(parent, message, 15, page.error, false, 12);
        text.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    }
}
