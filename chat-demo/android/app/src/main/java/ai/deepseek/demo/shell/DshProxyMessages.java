package ai.deepseek.demo.shell;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Translates the text-only subset between OpenAI Chat Completions and Messages. */
final class DshProxyMessages {
    private static final String[] MODELS = {"deepseek-flash", "deepseek-v4-pro"};
    private static final Set<String> FIELDS = new HashSet<>(Arrays.asList("model", "messages", "stream", "stream_options", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "n", "response_format"));
    final JSONObject upstream;
    final boolean stream;
    private final boolean includeUsage;
    private final String model;
    private final String id = "chatcmpl-" + UUID.randomUUID();
    private final long created = System.currentTimeMillis() / 1000;

    static JSONObject models() throws JSONException {
        JSONArray items = new JSONArray();
        for (String model : MODELS) items.put(new JSONObject().put("id", model).put("object", "model").put("created", 0).put("owned_by", "deepseek"));
        return new JSONObject().put("object", "list").put("data", items);
    }

    DshProxyMessages(String json) throws DshLocalProxy.Problem {
        try {
            // Android's recursive JSON parser needs a depth bound even for a size-limited payload.
            checkDepth(json);
            JSONTokener parser = new JSONTokener(json);
            Object object = parser.nextValue();
            if (!(object instanceof JSONObject) || parser.nextClean() != 0) throw bad();
            JSONObject req = (JSONObject) object;
            for (Iterator<String> it = req.keys(); it.hasNext();) {
                if (!FIELDS.contains(it.next())) throw new DshLocalProxy.Problem(400, "Only plain-text completion options are supported");
            }
            model = req.getString("model");
            if (!Arrays.asList(MODELS).contains(model)) throw new DshLocalProxy.Problem(400, "Choose a model from /v1/models");
            stream = bool(req, "stream", false);
            JSONObject opts = req.has("stream_options") ? req.getJSONObject("stream_options") : new JSONObject();
            includeUsage = bool(opts, "include_usage", false);
            if (req.has("n") && integer(req.get("n"), 1) != 1) throw bad();
            if (req.has("response_format") && !req.getJSONObject("response_format").getString("type").equals("text")) throw bad();
            if (req.has("max_tokens") && req.has("max_completion_tokens")) throw bad();
            int max = 4096;
            if (req.has("max_tokens")) max = integer(req.get("max_tokens"), 16384);
            if (req.has("max_completion_tokens")) max = integer(req.get("max_completion_tokens"), 16384);
            upstream = new JSONObject().put("model", model).put("stream", true).put("max_tokens", max)
                .put("thinking", new JSONObject().put("type", "disabled"));
            JSONArray messages = req.getJSONArray("messages");
            if (messages.length() == 0 || messages.length() > 256) throw bad();
            JSONArray history = new JSONArray();
            StringBuilder system = new StringBuilder();
            for (int i = 0; i < messages.length(); i++) {
                JSONObject message = messages.getJSONObject(i);
                String role = message.getString("role");
                if (message.has("tool_calls") || message.has("function_call")) throw bad();
                String text = text(message.get("content"));
                if (role.equals("system") || role.equals("developer")) {
                    if (history.length() > 0) throw new DshLocalProxy.Problem(400, "System instructions must precede the conversation");
                    if (system.length() > 0) system.append("\n\n");
                    system.append(text);
                } else if (role.equals("user") || role.equals("assistant")) {
                    history.put(new JSONObject().put("role", role).put("content", text));
                } else throw bad();
            }
            if (history.length() == 0) throw bad();
            upstream.put("messages", history);
            if (system.length() > 0) upstream.put("system", system.toString());
            for (String field : new String[]{"temperature", "top_p"}) {
                if (!req.has(field) || req.isNull(field)) continue;
                Object raw = req.get(field);
                if (!(raw instanceof Number)) throw bad();
                double value = ((Number) raw).doubleValue();
                if (!(value >= 0 && value <= 1)) throw bad();
                upstream.put(field, value);
            }
            if (req.has("stop") && !req.isNull("stop")) {
                Object raw = req.get("stop");
                JSONArray stop = raw instanceof String ? new JSONArray().put(raw) : req.getJSONArray("stop");
                if (stop.length() == 0 || stop.length() > 4) throw bad();
                for (int i = 0; i < stop.length(); i++) if (!(stop.get(i) instanceof String) || stop.getString(i).isEmpty()) throw bad();
                upstream.put("stop_sequences", stop);
            }
        } catch (JSONException malformed) { throw bad(); }
    }

    private static int integer(Object value, int max) throws DshLocalProxy.Problem {
        if (!(value instanceof Number)) throw bad();
        Number n = (Number) value;
        if (n.doubleValue() != n.intValue() || n.intValue() < 1 || n.intValue() > max) throw bad();
        return n.intValue();
    }

    private static boolean bool(JSONObject object, String field, boolean fallback) throws JSONException, DshLocalProxy.Problem {
        if (object.isNull(field)) return fallback;
        Object value = object.get(field);
        if (!(value instanceof Boolean)) throw bad();
        return (boolean) value;
    }

    private static String text(Object content) throws DshLocalProxy.Problem, JSONException {
        if (content instanceof String) return (String) content;
        if (!(content instanceof JSONArray)) throw bad();
        JSONArray blocks = (JSONArray) content;
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < blocks.length(); i++) {
            JSONObject block = blocks.getJSONObject(i);
            if (!"text".equals(block.optString("type")) || !(block.get("text") instanceof String)) throw bad();
            text.append(block.getString("text"));
        }
        return text.toString();
    }

    private static void checkDepth(String json) throws DshLocalProxy.Problem {
        int depth = 0;
        boolean quoted = false;
        for (int i = 0; i < json.length(); i++) {
            char c = json.charAt(i);
            if (quoted && c == '\\') { i++; continue; }
            if (c == '"') { quoted = !quoted; continue; }
            if (quoted) continue;
            // JSONTokener additionally accepts single-quoted strings and comments. Reject those
            // alternate syntaxes so that they cannot hide nesting from this pass.
            if (c == '\'' || c == '/' || c == '#') throw bad();
            if ((c == '[' || c == '{') && ++depth > 32) throw bad();
            if ((c == ']' || c == '}') && --depth < 0) throw bad();
        }
        if (depth != 0 || quoted) throw bad();
    }

    private static DshLocalProxy.Problem bad() { return new DshLocalProxy.Problem(400, "Invalid plain-text chat request"); }
    private static DshLocalProxy.Problem malformed() { return new DshLocalProxy.Problem(502, "The model stream was incomplete or unsupported"); }

    static void event(OutputStream output, String json) throws IOException {
        output.write(("data: " + json + "\n\n").getBytes(StandardCharsets.UTF_8));
        output.flush();
    }

    private JSONObject envelope(String object, JSONArray choices) throws JSONException {
        return new JSONObject().put("id", id).put("object", object).put("created", created).put("model", model).put("choices", choices);
    }

    private void chunk(OutputStream output, JSONObject delta, String finish) throws JSONException, IOException {
        JSONObject choice = new JSONObject().put("index", 0).put("delta", delta).put("finish_reason", finish == null ? JSONObject.NULL : finish);
        event(output, envelope("chat.completion.chunk", new JSONArray().put(choice)).toString());
    }

    JSONObject receive(InputStream input, OutputStream output) throws Exception {
        StringBuilder text = new StringBuilder();
        StringBuilder data = new StringBuilder();
        String eventType = "";
        String finish = null;
        boolean started = false;
        int total = 0;
        Map<Integer,String> open = new HashMap<>();
        Set<Integer> seen = new HashSet<>();
        int prompt = 0, completion = 0;
        while (true) {
            String line = DshLocalProxy.line(input, 128 * 1024);
            total += line.length() + 1;
            if (total > 8 * 1024 * 1024 || data.length() > 256 * 1024) throw malformed();
            if (!line.isEmpty()) {
                if (line.startsWith("data:")) {
                    if (data.length() > 0) data.append('\n');
                    data.append(line.substring(5));
                } else if (line.startsWith("event:")) eventType = line.substring(6).trim();
                continue;
            }
            if (data.length() == 0) { eventType = ""; continue; }
            JSONObject frame = new JSONObject(data.toString());
            data.setLength(0);
            String type = frame.getString("type");
            if (!eventType.isEmpty() && !eventType.equals(type)) throw malformed();
            eventType = "";
            if (type.equals("ping")) continue;
            if (type.equals("error")) {
                JSONObject error = frame.optJSONObject("error");
                String kind = error == null ? "" : error.optString("type");
                if (kind.contains("quota") || kind.contains("balance") || kind.contains("billing")) throw new DshLocalProxy.Problem(402, "Account quota unavailable");
                if (kind.equals("rate_limit_error")) throw new DshLocalProxy.Problem(429, "The model service rate-limited this request");
                throw new DshLocalProxy.Problem(502, "The model service interrupted the response");
            }
            if (type.equals("message_start")) {
                if (started) throw malformed();
                started = true;
                JSONObject usage = frame.getJSONObject("message").optJSONObject("usage");
                if (usage != null) {
                    prompt = usage.optInt("input_tokens") + usage.optInt("cache_creation_input_tokens") + usage.optInt("cache_read_input_tokens");
                    completion = usage.optInt("output_tokens");
                }
                if (output != null) chunk(output, new JSONObject().put("role", "assistant").put("content", ""), null);
                continue;
            }
            if (!started) throw malformed();
            String append = null;
            switch (type) {
                case "content_block_start": {
                    int index = frame.getInt("index");
                    JSONObject block = frame.getJSONObject("content_block");
                    String kind = block.getString("type");
                    if (!seen.add(index) || seen.size() > 128 || finish != null || !(kind.equals("text") || kind.equals("thinking"))) throw malformed();
                    open.put(index, kind);
                    if (kind.equals("text")) append = block.getString("text");
                    break;
                }
                case "content_block_delta": {
                    String kind = open.get(frame.getInt("index"));
                    JSONObject delta = frame.getJSONObject("delta");
                    String deltaType = delta.getString("type");
                    if ("text".equals(kind) && deltaType.equals("text_delta")) append = delta.getString("text");
                    else if (!("thinking".equals(kind) && (deltaType.equals("thinking_delta") || deltaType.equals("signature_delta")))) throw malformed();
                    break;
                }
                case "content_block_stop":
                    if (open.remove(frame.getInt("index")) == null) throw malformed();
                    break;
                case "message_delta": {
                    JSONObject delta = frame.getJSONObject("delta");
                    if (!delta.isNull("stop_reason")) {
                        String reason = delta.getString("stop_reason");
                        if (reason.equals("end_turn") || reason.equals("stop_sequence")) finish = "stop";
                        else if (reason.equals("max_tokens")) finish = "length";
                        else throw malformed();
                    }
                    JSONObject usage = frame.optJSONObject("usage");
                    if (usage != null) completion = usage.optInt("output_tokens", completion);
                    break;
                }
                case "message_stop": {
                    if (finish == null || !open.isEmpty()) throw malformed();
                    JSONObject usage = new JSONObject().put("prompt_tokens", prompt).put("completion_tokens", completion).put("total_tokens", prompt + completion);
                    if (output != null) {
                        chunk(output, new JSONObject(), finish);
                        if (includeUsage) event(output, envelope("chat.completion.chunk", new JSONArray()).put("usage", usage).toString());
                        event(output, "[DONE]");
                        return null;
                    }
                    JSONObject message = new JSONObject().put("role", "assistant").put("content", text.toString());
                    JSONObject choice = new JSONObject().put("index", 0).put("message", message).put("finish_reason", finish);
                    return envelope("chat.completion", new JSONArray().put(choice)).put("usage", usage);
                }
                default: break; // Ignore future, non-content event types.
            }
            if (append != null && !append.isEmpty()) {
                if (output != null) chunk(output, new JSONObject().put("content", append), null);
                else text.append(append);
            }
        }
    }
}
