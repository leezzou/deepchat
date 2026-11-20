"""Exercise the installed signed APK's native ZIP link reader on the isolated release-test AVD."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import re
import runpy
from threading import Thread
from uuid import uuid4
import zipfile

# Share the release verifier's exact AVD identity checks, offline guard and UI accessors.
release = runpy.run_path(str(Path(__file__).with_name('verify-workbuddy-release.py')))
adb, tap, wait_for = (release[k] for k in ('adb', 'tap', 'wait_for'))


def fixture(title, content):
    timestamp = '2026-01-10T01:02:03.000Z'
    summary = dict(id='signed-android-smoke', title=title, pinned=False,
                   inserted_at=timestamp, updated_at=timestamp)
    message = dict(id=1, parent_id=None, role='USER', status='FINISHED',
                   thinking_enabled=False, search_enabled=False, inserted_at=timestamp,
                   accumulated_token_usage=0, fragments=[dict(type='REQUEST', content=content)])
    files = {'manifest.json': {'export_format_version': 3},
             'chat_session_index.json': [dict(summary, message_count=1)],
             'chat_sessions/signed-android-smoke.json': dict(summary, current_message_id=1, messages=[message])}
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, value in files.items():
            archive.writestr(name, json.dumps(value))
    return data.getvalue()


@contextmanager
def local_download(data):
    served = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != '/fixture.zip':
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'application/zip')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            served.append(len(data))

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        host_port = server.server_address[1]
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        guest_port = adb('reverse', 'tcp:0', f'tcp:{host_port}').strip()
        assert re.fullmatch(r'\d+', guest_port), 'adb reverse did not allocate a guest port'
        try:
            yield f'http://127.0.0.1:{guest_port}/fixture.zip', served
        finally:
            adb('reverse', '--remove', 'tcp:' + guest_port)
            server.shutdown()
            thread.join()


def main():
    release['guard_device']()
    assert release['package_state']()[:2] == (release['RELEASE_NAME'], release['RELEASE_CODE'])
    token = uuid4().hex[:8]
    title = f'Android ZIP {token}'
    content = f'Native cache range read {token}'
    data = fixture(title, content)
    # Previous release checks leave Settings open. Relaunch without clearing app data.
    adb('shell', 'am', 'force-stop', release['PACKAGE'])
    release['start_app']()
    tap(wait_for(r'(?:打开边栏|Open sidebar).*')[0])
    tap(wait_for('设置|Settings')[0])
    tap(wait_for(r'数据管理|Data(?: management)?')[0])
    tap(wait_for(r'.*(?:从 DeepSeek 链接导入|Import from a DeepSeek link).*', allow_scroll=True)[0])
    field, _ = wait_for(r'.*(?:粘贴 DeepSeek|Paste the link from DeepSeek).*', allow_scroll=True)
    with local_download(data) as (url, served):
        tap(field)
        adb('shell', 'input', 'text', url)
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')  # dismiss IME
        tap(wait_for('下载并导入|Download and import', allow_scroll=True)[0])
        confirm, _ = wait_for('确认导入|Import', timeout=45)
        assert len(data) in served, 'The signed APK must fetch the synthetic ZIP through its native downloader'
        tap(confirm)
        wait_for(r'已导入 1 个对话|Imported 1 chat', timeout=45)
    # A fresh process must be able to reopen the imported chat and render the unique message.
    adb('shell', 'am', 'force-stop', release['PACKAGE'])
    release['start_app']()
    tap(wait_for(r'(?:打开边栏|Open sidebar).*')[0])
    tap(wait_for(re.escape(title))[0])
    wait_for(re.escape(content))
    print(f'PASS signed Android link import: served {len(data)} byte ZIP via localhost, confirmed one chat, reopened persisted message after process restart ({token})', flush=True)


if __name__ == '__main__':
    main()
