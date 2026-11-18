#!/usr/bin/env bash
#
# 发版脚本：改版本号 → 打包 → 更新 update.json → 提交推送 GitHub/Gitee → 建两边 Release。
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
GITHUB_REPO="${GITHUB_REPO:-leezzou/deepchat}"
GITEE_REPO="${GITEE_REPO:-yllzz/deepchat}"
GITEE_USER="${GITEE_USER:-yllzz}"
# 优先读取环境变量，其次读取 macOS 钥匙串；不要把令牌写进脚本。
if [ -z "${GITEE_TOKEN:-}" ] && command -v security >/dev/null 2>&1; then
  GITEE_TOKEN="$(security find-generic-password -a "$GITEE_USER" -s gitee-token -w 2>/dev/null || true)"
fi

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
const [file, version, notes, giteeRepo, githubRepo] = process.argv.slice(1);
const manifest = {
  version,
  publishedAt: new Date().toISOString().slice(0, 10),
  notes,
  pageUrl: `https://gitee.com/${giteeRepo}/releases/tag/v${version}`,
  apkUrl: `https://gitee.com/${giteeRepo}/releases/download/v${version}/deepchat.apk`,
  apkUrlFallback: `https://ghfast.top/https://github.com/${githubRepo}/releases/download/v${version}/deepchat.apk`,
};
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
' "$ROOT/update.json" "$VERSION" "$NOTES" "$GITEE_REPO" "$GITHUB_REPO"

echo "==> 更新 README 下载版本"
node -e '
const fs = require("fs");
const [file, version, giteeRepo] = process.argv.slice(1);
const next = `https://gitee.com/${giteeRepo}/releases/download/v${version}/deepchat.apk`;
let text = fs.readFileSync(file, "utf8");
text = text.replace(/https:\/\/gitee\.com\/[^/]+\/[^/]+\/releases\/download\/v[0-9.]+\/deepchat\.apk/g, next);
fs.writeFileSync(file, text);
' "$ROOT/README.md" "$VERSION" "$GITEE_REPO"

echo "==> 提交并推送 GitHub"
cd "$ROOT"
git add -A
git commit -m "release: $TAG" || echo "（没有需要提交的改动）"
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  git tag "$TAG"
fi
git push origin main
git push origin "$TAG"

echo "==> 建 GitHub Release"
gh release create "$TAG" "$ROOT/deepchat.apk" \
  --title "DeepChat $TAG" \
  --notes "${NOTES:-DeepChat $TAG}"

GITEE_OK=0
echo "==> 同步 Gitee 镜像"
if [ -z "${GITEE_TOKEN:-}" ]; then
  echo "警告：未找到 Gitee 令牌。请先运行 scripts/setup-gitee-token.sh，或设置 GITEE_TOKEN。" >&2
else
  export GITEE_TOKEN GITEE_USER GITEE_REPO
  ASKPASS="$(mktemp)"
  trap 'rm -f "$ASKPASS"' EXIT
  cat > "$ASKPASS" <<'SH'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' "$GITEE_USER" ;;
  *Password*) printf '%s\n' "$GITEE_TOKEN" ;;
esac
SH
  chmod 700 "$ASKPASS"
  export GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0
  if git -c credential.helper= push gitee main &&
     git -c credential.helper= push gitee "$TAG" &&
     python3 "$ROOT/scripts/publish-gitee.py" "$VERSION" "$NOTES" "$ROOT/deepchat.apk"; then
    GITEE_OK=1
  fi
fi

echo "==> 完成"
echo "GitHub: https://github.com/$GITHUB_REPO/releases/tag/$TAG"
if [ "$GITEE_OK" = 1 ]; then
  echo "Gitee:  https://gitee.com/$GITEE_REPO/releases/tag/$TAG"
else
  echo "Gitee 同步未完成；GitHub 已发布。修复 Gitee 授权后可重试。" >&2
  exit 1
fi
