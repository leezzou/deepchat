// The OS file chooser, draft, persistence and message adapters run in the production app.
// Synthetic providers record the outgoing messages. Any unmatched HTTP request is blocked by browser.mjs.
export async function fileAttachments(
  { page, phone, check, shot, result },
  { call, answer, eventually },
) {
  const requests = [];
  page.on("request", (request) =>
    requests.push({ method: request.method(), url: request.url(), headers: request.headers() }),
  );
  const content = "# 本机文档\n校验码：秋分-721\n第三行 🌿";
  const question = "请读一下以下文档。";
  const textarea = page.getByRole("textbox", { name: "消息", exact: true });
  const picker = page.getByRole("button", { name: "插入 TXT / Markdown 正文", exact: true });
  const choose = async (name, mimeType, buffer, trigger = picker) => {
    const dialog = page.waitForEvent("filechooser");
    await trigger.click();
    await (await dialog).setFiles({ name, mimeType, buffer });
  };
  const chooseDocument = () => choose("秋分记录.md", "text/markdown", Buffer.from(content));
  const send = () => page.getByRole("button", { name: "发送", exact: true }).click();
  const users = (request) => request.messages.filter((row) => row.role === "user");
  const preview = `${question}\n\n[文件正文：秋分记录.md]\n${content}`;
  const expected = preview.replace("第三行 🌿", "用户编辑后的第三行 🌿");
  // A deliberately unrelated saved API credential while WorkBuddy is active.
  await page.evaluate(() => {
    localStorage.setItem(
      "chat-demo:api-profiles",
      JSON.stringify([
        {
          id: "qa-inactive",
          name: "QA inactive",
          origin: "https://fixture.invalid/v1",
          protocol: "openai",
          model: "private-model",
          apiKey: "qa-inactive-key",
        },
      ]),
    );
    localStorage.setItem("chat-demo:active-profile", "qa-inactive");
    sessionStorage.setItem("qa-active-model", "deepseek-v4-pro");
    localStorage.setItem(
      "chat-demo:workbuddy-route:v1",
      JSON.stringify({
        model: "deepseek-v4-pro",
        revision: "00000000-0000-4000-8000-000000000054",
      }),
    );
  });
  await page.reload();
  await textarea.fill(question);
  await choose("图像.png", "image/png", Buffer.from([137, 80, 78, 71]));
  await page.getByText(/此入口不能读取图片或 PDF/).waitFor();
  check(
    (await textarea.inputValue()) === question,
    "Unsupported image leaves the original draft intact",
  );
  await choose("说明.txt", "text/plain", Buffer.from([0xff, 0xfe, 0x61, 0]));
  await page.getByText(/无法以 UTF-8 解码/).waitFor();
  check((await textarea.inputValue()) === question, "Invalid UTF-8 cannot enter the draft");
  await chooseDocument();
  await eventually(
    async () => (await textarea.inputValue()) === preview,
    "editable inline preview",
  );
  await textarea.fill(expected);
  check(
    (await page.evaluate(() => window.qa.calls)).every(
      (row) => !["chat", "read", "search"].includes(row.op),
    ),
    "Choosing a file creates only a local preview",
  );
  await shot("editable-preview");
  await send();
  const first = await call(page, "chat", 0);
  check(
    first.model === "deepseek-v4-pro" && users(first).at(-1).content === expected,
    "WorkBuddy receives selected Markdown as user text on the current model",
  );
  check(
    !/file_id|qa-inactive-key|base64/.test(JSON.stringify(first)),
    "No file reference, original binary or unrelated key on the bridge",
  );
  await answer(page, first.id, "已读完文档。");
  await page.getByText("已读完文档。", { exact: true }).last().waitFor();
  await eventually(async () => {
    const sessions = await page.evaluate(() => window.qa.store("chat-demo", "sessions"));
    return sessions.some((session) =>
      session.messages.some((m) => m.role === "assistant" && m.status === "done"),
    );
  }, "persisted first reply");
  const title = await page.evaluate(
    async () => (await window.qa.store("chat-demo", "sessions"))[0].title,
  );
  await page.reload();
  if (phone) await page.getByRole("button", { name: /^打开边栏/ }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await page.getByText("已读完文档。", { exact: true }).last().waitFor();
  await textarea.fill("校验码是什么？");
  await send();
  const second = await call(page, "chat", 0);
  check(
    users(second)[0].content === expected && users(second).at(-1).content === "校验码是什么？",
    "Reloaded history includes the prior file contents on follow-up",
  );
  await answer(page, second.id, "秋分-721");
  check(
    requests.every(
      (req) =>
        req.method === "GET" &&
        !/qa-inactive-key|秋分-721/.test(decodeURI(req.url) + JSON.stringify(req.headers)),
    ),
    "No HTTP POST or unrelated credential leaves the composer, including during history replay",
  );
  result.files = { route: first.model, replayed: true, selectedBytes: Buffer.byteLength(content) };
}

export async function deployedFileAttachments(kind, { page, check, shot }, { eventually }) {
  const routes = [
    {
      name: "official",
      protocol: "deepseek",
      origin: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
    },
    {
      name: "router",
      protocol: "openai",
      origin: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-v4-pro",
    },
    {
      name: "custom",
      protocol: "openai",
      origin: "https://fixture.invalid/v1",
      model: "deepseek-v4-pro",
    },
  ];
  const body = "# 春分\n正文-306",
    preview = `[文件正文：note.md]\n${body}`;
  for (const profile of routes.filter((route) => route.name === kind)) {
    const { origin, name, protocol, model } = profile;
    await page.evaluate((profile) => {
      localStorage.setItem(
        "chat-demo:api-profiles",
        JSON.stringify([{ ...profile, id: "qa-deployment", apiKey: "qa-demo-key" }]),
      );
      localStorage.setItem("chat-demo:active-profile", "qa-deployment");
      localStorage.setItem("chat-demo:chat-source", "api");
    }, profile);
    const endpoint =
      origin + (protocol === "deepseek" ? "/anthropic/v1/messages" : "/chat/completions");
    const requests = [];
    await page.route(endpoint, async (route) => {
      const request = route.request();
      requests.push({ body: request.postDataJSON(), headers: request.headers() });
      const sse =
        protocol === "deepseek"
          ? 'event: message_start\ndata: {"type":"message_start","message":{"id":"qa","model":"deepseek-v4-pro"}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"已收到"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
          : 'data: {"choices":[{"delta":{"content":"已收到"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: sse });
    });
    await page.reload();
    if (name === "custom") {
      await page.getByRole("button", { name: "添加文件", exact: true }).click();
      await page.getByRole("button", { name: "上传原件", exact: true }).waitFor();
      await shot("custom-file-choices");
    }
    const dialog = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "插入 TXT / Markdown 正文", exact: true }).click();
    await (
      await dialog
    ).setFiles({ name: "note.md", mimeType: "text/markdown", buffer: Buffer.from(body) });
    const input = page.getByRole("textbox", { name: "消息" });
    await eventually(async () => (await input.inputValue()) === preview, `${name} preview`);
    check(!requests.length, `${name}: selection stays local until Send`);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("已收到", { exact: true }).last().waitFor();
    const [sent] = requests;
    const user = sent.body.messages.findLast((row) => row.role === "user");
    check(
      sent.body.model === model &&
        user.content === preview &&
        !/file_id/.test(JSON.stringify(sent.body)),
      `${name}: selected endpoint receives model and user text`,
    );
    check(
      sent.headers[protocol === "deepseek" ? "x-api-key" : "authorization"] ===
        (protocol === "deepseek" ? "qa-demo-key" : "Bearer qa-demo-key"),
      `${name}: only its own configured credential authorizes the chat`,
    );
    await page.unroute(endpoint);
  }
}
