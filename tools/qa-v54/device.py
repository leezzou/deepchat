"""Run the published 53→54 upgrade and Android WebView UI on a new scratch guest.
Usage: python3 tools/qa-v54/device.py <published-v54.apk> <previous-v53.apk> <new-output-dir>
Call AFTER release notification. No existing emulator data or AVD is opened.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import socket
import subprocess
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('previous_qa', HERE.parent / 'verify-workbuddy-release.py')
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


def choose_port():
    attached = subprocess.check_output([qa.SDK / 'platform-tools/adb', 'devices'], text=True)
    for port in range(5572, 5680, 2):
        if f'emulator-{port}' in attached:
            continue
        with socket.socket() as first, socket.socket() as second:
            try:
                first.bind(('127.0.0.1', port))
                second.bind(('127.0.0.1', port+1))
                return port
            except OSError:
                pass
    raise RuntimeError('Need a free emulator port')


def start_guest(root, log):
    home = root / 'avd'
    home.mkdir()
    avd = 'DeepChatV54QA' + uuid.uuid4().hex[:8]
    path = home / (avd + '.avd')
    path.mkdir()
    abi = 'arm64-v8a' if platform.machine() in ('aarch64','arm64') else 'x86_64'
    image = f'system-images/android-34/google_apis/{abi}/'
    assert (qa.SDK / image / 'system.img').is_file(), 'Install Google APIs API 34 system image'
    (home / (avd+'.ini')).write_text(f'avd.ini.encoding=UTF-8\npath={path}\ntarget=android-34\n')
    (path / 'config.ini').write_text(f'''avd.ini.encoding=UTF-8
AvdId={avd}
avd.ini.displayname={avd}
hw.device.name=pixel_7
hw.device.manufacturer=Google
hw.lcd.width=1080
hw.lcd.height=2400
hw.lcd.density=420
hw.ramSize=2800
hw.gpu.enabled=yes
hw.gpu.mode=auto
hw.keyboard=yes
hw.mainKeys=no
hw.audioInput=no
hw.audioOutput=no
hw.cpu.ncore=4
hw.cpu.arch={'arm64' if abi=='arm64-v8a' else 'x86_64'}
abi.type={abi}
image.sysdir.1={image}
tag.id=google_apis
tag.display=Google APIs
target=android-34
showDeviceFrame=no
disk.dataPartition.size=3G
''')
    port = choose_port()
    qa.SERIAL = f'emulator-{port}'
    env = dict(os.environ, ANDROID_AVD_HOME=str(home), ANDROID_EMULATOR_HOME=str(root / 'emulator'))
    proc = subprocess.Popen([qa.SDK / 'emulator/emulator', '-avd', avd, '-port', str(port), '-no-window', '-no-snapshot', '-no-audio', '-no-boot-anim', '-gpu', 'swiftshader_indirect'], env=env, stdout=log, stderr=log)
    try:
        deadline=time.monotonic()+150
        while time.monotonic()<deadline:
            assert proc.poll() is None, 'Emulator failed to launch, see emulator.log'
            result=subprocess.run([qa.SDK/'platform-tools/adb','-s',qa.SERIAL,'shell','getprop','sys.boot_completed'],capture_output=True,text=True,timeout=8)
            if result.returncode==0 and result.stdout.strip()=='1':
                break
            time.sleep(1)
        else:
            raise RuntimeError('Scratch emulator did not boot')
        assert qa.adb('emu','avd','name').splitlines()[0]==avd, 'Port does not belong to this scratch AVD'
        qa.adb('shell','cmd','connectivity','airplane-mode','enable')
        qa.adb('shell','svc','wifi','disable')
        qa.adb('shell','svc','data','disable')
        assert qa.adb('shell','cmd','connectivity','airplane-mode').strip()=='enabled'
        assert not re.search(r'^default ',qa.adb('shell','ip','route'), re.M)
        assert f'package:{qa.PACKAGE}' not in qa.adb('shell','pm','list','packages',qa.PACKAGE).splitlines()
        return proc
    except BaseException:
        proc.terminate()
        proc.wait(timeout=25)
        raise


def tap(pattern, scroll=False):
    qa.tap(qa.wait_for(pattern, allow_scroll=scroll)[0])


def settings():
    qa.start_app()
    tap(r'(?:打开边栏|Open sidebar).*')
    tap('设置|Settings')


def backup_switch():
    tap('数据管理|Data',True)
    deadline=time.monotonic()+22
    while time.monotonic()<deadline:
        nodes=qa.tree()
        for n in nodes:
            if n.get('checkable')=='true' and any(re.search('自动备份|automatic backup',s,re.I) for s in qa.labels(n)):
                return n
        size=list(map(int,re.findall(r'(\d+)x(\d+)',qa.adb('shell','wm','size'))[-1]))
        x,y=size[0]//2,size[1]
        qa.adb('shell','input','swipe',str(x),str(y*3//4),str(x),str(y//3),'300')
    raise AssertionError('Missing accessible automatic backup switch')


def shot(out, name):
    data=subprocess.check_output([qa.SDK/'platform-tools/adb','-s',qa.SERIAL,'exec-out','screencap','-p'])
    assert data.startswith(b'\x89PNG\r\n\x1a\n')
    (out / (name+'.png')).write_bytes(data)


def inspect(apk,previous,out):
    assert qa.validate(apk)==('1.0.54','261162')
    assert qa.validate(previous,previous=True)==('1.0.53','261161')
    out.mkdir(parents=True,exist_ok=False)
    report={'stage':'published-emulator','account':'signed out, factory-new isolated Android guest','checks':[]}
    try:
        with tempfile.TemporaryDirectory(prefix='deepchat-v54-android-') as temp, (out/'emulator.log').open('wb') as log:
            proc=start_guest(Path(temp),log)
            try:
                qa.adb('install',str(previous))
                before=qa.package_state()
                qa.start_app()
                _, nodes = qa.wait_for(r'(?:打开边栏|Open sidebar).*')
                composer = next(node for node in nodes if node.get('class') == 'android.widget.EditText')
                qa.tap(composer)
                draft = 'qa54-upgrade-draft'
                qa.adb('shell', 'input', 'text', draft)
                qa.wait_for(re.escape(draft))
                qa.adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
                qa.adb('shell','am','force-stop',qa.PACKAGE)
                qa.start_app()
                qa.wait_for(re.escape(draft))
                qa.adb('shell','am','force-stop',qa.PACKAGE)
                qa.adb('install','-r',str(apk))
                after=qa.package_state()
                assert before[:2]==('1.0.53','261161') and after==('1.0.54','261162',*before[2:])
                base=qa.adb('shell','pm','path',qa.PACKAGE).strip().removeprefix('package:')
                assert re.fullmatch(r'/data/app/[\w/+=.~\-]+/base\.apk',base)
                digest=hashlib.sha256(apk.read_bytes()).hexdigest()
                assert qa.adb('shell','sha256sum',base).split()[0]==digest
                report.update(apkSha256=digest,upgrade='adb install -r',before=before,after=after)
                qa.start_app()
                qa.wait_for(re.escape(draft))
                shot(out, 'android-preserved-draft')
                report['checks'].append('53 → 54 release-signed upgrade retained the unsent draft, UID and first install time')
                settings()
                switch=backup_switch()
                assert switch.get('checked')=='true', 'The new auto-backup preference must default to enabled'
                qa.tap(switch)
                assert any(n.get('checkable')=='true' and n.get('checked')=='false' and any(re.search('自动备份|automatic backup',s,re.I) for s in qa.labels(n)) for n in qa.tree())
                shot(out,'android-backup')
                report['checks'].append('New automatic-backup setting opens enabled and can be turned off')
                qa.adb('shell','input','keyevent','KEYCODE_BACK')
                tap('模型上下文|Model context|Model contexts',True)
                qa.wait_for('.*(?:tokens|Token|上下文窗口|Context window).*')
                shot(out,'android-context')
                qa.adb('shell','input','keyevent','KEYCODE_BACK')
                qa.wait_for('设置|Settings')
                report['checks'].append('Android WebView opened model contexts, then hardware Back returned to Settings')
                tap(qa.ACCOUNT,True)
                qa.wait_for('未登录|Signed out')
                shot(out,'android-signed-out-account')
                report['checks'].append('WorkBuddy account opens signed out')
            finally:
                proc.terminate()
                try: proc.wait(timeout=25)
                except subprocess.TimeoutExpired:
                    proc.kill(); proc.wait()
        report['status']='pass'
    except BaseException as exc:
        report.update(status='fail',error=str(exc)); raise
    finally:
        (out/'device-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for arg in ['published_apk','previous_apk','new_evidence_directory']:
        parser.add_argument(arg,type=Path)
    args=parser.parse_args()
    inspect(args.published_apk.resolve(strict=True),args.previous_apk.resolve(strict=True),args.new_evidence_directory.resolve())
