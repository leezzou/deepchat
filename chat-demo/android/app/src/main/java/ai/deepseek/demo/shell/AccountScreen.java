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
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;
import android.text.InputType;
import android.text.format.DateFormat;
import android.view.inputmethod.EditorInfo;
import android.view.View;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.browser.customtabs.CustomTabsIntent;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

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
    private final ExecutorService photoWorker = Executors.newSingleThreadExecutor();
    private int walletGeneration;
    private String avatar = "", revision = "", requestedPhoto = "";
    private Bitmap photo;
    private int photoGeneration;
    private final Runnable poll = () -> checkStatus(false);
    private AccountWindow dialog, proxyDialog;
    private AccountPage proxyPage;
    // The exact wallet view (including focus and scroll) remains owned by this visit to usage.
    private boolean underUsage, walletNeedsRender;
    private AccountConfirmSheet confirmation;
    private AlertDialog manualPrompt;
    private boolean exchanging;
    private AccountPage page;
    private volatile boolean destroyed;
    private boolean checking, refreshing, refreshAgain, returningFromPayment;
    private boolean proxyRunning;
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

    public boolean isShowing() { return dialog != null && dialog.isActive() && !underUsage; }

    void updateTheme() {
        if (page != null && page.dark != theme.isAppDark()) {
            page.updateTheme();
            if (proxyPage != null) { proxyPage.updateTheme(); renderProxy(); }
            render();
        }
    }

    public void show(boolean fromUsage, boolean confirmLogout) {
        if (destroyed || activity.isFinishing() || activity.isDestroyed() || !SecurityPlugin.isUnlocked()) return;
        if (confirmLogout) {
            if (host.signedIn()) confirmLogout();
            return;
        }
        if (isShowing()) return;
        if (fromUsage && underUsage && dialog != null && sameVisit()) {
            underUsage = false;
            dialog.reveal(true);
            if (walletNeedsRender) render();
            checkStatus(false);
            return;
        }
        if (dialog != null) dialog.dismissNow();
        closeConfirmation();
        closeProxy();
        underUsage = walletNeedsRender = false;
        clearIdentity();
        session = Session.UNKNOWN;
        exchanging = false;
        action = Action.NONE;
        name = statusError = actionError = walletError = proxyError = "";
        checking = refreshing = refreshAgain = returningFromPayment = proxyRunning = false;
        proxyAddress = "";
        wallets = null;
        updated = null;
        AccountWindow opened = new AccountWindow(activity, theme.isAppDark(), this::schedulePoll);
        dialog = opened;
        page = new AccountPage(activity, opened.getWindow(), theme, "DeepSeek 账号", opened::dismiss, this::render);
        opened.setContentView(page);
        opened.setTitle("DeepSeek 账号");
        opened.setOnDismissListener(ignored -> {
            if (dialog != opened) return;
            main.removeCallbacks(poll);
            closeConfirmation();
            closeProxy();
            dialog = null;
            page = null;
            clearIdentity();
            wallets = null;
            underUsage = false;
        });
        // The host already owns the current in-memory session. Resolve the layout before the
        // first frame so opening a known account never flashes a different welcome page.
        try {
            Status initial = new Status(host.status());
            session = initial.session;
            updateIdentity(initial);
            statusError = initial.error;
            exchanging = initial.exchanging;
        } catch (Exception failure) {
            statusError = failure("无法读取账户状态", failure);
        }
        opened.reveal(fromUsage);
        if (session == Session.SIGNED_IN) refreshWallets();
        else {
            render();
            schedulePoll();
        }
    }

    private boolean sameVisit() {
        try {
            Status current = new Status(host.status());
            return current.session == session && current.revision.equals(revision);
        } catch (Exception unavailable) {
            return false;
        }
    }

    void accountChanged() {
        if (destroyed) return;
        if (underUsage && !sameVisit()) {
            // Never restore balances after the wallet's grant was invalidated.
            underUsage = false;
            dialog.dismissNow();
        } else if (isShowing()) checkStatus(false);
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

    /** Release private dialogs on lock without tearing down the account service. */
    public void hideForLock() {
        main.removeCallbacks(poll);
        closeConfirmation();
        closeProxy();
        if (dialog != null) dialog.dismissNow();
    }

    /** Host destruction. Normal Back / Continue only close the dialog, so it can be reopened. */
    public void dismiss() {
        destroyed = true;
        main.removeCallbacks(poll);
        closeConfirmation();
        closeProxy();
        if (dialog != null) dialog.dismissNow();
        accountWorker.shutdownNow();
        walletWorker.shutdownNow();
        photoWorker.shutdownNow();
        clearIdentity();
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
        AccountWindow owner = dialog;
        if (destroyed || owner == null) return;
        worker.execute(() -> {
            T value = null;
            Exception error = null;
            try { value = job.call(); } catch (Exception ex) { error = ex; }
            final T done = value;
            final Exception failed = error;
            main.post(() -> {
                if (!destroyed && dialog == owner && (isShowing() || underUsage)) result.complete(done, failed);
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
            boolean accountSwitched = session == Session.SIGNED_IN && !revision.equals(result.revision);
            boolean changed = previous != result.session || !statusError.equals(result.error)
                    || exchanging != result.exchanging || !name.equals(result.name)
                    || !avatar.equals(result.avatar) || accountSwitched;
            session = result.session;
            exchanging = result.exchanging;
            if (exchanging || session != Session.PENDING) {
                if (manualPrompt != null) manualPrompt.dismiss();
            }
            statusError = result.error;
            updateIdentity(result);
            if (previous != session || accountSwitched) {
                actionError = "";
                if (session != Session.SIGNED_IN || accountSwitched) {
                    walletGeneration++;
                    refreshing = refreshAgain = false;
                    wallets = null;
                    updated = null;
                    walletError = "";
                    closeProxy();
                }
                page.scrollToStart();
            }
            if (changed) render();
            if (session == Session.SIGNED_IN && (alsoBalance || previous != session || accountSwitched)) refreshWallets();
            schedulePoll();
        });
    }

    private void clearIdentity() {
        photoGeneration++;
        name = avatar = revision = requestedPhoto = "";
        photo = null;
    }

    private void updateIdentity(Status status) {
        if (!avatar.equals(status.avatar) || !revision.equals(status.revision)) clearIdentity();
        name = status.name;
        avatar = status.avatar;
        revision = status.revision;
    }

    private void loadPhoto() {
        if (avatar.isEmpty() || avatar.equals(requestedPhoto)) return;
        String url = avatar;
        requestedPhoto = url;
        int generation = photoGeneration;
        submit(photoWorker, () -> AccountAvatar.load(url), (value, ex) -> {
            if (photoGeneration == generation && session == Session.SIGNED_IN && page != null) {
                photo = value;
                page.setPhoto(value);
            }
        });
    }

    private static final class Status {
        final Session session;
        final boolean exchanging;
        final String name, avatar, revision, error;
        Status(JSONObject json) throws JSONException {
            boolean signed = json.getBoolean("signedIn");
            boolean pending = json.getBoolean("pending");
            session = signed ? Session.SIGNED_IN : pending ? Session.PENDING : Session.SIGNED_OUT;
            exchanging = session == Session.PENDING && json.optBoolean("exchanging", false);
            name = signed && !json.isNull("name") ? json.getString("name") : "";
            avatar = signed ? json.optString("avatar", "") : "";
            revision = signed ? json.optString("revision", "") : "";
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
                if (next == Action.LOGOUT && proxyDialog != null) readProxyState();
            } else if (next == Action.LOGOUT) {
                session = Session.SIGNED_OUT;
                page.scrollToStart();
                clearIdentity();
                proxyAddress = "";
                wallets = null;
                updated = null;
                closeProxy();
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
        page.label(content, "从浏览器复制以 http://127.0.0.1: 开头的完整回调网址。仅供本次登录，请勿分享。", 15, page.ink, false, 0);
        EditText input = new EditText(context);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setHint("粘贴完整的回调网址");
        input.setTextColor(page.ink);
        input.setHintTextColor(page.muted);
        input.setSaveEnabled(false);
        input.setMinHeight(Math.round(48 * activity.getResources().getDisplayMetrics().density));
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
        prompt.getWindow().setWindowAnimations(android.R.style.Animation_Dialog);
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
        prompt.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener(v -> {
            WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(input);
            if (insets != null && insets.isVisible(WindowInsetsCompat.Type.ime())) {
                WindowCompat.getInsetsController(prompt.getWindow(), input).hide(WindowInsetsCompat.Type.ime());
            } else prompt.dismiss();
        });
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

    private boolean settingsLogoutPending;

    private void logoutFromSettings() {
        if (settingsLogoutPending || destroyed || !SecurityPlugin.isUnlocked() || !host.signedIn()) return;
        settingsLogoutPending = true;
        accountWorker.execute(() -> {
            String error = null;
            try { proxy.stop(); host.logout(); }
            catch (Exception failure) { error = failure("退出登录失败", failure); }
            final String message = error;
            main.post(() -> {
                settingsLogoutPending = false;
                if (!destroyed && message != null && SecurityPlugin.isUnlocked())
                    Toast.makeText(activity, message, Toast.LENGTH_LONG).show();
            });
        });
    }

    private void confirmLogout() {
        if (settingsLogoutPending || confirmation != null || (isShowing() && action != Action.NONE)) return;
        boolean fromSettings = !isShowing();
        AccountConfirmSheet prompt = new AccountConfirmSheet(activity, theme.isAppDark(), () -> {
            if (destroyed || !SecurityPlugin.isUnlocked() || !host.signedIn()) return;
            if (fromSettings) logoutFromSettings();
            else accountAction(Action.LOGOUT);
        });
        confirmation = prompt;
        prompt.setOnDismissListener(ignored -> { if (confirmation == prompt) confirmation = null; });
        prompt.show();
    }

    private void openProxy() {
        if (!isShowing() || proxyDialog != null || session != Session.SIGNED_IN) return;
        AccountWindow child = new AccountWindow(activity, theme.isAppDark(), null);
        proxyDialog = child;
        proxyPage = new AccountPage(activity, child.getWindow(), theme, "本机 API 设置", child::dismiss, this::renderProxy);
        child.setTitle("本机 API 设置");
        child.setContentView(proxyPage);
        child.setOnDismissListener(ignored -> {
            if (proxyDialog == child) clearProxyPage();
        });
        readProxyState();
        child.reveal(false);
        renderProxy();
    }

    private void clearProxyPage() {
        proxyDialog = null;
        proxyPage = null;
        proxyRunning = false;
        proxyAddress = proxyError = "";
    }

    private void closeProxy() {
        if (proxyDialog != null) proxyDialog.dismissNow();
        clearProxyPage();
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
        renderProxy();
        submit(accountWorker, () -> {
            if (enable) {
                if (destroyed || new Status(host.status()).session != Session.SIGNED_IN) throw new IllegalStateException();
                proxy.start();
                if (destroyed) proxy.stop();
            } else proxy.stop();
            return null;
        }, (ignored, ex) -> {
            action = Action.NONE;
            if (proxyDialog != null && proxyDialog.isActive()) readProxyState();
            if (ex != null && proxyDialog != null) proxyError = enable ? "未能启用本机 API。请确认仍已登录，然后重试。" : "未能关闭本机 API，请重试。";
            renderProxy();
        });
    }

    private void copyLocal(boolean key) {
        if (!isShowing() || proxyDialog == null || !proxyDialog.isActive() || session != Session.SIGNED_IN) return;
        JSONObject info = proxy.status();
        if (!info.optBoolean("running")) {
            readProxyState();
            proxyError = "本机 API 已关闭，请重新启用。";
            renderProxy();
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
            renderProxy();
        }
    }

    private void render() {
        if (underUsage) { walletNeedsRender = true; return; }
        if (!isShowing() || page == null) return;
        walletNeedsRender = false;
        page.reset();
        if (session == Session.SIGNED_IN) {
            renderSignedIn();
            return;
        }
        LinearLayout panel = page.panel(0, true);
        if (session == Session.SIGNED_OUT) {
            page.identity(panel, "未登录", "登录后可查看余额或充值。", "D", null);
            errors();
            page.button(panel, action == Action.LOGIN ? "正在打开浏览器…" : "登录 DeepSeek", PRIMARY, 16,
                    action == Action.NONE ? () -> accountAction(Action.LOGIN) : null);
            usageEntry(page.panel(24, false));
        } else if (session == Session.PENDING) {
            page.identity(panel, exchanging ? "正在完成登录" : "等待浏览器授权",
                    exchanging ? "已收到授权，正在确认账号。" : "请在浏览器中完成登录，再返回这里。", "D", null);
            if (!exchanging) {
                page.label(panel, "授权后无法返回？可复制回调网址手动完成。", 14, page.muted, false, 16);
                page.button(panel, "手动完成授权", TONAL, 8, action == Action.NONE ? this::openManualPrompt : null);
            }
            errors();
            page.button(page.body, action == Action.CANCEL ? "正在取消…" : "取消登录", PLAIN, 8,
                    action == Action.NONE ? () -> accountAction(Action.CANCEL) : null);
        } else {
            page.identity(panel, checking ? "正在读取账号…" : "账号状态未确认",
                    checking ? "正在检查本机登录状态。" : "重新读取可检查当前登录状态。", "D", null);
            errors();
            if (!checking) page.button(panel, "重新读取", TONAL, 16, () -> checkStatus(true));
        }
    }

    private void renderSignedIn() {
        String initial = name.isEmpty() ? "D" : name.substring(0, name.offsetByCodePoints(0, 1));
        page.identity(page.panel(0, true), name.isEmpty() ? "已登录" : name, "DeepSeek 个人账号", initial, photo);
        loadPhoto();
        errors();
        page.section("账户余额", 24);
        LinearLayout box = page.panel(8, true);
        group(box, "钱包余额", wallets == null ? null : wallets.cash, "暂无钱包");
        page.divider(box, 0);
        group(box, "赠送余额", wallets == null ? null : wallets.bonus, "暂无赠送余额");
        if (updated != null) {
            String time = DateFormat.getTimeFormat(activity).format(updated);
            page.label(box, (walletError.isEmpty() ? "更新于 " : "上次更新 ") + time, 13, page.muted, false, 8);
        }
        error(box, walletError);
        LinearLayout row = page.actionRow(box, 12);
        boolean available = action == Action.NONE;
        page.button(row, "前往充值", PRIMARY, 0, available ? this::openPayment : null);
        page.button(row, refreshing ? "正在刷新…" : "刷新余额", TONAL, 8,
                available && !refreshing ? this::refreshWallets : null);
        page.section("用量与连接", 24);
        LinearLayout links = page.panel(8, false);
        usageEntry(links);
        page.divider(links, 0);
        page.navigationRow(links, "本机 API 设置", available ? this::openProxy : null);
        page.button(page.body, action == Action.LOGOUT ? "正在退出…" : "退出登录", DANGER, 16,
                available ? this::confirmLogout : null);
    }

    private void usageEntry(LinearLayout parent) {
        page.navigationRow(parent, "模型用量", action == Action.NONE ? () -> {
            if (!isShowing()) return;
            underUsage = true;
            openUsage.run();
            dialog.hideForUsage();
        } : null);
    }

    private void group(LinearLayout parent, String title, List<String[]> rows, String empty) {
        if (rows == null || rows.isEmpty()) {
            page.balanceLine(parent, title, rows != null ? empty : refreshing ? "读取中…" : "未获取", false);
            return;
        }
        boolean first = true;
        for (String[] wallet : rows) {
            page.walletRow(parent, first ? title : "", wallet[0], wallet[1]);
            first = false;
        }
    }

    private void renderProxy() {
        AccountPage page = proxyPage;
        if (page == null || !proxyDialog.isActive()) return;
        page.reset();
        LinearLayout control = page.panel(0, true);
        page.label(control, proxyRunning ? "本机 API 已启用" : "本机 API 已关闭", 18, page.ink, true, 0);
        page.label(control, "仅限此手机访问。持有密钥的应用可使用你的账户余额。", 14, page.muted, false, 6);
        page.button(control, action == Action.PROXY ? "正在处理…" : proxyRunning ? "关闭本机 API" : "启用本机 API",
                proxyRunning ? TONAL : PRIMARY, 16, action == Action.NONE ? this::toggleProxy : null);
        error(page, control, proxyError);
        if (!proxyRunning) return;
        page.section("连接信息", 24);
        LinearLayout details = page.panel(8, true);
        page.label(details, "连接地址", 14, page.muted, false, 0);
        page.label(details, proxyAddress, 16, page.ink, true, 4);
        page.label(details, "本机密钥  ••••••••", 14, page.muted, false, 12);
        LinearLayout row = page.actionRow(details, 12);
        boolean enabled = action == Action.NONE;
        page.button(row, "复制地址", TONAL, 0, enabled ? () -> copyLocal(false) : null);
        page.button(row, "复制本机密钥", TONAL, 8, enabled ? () -> copyLocal(true) : null);
    }

    private void errors() {
        error(page.body, statusError);
        error(page.body, actionError);
    }
    private void error(LinearLayout parent, String message) {
        error(page, parent, message);
    }
    private void error(AccountPage page, LinearLayout parent, String message) {
        if (message.isEmpty()) return;
        TextView text = page.label(parent, message, 15, page.error, false, 12);
        text.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    }
}
