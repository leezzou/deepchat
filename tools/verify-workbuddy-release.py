"""Validate the signed 1.0.48 APK and run its browser and Android WorkBuddy regressions.

python3 tools/verify-workbuddy-release.py /path/to/app.apk [--browser-only | --device-only]
Set PLAYWRIGHT_NODE_MODULES to use the optional external Playwright runtime.
Android requires the isolated read-only Pixel_7_API_34_arm64 already running on 5562.
"""
import argparse
import hashlib
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
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
VERSION = r'(?:版本|Version)\s*1\.0\.48'
BALANCE = r'.*(?:剩余积分与用量|Credits and usage).*'
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
    expected = f"name='{PACKAGE}' versionCode='261156' versionName='1.0.48'"
    if expected not in meta:
        raise ValueError(f'APK manifest differs from 1.0.48/261156: {meta}')
    cert = run([builds[-1] / 'apksigner', 'verify', '--print-certs', apk])
    if f'Signer #1 certificate SHA-256 digest: {CERT}' not in cert.splitlines():
        raise ValueError('APK signature differs from the release signing certificate')
    print(f'PASS signed {expected}, cert {CERT}, APK sha256 {hashlib.sha256(apk.read_bytes()).hexdigest()}', flush=True)


def browser_checks(apk):
    with tempfile.TemporaryDirectory(prefix='workbuddy48-assets-') as folder, zipfile.ZipFile(apk) as archive:
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
            subprocess.run(node + [str(TOOLS / test), str(root)], check=True, timeout=180)


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
            shown = [s[:90] for node in nodes for s in labels(node) if s]
            raise AssertionError(f'Android control {pattern!r} missing. Visible: {shown}')
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


def native_checks(apk):
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
    tap(version, 6)
    _, after_six = wait_for(VERSION)
    assert_private(after_six)
    time.sleep(1.35)
    tap(version)
    _, interrupted = wait_for(VERSION)
    assert_private(interrupted)
    time.sleep(1.35)  # Start a fresh uninterrupted seven-tap sequence.
    tap(version, 7)
    wallet_page, panel = wait_for(BALANCE)
    assert match(panel, r'剩余积分|Available credits') is None, 'Website wallet must omit unsupported numeric output'
    assert match(panel, AUTO) is not None
    switches = [n for n in panel if n.get('class') == 'android.widget.Switch' and any(re.search(AUTO, s, re.I) for s in labels(n))]
    assert len(switches) == 1 and switches[0].get('checked') == 'false' and switches[0].get('enabled') == 'false', 'Expected a disabled, unchecked switch'
    assert not any(re.search(r'API[\s_-]*Key|密钥|访问令牌|access token', s, re.I) for n in panel for s in labels(n)), 'Unexpected WorkBuddy API key flow'
    assert match(panel, r'.*(?:Buddy 加油站|Buddy Gas Station).*') is not None, 'Expected the official activity explanation'
    # The guest has no network path. Open the real native wallet and observe its WebView error.
    guard_device()
    tap(wallet_page)
    error, _ = wait_for(r'.*(?:未能载入 WorkBuddy 官网|ERR_INTERNET_DISCONNECTED|ERR_PROXY_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED).*')
    status = next(s for s in labels(error) if s)
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    wait_for(BALANCE)
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    restored, returned = wait_for(VERSION)
    assert_private(returned)
    assert restored.get('bounds') == version.get('bounds'), f'Version footer shifted from {version.get("bounds")} to {restored.get("bounds")}'
    print(f'PASS {SERIAL}: six taps hidden, ×7 opens real offline wallet, numeric balance hidden, check-in disabled, {status!r}; hardware Back restores Settings version footer at {restored.get("bounds")}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--browser-only', action='store_true')
    group.add_argument('--device-only', action='store_true')
    args = parser.parse_args()
    apk = args.apk.resolve(strict=True)
    validate(apk)
    if not args.device_only:
        browser_checks(apk)
    if not args.browser_only:
        native_checks(apk)
