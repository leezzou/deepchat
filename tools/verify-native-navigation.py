"""Exercise toolbar and Android Back against the signed app on the offline release-test AVD.

Run after installing the app: python3 tools/verify-native-navigation.py
"""
from pathlib import Path
import runpy

# Reuse the release suite's device guard, UI Automator matchers and adb serial.
release = runpy.run_path(str(Path(__file__).with_name('verify-workbuddy-release.py')))
adb, guard, wait, tap = (release[key] for key in ('adb', 'guard_device', 'wait_for', 'tap'))
package = release['PACKAGE']


def open_item(label):
    tap(wait(label)[0])


def back():
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')


if __name__ == '__main__':
    guard()
    drawer = r'打开边栏|Open sidebar'
    adb('shell', 'wm', 'dismiss-keyguard')
    if release['match'](release['tree'](), drawer) is None:
        # Restart after other suites leave dialogs open. Keep all records and settings.
        adb('shell', 'am', 'force-stop', package)
        adb('shell', 'am', 'start', '-W', '-n', package + '/.MainActivity')
        try:
            wait(drawer)
        except AssertionError:
            wait(drawer)  # Cold WebView startup can exceed one UI Automator observation window.
    settings = r'设置|Settings'
    memory = r'记忆|Memory'
    add = r'添加记忆|Add memory'
    toolbar_back = r'返回|Back'
    favorites = r'收藏|Favorites'
    empty_favorites = r'长按一条回复.*|Press and hold a reply.*'
    open_item(drawer)
    open_item(favorites)
    wait(empty_favorites)
    open_item(memory)
    wait(add)
    back()
    wait(empty_favorites)
    open_item(memory)
    open_item(toolbar_back)
    wait(empty_favorites)
    print('PASS Android history → memory → unchanged Favorites, via hardware and toolbar Back', flush=True)
    open_item(settings)
    open_item(memory)
    open_item(add)
    wait(r'取消|Cancel')
    back()
    wait(add)
    open_item(toolbar_back)
    sign_in = r'登录 DeepSeek 账号|登录 DeepSeek|Sign in to DeepSeek'
    open_item(sign_in)
    wait(r'DeepSeek 账号')
    back()
    wait(sign_in)
    back()
    wait(empty_favorites)
    back()
    wait(r'搜索历史对话|Search chat history')
    back()
    wait(drawer)
    print('PASS Android settings → memory editor → memory → settings, native account → settings → original drawer → chat', flush=True)
