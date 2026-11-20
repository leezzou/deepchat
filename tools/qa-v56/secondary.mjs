import assert from "node:assert/strict";
import { button, front, openSettings, runner } from "./browser.mjs";
import { accountsFixture } from "./accounts-fixture.mjs";

const suite = await runner(process.argv.slice(2));
async function forms({ page, record, shot }) {
  await openSettings(page);
  const enter = async (from, buttonName, to) => {
    await button(front(page, from), buttonName).click();
    const scope = front(page, to);
    await scope.waitFor();
    return scope;
  };
  const back = async (scope) => {
    await button(scope, "返回").click();
    await scope.waitFor({ state: "detached" });
  };
  const font = await enter("root", /^字体大小/, "fontSize");
  const slider = font.getByRole("slider");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await slider.inputValue(), "3");
  assert.equal(await slider.getAttribute("aria-valuetext"), "较大");
  await font.getByRole("switch").check();
  assert.ok(await slider.isDisabled());
  await font.getByRole("switch").uncheck();
  assert.equal(await slider.inputValue(), "2");
  await shot("font");
  record.checks.push(
    "Font sample and accessible slider update, follow-system resets the saved scale",
  );
  await back(font);
  const profiles = await enter("root", /^API Key 管理/, "apiKey");
  const guide = await enter("apiKey", /^申请官方 API Key/, "guide");
  assert.deepEqual(
    await guide
      .getByRole("link")
      .evaluateAll((links) => links.map((link) => new URL(link.href).pathname)),
    ["/sign_in", "/top_up", "/api_keys"],
  );
  await shot("guide");
  await button(guide, "填写 API Key").click();
  const editor = front(page, "apiEdit");
  const origin = editor.locator("#api-profile-origin");
  const key = editor.locator("#api-profile-key");
  const save = button(editor, "保存并启用");
  assert.ok(await save.isDisabled());
  await key.fill("qa-exclusively-local-use");
  await origin.fill("https://example.invalid/v1");
  assert.equal(await key.inputValue(), "");
  await key.fill("second-local-fixture");
  await editor.locator("details > summary").click();
  await editor.locator("#api-profile-window").fill("0");
  assert.ok(await save.isDisabled());
  assert.equal(await editor.locator("#api-profile-window").getAttribute("aria-invalid"), "true");
  await editor.locator("#api-profile-window").fill("65536");
  await editor.locator("details > summary").click();
  await editor.locator("#api-profile-name").fill("QA secondary");
  await editor.locator("#api-profile-key").focus();
  await shot("editor");
  await save.click();
  await editor.waitFor({ state: "detached" });
  if (await guide.isVisible()) await back(guide);
  await profiles.getByRole("button", { name: /QA secondary.*example/ }).waitFor();
  assert.equal(
    await profiles
      .getByRole("button", { name: /QA secondary.*example/ })
      .getAttribute("aria-pressed"),
    "true",
  );
  record.checks.push(
    "Guide external destinations, guide-to-form, key clearing on host change, invalid window, save and activate",
  );
  await shot("profiles");
  await back(profiles);
  const context = await enter("root", /^模型上下文/, "contextModels");
  const input = context.locator("[data-context-window]");
  const defaultValue = await input.inputValue();
  await input.fill("51201");
  await context.locator("[data-context-save]").click();
  await context.getByText("已保存。").waitFor();
  await context.locator("summary").click();
  await shot("window");
  await context.locator("[data-context-reset]").click();
  assert.equal(await input.inputValue(), defaultValue);
  record.checks.push("Scoped window save, expanded sources and restore default");
  await back(context);
  const data = await enter("root", /^数据管理/, "data");
  await shot("data");
  const compacted = await enter("data", /^已压缩的对话/, "compacted");
  await compacted.getByText("还没有对话摘要", { exact: true }).waitFor();
  await shot("summaries");
  await back(compacted);
  const dav = await enter("data", /WebDAV/, "webdav");
  await dav.getByLabel("WebDAV 目录地址").fill("http://example.invalid/dav/");
  await button(dav, "测试连接").click();
  await dav.getByRole("alert").waitFor();
  assert.ok(await dav.locator("section").first().getByRole("alert").isVisible());
  await dav.getByLabel("WebDAV 目录地址").fill("https://example.invalid/dav/");
  await dav.getByLabel("备份密码", { exact: true }).fill("short");
  assert.ok(await button(dav, "加密并备份").isDisabled());
  await dav.getByLabel("备份密码", { exact: true }).fill("test-passphrase-long");
  await button(dav, "从备份恢复").click();
  await button(page.getByRole("dialog", { name: "确认恢复" }), "取消").click();
  record.checks.push(
    "WebDAV connection error at triggering section, password limits and cancel restore",
  );
  await shot("dav");
  await back(dav);
  await back(data);
  const security = await enter("root", /^安全与应用锁/, "security");
  await shot("security");
  await back(security);
  const memory = await enter("root", /^记忆/, "memory");
  await button(memory, /添加记忆/).click();
  const dialog = page.getByRole("dialog", { name: /添加记忆/ });
  await dialog.getByRole("textbox").fill("中文回复");
  await button(dialog, "保存").click();
  await memory.getByText("中文回复", { exact: true }).waitFor();
  await shot("memory");
  record.checks.push("Global memory editor saves a note, scope remains visible");
  await page.evaluate(async () => {
    // A persisted but unopened conversation exercises the real cold-cache read path.
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const id = 'qa-cold-summary';
    const date = Date.now();
    const summary = {id, title:'本地摘要测试', createdAt:date, updatedAt:date};
    const message = { id:'qa-message', parentId:null, createdAt:date, role:'user', files:[], content:'保留原文' };
    await new Promise((resolve,reject) => {
      const tx = db.transaction(['sessions','sessionSummaries'], 'readwrite');
      tx.objectStore('sessionSummaries').put({...summary, fileIds:[]});
      tx.objectStore('sessions').put({...summary, rootMessageId:message.id, messages:[message], compactedThrough:message.id, checkpoint:{text:'<compacted-summary>重启后读到的摘要</compacted-summary>',createdAt:date,coveredMessages:1}});
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    localStorage.setItem('chat-demo:compacted-index',JSON.stringify([{sessionId:id,title:summary.title,createdAt:date,coveredMessages:1}]));
  });
  await page.reload();
  await openSettings(page);
  await enter('root', /^数据管理/, 'data');
  const saved = await enter('data', /^已压缩的对话/, 'compacted');
  await button(saved, /^本地摘要测试/).click();
  await saved.getByText('重启后读到的摘要', {exact:true}).waitFor();
  await shot('summary-expanded');
  await button(saved, '恢复完整上下文').click();
  await saved.getByText('还没有对话摘要',{exact:true}).waitFor();
  await page.waitForFunction(async () => {
    const db = await new Promise((resolve,reject) => { const req = indexedDB.open('chat-demo'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const restored = await new Promise((resolve,reject) => { const req = db.transaction('sessions').objectStore('sessions').get('qa-cold-summary'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    db.close();
    return restored && !restored.checkpoint && !restored.compactedThrough && restored.messages[0].content === '保留原文';
  });
  record.checks.push('Cold-cache summary expansion and persisted restore preserve original messages');
}
async function desktop({ page, shot, record }) {
  await openSettings(page)
  await page.locator('[data-settings-tab="apiKey"]').click()
  const panel = page.getByRole('tabpanel')
  const guideEntry = button(panel, '申请官方 API Key')
  await guideEntry.click()
  const guide = page.getByRole('dialog', {name:'申请官方 API Key',exact:true})
  assert.equal(await guide.getByRole('link').count(), 3)
  await shot('guide')
  await button(guide, '填写 API Key').click()
  const adding = page.getByRole('dialog', {name:'添加 API Key',exact:true})
  await adding.locator('#api-profile-key').fill('qa-desktop-synthetic-only')
  await adding.locator('#api-profile-name').fill('桌面测试配置')
  await shot('add')
  await button(adding, '保存并启用').click()
  await adding.waitFor({state:'detached'})
  assert.equal(await button(panel, /^桌面测试配置/).getAttribute('aria-pressed'),'true')
  assert.ok(await guideEntry.evaluate(el=>el===document.activeElement), 'Return focus to guide entry after guide-to-editor save')
  await button(panel, /^编辑此配置.*桌面测试配置/).click()
  const editing = page.getByRole('dialog',{name:'编辑此配置',exact:true})
  await editing.locator('#api-profile-name').fill('已改名的配置')
  await button(editing, '保存并启用').click()
  await editing.waitFor({state:'detached'})
  const edit = button(panel, /^编辑此配置.*已改名的配置/)
  assert.ok(await edit.evaluate(el=>el===document.activeElement), 'Return focus to renamed editor entry')
  await shot('profiles')
  await edit.click()
  await button(editing, '删除此配置').click()
  const confirming = page.getByRole('dialog',{name:'删除这条 API 配置？',exact:true})
  await button(confirming, '取消').click()
  await confirming.waitFor({state:'detached'})
  await button(editing, '删除此配置').click()
  await button(confirming, '删除').click()
  await editing.waitFor({state:'detached'})
  assert.equal(await edit.count(),0)
  await panel.locator('[data-api-usage-entry]').click()
  const usage = page.getByRole('dialog',{name:'模型用量',exact:true})
  await usage.waitFor()
  await page.keyboard.press('Escape')
  await usage.waitFor({state:'detached'})
  record.checks.push('Desktop guide links and CTA, profile create/select, edit, cancel deletion, confirm deletion, usage dialog and keyboard return focus')
}
try {
  await Promise.all([
    suite.visit(320, 'light', 'secondary', accountsFixture, forms),
    suite.visit(390, 'dark', 'secondary', accountsFixture, forms),
    suite.visit(1280, 'light', 'secondary', accountsFixture, desktop),
    suite.visit(1280, 'dark', 'secondary', accountsFixture, desktop),
  ])
} finally {
  await suite.finish();
}
