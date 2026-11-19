"""Validate the signed APK against the workspace release version and run WorkBuddy regressions.

python3 tools/verify-workbuddy-release.py /path/to/app.apk [--browser-only | --device-only]
Set PLAYWRIGHT_NODE_MODULES to use the optional external Playwright runtime.
Android requires the isolated read-only Pixel_7_API_34_arm64 already running on 5562.
"""
import argparse
from contextlib import contextmanager, nullcontext
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


# This network is confined to a signed-out read-only guest. Only consent navigation is exercised.
@contextmanager
def consent_network():
    guard_device()
    try:
        adb('shell', 'settings', 'put', 'global', 'http_proxy', ':0')
        adb('emu', 'proxy', 'clear')
        adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable')
        adb('shell', 'svc', 'wifi', 'enable')
        adb('shell', 'svc', 'data', 'enable')
        end = time.monotonic() + 30
        while not re.search(r'Active default network: \d+', adb('shell', 'dumpsys', 'connectivity')):
            if time.monotonic() > end:
                raise RuntimeError('Guest network did not connect')
            time.sleep(0.5)
        yield True
    finally:
        guard_device()


def tree(all_windows=False):
    args = ['--windows'] if all_windows else []
    xml = adb('exec-out', 'uiautomator', 'dump', *args, '/dev/tty')
    closing = '</displays>' if all_windows else '</hierarchy>'
    if '<?xml' not in xml or closing not in xml:
        return []  # Dialog or WebView can be changing during first launch.
    xml = xml[xml.index('<?xml'):xml.rindex(closing) + len(closing)]
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
            if right > left and bottom - top >= (75 if allow_scroll else 1):
                return hit, nodes
        if time.monotonic() > end:
            raise AssertionError(f'Expected Android control {pattern!r} missing across {len(nodes)} app nodes')
        if allow_scroll and hit is not None:
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
    login, nodes = wait_for('电脑版登录|Desktop sign-in')
    assert match(nodes, r'未登录|Signed out') is not None
    tap(login)
    deadline = time.monotonic() + 55
    seen = set()
    qr_image = False
    while time.monotonic() < deadline:
        nodes = tree(all_windows=True)  # Keep external auth UI and identifiers in memory.
        seen = {key for key, pattern in required.items() if match(nodes, pattern) is not None}
        qr_image = any(re.search(r'二维码|QR code', s, re.I) for n in nodes for s in labels(n))
        header = match(nodes, r'www\.workbuddy\.cn')
        back = match(nodes, r'返回 DeepChat|Return to DeepChat')
        if seen == set(required) and header is not None and back is not None :
            break
    else:
        raise AssertionError(f'Consent indicators {sorted(seen)}')
    print(f'PASS Android official WorkBuddy desktop page: {sorted(seen)}, QR accessibility label={qr_image}', flush=True)
    tap(match(nodes, required['phone']))
    end = time.monotonic() + 35
    while time.monotonic() < end:
        nodes = tree(all_windows=True)
        phone = match(nodes, r'.*(?:请输入手机号|Enter phone number).*')
        code = match(nodes, r'.*(?:请输入验证码|verification code).*')
        if phone is not None and code is not None:
            break
    else:
        raise AssertionError(f'Phone form missing across {len(nodes)} app nodes')
    print(f'PASS official WorkBuddy desktop consent on Android: {sorted(seen)}, QR accessibility label={qr_image}, phone tab opened in the same visit', flush=True)
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


def check_sms_policy(apk, expected):
    # Run the signed release's URI predicates on Android without constructing a WebView or HTTP request.
    guard_device()
    source = '''
import android.net.Uri;
import java.lang.reflect.Method;
public class SignedWalletPolicy {
    public static void main(String[] args) throws Exception {
        Class<?> type = Class.forName("ai.deepseek.demo.shell.WorkBuddyDesktopBrowser");
        Method resource = type.getDeclaredMethod("resourceAllowed", Uri.class);
        Method document = type.getDeclaredMethod("documentAllowed", Uri.class, boolean.class, String.class);
        resource.setAccessible(true);
        document.setAccessible(true);
        Uri exact = Uri.parse("https://oauth2.account.tencent.com/");
        boolean allowed = (boolean) resource.invoke(null, exact);
        if (allowed != Boolean.parseBoolean(args[0])) throw new AssertionError("Official account resource decision");
        for (boolean main : new boolean[]{true, false}) {
            if ((boolean) document.invoke(null, exact, main, "local-fixture")) throw new AssertionError("Account document permitted");
        }
        for (String invalid : new String[]{"http://oauth2.account.tencent.com/", "https://oauth2.account.tencent.com.example.invalid/"}) {
            if ((boolean) resource.invoke(null, Uri.parse(invalid))) throw new AssertionError("Non-official resource permitted");
        }
        System.out.println("PASS packaged Android policy: SMS HTTPS resource=" + allowed + ", documents=false, insecure/lookalike=false");
    }
}'''
    android = SDK / 'platforms/android-34/android.jar'
    d8 = sorted((SDK / 'build-tools').glob('*/d8'))[-1]
    with tempfile.TemporaryDirectory(prefix='signed-policy-') as temp:
        folder = Path(temp)
        java = folder / 'SignedWalletPolicy.java'
        java.write_text(source)
        probe = folder / 'probe.jar'
        subprocess.run(['javac', '--release', '8', '-cp', android, '-d', folder, java], check=True)
        subprocess.run([d8, '--lib', android, '--min-api', '34', '--output', probe, folder / 'SignedWalletPolicy.class'], check=True)
        remote = adb('shell', 'mktemp', '-d', '/data/local/tmp/wb-policy.XXXXXX').strip()
        assert re.fullmatch(r'/data/local/tmp/wb-policy\.[a-zA-Z0-9]{6}', remote)
        adb('push', str(apk), remote + '/app.apk')
        adb('push', str(probe), remote + '/probe.jar')
        adb('shell', 'chmod', '444', remote + '/app.apk', remote + '/probe.jar')
        output = adb('shell', f'CLASSPATH={remote}/probe.jar:{remote}/app.apk', 'app_process', '/system/bin', 'SignedWalletPolicy', str(expected).lower())
        assert 'PASS packaged Android policy:' in output, 'Packaged URI regression failed'
        print(output.strip(), flush=True)


def native_checks(apk, live_consent=False):
    guard_device()
    existing = adb('shell', 'pm', 'list', 'packages', PACKAGE).splitlines()
    if f'package:{PACKAGE}' in existing:
        print(adb('uninstall', PACKAGE).strip(), flush=True)  # Disposable guest can contain an older debug-signed APK.
    print(adb('install', str(apk)).strip(), flush=True)
    with (consent_network() if live_consent else nullcontext(None)) as reached:
        exercise_ui(reached)


def exercise_ui(reached):
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
    if reached is not None:
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
    group.add_argument('--sms-policy-only', action='store_true', help='Exercise the signed Android code for the phone verification host on the offline guest')
    parser.add_argument('--live-consent', action='store_true', help='Visit official Tencent consent page with a fresh unsigned-in account on the isolated guest')
    args = parser.parse_args()
    if (args.browser_only or args.sms_policy_only) and args.live_consent:
        parser.error('--live-consent requires the Android UI checks')
    apk = args.apk.resolve(strict=True)
    validate(apk)
    if args.sms_policy_only:
        check_sms_policy(apk, True)
    else:
        if not args.device_only:
            browser_checks(apk)
        if not args.browser_only:
            native_checks(apk, args.live_consent)
