# WorkBuddy model identity regression

The browser suite opens the actual model picker, sends a message and reads terminal records from the app’s IndexedDB usage ledger. A local substitute for Android’s WorkBuddy port provides an account roster and feeds fragmented UTF-8 SSE bytes. Chat, search planning and the model picker use the supplied APK web assets. Each case records the catalog route, the upstream model string supplied by the fixture, the Android bridge request, visible outcome and saved receipts. The harness blocks external chat traffic.

```sh
node tools/qa-v56/hunyuan.mjs /path/to/v55/assets/public /path/to/fresh-v55-results --baseline-v55
node tools/qa-v56/hunyuan.mjs /path/to/v56/assets/public /path/to/fresh-v56-results
```

The native test runs the actual Android catalog and chat/planner JSON serialization code on a JVM. `JSON_JAR` must point to a local `org.json` jar, for example version `20240303` from the Gradle cache. The optional final argument accepts the `product.json` bundled with Tencent WorkBuddy 5.11.3, CLI 2.176.0. Passing it exercises real model rows with the test roster. Without that argument the test uses an equivalent offline fixture.

```sh
src=chat-demo/android/app/src/main/java/ai/deepseek/demo/shell
classes=$(mktemp -d)
javac -cp "$JSON_JAR" -d "$classes" "$src/WorkBuddyCatalog.java" "$src/WorkBuddyPromotion.java" "$src/WorkBuddyWire.java" tools/qa-v56/hunyuan-native.java
java -cp "$classes:$JSON_JAR" ai.deepseek.demo.shell.HunyuanNativeQa
java -cp "$classes:$JSON_JAR" ai.deepseek.demo.shell.HunyuanNativeQa /Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/product.json
```

## Evidence for the fixtures

| Catalog route | Product name or documented version | What the evidence establishes |
| --- | --- | --- |
| `hy3` and `hy3-x` | `Hy3` | Both product rows have this name. CLI 2.176.0 assigns them `x0.00 credits` and `x0.05 credits` respectively. |
| `hy4-preview` and `hy4-preview-x` | `Hy4 preview` | Two product rows with distinct route IDs. Both have `x0.29 credits` in this catalog version. |
| `hunyuan-chat` | `Hunyuan-Turbos` | Explicit WorkBuddy catalog spelling. |
| `hy3` | `hy3-202608` | Tencent lists the versioned spelling in the Hy Token Plan table. The association documented there applies to that plan. |
| `hy4-flash`, `hy4`, `hy4-preview` | `Hy4 flash`, `Hy4`, `Hy4 preview` | Tencent TokenHub lists these as separate models. |
| `glm-5.3`, `kimi-k3-2`, `deepseek-v4-pro` | `GLM-5.3`, `Kimi-K3`, `Deepseek-V4-Pro` | Separate domestic catalog products in the same CLI release. |

The Tencent API example shows `model` as a string and `object` as `chat.completion.chunk` during streaming. A nonstreaming example requests `hy4` and reports `model: "hy4"`. The fixture response strings test DeepChat behavior against these protocol and naming examples. The actual `model` on the affected user’s WorkBuddy stream remains unobserved. The `hy-deploy-qa` case uses an invented deployment identifier to exercise explicit native origin metadata.

- [Tencent CLI 2.176.0 domestic product catalog](https://unpkg.com/@tencent-ai/codebuddy-code@2.176.0/product.internal.json)
- [Tencent TokenHub model names and IDs](https://cloud.tencent.com/document/product/1823/130079)
- [Hy Token Plan supported models](https://cloud.tencent.com/document/product/1823/130060)
- [Tencent Chat Completions stream protocol](https://cloud.tencent.com/document/product/1823/135872)
- [Tencent Hy4 request and response example](https://www.tencentcloud.com/document/product/1300/80695)
