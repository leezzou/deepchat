// node tools/qa-v55/share.mjs <production dist> <new evidence directory>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright";
import { installFixture } from "../qa-v54/fixture.mjs";
import { androidFixture } from "./settings-routes.mjs";

const requireApp = createRequire(new URL("../../chat-demo/package.json", import.meta.url));
const { unzipSync } = requireApp("fflate");
assert.equal(process.argv.length, 4, "Pass the production dist and a fresh evidence directory");
const assets = path.resolve(process.argv[2]),
  out = path.resolve(process.argv[3]);
await mkdir(path.dirname(out), { recursive: true });
await mkdir(out);
const html = await readFile(path.join(assets, "index.html"), "utf8");
const entry = html.match(/<script[^>]*src="([^"]*main\.[^"]+\.js)"/)?.[1];
assert.ok(entry, "Expected a production build");
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const origin = "https://share-test.localhost";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_EXECUTABLE_PATH ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
const report = {
  assets,
  bundleSha256: sha(await readFile(path.join(assets, entry))),
  browser: browser.version(),
  checks: [],
  failures: [],
  pages: [],
  pageErrors: [],
};
const verify = (result, name) => (result ? report.checks : report.failures).push(name);
const question = "请整理下面的格式样例。";
const hidden = "PRIVATE_THOUGHT_ONLY";
const extra = Array.from(
  { length: 170 },
  (_, i) => `Record ${String(i + 1).padStart(3, "0")} complete.`,
);
const body = [
  "# 分享格式验收",
  "",
  "**BOLD _BOTH_ END** and *ITALIC*.",
  "",
  "Literal \\*STAR\\* and `a**b`.",
  "",
  "```js",
  "const exponent = 2 ** 3;",
  "```",
  "",
  "Final answer.",
].join("\n");
const contexts = [];
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

// Observe the real drawing calls and pixels from the same canvas passed to the browser encoder.
// No renderer, app module or command handler is replaced.
function observe() {
  localStorage.setItem("chat-demo:locale", "zh-CN");
  const evidence = (window.qaShare = { paint: [], shares: [], nativeShares: [], clips: [] });
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: async ({ text }) => {
      evidence.shares.push(text);
    },
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text) => {
        evidence.clips.push(text);
      },
    },
  });
  const live = new WeakMap();
  const draw = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
    const result = draw.call(this, text, x, y, ...rest);
    const runs = live.get(this.canvas) ?? [];
    const metrics = this.measureText(text),
      transform = this.getTransform();
    const left = x - metrics.actualBoundingBoxLeft,
      top = y - metrics.actualBoundingBoxAscent;
    const pixelWidth = Math.ceil(
      (metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight) * transform.a,
    );
    const pixelHeight = Math.ceil(
      (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) * transform.d,
    );
    let ink = 0;
    if (pixelWidth && pixelHeight && text.trim()) {
      const image = this.getImageData(
        Math.floor(left * transform.a + transform.e),
        Math.floor(top * transform.d + transform.f),
        pixelWidth,
        pixelHeight,
      );
      for (let i = 0; i < image.data.length; i += 4)
        if (image.data[i] < 160 && image.data[i + 3] > 180) ink++;
    }
    runs.push({ text, font: this.font, ink });
    live.set(this.canvas, runs);
    return result;
  };
  const encode = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
    if (live.has(this)) {
      evidence.paint.push(live.get(this));
      live.delete(this);
    }
    return encode.call(this, callback, ...args);
  };
}

function seed({ mode, body, question, hidden }) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("chat-demo");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result,
        tx = db.transaction(["sessions", "sessionSummaries"], "readwrite");
      const now = Date.now(),
        id = `qa-${mode}`;
      const base = {
        id,
        title: `分享样例 ${mode}`,
        createdAt: now,
        updatedAt: now + 1,
        fileIds: [],
      };
      tx.objectStore("sessionSummaries").put(base);
      tx.objectStore("sessions").put({
        ...base,
        rootMessageId: "question",
        messages: [
          {
            id: "question",
            role: "user",
            parentId: null,
            selectedChildId: "reply",
            createdAt: now,
            files: [],
            content: question,
          },
          {
            id: "reply",
            role: "assistant",
            parentId: "question",
            createdAt: now + 1,
            status: "done",
            stopReason: "end_turn",
            model: "deepseek-flash",
            blocks: [
              { type: "thinking", thinking: hidden },
              { type: "text", text: body },
            ],
          },
        ],
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}
async function openChat(mode) {
  const context = await browser.newContext({
    locale: "zh-CN",
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
  });
  contexts.push(context);
  await context.addInitScript(installFixture);
  await context.addInitScript(observe);
  if (mode === "native") {
    await context.addInitScript(androidFixture, true);
    await context.addInitScript(() => {
      // The driver only observes the system-share boundary; Capacitor resolves the real plugin method.
      window.addEventListener(
        "DOMContentLoaded",
        () => {
          const cap = window.Capacitor;
          cap.PluginHeaders.push({ name: "Share", methods: [{ name: "share", rtype: "promise" }] });
          const nativePromise = cap.nativePromise;
          cap.nativePromise = (plugin, method, options) => {
            if (plugin === "Share" && method === "share") {
              window.qaShare.nativeShares.push(options.text);
              return Promise.resolve({});
            }
            return nativePromise(plugin, method, options);
          };
        },
        { once: true },
      );
    });
  }
  await context.route("https://**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || route.request().method() !== "GET") return route.abort();
    const file = path.resolve(assets, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    assert.ok(file.startsWith(assets + path.sep));
    try {
      await route.fulfill({
        body: await readFile(file),
        contentType: types[path.extname(file)] || "application/octet-stream",
      });
    } catch {
      await route.fulfill({ status: 404, body: "" });
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.pageErrors.push(e.message));
  page.setDefaultTimeout(8000);
  await page.goto(origin);
  await page
    .getByRole("button", { name: "打开边栏" })
    .waitFor()
    .catch(async (error) => {
      throw new Error(`Chat startup: ${await page.locator("body").innerText()}. ${error.message}`);
    });
  await page.waitForFunction(async () =>
    (await indexedDB.databases()).some((d) => d.name === "chat-demo" && d.version >= 12),
  );
  const reply = mode === "multiple" ? [body, "", ...extra, "End of export."].join("\n") : body;
  await page.evaluate(seed, { mode, body: reply, question, hidden });
  await page.reload();
  await page.getByRole("button", { name: "打开边栏" }).click();
  await page.getByText(`分享样例 ${mode}`, { exact: true }).click();
  const row = page.locator('[data-message-id="reply"]');
  await row.waitFor();
  return { page, row, reply };
}
const button = (scope, name) =>
  scope.getByRole("button", { name, exact: typeof name === "string" });
async function download(page, action) {
  const next = page.waitForEvent("download");
  await action.click();
  const item = await next;
  return { name: item.suggestedFilename(), data: await readFile(await item.path()) };
}
function paints(runs, token, predicate) {
  const text = runs.map((r) => r.text).join("");
  const start = text.indexOf(token);
  if (start < 0) return false;
  let at = 0;
  return runs
    .filter((r) => {
      const overlaps = at < start + token.length && at + r.text.length > start;
      at += r.text.length;
      return overlaps;
    })
    .every((r) => r.ink > 0 && predicate(r.font));
}
const bold = (font) => /\b(?:bold|[6-9]00)\b/i.test(font);
const italic = (font) => /\b(?:italic|oblique)\b/i.test(font);
const mono = (font) => /mono|menlo|consolas|courier/i.test(font);
function checkPlain(actual, label) {
  const expected = [
    "分享格式验收",
    "BOLD BOTH END and ITALIC.",
    "Literal *STAR* and a**b.",
    "const exponent = 2 ** 3;",
    "Final answer.",
  ].join("\n\n");
  verify(actual === expected, `${label} receives the exact expected plain-text body`);
  verify(
    actual.includes("BOLD BOTH END and ITALIC.") && actual.includes("Final answer."),
    `${label} includes readable nested prose`,
  );
  verify(
    actual.includes("*STAR*") &&
      actual.includes("a**b") &&
      actual.includes("const exponent = 2 ** 3;"),
    `${label} preserves literals and code`,
  );
  verify(
    !/(\*\*BOLD|_BOTH_|\*ITALIC\*|\\\*|```|`a\*\*b`|# 分享格式验收)/.test(actual) &&
      !actual.includes(hidden),
    `${label} omits Markdown formatting and hidden thinking`,
  );
}
async function run(mode) {
  const { page, row, reply } = await openChat(mode);
  try {
    if (mode === "native") {
      await button(row, "分享").click();
      await page.waitForFunction(() => window.qaShare.nativeShares.length === 1);
      checkPlain(
        await page.evaluate(() => window.qaShare.nativeShares[0]),
        "Android Capacitor Share.share",
      );
      return;
    }
    if (mode === "single") {
      await button(row, "分享").click();
      await page.waitForFunction(() => window.qaShare.shares.length === 1);
      const shared = await page.evaluate(() => window.qaShare.shares[0]);
      checkPlain(shared, "Web Share API");
      await page.evaluate(() => {
        delete navigator.share;
        let proto = Object.getPrototypeOf(navigator);
        while (proto && !Object.hasOwn(proto, "share")) proto = Object.getPrototypeOf(proto);
        if (proto) delete proto.share;
      });
      await button(row, "分享").click();
      await page.waitForFunction(() => window.qaShare.clips.length === 1);
      const clipped = await page.evaluate(() => window.qaShare.clips[0]);
      checkPlain(clipped, "Share clipboard fallback");
      verify(shared === clipped, "Clipboard receives the same text as Web Share");
      await button(row.locator("[data-message-actions]"), "复制").click();
      await page.waitForFunction(() => window.qaShare.clips.length === 2);
      checkPlain(await page.evaluate(() => window.qaShare.clips[1]), "Message copy button");
      await button(row, "消息操作").click();
      await button(page.getByRole("dialog", { name: "消息操作" }), "复制").click();
      await page.waitForFunction(() => window.qaShare.clips.length === 3);
      checkPlain(await page.evaluate(() => window.qaShare.clips[2]), "Message menu copy");
    }
    await button(row, "消息操作").click();
    await button(page.getByRole("dialog", { name: "消息操作" }), "多选消息").click();
    await page.getByRole("checkbox", { name: "选择第 1 条消息" }).check();
    await button(page, "分享预览").click();
    const preview = page.getByRole("dialog", { name: "分享预览" }),
      images = preview.locator('img[src^="blob:"][alt^="对话长图"]');
    await images.first().waitFor();
    verify(
      !(await preview.getByLabel("包含思考过程").isChecked()),
      `${mode}: thinking defaults to hidden`,
    );
    const displayed = await images.evaluateAll(async (items) =>
      Promise.all(
        items.map(async (img) => {
          const blob = await (await fetch(img.src)).blob(),
            buffer = await blob.arrayBuffer();
          const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))]
            .map((n) => n.toString(16).padStart(2, "0"))
            .join("");
          return { sha256: hash, bytes: blob.size, alt: img.alt };
        }),
      ),
    );
    verify(
      mode === "single" ? displayed.length === 1 : displayed.length > 1,
      `${mode}: expected page count`,
    );
    await page.screenshot({ path: path.join(out, `${mode}-preview.png`) });
    const file = await download(
      page,
      button(preview, mode === "single" ? "导出长图" : "导出图片包"),
    );
    const pages =
      mode === "single"
        ? [file.data]
        : Object.entries(unzipSync(file.data))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, v]) => Buffer.from(v));
    verify(file.name.endsWith(mode === "single" ? ".png" : ".zip"), `${mode}: download extension`);
    verify(pages.length === displayed.length, `${mode}: archive contains every preview page`);
    for (const [i, bytes] of pages.entries()) {
      const name = `${mode}-${i + 1}.png`;
      await writeFile(path.join(out, name), bytes);
      const info = {
        file: name,
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        sha256: sha(bytes),
        preview: displayed[i],
      };
      report.pages.push(info);
      verify(
        info.sha256 === displayed[i]?.sha256 &&
          info.width >= 440 &&
          info.height > 0 &&
          bytes.subarray(1, 4).toString() === "PNG",
        `${name} matches the preview byte for byte`,
      );
    }
    const md = await download(page, button(preview, /Markdown/i));
    const markdown = md.data.toString("utf8");
    await writeFile(path.join(out, `${mode}-source.md`), md.data);
    verify(
      md.name.endsWith(".md") &&
        markdown.includes(reply) &&
        markdown.indexOf(question) >= 0 &&
        markdown.indexOf(question) < markdown.indexOf(reply) &&
        !markdown.includes(hidden),
      `${mode}: .md contains the selected messages and exact Markdown source`,
    );
    const records = await page.evaluate(() => window.qaShare.paint);
    const runs = records.flat(),
      painted = runs.map((r) => r.text).join("");
    verify(
      records.length === pages.length,
      `${mode}: canvas observations cover each delivered page`,
    );
    verify(
      paints(runs, "BOLD", bold) &&
        paints(runs, "END", bold) &&
        paints(runs, "BOTH", (f) => bold(f) && italic(f)) &&
        paints(runs, "ITALIC", italic),
      `${mode}: nested bold/italic runs have ink in their requested typefaces`,
    );
    verify(
      paints(runs, "a**b", mono) && paints(runs, "const exponent = 2 ** 3;", mono),
      `${mode}: inline and fenced code render literally in a monospace face`,
    );
    verify(
      painted.includes("*STAR*") &&
        !painted.includes("\\*STAR") &&
        !painted.includes("**BOLD") &&
        !painted.includes("_BOTH_") &&
        !painted.includes("*ITALIC*") &&
        !painted.includes(hidden),
      `${mode}: escaped star is visible, formatting and hidden thinking are absent`,
    );
    if (mode === "multiple")
      verify(
        extra.every((t) => painted.includes(t)) && painted.includes("End of export."),
        "Every multi-page record and the final line are painted",
      );
    await writeFile(path.join(out, `${mode}-paint.json`), JSON.stringify(records, null, 2));
  } catch (e) {
    await page.screenshot({ path: path.join(out, `${mode}-failure.png`) }).catch(() => {});
    report.failures.push(`${mode}: ${e.stack || e}`);
  }
}
try {
  await run("single");
  await run("multiple");
  await run("native");
  verify(report.pageErrors.length === 0, "No uncaught browser errors");
} finally {
  await Promise.all(contexts.map((c) => c.close()));
  await browser.close();
  await writeFile(path.join(out, "share-report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(`${report.checks.length} passed, ${report.failures.length} failed`);
for (const failure of report.failures) console.log(failure);
process.exitCode = report.failures.length ? 1 : 0;
