#!/usr/bin/env bash
# 把 Gitee 私人令牌存入 macOS 钥匙串，供 release.sh 使用。
set -euo pipefail
USER_NAME="${GITEE_USER:-yllzz}"
printf 'Gitee 用户名 [%s]: ' "$USER_NAME"
read -r input
USER_NAME="${input:-$USER_NAME}"
printf 'Gitee 私人令牌: '
read -rs TOKEN
printf '\n'
if [ -z "$TOKEN" ]; then
  echo '令牌为空，已取消。' >&2
  exit 1
fi
security add-generic-password -U -a "$USER_NAME" -s gitee-token -w "$TOKEN"
unset TOKEN
echo "已保存到钥匙串：account=$USER_NAME service=gitee-token"
