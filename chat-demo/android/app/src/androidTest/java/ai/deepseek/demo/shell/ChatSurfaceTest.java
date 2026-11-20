package ai.deepseek.demo.shell;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeFalse;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import android.widget.ScrollView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.runner.intent.IntentStubberRegistry;
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry;
import androidx.test.runner.lifecycle.Stage;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.Callable;
import java.util.concurrent.FutureTask;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/** Run this class in its own instrumentation invocation. OfflineHttps installs a process-wide URL factory. */
@RunWith(AndroidJUnit4.class)
@androidx.test.filters.SdkSuppress(minSdkVersion = 24)
public class ChatSurfaceTest {
    private static final long TIMEOUT_MS = 15000;
    private static final String MESSAGES = "https://api.deepseek.com/anthropic/v1/messages";
    private static final String SEND = "button[aria-label=Send],button[aria-label=发送]";
    private static final String STOP = "button[aria-label=Stop],button[aria-label=停止生成]";
    private static final String ANSWER = "[data-message-id] .ds-assistant-message-main-content";

    private final OfflineHttps net = new OfflineHttps();
    private final String grant = "instrumentation-only-" + UUID.randomUUID();
    private ActivityScenario<MainActivity> scenario;
    private MainActivity activity;
    private AccountScreen screen;

    @BeforeClass public static void installOfflineNetwork() throws Exception { OfflineHttps.install(); }

    @Before public void launchSignedOutActivity() throws Exception {
        net.activate();
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SharedPreferences prefs = context.getSharedPreferences("dsh-account-v1", Context.MODE_PRIVATE);
        // Guard before MainActivity even constructs its host. Never read/decrypt a stored credential.
        assumeFalse("Use a signed-out test installation", prefs.contains("ciphertext") || prefs.contains("iv"));
        scenario = ActivityScenario.launch(MainActivity.class);
        scenario.onActivity(current -> activity = current);
        DshAccountHost host = (DshAccountHost) field(MainActivity.class, "account").get(activity);
        org.junit.Assume.assumeTrue("Requires WebMessageListener", host != null);
        assumeFalse("Existing account", host.signedIn());
        screen = (AccountScreen) field(MainActivity.class, "screen").get(activity);
        dom("packaged composer", "location.origin === 'https://localhost' && !!document.querySelector('main textarea')");
        assertFalse("The optional account integration must not gate startup", onUi(screen::isShowing));
        assertTrue("Existing updater, system bars and account bridge are available", js("!!window.AndroidUpdater && !!window.AndroidSystemBars && !!window.DshNative"));
        // Never send test content via a user's API profile. The JS expression returns only a boolean.
        assumeFalse("Use a clean test installation", js("localStorage.getItem('chat-demo:api-key') !== null || "
                + "(localStorage.getItem('chat-demo:api-profiles') || '[]') !== '[]' || localStorage.getItem('chat-demo:chat-source') === 'api'"));
        synchronized (host) {
            assumeFalse("Account changed during startup", host.signedIn() || host.status().getBoolean("pending"));
            field(DshAccountHost.class, "grant").set(host, grant);
        }
        // Deliver the same signed-in status notification as a normal account state change.
        DshWebBridge bridge = (DshWebBridge) field(MainActivity.class, "accountBridge").get(activity);
        onUi(() -> { bridge.changed(); return null; });
    }

    @After public void closeActivity() {
        try {
            // The synthetic grant lives only in this activity's host and has never been persisted.
            if (scenario != null) scenario.close();
        } finally { net.finish(); }
    }

    @Test public void composerRendersReplyWhileMessagesStreamIsStillOpen() throws Exception {
        // Start a fresh conversation if the previous test run left its conversation selected.
        if (js("!!document.querySelector('[data-message-id]')")) {
            dom("new chat button", "(()=>{const b=[...document.querySelectorAll('button')].find(el=>el.getClientRects().length && "
                + "['New chat','开启新对话'].includes(el.getAttribute('aria-label') || el.innerText.trim()));"
                + "if(!b)return false;b.click();return true})()");
            dom("empty conversation", "!document.querySelector('[data-message-id]') && !!document.querySelector('main textarea')");
        }
        assumeFalse("Leave an existing draft untouched", js("!!document.querySelector('main textarea').value || "
            + "!!document.querySelector('main button[aria-label=Delete],main button[aria-label=删除]')"));
        assertTrue(js("(window.dispatchEvent(new Event('deepchat:open-api-usage')),true)"));
        dom("initial usage snapshot", "!!document.querySelector('[data-usage-loaded]')");
        assertTrue(js("(window.__beforeUsage=Number(document.querySelector('[data-usage-total]')?.dataset.usageTotal ?? 0), true)"));
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
        dom("return to composer", "!document.querySelector('[data-api-usage]')");
        String id = UUID.randomUUID().toString();
        String prompt = "Offline question " + id;
        String first = "Offline answer " + id;
        String last = " complete.";
        // React tracks the instance's value setter. Use the DOM setter and bubble a normal input event.
        assertTrue("enter text", js("(()=>{const t=document.querySelector('main textarea');t.focus();"
            + "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t," + JSONObject.quote(prompt) + ");"
            + "t.dispatchEvent(new Event('input',{bubbles:true}));return true})()"));
        try (PipedInputStream body = new PipedInputStream(4096); PipedOutputStream upstream = new PipedOutputStream(body)) {
            OfflineHttps.Exchange exchange = net.expect("POST", MESSAGES, 200, "text/event-stream", body);
            clickDom("enabled send button", SEND);
            OfflineHttps.Connection request = exchange.await();
            assertEquals(grant, request.getRequestProperty("x-dsh-auth-token"));
            JSONObject sent = request.requestJson();
            assertTrue(sent.getBoolean("stream"));
            JSONArray messages = sent.getJSONArray("messages");
            JSONObject question = messages.getJSONObject(messages.length() - 1);
            assertEquals("user", question.getString("role"));
            assertEquals(prompt, question.getString("content"));
            event(upstream, "{\"type\":\"message_start\",\"message\":{\"role\":\"assistant\",\"usage\":{\"input_tokens\":1200,\"cache_read_input_tokens\":512,\"output_tokens\":0}}}");
            event(upstream, "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}");
            delta(upstream, first);
            dom("first answer fragment before the second fragment or EOF", answerIs(first) + " && !!document.querySelector('" + STOP + "')");
            delta(upstream, last);
            event(upstream, "{\"type\":\"content_block_stop\",\"index\":0}");
            event(upstream, "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2059}}");
            event(upstream, "{\"type\":\"message_stop\"}");
            upstream.close();
            dom("completed assistant reply", answerIs(first + last) + " && !document.querySelector('" + STOP + "')");
        }
        assertTrue(js("(window.dispatchEvent(new Event('deepchat:open-api-usage')),true)"));
        dom("usage includes the streamed input, cache and final output", "Number(document.querySelector('[data-usage-total]')?.dataset.usageTotal) === window.__beforeUsage + 3771");
        clickDom("30-day activity", "[data-usage-days='30']");
        dom("30-day range is selected", "document.querySelector('[data-usage-days=\\\"30\\\"]')?.getAttribute('aria-pressed')==='true'");
    }

    @Test public void largeAttachmentReachesServerAndChatByReference() throws Exception {
        final int mib = 1024 * 1024, pages = 41;
        final String fileId = "file-api-test-large";
        OfflineHttps.Exchange upload = net.json("POST", "https://api.deepseek.com/anthropic/v1/files", 200,
            new JSONObject().put("id", fileId).toString());
        assertTrue(js("(()=>{const input=document.querySelector('input[type=file][multiple]');if(!input)return false;"
            + "const piece=new Uint8Array(1048576).fill(65);const dt=new DataTransfer();"
            + "dt.items.add(new File(Array(41).fill(piece),'large.pdf',{type:'application/pdf'}));"
            + "input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()"));
        OfflineHttps.Connection received = upload.await();
        String boundary = received.getRequestProperty("Content-Type").split("boundary=", 2)[1];
        java.security.MessageDigest expected = java.security.MessageDigest.getInstance("SHA-256");
        String prefix = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nrich_layout_recognition\r\n--" + boundary
            + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"large.pdf\"\r\nContent-Type: application/pdf\r\n\r\n";
        expected.update(prefix.getBytes(StandardCharsets.UTF_8));
        byte[] piece = new byte[mib];
        java.util.Arrays.fill(piece, (byte)'A');
        for (int i = 0; i < pages; i++) expected.update(piece);
        expected.update(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        assertArrayEquals("Multipart length, order and file contents survive the WebView/native boundary", expected.digest(), received.uploadedDigest());
        final String prompt = "请概括这份文档";
        assertTrue(js("(()=>{const t=document.querySelector('main textarea');"
            + "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t," + JSONObject.quote(prompt) + ");"
            + "t.dispatchEvent(new Event('input',{bubbles:true}));return true})()"));
        OfflineHttps.Exchange chat = net.json("POST", MESSAGES, 400, "{\"error\":{\"message\":\"document text exceeds 8 MiB: fixture-private\"}}");
        clickDom("send uploaded file", SEND);
        OfflineHttps.Connection request = chat.await();
        assertEquals("files-api-2025-04-14", request.getRequestProperty("anthropic-beta"));
        JSONArray messages = request.requestJson().getJSONArray("messages");
        JSONObject question = messages.getJSONObject(messages.length() - 1);
        assertEquals("user", question.getString("role"));
        JSONArray blocks = question.getJSONArray("content");
        assertEquals(2, blocks.length());
        assertEquals("document", blocks.getJSONObject(0).getString("type"));
        assertEquals(fileId, blocks.getJSONObject(0).getJSONObject("source").getString("file_id"));
        assertEquals("text", blocks.getJSONObject(1).getString("type"));
        assertEquals(prompt, blocks.getJSONObject(1).getString("text"));
        dom("actionable parsed-text limit", "document.body.innerText.includes('8 MiB') && !document.body.innerText.includes('fixture-private')");
    }

    @Test public void phoneAccountShowsRoundedBalancesAndOpensUsageReport() throws Exception {
        org.junit.Assume.assumeTrue("Exercise the phone settings entry", js("innerWidth < 768"));
        OfflineHttps.Exchange wallet = net.json("GET", "https://platform.deepseek.com/api/v0/users/get_user_summary", 200,
            "{\"code\":0,\"data\":{\"biz_code\":0,\"biz_data\":{\"normal_wallets\":[{\"currency\":\"USD\",\"balance\":\"12.3400\"}],"
                + "\"bonus_wallets\":[{\"currency\":\"CNY\",\"balance\":\"0.005\"}]}}}");
        clickDom("open mobile drawer", "main button[aria-label^='打开边栏'],main button[aria-label^='Open sidebar']");
        clickDom("open settings", "button[aria-label='设置'],button[aria-label='Settings']");
        clickDom("open native account", "button[data-dsh-account]");
        assertEquals(grant, wallet.await().getRequestProperty("x-dsh-auth-token"));
        for (String label : new String[]{"钱包余额", "USD", "12.34", "赠送余额", "CNY", "0.01"}) nativeLabel(label, false);

        Field pageField = field(AccountScreen.class, "page");
        boolean initiallyDark = onUi(() -> ((AccountPage) pageField.get(screen)).dark);
        assertTrue(js("(window.AndroidSystemBars.setDark(" + !initiallyDark + "),true)"));
        await("wallet follows the app-selected theme", () -> onUi(() -> ((AccountPage) pageField.get(screen)).dark != initiallyDark));
        assertTrue(js("(window.AndroidSystemBars.setDark(" + initiallyDark + "),true)"));
        await("restore initial wallet theme", () -> onUi(() -> ((AccountPage) pageField.get(screen)).dark == initiallyDark));

        BlockingQueue<Intent> launches = new LinkedBlockingQueue<>();
        IntentStubberRegistry.load(intent -> {
            // Let Capacitor's in-app browser controller launch the actual Custom Tab intent.
            if (intent.getComponent() != null && intent.getComponent().getClassName().equals(
                    "com.capacitorjs.plugins.browser.BrowserControllerActivity")) return null;
            launches.add(new Intent(intent));
            return new Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null);
        });
        // Enough currencies to require actual scrolling, including on a tall phone.
        JSONArray balances = new JSONArray();
        for (String unit : "USD CNY EUR GBP HKD JPY AUD NZD CAD CHF SGD SEK NOK AED MXN ZAR INR BRL PLN KRW".split(" ")) {
            balances.put(new JSONObject().put("currency", unit).put("balance", "13.3400"));
        }
        OfflineHttps.Exchange refreshed = net.json("GET", "https://platform.deepseek.com/api/v0/users/get_user_summary", 200,
            "{\"code\":0,\"data\":{\"biz_code\":0,\"biz_data\":{\"normal_wallets\":" + balances + ",\"bonus_wallets\":[]}}}");
        try {
            nativeLabel("前往充值", true);
            Intent payment = launches.poll(TIMEOUT_MS, TimeUnit.MILLISECONDS);
            assertNotNull("top-up intent", payment);
            assertEquals(Intent.ACTION_VIEW, payment.getAction());
            assertEquals("https://platform.deepseek.com/top_up", payment.getDataString());
            assertTrue("single top-up intent", launches.isEmpty());
            onUi(() -> { screen.onResume(); return null; });
            assertEquals(grant, refreshed.await().getRequestProperty("x-dsh-auth-token"));
            nativeLabel("13.34", false);
            AccountPage walletPage = onUi(() -> (AccountPage) pageField.get(screen));
            ScrollView walletScroll = (ScrollView) field(AccountPage.class, "scroll").get(walletPage);
            int walletY = onUi(() -> { walletScroll.scrollTo(0, walletScroll.getHeight()); return walletScroll.getScrollY(); });
            assertTrue("fixture scrolled the wallet", walletY > 0);
            Field childField = field(AccountScreen.class, "proxyDialog");
            for (boolean header : new boolean[]{true, false}) {
                nativeLabel("本机 API 设置", true);
                await("child owns input", () -> onUi(() -> {
                    AccountWindow child = (AccountWindow) childField.get(screen);
                    return child != null && child.getWindow().getDecorView().hasWindowFocus();
                }));
                if (header) onUi(() -> {
                    AccountPage childPage = (AccountPage) field(AccountScreen.class, "proxyPage").get(screen);
                    ((View) field(AccountPage.class, "back").get(childPage)).performClick();
                    return null;
                });
                else InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
                await("only child was popped", () -> onUi(() -> childField.get(screen) == null && screen.isShowing()));
                assertEquals(walletY, (int) onUi(walletScroll::getScrollY));
            }
            nativeLabel("模型用量", true);
            dom("the in-app usage report opens from the native wallet", "!!document.querySelector('[data-api-usage]')");
            assertFalse("wallet yields to the usage report", onUi(screen::isShowing));
            assertTrue("opening usage stays in the app", launches.isEmpty());
            await("usage owns input after wallet exit", () -> onUi(() -> activity.getWindow().getDecorView().hasWindowFocus()));
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
            nativeLabel("模型用量", false);
            nativeLabel("13.34", false);
            assertSame("same wallet view on return", walletPage, onUi(() -> pageField.get(screen)));
            assertEquals("wallet scroll is retained", walletY, (int) onUi(walletScroll::getScrollY));
            dom("system back restores the account", "!document.querySelector('[data-api-usage]')");
            nativeLabel("模型用量", true);
            clickDom("open the official platform report", "[data-api-usage-official]");
            Intent report = launches.poll(TIMEOUT_MS, TimeUnit.MILLISECONDS);
            assertNotNull("DeepSeek usage dashboard intent", report);
            assertEquals("https://platform.deepseek.com/usage", report.getDataString());
            // A real Custom Tab pauses the controller, which finishes on its second resume.
            // The stub intercepts that launch, so finish the controller to simulate returning.
            await("intercepted Custom Tab controller", () -> onUi(() -> {
                for (Activity resumed : ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)) {
                    if (resumed instanceof com.capacitorjs.plugins.browser.BrowserControllerActivity) {
                        resumed.finish();
                        return true;
                    }
                }
                return false;
            }));
            await("usage regains input after browser return", () -> onUi(() -> activity.getWindow().getDecorView().hasWindowFocus()));
            clickDom("usage header returns to wallet", "[data-usage-source='account'] header button");
            await("wallet regains input", () -> onUi(walletPage::hasWindowFocus));
            dom("usage closed", "!document.querySelector('[data-api-usage]')");
            assertEquals(walletY, (int) onUi(walletScroll::getScrollY));
            nativeLabel("退出登录", true);
            Field confirmField = field(AccountScreen.class, "confirmation");
            await("logout confirmation owns input", () -> onUi(() -> {
                android.app.Dialog confirm = (android.app.Dialog) confirmField.get(screen);
                return confirm != null && confirm.getWindow().getDecorView().hasWindowFocus();
            }));
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
            await("Back cancels only logout", () -> onUi(() -> confirmField.get(screen) == null && walletPage.hasWindowFocus()));
            onUi(() -> { ((View) field(AccountPage.class, "back").get(walletPage)).performClick(); return null; });
            await("wallet header returns to settings", () -> onUi(() -> !screen.isShowing() && activity.getWindow().getDecorView().hasWindowFocus()));
            dom("settings still on its root page", "!!document.querySelector('[data-settings-route=root][data-route-position=front]')");
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
            dom("settings closed with drawer open", "!document.querySelector('[data-settings-shell]') && "
                    + "!!document.querySelector(\"[aria-hidden='false'] button[aria-label='设置'],[aria-hidden='false'] button[aria-label='Settings']\")");
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
            dom("drawer yields to chat", "!!document.querySelector('main textarea') && "
                    + "!document.querySelector(\"[aria-hidden='false'] button[aria-label='设置'],[aria-hidden='false'] button[aria-label='Settings']\")");
        } finally { IntentStubberRegistry.reset(); }
    }

    private static Field field(Class<?> owner, String name) throws ReflectiveOperationException {
        Field result = owner.getDeclaredField(name);
        result.setAccessible(true);
        return result;
    }

    private static <T> T onUi(Callable<T> action) throws Exception {
        FutureTask<T> task = new FutureTask<>(action);
        new Handler(Looper.getMainLooper()).post(task);
        return task.get(TIMEOUT_MS, TimeUnit.MILLISECONDS);
    }

    private boolean js(String expression) throws Exception {
        BlockingQueue<String> results = new LinkedBlockingQueue<>();
        onUi(() -> {
            activity.getBridge().getWebView().evaluateJavascript("Boolean(" + expression + ")", results::offer);
            return null;
        });
        String result = results.poll(TIMEOUT_MS, TimeUnit.MILLISECONDS);
        assertNotNull("WebView evaluation timed out", result);
        assertTrue("Invalid JavaScript result: " + result, "true".equals(result) || "false".equals(result));
        return "true".equals(result);
    }

    private static void await(String description, Callable<Boolean> check) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + TIMEOUT_MS;
        do {
            if (check.call()) return;
            SystemClock.sleep(75);
        } while (SystemClock.elapsedRealtime() < deadline);
        fail("Timed out waiting for " + description);
    }

    private void dom(String description, String condition) throws Exception { await(description, () -> js(condition)); }

    private void clickDom(String description, String selector) throws Exception {
        dom(description, "(()=>{const b=[...document.querySelectorAll(" + JSONObject.quote(selector) + ")].find(el=>el.getClientRects().length);"
            + "if(!b || b.disabled || b.getAttribute('aria-disabled')==='true')return false;"
            + "b.click();return true})()");
    }

    private static String answerIs(String text) {
        return "[...document.querySelectorAll('" + ANSWER + "')].some(el=>el.getClientRects().length && el.innerText.trim()==="
            + JSONObject.quote(text) + ")";
    }

    private static void event(PipedOutputStream upstream, String json) throws Exception {
        upstream.write(("data: " + json + "\n\n").getBytes(StandardCharsets.UTF_8));
        upstream.flush();
    }

    private static void delta(PipedOutputStream upstream, String text) throws Exception {
        event(upstream, "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":" + JSONObject.quote(text) + "}}");
    }

    private void nativeLabel(String label, boolean click) throws Exception {
        Field page = field(AccountScreen.class, "page");
        await("native control " + label, () -> onUi(() -> {
            View view = labelIn((View) page.get(screen), label);
            return view != null && view.isShown() && (!click || (view.isEnabled() && view.performClick()));
        }));
    }

    private static View labelIn(View root, String label) {
        if (root instanceof TextView && label.contentEquals(((TextView) root).getText())) return root;
        if (root instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) root;
            for (int i = 0; i < group.getChildCount(); i++) {
                View match = labelIn(group.getChildAt(i), label);
                if (match != null) return match;
            }
        }
        return null;
    }
}
