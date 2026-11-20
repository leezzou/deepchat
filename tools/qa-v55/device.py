"""Run after the v55 release link is sent. Supply both published APKs and a new evidence folder.

python3 tools/qa-v55/device.py <v55.apk> <v54.apk> <evidence-dir>
Use --empty to exercise the empty report separately on a fresh guest.
"""
import argparse
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
import uuid

V54 = Path(__file__).resolve().parents[1] / 'qa-v54' / 'device.py'
spec = importlib.util.spec_from_file_location('scratch_device_v54', V54)
scratch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scratch)
qa = scratch.qa
MODEL = 'local-model'  # The bundled LM Studio preset is keyless and uses localhost:1234/v1.
SIDEBAR = r'(?:打开边栏|Open sidebar).*'
# A WebView container concatenates the accessible names of all Settings rows.
MANAGE_KEYS = r'(?:API Key 管理|Manage API keys|API Key management|API keys)(?:\s+[^\n]*)?'
USAGE = r'模型用量|Model usage'
TREND = r'Token 用量趋势|Token usage over time'
ANSWER = 'QA usage sample received.'


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@contextmanager
def loopback_fixture(question, models=(MODEL,), *, answer=ANSWER):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, body=b'', content_type='application/json', status=200):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Access-Control-Allow-Headers', 'content-type, authorization')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.reply(status=204)

        def do_GET(self):
            if self.path == '/v1/models':
                self.reply(json.dumps({'object': 'list', 'data': [{'id': m, 'object': 'model'} for m in models]}).encode())
            elif self.path == '/api/v1/models':
                self.reply(json.dumps({'models': [{'key': m, 'display_name': m} for m in models]}).encode())
            else:
                self.reply(status=404)

        def do_POST(self):
            if self.path != '/v1/chat/completions':
                return self.reply(status=404)
            payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            model = payload.get('model')
            if model not in models:
                return self.reply(status=400)
            last = payload.get('messages', [{}])[-1]
            content = last.get('content')
            if isinstance(content, list):
                content = ''.join(part.get('text', '') for part in content if isinstance(part, dict))
            chat = last.get('role') == 'user' and str(content).strip() == question
            stream = payload.get('stream') is True
            include_usage = (payload.get('stream_options') or {}).get('include_usage') is True
            calls.append({'chat': chat, 'stream': stream, 'includeUsage': include_usage, 'model': model})
            text = answer if chat else 'QA sample title'
            if not stream:
                return self.reply(json.dumps({'model': model, 'choices': [{'message': {'role': 'assistant', 'content': text}, 'finish_reason': 'stop'}]}).encode())
            frames = [{'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': text}, 'finish_reason': None}]},
                      {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]}]
            if chat and include_usage:
                frames.append({'choices': [], 'usage': {'prompt_tokens': 80, 'completion_tokens': 20,
                              'prompt_tokens_details': {'cached_tokens': 20},
                              'completion_tokens_details': {'cached_tokens': 0}}})
            body = ''.join('data: ' + json.dumps({'model': model, **frame}) + '\n\n' for frame in frames)
            self.reply((body + 'data: [DONE]\n\n').encode(), 'text/event-stream')

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            qa.adb('reverse', 'tcp:1234', f'tcp:{server.server_port}')
            try:
                yield calls
            finally:
                qa.adb('reverse', '--remove', 'tcp:1234')
        finally:
            server.shutdown()
            thread.join()


def restart():
    qa.adb('shell', 'am', 'force-stop', qa.PACKAGE)
    qa.start_app()
    qa.wait_for(SIDEBAR)


def enter_text(text):
    _, nodes = qa.wait_for(SIDEBAR)
    boxes = [n for n in nodes if n.get('class') == 'android.widget.EditText']
    assert len(boxes) == 1, 'Expected the chat composer'
    qa.tap(boxes[0])
    qa.adb('shell', 'input', 'text', text)
    qa.wait_for(re.escape(text))


def scroll():
    width, height = map(int, re.findall(r'(\d+)x(\d+)', qa.adb('shell', 'wm', 'size'))[-1])
    qa.adb('shell', 'input', 'swipe', str(width // 2), str(height * 7 // 10), str(width // 2), str(height * 4 // 10), '390')


def seed_usage(question, out, evidence_label='v54'):
    with loopback_fixture(question) as calls:
        scratch.settings()
        scratch.tap(MANAGE_KEYS, True)
        scratch.tap(r'添加 API Key|Add API Key', True)
        _, nodes = qa.wait_for(r'服务商|Provider')
        triggers = [n for n in nodes if n.get('clickable') == 'true' and qa.match([n], r'服务商|Provider|DeepSeek 官方|DeepSeek official') is not None]
        assert triggers, 'Missing provider selector in the v54 form'
        qa.tap(triggers[0])
        scratch.tap(r'LM Studio.*', True)
        scratch.tap(r'保存并启用|Save and use', True)
        qa.wait_for(r'添加 API Key|Add API Key', allow_scroll=True)
        restart()
        enter_text(question)
        scratch.tap(r'发送|Send')
        qa.wait_for(re.escape(ANSWER))
        expected = {'chat': True, 'stream': True, 'includeUsage': True, 'model': MODEL}
        assert [call for call in calls if call['chat']] == [expected], f'Unexpected v54 wire requests: {calls}'
        scratch.shot(out, f'{evidence_label}-loopback-reply')
        return list(calls)


def installed_digest(apk):
    base = qa.adb('shell', 'pm', 'path', qa.PACKAGE).strip().removeprefix('package:')
    assert re.fullmatch(r'/data/app/[\w/+=.~\-]+/base\.apk', base), base
    digest = qa.adb('shell', 'sha256sum', base).split()[0]
    assert digest == sha256(apk), 'Installed APK differs from the supplied release asset'
    return digest


def chart_evidence(out, empty):
    scratch.settings()
    scratch.tap(USAGE, True)
    qa.wait_for(TREND)
    if empty:
        qa.wait_for(r'.*(?:暂无用量记录|通过此应用发起请求后|No usage recorded yet|Send a request with this app).*', allow_scroll=True)
        scratch.shot(out, 'v55-empty-report')
        result = {'empty': True}
    else:
        expected = {
            'trend': TREND,
            'trendValues': r'(?:输入\s*80\s*Token，\s*输出\s*20\s*Token。|Input 80 tokens\. Output 20 tokens\.)',
            'providerRanking': r'渠道排行|Top providers', 'provider': r'LM Studio.*',
            'modelRanking': r'模型排行|Top models', 'model': r'local-model.*',
            'cache': r'缓存命中率|Cache hit rates',
            'inputRate': r'25\s*%', 'inputPair': r'.*(?:命中\s*20\s*/\s*80\s*Token|20 of 80 tokens hit).*',
            'outputRate': r'0\s*%', 'outputPair': r'.*(?:命中\s*0\s*/\s*20\s*Token|0 of 20 tokens hit).*',
        }
        result = {}
        for viewport in range(9):
            labels = [s for n in qa.tree() for s in qa.labels(n) if s]
            found = {key: s for key, rx in expected.items() for s in labels if re.fullmatch(rx, s, re.I | re.S)}
            if found.keys() - result.keys():
                scratch.shot(out, f'v55-usage-{viewport}')
                result.update(found)
            if result.keys() == expected.keys():
                break
            scroll()
        assert result.keys() == expected.keys(), f'Chart evidence missing {expected.keys() - result.keys()}, observed {result}'
    qa.adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    # Settings remembers its scroll. Its model-usage entry and neighboring API Key entry
    # identify the root more reliably than a Settings heading which also labels the drawer.
    qa.wait_for(USAGE)
    qa.wait_for(MANAGE_KEYS, allow_scroll=True)
    scratch.shot(out, 'v55-report-back-to-settings')
    return result


def require_release(apk, version, code):
    # Keep historical upgrade pairs runnable after the repository advances a version.
    assert qa.validate(apk, previous=int(code) < int(qa.RELEASE_CODE)) == (version, code)


def first_launch():
    # A freshly created API 34 image occasionally shows a System UI startup ANR.
    # Allow only that system dialog to continue. Surface any application failure.
    qa.start_app()
    deadline = time.monotonic() + 80
    dismissed = False
    while time.monotonic() < deadline:
        nodes = qa.tree(packages=(qa.PACKAGE, 'android'))
        if qa.match(nodes, SIDEBAR) is not None:
            return
        if not dismissed and qa.match(nodes, r"System UI isn't responding|系统界面无响应") is not None:
            wait_button = qa.match(nodes, 'Wait|等待')
            if wait_button is not None:
                qa.tap(wait_button)
                qa.start_app()
                dismissed = True
    raise AssertionError('App home did not become accessible after first launch')


def inspect(apk, previous, out, empty=False):
    require_release(apk, '1.0.55', '261163')
    require_release(previous, '1.0.54', '261162')
    out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'running', 'mode': 'empty' if empty else 'loopback', 'upgrade': 'adb install -r'}
    try:
        with tempfile.TemporaryDirectory(prefix='deepchat-v55-android-') as temp, (out / 'emulator.log').open('wb') as log:
            proc = scratch.start_guest(Path(temp), log)
            try:
                qa.adb('install', str(previous))
                before = qa.package_state()
                assert before[:2] == ('1.0.54', '261162')
                report.update(before=before, previousSha256=installed_digest(previous))
                first_launch()
                token = str(uuid.uuid4().int)[:12]
                if not empty:
                    report['fixtureRequests'] = seed_usage('54' + token, out)
                restart()
                draft = '55' + token
                enter_text(draft)
                qa.adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
                restart()
                qa.wait_for(draft)
                qa.adb('shell', 'am', 'force-stop', qa.PACKAGE)
                qa.adb('install', '-r', str(apk))
                after = qa.package_state()
                assert after == ('1.0.55', '261163', *before[2:]), (before, after)
                report.update(after=after, publishedSha256=installed_digest(apk))
                restart()
                qa.wait_for(draft)
                report['retainedDraft'] = draft
                scratch.shot(out, 'v55-preserved-draft')
                report['chart'] = chart_evidence(out, empty)
                report['backToSettings'] = True
            except Exception:
                scratch.shot(out, 'failure')
                (out / 'last-ui.json').write_text(json.dumps([dict(n.attrib) for n in qa.tree()], ensure_ascii=False, indent=2))
                raise
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=25)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
        report['status'] = 'pass'
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    except BaseException as exc:
        report.update(status='fail', error=str(exc))
        raise
    finally:
        (out / 'device-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ('published_apk', 'previous_apk', 'evidence'):
        parser.add_argument(field, type=Path)
    parser.add_argument('--empty', action='store_true', help='Check the empty report on a fresh signed-out guest')
    args = parser.parse_args()
    inspect(args.published_apk.resolve(strict=True), args.previous_apk.resolve(strict=True), args.evidence.resolve(), args.empty)
