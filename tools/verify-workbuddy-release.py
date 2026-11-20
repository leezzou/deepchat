"""Validate the signed APK against the workspace release version and run WorkBuddy regressions.

python3 tools/verify-workbuddy-release.py /path/to/app.apk [--browser-only | --device-only]
For a release upgrade, add --previous-apk /path/to/previous.apk. Add --live-update after
publication to attempt the old app's public update flow before falling back to adb install -r.
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
ACCOUNT = r'登录 WorkBuddy 账号|Sign in to WorkBuddy'
DSH = r'登录 DeepSeek 账号|Sign in to DeepSeek'


def run(args, timeout=45):
    return subprocess.check_output(list(map(str, args)), timeout=timeout, text=True)


def adb(*args):
    return run([SDK / 'platform-tools/adb', '-s', SERIAL, *args])


def validate(apk, previous=False):
    builds = sorted((p for p in (SDK / 'build-tools').iterdir() if re.fullmatch(r'\d+(\.\d+)+', p.name)), key=lambda p: tuple(map(int, p.name.split('.'))))
    if not builds:
        raise RuntimeError('Install Android SDK Build Tools to validate the APK')
    meta = run([builds[-1] / 'aapt', 'dump', 'badging', apk]).splitlines()[0]
    match_meta = re.search(r"name='([^']+)' versionCode='(\d+)' versionName='(\d+\.\d+\.\d+)'", meta)
    if not match_meta or match_meta[1] != PACKAGE:
        raise ValueError(f'Unexpected APK package or version: {meta}')
    code, name = match_meta[2], match_meta[3]
    if previous:
        if int(code) >= int(RELEASE_CODE):
            raise ValueError(f'The old APK must precede version code {RELEASE_CODE}: {meta}')
    elif (name, code) != (RELEASE_NAME, RELEASE_CODE):
        raise ValueError(f'APK manifest differs from {RELEASE_NAME}/{RELEASE_CODE}: {meta}')
    cert = run([builds[-1] / 'apksigner', 'verify', '--print-certs', apk])
    if f'Signer #1 certificate SHA-256 digest: {CERT}' not in cert.splitlines():
        raise ValueError('APK signature differs from the release signing certificate')
    print(f'PASS signed {PACKAGE} {name}/{code}, cert {CERT}, APK sha256 {hashlib.sha256(apk.read_bytes()).hexdigest()}', flush=True)
    return name, code


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


# Public update and optional consent tests use only this disposable, signed-out guest.
@contextmanager
def guest_network():
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


def tree(all_windows=False, packages=(PACKAGE,)):
    args = ['--windows'] if all_windows else []
    xml = adb('exec-out', 'uiautomator', 'dump', *args, '/dev/tty')
    closing = '</displays>' if all_windows else '</hierarchy>'
    if '<?xml' not in xml or closing not in xml:
        return []  # Dialog or WebView can be changing during first launch.
    xml = xml[xml.index('<?xml'):xml.rindex(closing) + len(closing)]
    return [node for node in ET.fromstring(xml).iter('node') if node.get('package') in packages]


def labels(node):
    return [node.get('text', ''), node.get('content-desc', '')]


def match(nodes, pattern):
    return next((n for n in nodes if any(re.fullmatch(pattern, s, re.I) for s in labels(n))), None)


def wait_for(pattern, allow_scroll=False, timeout=24, packages=(PACKAGE,)):
    end = time.monotonic() + timeout
    while True:
        nodes = tree(packages=packages)
        hit = match(nodes, pattern)
        if hit is not None:
            left, top, right, bottom = map(int, re.findall(r'-?\d+', hit.get('bounds')))
            if right > left and bottom - top >= (16 if allow_scroll else 1):
                return hit, nodes
        if time.monotonic() > end:
            raise AssertionError(f'Expected Android control {pattern!r} missing across {len(nodes)} app nodes')
        if allow_scroll and nodes:
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
        if seen == set(required) and header is not None and back is not None:
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
        if match(nodes, r'WorkBuddy 账号|WorkBuddy account') is not None and cancel is not None:
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


CHECK_UPDATE = r'(?:检查更新|Check for updates).*'
INSTALLERS = ('com.android.packageinstaller', 'com.google.android.packageinstaller')


def package_state():
    info = adb('shell', 'dumpsys', 'package', PACKAGE)
    def field(pattern):
        hit = re.search(pattern, info, re.M)
        if not hit:
            raise AssertionError(f'Missing package field {pattern}')
        return hit[1].strip()
    return (field(r'^\s*versionName=(\S+)'), field(r'^\s*versionCode=(\d+)'),
            field(r'^\s*(?:userId|appId)=(\d+)'), field(r'^\s*firstInstallTime=(.+)$'))


def start_app():
    adb('shell', 'wm', 'dismiss-keyguard')
    adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity')


def public_upgrade():
    # Only called for --live-update, on the guarded, disposable AVD. Grant this single app
    # the install-source permission so the test can exercise the public APK installer itself.
    adb('shell', 'appops', 'set', PACKAGE, 'REQUEST_INSTALL_PACKAGES', 'allow')
    start_app()
    tap(wait_for(r'(?:Open sidebar|打开边栏).*')[0])
    tap(wait_for('Settings|设置')[0])
    tap(wait_for(CHECK_UPDATE, allow_scroll=True)[0])
    download, details = wait_for('下载并安装|Download and install', timeout=50)
    assert match(details, rf'.*(?:发现新版本|Version)\s*v?{re.escape(RELEASE_NAME)}(?: is available)?') is not None, 'The old app must offer exactly the published target'
    print(f'Public update: old app offered {RELEASE_NAME}; requesting download', flush=True)
    tap(download)
    # In 1.0.52 the ready banner is on the chat screen, behind both Settings and its drawer.
    if match(tree(), CHECK_UPDATE) is not None:
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    if match(tree(), '设置|Settings') is not None:
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    tap(wait_for('安装更新|Install update', timeout=75)[0])
    confirm, nodes = wait_for('更新|Update|安装|Install|仅此一次|Just once', packages=(*INSTALLERS, 'android'))
    if confirm.get('package') == 'android':
        assert match(nodes, r'.*(?:软件包安装程序|Package installer).*') is not None, 'Only select the system package installer'
        assert match([confirm], '仅此一次|Just once') is not None
        tap(confirm)
        confirm, _ = wait_for('更新|Update|安装|Install', packages=INSTALLERS)
    tap(confirm)
    end = time.monotonic() + 40
    while time.monotonic() < end:
        if package_state()[:2] == (RELEASE_NAME, RELEASE_CODE):
            return
        time.sleep(.5)
    raise AssertionError('Android installer did not apply the announced version')


def native_checks(apk, previous=None, live_update=False, live_consent=False):
    old_meta = validate(previous, previous=True) if previous else None
    guard_device()
    existing = adb('shell', 'pm', 'list', 'packages', PACKAGE).splitlines()
    if f'package:{PACKAGE}' in existing:
        print(adb('uninstall', PACKAGE).strip(), flush=True)  # Disposable guest may contain a debug build.
    if previous:
        print(adb('install', str(previous)).strip(), flush=True)
        old_state = package_state()
        assert old_state[:2] == old_meta, f'Old package state {old_state}'
        installed_via = 'adb install -r'
        if live_update:
            try:
                with guest_network():
                    public_upgrade()
                installed_via = 'public download and Android installer'
            except (AssertionError, RuntimeError, subprocess.SubprocessError) as error:
                print(f'Public upgrade unavailable: {error}; continuing with signed replacement', flush=True)
        if installed_via == 'adb install -r':
            guard_device()
            print(adb('install', '-r', str(apk)).strip(), flush=True)
        new_state = package_state()
        assert new_state == (RELEASE_NAME, RELEASE_CODE, *old_state[2:]), f'Upgrade changed package identity: {old_state} → {new_state}'
        base = adb('shell', 'pm', 'path', PACKAGE).strip().removeprefix('package:')
        assert re.fullmatch(r'/data/app/[\w/+=.~\-]+/base\.apk', base), 'Expected one installed base APK'
        assert adb('shell', 'sha256sum', base).split()[0] == hashlib.sha256(apk.read_bytes()).hexdigest(), 'Installed bytes differ from published APK'
        print(f'PASS {installed_via}: {old_state[0]}/{old_state[1]} → {new_state[0]}/{new_state[1]}, same UID {new_state[2]}, firstInstallTime {new_state[3]}, installed APK digest matches', flush=True)
        adb('shell', 'am', 'force-stop', PACKAGE)
    else:
        print(adb('install', str(apk)).strip(), flush=True)
    with (guest_network() if live_consent else nullcontext(None)) as reached:
        exercise_ui(reached)


def exercise_ui(reached):
    start_app()
    opener, home = wait_for('Open sidebar|打开边栏')
    assert_private(home)
    tap(opener)
    settings, drawer = wait_for('Settings|设置')
    assert_private(drawer)
    tap(settings)
    account, root = wait_for(ACCOUNT)
    assert_private(root)
    dsh = match(root, DSH)
    assert dsh is not None, 'Expected DeepSeek account immediately above WorkBuddy'
    _, top, _, bottom = map(int, re.findall(r'\d+', account.get('bounds')))
    dsh_bottom = int(re.findall(r'\d+', dsh.get('bounds'))[-1])
    assert -10 <= top - dsh_bottom <= 30 and bottom - top >= 80, 'Account order or touch target changed'
    tap(account)
    _, public_page = wait_for('电脑版登录|Desktop sign-in')
    assert match(public_page, r'未登录|Signed out') is not None
    if reached is not None:
        consent_check()
    _, panel = wait_for(BALANCE, allow_scroll=True)
    assert match(panel, r'登录后显示|Sign in to view') is not None
    assert match(panel, r'—') is not None
    _, panel = wait_for(r'DeepSeek 有日额度限制。|DeepSeek has a daily usage limit\.', allow_scroll=True)
    assert not any(re.search(r'本机今日已记录|重置时间|Recorded on this device|reset time|remaining allowance', s, re.I) for n in panel for s in labels(n))
    _, panel = wait_for(AUTO, allow_scroll=True)
    switches = [n for n in panel if n.get('class') == 'android.widget.Switch' and any(re.search(AUTO, s, re.I) for s in labels(n))]
    assert len(switches) == 1 and switches[0].get('checked') == 'false' and switches[0].get('enabled') == 'false', 'Expected a disabled, unchecked switch'
    assert not any(re.search(r'API[\s_-]*Key|密钥|访问令牌|access token', s, re.I) for n in panel for s in labels(n)), 'Unexpected WorkBuddy API key flow'
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    restored_account, root = wait_for(ACCOUNT)
    assert_private(root)
    assert restored_account.get('bounds') == account.get('bounds'), 'Public account Back changed Settings position'
    print(f'PASS {SERIAL}: signed-out WorkBuddy account below DeepSeek shows balance, single daily-limit note and disabled check-in; hardware Back restores Settings', flush=True)
    version, original = wait_for(VERSION, allow_scroll=True)
    assert_private(original)
    left, _, right, _ = map(int, re.findall(r'\d+', version.get('bounds')))
    width = int(re.findall(r'(\d+)x\d+', adb('shell', 'wm', 'size'))[-1])
    assert abs(left + right - width) <= 4, 'Version footer is off-center'
    assert version.get('clickable') == 'false', 'Version footer must be static text'
    tap(version, 7)
    restored, returned = wait_for(VERSION)
    assert_private(returned)
    assert restored.get('bounds') == version.get('bounds'), 'Version footer moved after seven taps'
    row, _ = wait_for(CHECK_UPDATE)
    tap(row)
    error = r'.*(?:检查更新失败|无法检查更新|Could not check for updates|Unable to check for updates).*'
    status = error if reached is None else r'.*(?:已经是最新版本|latest version|检查更新失败|Could not check for updates).*'
    wait_for(status, timeout=75)
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    check, _ = wait_for(CHECK_UPDATE)
    assert row.get('bounds') == check.get('bounds'), 'Update Back changed Settings scroll position'
    print(f'PASS {SERIAL}: seven taps leave static version centered at {restored.get("bounds")}; update result is visible, hardware Back restores Settings', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--browser-only', action='store_true')
    group.add_argument('--device-only', action='store_true')
    group.add_argument('--sms-policy-only', action='store_true', help='Exercise the signed Android code for the phone verification host on the offline guest')
    parser.add_argument('--live-consent', action='store_true', help='Visit official Tencent consent page with a fresh unsigned-in account on the isolated guest')
    parser.add_argument('--previous-apk', type=Path, help='Install an older signed APK first and verify a data-preserving upgrade')
    parser.add_argument('--live-update', action='store_true', help='Try the published update and Android installer from the old app before falling back to adb install -r')
    args = parser.parse_args()
    if (args.browser_only or args.sms_policy_only) and (args.live_consent or args.previous_apk or args.live_update):
        parser.error('Consent and upgrade options require the Android UI checks')
    if args.live_update and not args.previous_apk:
        parser.error('--live-update requires --previous-apk')
    apk = args.apk.resolve(strict=True)
    validate(apk)
    if args.sms_policy_only:
        check_sms_policy(apk, True)
    else:
        if not args.device_only:
            browser_checks(apk)
        if not args.browser_only:
            native_checks(apk, args.previous_apk.resolve(strict=True) if args.previous_apk else None, args.live_update, args.live_consent)
