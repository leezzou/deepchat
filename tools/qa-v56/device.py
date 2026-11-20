"""Verify published v55 → v56 with a real on-device conversation on an isolated API 34 guest.

python3 tools/qa-v56/device.py <published-v56.apk> <published-v55.apk> <new-evidence-dir>
Run after receiving the v56 public release link. All provider traffic stays on loopback.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import struct
import subprocess
import tempfile
import uuid

V55 = Path(__file__).resolve().parents[1] / 'qa-v55' / 'device.py'
spec = importlib.util.spec_from_file_location('device_v55', V55)
v55 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v55)
qa, scratch = v55.qa, v55.scratch
PICK_MODEL = r'(?:Choose model|选择模型)\s*·\s*'
SECOND_MODEL = 'qa-local-second'
DSH = r'登录 DeepSeek 账号|Sign in to DeepSeek'
WB = r'登录 WorkBuddy 账号|Sign in to WorkBuddy'


def back():
    qa.adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')


def open_saved_chat(question):
    # A cold start can land on a fresh composer. Go through the drawer to restore the thread.
    scratch.tap(v55.SIDEBAR)
    scratch.tap(rf'(?:{re.escape(question)}|QA sample title)')
    qa.wait_for(re.escape(question))
    qa.wait_for(re.escape(v55.ANSWER))


def preserved_chat(apk, previous, out, report):
    token = str(uuid.uuid4().int)[:12]
    question, draft = '55' + token, '56' + token
    qa.adb('install', str(previous))
    before = qa.package_state()
    assert before[:2] == ('1.0.55', '261163'), before
    report.update(before=before, oldSha256=v55.installed_digest(previous))
    v55.first_launch()
    report['oldChatRequest'] = v55.seed_usage(question, out, 'v55')
    scratch.tap('New chat|开启新对话')
    v55.enter_text(draft)
    qa.adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
    v55.restart()
    qa.wait_for(draft)
    open_saved_chat(question)
    qa.adb('shell', 'am', 'force-stop', qa.PACKAGE)
    qa.adb('install', '-r', str(apk))
    after = qa.package_state()
    assert after == ('1.0.56', '261164', *before[2:]), (before, after)
    report.update(after=after, publishedSha256=v55.installed_digest(apk))
    v55.restart()
    # The fresh composer and its draft are independent of the saved chat in the drawer.
    if qa.match(qa.tree(), re.escape(draft)) is None:
        scratch.tap('New chat|开启新对话')
    qa.wait_for(draft)
    scratch.shot(out, 'v56-retained-draft')
    open_saved_chat(question)
    scratch.shot(out, 'v56-retained-chat')
    report.update(retainedQuestion=question, retainedAnswer=v55.ANSWER, retainedDraft=draft)
    print('PASS v55 → v56 retained the installed identity, original messages and unsent draft', flush=True)


def composer_model(out, report):
    question = '560' + str(uuid.uuid4().int)[:12]
    reply = 'Selected model answered ' + question
    with v55.loopback_fixture(question, models=(v55.MODEL, SECOND_MODEL), answer=reply) as calls:
        scratch.tap(PICK_MODEL + re.escape(v55.MODEL))
        qa.wait_for(r'Available models|可选模型')
        qa.wait_for(SECOND_MODEL)
        scratch.shot(out, 'v56-composer-model-list')
        scratch.tap(SECOND_MODEL)
        qa.wait_for(PICK_MODEL + SECOND_MODEL)
        scratch.shot(out, 'v56-composer-selected')
        v55.enter_text(question)
        scratch.tap('Send|发送')
        expected = {'chat': True, 'stream': True, 'includeUsage': True, 'model': SECOND_MODEL}
        qa.wait_for(re.escape(question))
        qa.wait_for(PICK_MODEL + SECOND_MODEL)
        qa.wait_for(re.escape(reply))
        assert [c for c in calls if c['chat']] == [expected], calls
        report['composerRequest'] = expected
    print('PASS composer switched the model and the next request reached the selected model', flush=True)


def settings_checks(out, report):
    scratch.settings()
    groups = {
        'account': r'账户|Account', 'preferences': r'界面偏好|Interface preferences',
        'models': r'模型与用量|Models and usage', 'privacy': r'数据与隐私|Data and privacy',
        'about': r'关于与帮助|About and help',
    }
    visited = set()
    for position in range(8):
        nodes = qa.tree()
        assert qa.match(nodes, '账号资料|Account profile') is None, 'Obsolete profile row is still in Settings'
        sections = {key for key, value in groups.items() if qa.match(nodes, value) is not None}
        if sections - visited:
            scratch.shot(out, f'v56-settings-{position}')
        visited.update(sections)
        if visited == groups.keys():
            break
        v55.scroll()
    assert visited == groups.keys(), f'Missing settings groups {groups.keys() - visited}'
    report['settingsGroups'] = sorted(visited)
    # Re-enter Settings at its top. Accessibility scrolls only down on each lookup.
    v55.restart()
    scratch.settings()
    scratch.tap(WB)
    qa.wait_for('未登录|Signed out')
    qa.wait_for('剩余积分|Available credits', allow_scroll=True)
    qa.wait_for(r'DeepSeek 有日额度限制。|DeepSeek has a daily usage limit\.', allow_scroll=True)
    scratch.shot(out, 'v56-workbuddy-signed-out')
    back()
    qa.wait_for(DSH)
    scratch.tap(v55.MANAGE_KEYS, True)
    qa.wait_for('已存配置|Saved profiles')
    qa.wait_for(r'LM Studio(?:\s+.*)?')
    scratch.shot(out, 'v56-saved-api-profile')
    back()
    qa.wait_for(v55.MANAGE_KEYS, allow_scroll=True)
    report['settingsPages'] = ['WorkBuddy signed out', 'saved LM Studio API profile', 'hardware Back']


def native_account(out, dark, scale, check_usage=False):
    mode = 'yes' if dark else 'no'
    qa.adb('shell', 'cmd', 'uimode', 'night', mode)
    qa.adb('shell', 'settings', 'put', 'system', 'font_scale', str(scale))
    assert mode in qa.adb('shell', 'cmd', 'uimode', 'night').lower()
    assert float(qa.adb('shell', 'settings', 'get', 'system', 'font_scale')) == scale
    v55.restart()
    scratch.settings()
    scratch.tap(DSH)
    qa.wait_for('未登录')
    title, nodes = qa.wait_for('DeepSeek 账号')
    assert title.get('class') == 'android.widget.TextView'
    assert any(n.get('class') == 'android.widget.ImageButton' and '返回' in qa.labels(n) for n in nodes)
    login = qa.match(nodes, '登录 DeepSeek')
    assert login is not None and login.get('enabled') == 'true'
    assert qa.match(nodes, '模型用量') is not None
    label = ('dark' if dark else 'light') + ('-large' if scale > 1 else '-normal')
    scratch.shot(out, 'v56-dsh-' + label)
    # Sample the blank side margin on the native account surface to verify the rendered theme.
    raw = subprocess.check_output([qa.SDK / 'platform-tools/adb', '-s', qa.SERIAL, 'exec-out', 'screencap'])
    width, height, image_format = struct.unpack_from('<III', raw)
    header = len(raw) - width * height * 4
    assert image_format in (1, 2) and header in (12, 16), (width, height, image_format, header)
    offset = header + 4 * (width * (height // 2) + 2)
    rgb = list(raw[offset:offset + 3])
    assert (max(rgb) < 100 if dark else min(rgb) > 195), (label, rgb)
    left, top, right, bottom = map(int, re.findall(r'\d+', title.get('bounds')))
    assert 0 <= left < right <= width and 0 <= top < bottom <= height
    if check_usage:
        scratch.tap('模型用量')
        qa.wait_for(v55.TREND)
        back()
        qa.wait_for('登录 DeepSeek')
    back()
    qa.wait_for(DSH)
    qa.wait_for(WB)
    return {'appearance': label, 'systemFontScale': scale, 'surfaceRGB': rgb, 'titleHeightPx': bottom - top}


def run(apk, previous, out):
    v55.require_release(previous, '1.0.55', '261163')
    v55.require_release(apk, '1.0.56', '261164')
    out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'running', 'upgrade': 'adb install -r'}
    try:
        with tempfile.TemporaryDirectory(prefix='deepchat-v56-android-') as temp, (out / 'emulator.log').open('wb') as log:
            proc = scratch.start_guest(Path(temp), log)
            try:
                preserved_chat(apk, previous, out, report)
                composer_model(out, report)
                settings_checks(out, report)
                report['dshAccount'] = []
                for dark in [False, True]:
                    normal = native_account(out, dark, 1.0, check_usage=not dark)
                    large = native_account(out, dark, 1.5)
                    report['dshAccount'].extend([normal, large])
                    assert large['titleHeightPx'] > normal['titleHeightPx'], (normal, large)
                report['status'] = 'pass'
            except Exception as exc:
                report.update(status='fail', error=str(exc))
                scratch.shot(out, 'failure')
                (out / 'failure-ui.json').write_text(json.dumps([dict(n.attrib) for n in qa.tree()], ensure_ascii=False, indent=2))
                raise
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=25)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
    finally:
        (out / 'device-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('published_v56', type=Path)
    parser.add_argument('published_v55', type=Path)
    parser.add_argument('new_evidence_directory', type=Path)
    args = parser.parse_args()
    run(args.published_v56.resolve(strict=True), args.published_v55.resolve(strict=True), args.new_evidence_directory.resolve())
