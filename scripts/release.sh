#!/usr/bin/env bash
#
# 发版脚本：改版本号 → 打包 → 更新 update.json → 提交推送 → 建 GitHub Release。
#
#   scripts/release.sh 1.0.1 "修了 xxx；加了 yyy"
#
# 前置：JAVA_HOME 指向 JDK 17、已安装 Android SDK、gh 已登录。
set -euo pipefail

VERSION="${1:?用法: scripts/release.sh <版本号> [更新说明]}"
NOTES="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/chat-demo"
TAG="v$VERSION"

# 必须 JDK 17（系统默认可能是 21/27，AGP 8.2.1 会直接崩）
JDK17="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
if [ -x "$JDK17/bin/java" ]; then
  export JAVA_HOME="$JDK17"
fi
if ! "$JAVA_HOME/bin/java" -version 2>&1 | grep -q '\"17\.'; then
  echo "错误：需要 JDK 17，当前是 $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)" >&2
  exit 1
fi
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

echo "==> 版本号 → $VERSION"
node -e '
const fs = require("fs");
const path = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.version = process.argv[2];
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
' "$APP/package.json" "$VERSION"

CURRENT_CODE="$(sed -n 's/.*versionCode \([0-9][0-9]*\).*/\1/p' "$APP/android/app/build.gradle" | head -1)"
DATE_CODE="$(date +%y%m%d)"
# 同一天发多次时日期编号不会变化，必须保证 versionCode 单调递增
if [ -n "$CURRENT_CODE" ] && [ "$DATE_CODE" -le "$CURRENT_CODE" ]; then
  VERSION_CODE=$((CURRENT_CODE + 1))
else
  VERSION_CODE="$DATE_CODE"
fi

node -e '
const fs = require("fs");
const path = process.argv[1];
const version = process.argv[2];
const code = Number(process.argv[3]);
let text = fs.readFileSync(path, "utf8");
text = text.replace(/versionCode \d+/, `versionCode ${code}`);
text = text.replace(/versionName "[^"]*"/, `versionName "${version}"`);
fs.writeFileSync(path, text);
' "$APP/android/app/build.gradle" "$VERSION" "$VERSION_CODE"

echo "==> 构建 Web 资源"
(cd "$APP" && pnpm build && npx cap sync android >/dev/null)

echo "==> 打 release APK"
(cd "$APP/android" && ./gradlew assembleRelease --no-daemon)

cp "$APP/android/app/build/outputs/apk/release/app-release.apk" "$ROOT/deepchat.apk"

echo "==> 更新 update.json"
node -e '
const fs = require("fs");
const [file, version, notes] = process.argv.slice(1);
const repo = "leezzou/deepchat";
const manifest = {
  version,
  publishedAt: new Date().toISOString().slice(0, 10),
  notes,
  pageUrl: `https://github.com/${repo}/releases/tag/v${version}`,
  apkUrl: `https://gh-proxy.com/https://github.com/${repo}/releases/download/v${version}/deepchat.apk`,
  apkUrlFallback: `https://github.com/${repo}/releases/download/v${version}/deepchat.apk`,
};
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
' "$ROOT/update.json" "$VERSION" "$NOTES"

echo "==> 提交并推送"
cd "$ROOT"
git add -A
git commit -m "release: $TAG" || echo "（没有需要提交的改动）"
git push origin main

echo "==> 建 Release $TAG"
gh release create "$TAG" "$ROOT/deepchat.apk" \
  --title "DeepChat $TAG" \
  --notes "${NOTES:-DeepChat $TAG}"

echo "==> 完成：https://github.com/leezzou/deepchat/releases/tag/$TAG"
