package ai.deepseek.demo.shell;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.browser.customtabs.CustomTabsIntent;
import org.json.JSONArray;
import org.json.JSONObject;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;

/** Android port of the DSH account host. Account material stays inside the native process. */
final class DshAccountHost {
    static final String PLATFORM = "https://platform.deepseek.com";
    private final String clientVersion;
    final String userAgent;
    private static final String AUTH = "/auth-api/v0/dsh/";
    private static final String ALIAS = "dsh-account-v1";
    private final Activity activity;
    private final SharedPreferences prefs;
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private final SecureRandom rng = new SecureRandom();
    private String grant, name = "", error = "";
    private Attempt active;
    private boolean closed;
    private Runnable sessionListener;

    synchronized void setSessionListener(Runnable listener) { sessionListener = listener; }
    // Called under the host lock. The listener only posts a status refresh onto the UI thread.
    private void sessionChanged() { if (sessionListener != null) sessionListener.run(); }

    private static final class Attempt {
        final ServerSocket server;
        final String state, verifier, redirect;
        volatile String authorizationId;
        volatile String receivedCode;
        volatile long deadline = SystemClock.elapsedRealtime() + 600000;
        Attempt(String state, String verifier) throws IOException {
            this.state = state; this.verifier = verifier;
            server = new ServerSocket();
            server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 4);
            redirect = "http://127.0.0.1:" + server.getLocalPort() + "/oauth/callback";
        }
        void close() { try { server.close(); } catch (IOException ignored) {} }
    }
    DshAccountHost(Activity activity) {
        this.activity = activity;
        try {
            clientVersion = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
        } catch (android.content.pm.PackageManager.NameNotFoundException impossible) {
            throw new IllegalStateException("Unable to read app version", impossible);
        }
        userAgent = "DeepChat/" + clientVersion + " (Android)";
        prefs = activity.getSharedPreferences(ALIAS, Context.MODE_PRIVATE);
        if (prefs.contains("ciphertext")) try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, decode(prefs.getString("iv", ""))));
            JSONObject saved = new JSONObject(new String(cipher.doFinal(decode(prefs.getString("ciphertext", ""))), StandardCharsets.UTF_8));
            grant = saved.getString("token"); name = saved.optString("name");
        } catch (Exception invalid) { error = "此设备上的登录凭据无法读取，请重新授权。"; }
    }
    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        SecretKey existing = (SecretKey)store.getKey(ALIAS, null);
        if (existing != null) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    private static String encode(byte[] bytes) { return Base64.encodeToString(bytes, Base64.NO_WRAP | Base64.URL_SAFE | Base64.NO_PADDING); }
    private static byte[] decode(String value) { return Base64.decode(value, Base64.URL_SAFE | Base64.NO_WRAP); }
    private String nonce() { byte[] bytes = new byte[32]; rng.nextBytes(bytes); return encode(bytes); }
    synchronized String token() { return grant; }
    synchronized boolean signedIn() { return grant != null; }
    synchronized JSONObject status() throws Exception {
        return new JSONObject().put("signedIn", signedIn()).put("pending", active != null).put("exchanging", active != null && active.receivedCode != null).put("name", name).put("error", error);
    }
    synchronized JSONObject beginLogin() throws Exception {
        if (closed) throw new IOException("账户页已关闭。");
        if (active != null || grant != null) return status();
        Attempt attempt = new Attempt(nonce(), nonce()); active = attempt; error = "";
        workers.execute(() -> authorize(attempt));
        return status();
    }
    private synchronized boolean live(Attempt a) { return !closed && active == a && SystemClock.elapsedRealtime() < a.deadline; }
    private void authorize(Attempt a) {
        try {
            String challenge = encode(MessageDigest.getInstance("SHA-256").digest(a.verifier.getBytes(StandardCharsets.US_ASCII)));
            JSONObject init = request(AUTH + "auth_init", new JSONObject().put("code_challenge", challenge).put("code_challenge_method", "S256")
                    .put("state", a.state).put("redirect_uri", a.redirect).put("locale", locale()).put("login_source", "web"), null);
            a.authorizationId = init.getString("authorize_id");
            Uri page = platformPage(init.getString("authorize_url"), "/dsh/authorize");
            long seconds = Math.min(600, init.getLong("expires_in"));
            a.deadline = Math.min(a.deadline, SystemClock.elapsedRealtime() + 1000L * seconds);
            activity.runOnUiThread(() -> {
                if (!live(a)) return;
                try { new CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, page); }
                catch (Exception noBrowser) { finish(a, "无法打开授权页，请安装或启用系统浏览器。"); }
            });
            awaitCallback(a);
            if (!live(a) || a.receivedCode == null) {
                finish(a, "本次授权已结束，请重新登录。");
                return;
            }
            exchange(a);
        } catch (SocketTimeoutException timeout) {
            finish(a, a.receivedCode == null ? "授权等待超时，请重新登录。" : "已收到授权，但平台连接超时，请检查网络并重新登录。");
        } catch (Exception e) {
            String reason = safeError(e);
            finish(a, a.receivedCode == null ? reason : "已收到授权。" + reason);
        }
        finally {
            a.close();
            if (a.authorizationId != null && !signedIn()) try { request(AUTH + "auth_cancel", new JSONObject().put("authorize_id", a.authorizationId).put("code_verifier", a.verifier), null); } catch (Exception ignored) {}
        }
    }
    // Confirm delivery before an HTTPS request or a keystore operation can stall the browser.
    private void awaitCallback(Attempt a) throws IOException {
        try {
            while (live(a) && a.receivedCode == null) {
                a.server.setSoTimeout((int)Math.max(1, a.deadline - SystemClock.elapsedRealtime()));
                try (Socket socket = a.server.accept()) {
                    socket.setSoTimeout(5000);
                    try {
                        String code = callbackCode(socket, a);
                        boolean accepted = code != null && claim(a, code);
                        reply(socket, accepted);
                    } catch (IOException | RuntimeException invalid) {
                        reply(socket, false);
                    }
                }
            }
        } catch (SocketException wake) {
            if (live(a) && a.receivedCode == null) throw wake;
        }
    }

    private synchronized boolean claim(Attempt a, String code) {
        if (!live(a) || a.receivedCode != null || a.authorizationId == null) return false;
        a.receivedCode = code;
        a.close(); // Wake accept() if a user supplied a callback from a browser that cannot reach loopback.
        return true;
    }

    synchronized void submitCallback(String pasted) throws IOException {
        Attempt a = active;
        if (a == null || !live(a)) throw new IOException("本次授权已结束，请重新登录。");
        if (pasted == null || pasted.length() > 12288) throw new IOException("请输入本次浏览器返回的完整地址。");
        String url = pasted.trim();
        if (!url.startsWith(a.redirect + "?") || url.indexOf('#') >= 0 || url.indexOf('\r') >= 0 || url.indexOf('\n') >= 0)
            throw new IOException("返回地址与本次登录不匹配。");
        String code = validateCode(Uri.parse(url), a);
        if (code == null || !claim(a, code)) throw new IOException("该返回地址无效、已处理或已过期。");
    }

    private void exchange(Attempt a) throws Exception {
        JSONObject result = request(AUTH + "auth_exchange", new JSONObject().put("code", a.receivedCode).put("code_verifier", a.verifier)
            .put("redirect_uri", a.redirect).put("device_id", deviceId()).put("device_model", Build.MANUFACTURER + " " + Build.MODEL)
            .put("os_version", "Android " + Build.VERSION.RELEASE), null);
        String received = result.opt("token") instanceof String ? result.getString("token") : "";
        if (!received.matches("[\\x21-\\x7e]{1,16384}")) throw new PlatformFailure("平台没有返回有效的登录凭据，请重新授权。");
        boolean committed = false;
        try {
            synchronized (this) {
                if (!live(a)) {
                    finish(a, "本次授权已过期，请重新登录。");
                    return;
                }
                JSONObject user = result.optJSONObject("user");
                JSONObject profile = user == null ? null : user.optJSONObject("id_profile");
                String display = profile == null || profile.isNull("name") ? "" : profile.optString("name");
                try {
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.ENCRYPT_MODE, key());
                    byte[] encrypted = cipher.doFinal(new JSONObject().put("token", received).put("name", display).toString().getBytes(StandardCharsets.UTF_8));
                    if (!prefs.edit().putString("iv", encode(cipher.getIV())).putString("ciphertext", encode(encrypted)).commit()) throw new IOException();
                } catch (Exception unavailable) {
                    throw new PlatformFailure("设备未能安全保存登录凭据，请解锁手机并检查可用存储后重试。");
                }
                grant = received;
                name = display;
                active = null;
                error = "";
                committed = true;
                sessionChanged();
            }
        } finally { if (!committed) revoke(received); }
    }
    private synchronized void finish(Attempt a, String message) { if (active == a) { active = null; error = message; a.close(); } }
    synchronized void cancelLogin() { if (active != null) finish(active, ""); }
    private synchronized String deviceId() throws Exception {
        String id = prefs.getString("device", null);
        if (id != null) return id;
        id = UUID.randomUUID().toString();
        if (!prefs.edit().putString("device", id).commit()) throw new IOException("无法保存设备信息。");
        return id;
    }
    private static Uri platformPage(String url, String path) throws Exception {
        URI uri = new URI(url);
        if (!"https".equals(uri.getScheme()) || !"platform.deepseek.com".equals(uri.getRawAuthority()) || !path.equals(uri.getRawPath()) || uri.getRawFragment() != null || !uri.toASCIIString().equals(url)) throw new IOException("授权页面地址无效。");
        return Uri.parse(url);
    }
    private static String callbackCode(Socket s, Attempt a) throws IOException {
        InputStream in = new BufferedInputStream(s.getInputStream()); ByteArrayOutputStream buf = new ByteArrayOutputStream(); int suffix = 0;
        long timeout = SystemClock.elapsedRealtime() + 6000;
        while (buf.size() < 12288 && SystemClock.elapsedRealtime() < timeout) {
            int b = in.read(); if (b < 0) return null; buf.write(b); suffix = (suffix << 8) | b;
            if (suffix == 0x0d0a0d0a) break;
        }
        if (suffix != 0x0d0a0d0a) return null;
        String[] lines = new String(buf.toByteArray(), StandardCharsets.US_ASCII).split("\r\n");
        String[] words = lines[0].split(" ");
        if (words.length != 3 || !words[0].equals("GET") || !words[1].startsWith("/oauth/callback?") || words[1].contains("#")) return null;
        String expected = "127.0.0.1:" + a.server.getLocalPort(); int hosts = 0;
        for (String line : lines) if (line.regionMatches(true,0,"Host:",0,5)) { if (!expected.equals(line.substring(5).trim())) return null; hosts++; }
        if (hosts != 1) return null;
        Uri uri = Uri.parse("http://" + expected + words[1]);
        return validateCode(uri, a);
    }
    private static String validateCode(Uri uri, Attempt a) {
        List<String> states = uri.getQueryParameters("state"), codes = uri.getQueryParameters("code");
        if (states.size()!=1 || codes.size()!=1 || codes.get(0).isEmpty() || !MessageDigest.isEqual(states.get(0).getBytes(StandardCharsets.UTF_8), a.state.getBytes(StandardCharsets.UTF_8))) return null;
        return codes.get(0);
    }
    private static void reply(Socket socket, boolean accepted) {
        String title = accepted ? "授权结果已交回 DeepChat" : "这个返回地址无法用于本次登录";
        String message = accepted ? "请关闭此页面，返回 DeepChat 查看登录结果。" : "请返回 DeepChat，检查授权状态或重新登录。";
        byte[] body = ("<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>"
                + title + "</title><main><h2>" + title + "</h2><p>" + message + "</p></main></html>").getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 " + (accepted ? "200 OK" : "400 Bad Request")
                + "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\nContent-Length: " + body.length + "\r\n\r\n";
        try {
            OutputStream output = socket.getOutputStream();
            output.write(header.getBytes(StandardCharsets.US_ASCII));
            output.write(body);
            output.flush();
        } catch (IOException closedByBrowser) { /* A valid delivery still completes if the tab closes. */ }
    }
    synchronized void rejectToken(String rejected) {
        if (grant != null && grant.equals(rejected)) { clear(); error = "授权已过期，请重新登录。"; }
    }
    private void clear() {
        if (!prefs.edit().remove("iv").remove("ciphertext").commit()) throw new IllegalStateException("删除设备登录凭据失败，请重试。");
        grant = null; name = ""; error = "";
        sessionChanged();
    }
    synchronized void logout() {
        cancelLogin(); String old = grant; clear(); if (old != null) workers.execute(() -> revoke(old));
    }
    private void revoke(String old) { try { request("/auth-api/v0/users/logout", new JSONObject(), old); } catch (Exception ignored) {} }
    JSONObject balance() throws Exception {
        String t = token(); if (t == null) throw new IOException("请先完成账户授权。");
        JSONObject summary = request("/api/v0/users/get_user_summary", null, t);
        if (!t.equals(token())) throw new IOException("登录状态已变更。");
        return new JSONObject().put("wallets", wallets(summary.getJSONArray("normal_wallets"))).put("bonusWallets", wallets(summary.getJSONArray("bonus_wallets")));
    }
    private static JSONArray wallets(JSONArray raw) throws Exception {
        JSONArray clean = new JSONArray();
        for (int i=0;i<raw.length();i++) { JSONObject item = raw.getJSONObject(i); String amount = item.getString("balance"), unit = item.getString("currency");
            if (!unit.matches("[A-Z]{3}") || amount.length() > 96 || !amount.matches("-?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]{1,3})?")) throw new IOException("余额格式有误，请稍后刷新。");
            clean.put(new JSONObject().put("currency",unit).put("balance",amount)); }
        return clean;
    }
    private static String locale() { return Locale.getDefault().getLanguage().equals("zh") ? "zh_CN" : "en_US"; }
    private static String safeError(Exception e) { return e instanceof PlatformFailure ? e.getMessage() : "无法完成授权，请检查网络或重试。"; }
    private static final class PlatformFailure extends IOException { PlatformFailure(String s) { super(s); } }
    private JSONObject request(String path, JSONObject data, String t) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection)new URL(PLATFORM + path).openConnection(Proxy.NO_PROXY);
        try {
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(12000); connection.setReadTimeout(25000); connection.setUseCaches(false);
            connection.setRequestProperty("User-Agent", userAgent);
            // The DSH browser login contract uses the web client profile on non-desktop hosts.
            connection.setRequestProperty("x-client-platform", "web");
            connection.setRequestProperty("x-client-bundle-id", "");
            connection.setRequestProperty("x-client-version", clientVersion);
            connection.setRequestProperty("x-client-locale", locale()); connection.setRequestProperty("x-client-timezone-offset", String.valueOf(TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 1000));
            if (t != null) connection.setRequestProperty("x-dsh-auth-token", t);
            if (path.equals("/auth-api/v0/users/logout")) { connection.setRequestMethod("POST"); }
             else if (data != null) { connection.setRequestMethod("POST"); connection.setRequestProperty("Content-Type", "application/json"); connection.setDoOutput(true);
                try (OutputStream out = connection.getOutputStream()) { out.write(data.toString().getBytes(StandardCharsets.UTF_8)); } }
            int status = connection.getResponseCode(); if (t != null && status == 401) rejectToken(t);
            if (status < 200 || status >= 300) throw new PlatformFailure("平台返回 HTTP " + status + "，请稍后重试。");
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(); byte[] chunk = new byte[8192]; int count;
            try (InputStream in = connection.getInputStream()) { while ((count = in.read(chunk)) != -1) { if (buffer.size()+count>1048576) throw new IOException(); buffer.write(chunk,0,count); } }
            JSONObject payload = new JSONObject(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
            int code = payload.getInt("code"); if (t != null && code == 40003) rejectToken(t);
            if (code != 0) throw new PlatformFailure("平台未接受请求（" + code + "）。");
            JSONObject business = payload.getJSONObject("data"); int biz = business.getInt("biz_code");
            if (biz != 0) throw new PlatformFailure("平台未接受请求（" + biz + "）。");
            JSONObject result = business.optJSONObject("biz_data"); return result == null ? new JSONObject() : result;
        } finally { connection.disconnect(); }
    }
    synchronized void close() { sessionListener = null; closed = true; cancelLogin(); workers.shutdown(); }
}
