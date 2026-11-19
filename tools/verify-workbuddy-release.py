"""Validate the signed APK against the workspace release version and run WorkBuddy regressions.

python3 tools/verify-workbuddy-release.py /path/to/app.apk [--browser-only | --device-only]
Set PLAYWRIGHT_NODE_MODULES to use the optional external Playwright runtime.
Android requires the isolated read-only Pixel_7_API_34_arm64 already running on 5562.
"""
import argparse
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import re
import select
import shlex
import shutil
import socket
import socketserver
import subprocess
import threading
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile

TOOLS = Path(__file__).resolve().parent
SDK = Path(os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT') or Path.home() / 'Library/Android/sdk')
SERIAL = 'emulator-5562'
AVD = 'Pixel_7_API_34_arm64'
PACKAGE = 'ai.deepseek.demo.shell'
CERT = 'fd8a24e368215166788ea8e1878714682906730be5c96dbfe43d408298be9d86'
GRADLE = (TOOLS.parent / 'chat-demo/android/app/build.gradle').read_text()
RELEASE_NAME = re.search(r'^\s*versionName\s+"(\d+\.\d+\.\d+)"', GRADLE, re.M)[1]
RELEASE_CODE = re.search(r'^\s*versionCode\s+(\d+)', GRADLE, re.M)[1]
VERSION = r'(?:版本|Version)\s*' + re.escape(RELEASE_NAME)
BALANCE = r'剩余积分|Available credits'
AUTO = r'.*(?:每日自动签到|Daily automatic check-in).*'


def run(args, timeout=45):
    return subprocess.check_output(list(map(str, args)), timeout=timeout, text=True)


def adb(*args):
    return run([SDK / 'platform-tools/adb', '-s', SERIAL, *args])


def validate(apk):
    builds = sorted((p for p in (SDK / 'build-tools').iterdir() if re.fullmatch(r'\d+(\.\d+)+', p.name)), key=lambda p: tuple(map(int, p.name.split('.'))))
    if not builds:
        raise RuntimeError('Install Android SDK Build Tools to validate the APK')
    meta = run([builds[-1] / 'aapt', 'dump', 'badging', apk]).splitlines()[0]
    expected = f"name='{PACKAGE}' versionCode='{RELEASE_CODE}' versionName='{RELEASE_NAME}'"
    if expected not in meta:
        raise ValueError(f'APK manifest differs from {RELEASE_NAME}/{RELEASE_CODE}: {meta}')
    cert = run([builds[-1] / 'apksigner', 'verify', '--print-certs', apk])
    if f'Signer #1 certificate SHA-256 digest: {CERT}' not in cert.splitlines():
        raise ValueError('APK signature differs from the release signing certificate')
    print(f'PASS signed {expected}, cert {CERT}, APK sha256 {hashlib.sha256(apk.read_bytes()).hexdigest()}', flush=True)


def browser_checks(apk):
    with tempfile.TemporaryDirectory(prefix='workbuddy-assets-') as folder, zipfile.ZipFile(apk) as archive:
        root = Path(folder).resolve()
        for entry in archive.infolist():
            if not entry.filename.startswith('assets/public/') or entry.is_dir():
                continue
            dest = (root / entry.filename[len('assets/public/'):]).resolve()
            if root not in dest.parents:
                raise ValueError(f'Unexpected asset path {entry.filename}')
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, dest.open('wb') as target:
                shutil.copyfileobj(source, target)
        node = ['node']
        if os.environ.get('PLAYWRIGHT_NODE_MODULES'):
            node += ['--import', str(TOOLS / 'external-playwright.mjs')]
        for test in ['verify-navigation.mjs', 'verify-workbuddy-ui.mjs']:
            subprocess.run(node + [str(TOOLS / test), str(root)] + ([RELEASE_NAME] if test == 'verify-workbuddy-ui.mjs' else []), check=True, timeout=180)


def guard_device():
    # Require host-owned copy-on-write process as well as the guest's AVD identity before mutation.
    if adb('emu', 'avd', 'name').splitlines()[0] != AVD:
        raise RuntimeError(f'Unexpected AVD at {SERIAL}')
    def matches(line):
        argv = shlex.split(line)
        return (argv and 'qemu-system-' in Path(argv[0]).name and '-read-only' in argv
                and ['-port', '5562'] in [argv[i:i+2] for i in range(len(argv))]
                and ['-avd', AVD] in [argv[i:i+2] for i in range(len(argv))])
    if not any(matches(line) for line in run(['ps', '-axo', 'command=']).splitlines() if 'qemu-system-' in line):
        raise RuntimeError(f'Expected read-only local emulator {SERIAL}')
    if adb('shell', 'getprop', 'sys.boot_completed').strip() != '1':
        raise RuntimeError('Isolated emulator has not finished booting')
    adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable')
    adb('shell', 'svc', 'wifi', 'disable')
    adb('shell', 'svc', 'data', 'disable')
    if adb('shell', 'cmd', 'connectivity', 'airplane-mode').strip() != 'enabled' or re.search(r'^default ', adb('shell', 'ip', 'route'), re.M):
        raise RuntimeError('Isolated emulator requires offline networking')


# The opt-in consent check uses a local TLS tunnel. Only these official service/asset
# hosts can connect. The guest's emulator-level dead proxy still denies direct TCP.
CONSENT_HOSTS = frozenset({
    'www.workbuddy.cn', 'assets.workbuddy.cn',
    'open.weixin.qq.com', 'res.wx.qq.com', 'long.open.weixin.qq.com', 'lp.open.weixin.qq.com',
    'api.account.tencent.com', 'gatherer.m.qq.com', 'browsertdidticket.m.qq.com',
})


class ConsentTunnel(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(15)
        try:
            line = self.rfile.readline(1024)
            match_host = re.fullmatch(rb'CONNECT ([a-z0-9.-]+):443 HTTP/1\.[01]\r\n', line)
            host = match_host[1].decode('ascii') if match_host else ''
            if host not in CONSENT_HOSTS:
                self.wfile.write(b'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
                return
            for _ in range(32):
                if self.rfile.readline(4096) == b'\r\n':
                    break
            else:
                return
            with socket.create_connection((host, 443), timeout=10) as remote:
                self.server.reached.add(host)
                self.wfile.write(b'HTTP/1.1 200 Connection established\r\n\r\n')
                while not self.server.stopping.is_set():
                    ready, _, _ = select.select([self.connection, remote], [], [], 1)
                    for source in ready:
                        data = source.recv(65536)
                        if not data:
                            return
                        (remote if source is self.connection else self.connection).sendall(data)
        except OSError:
            return


@contextmanager
def consent_network():
    guard_device()
    processes = run(['ps', '-axo', 'command=']).splitlines()
    assert any(re.search(r'/qemu-system-\S+ -avd Pixel_7_API_34_arm64 -port 5562 .*?-http-proxy http://127\.0\.0\.1:9(?:\s|$)', p) for p in processes), 'Live consent requires the guest isolation proxy'
    with socketserver.ThreadingTCPServer(('127.0.0.1', 0), ConsentTunnel) as server:
        server.daemon_threads = True
        server.reached = set()
        server.stopping = threading.Event()
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        port = adb('reverse', 'tcp:0', f'tcp:{server.server_address[1]}').strip()
        assert port.isdecimal()
        try:
            adb('shell', 'settings', 'put', 'global', 'http_proxy', f'127.0.0.1:{port}')
            adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable')
            adb('shell', 'svc', 'wifi', 'enable')
            yield server.reached
        finally:
            server.stopping.set()
            guard_device()
            adb('shell', 'settings', 'put', 'global', 'http_proxy', ':0')
            adb('reverse', '--remove', f'tcp:{port}')
            server.shutdown()
            worker.join()


def tree():
    xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty')
    if '<?xml' not in xml or '</hierarchy>' not in xml:
        return []  # Activity or WebView may still be changing during first launch.
    xml = xml[xml.index('<?xml'):xml.rindex('</hierarchy>') + len('</hierarchy>')]
    return [node for node in ET.fromstring(xml).iter('node') if node.get('package') == PACKAGE]


def labels(node):
    return [node.get('text', ''), node.get('content-desc', '')]


def match(nodes, pattern):
    return next((n for n in nodes if any(re.fullmatch(pattern, s, re.I) for s in labels(n))), None)


def wait_for(pattern, allow_scroll=False):
    end = time.monotonic() + 24
    while True:
        nodes = tree()
        hit = match(nodes, pattern)
        if hit is not None:
            left, top, right, bottom = map(int, re.findall(r'-?\d+', hit.get('bounds')))
            if right > left and bottom > top:
                return hit, nodes
        if time.monotonic() > end:
            raise AssertionError(f'Expected Android control {pattern!r} missing across {len(nodes)} app nodes')
        if allow_scroll:
            size = list(map(int, re.findall(r'(\d+)x(\d+)', adb('shell', 'wm', 'size'))[-1]))
            x, y1, y2 = size[0] // 2, size[1] * 3 // 4, size[1] // 3
            adb('shell', 'input', 'swipe', str(x), str(y1), str(x), str(y2), '260')


def tap(node, count=1):
    x, y, right, bottom = map(int, re.findall(r'\d+', node.get('bounds')))
    assert right > x and bottom > y, 'Expected visible Android control'
    cmd = f'input tap {(x + right) // 2} {(y + bottom) // 2}'
    adb('shell', '; '.join([cmd] * count))


def assert_private(nodes):
    assert match(nodes, BALANCE) is None and match(nodes, AUTO) is None, 'Wallet controls leaked outside WorkBuddy'


def consent_check():
    required = {'wechat-qr': r'微信扫码登录|WeChat QR', 'phone': r'手机(?:号)?(?:登录)?|Phone', 'sso': r'SSO(?:登录)?', 'qq': r'QQ(?:登录)?', 'email': r'邮箱(?:登录)?|Email'}
    with consent_network() as reached:
        login, nodes = wait_for('电脑版登录|Desktop sign-in')
        assert match(nodes, r'未登录|Signed out') is not None
        tap(login)
        deadline = time.monotonic() + 55
        seen = set()
        qr_image = False
        while time.monotonic() < deadline:
            nodes = tree()  # Secure consent page: only emit fixed indicators, never dump labels or images.
            seen = {key for key, pattern in required.items() if match(nodes, pattern) is not None}
            qr_image = any(re.search(r'二维码|QR code', s, re.I) for n in nodes for s in labels(n))
            header = match(nodes, r'www\.workbuddy\.cn')
            back = match(nodes, r'返回 DeepChat|Return to DeepChat')
            if seen == set(required) and header is not None and back is not None and 'open.weixin.qq.com' in reached:
                break
        else:
            raise AssertionError(f'Consent indicators {sorted(seen)}, official hosts reached {sorted(reached)}')
        tap(match(nodes, required['phone']))
        phone_fields, nodes = wait_for(r'.*(?:请输入手机号|Enter phone number).*')
        assert match(nodes, r'.*(?:请输入验证码|verification code).*') is not None, 'Phone tab must display a verification field'
        print(f'PASS official WorkBuddy desktop consent on Android: {sorted(seen)}, WeChat QR origin reached, QR accessibility label={qr_image}, phone tab opened in the same visit', flush=True)
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
        # Collect only whitelisted rows from here on; an unexpected return to consent must never dump its URL.
        end = time.monotonic() + 15
        while time.monotonic() < end:
            nodes = tree()
            cancel = match(nodes, '取消|Cancel')
            if match(nodes, 'WorkBuddy') is not None and cancel is not None:
                tap(cancel)
                break
        else:
            raise AssertionError('System Back did not return to the pending WorkBuddy visit')
    wait_for('电脑版登录|Desktop sign-in')


def native_checks(apk, live_consent=False):
    guard_device()
    existing = adb('shell', 'pm', 'list', 'packages', PACKAGE).splitlines()
    if f'package:{PACKAGE}' in existing:
        print(adb('uninstall', PACKAGE).strip(), flush=True)  # Disposable guest can contain an older debug-signed APK.
    print(adb('install', str(apk)).strip(), flush=True)
    adb('shell', 'wm', 'dismiss-keyguard')
    adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity')
    opener, home = wait_for('Open sidebar|打开边栏')
    assert_private(home)
    tap(opener)
    settings, drawer = wait_for('Settings|设置')
    assert_private(drawer)
    tap(settings)
    version, original = wait_for(VERSION, allow_scroll=True)
    assert_private(original)
    left, _, right, _ = map(int, re.findall(r'\d+', version.get('bounds')))
    width = int(re.findall(r'(\d+)x\d+', adb('shell', 'wm', 'size'))[-1])
    assert abs(left + right - width) <= 4, 'Version footer is off-center'
    tap(version, 6)
    _, after_six = wait_for(VERSION)
    assert_private(after_six)
    time.sleep(1.35)
    tap(version)
    _, interrupted = wait_for(VERSION)
    assert_private(interrupted)
    time.sleep(1.35)  # Start a fresh uninterrupted seven-tap sequence.
    tap(version, 7)
    _, panel = wait_for(BALANCE)
    assert match(panel, r'.*(?:在官网查看|View on WorkBuddy).*') is None, 'Wallet must stay in the app'
    assert match(panel, r'(?:未登录|Signed out)') is not None
    assert match(panel, AUTO) is not None
    switches = [n for n in panel if n.get('class') == 'android.widget.Switch' and any(re.search(AUTO, s, re.I) for s in labels(n))]
    assert len(switches) == 1 and switches[0].get('checked') == 'false' and switches[0].get('enabled') == 'false', 'Expected a disabled, unchecked switch'
    assert not any(re.search(r'API[\s_-]*Key|密钥|访问令牌|access token', s, re.I) for n in panel for s in labels(n)), 'Unexpected WorkBuddy API key flow'
    if live_consent:
        consent_check()
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    restored, returned = wait_for(VERSION)
    assert_private(returned)
    assert restored.get('bounds') == version.get('bounds'), f'Version footer shifted from {version.get("bounds")} to {restored.get("bounds")}'
    print(f'PASS {SERIAL}: six taps hidden, ×7 opens in-app signed-out wallet, check-in disabled, hardware Back restores centered Settings version footer at {restored.get("bounds")}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--browser-only', action='store_true')
    group.add_argument('--device-only', action='store_true')
    parser.add_argument('--live-consent', action='store_true', help='Visit official Tencent consent page with a fresh unsigned-in account on the isolated guest')
    args = parser.parse_args()
    if args.browser_only and args.live_consent:
        parser.error('--live-consent requires Android')
    apk = args.apk.resolve(strict=True)
    validate(apk)
    if not args.device_only:
        browser_checks(apk)
    if not args.browser_only:
        native_checks(apk, args.live_consent)
