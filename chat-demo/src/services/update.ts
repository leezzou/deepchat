/**
 * 检查更新：直接读 GitHub Releases（本仓库的最新 release）。
 * 发版流程：改 chat-demo/package.json 的 version → 打包 → gh release create vX.Y.Z deepchat.apk
 */

/** 本项目的 GitHub 仓库，发版与检查更新都指向它 */
export const GITHUB_REPO = 'leezzou/deepchat'

/**
 * 版本清单：仓库根目录的 update.json。
 * 走 raw.githubusercontent（CDN，没有 API 的 60 次/小时限制），API 只在清单缺失时兜底。
 */
const MANIFEST_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/update.json`

/** 去掉 v 前缀与预发布后缀，只留 x.y.z */
const normalizeVersion = (value: string): string =>
  value
    .trim()
    .replace(/^v/i, '')
    .split(/[-+]/)[0]

/** 逐段数字比较；a>b 返回 1，相等 0，a<b 返回 -1 */
export const compareVersions = (a: string, b: string): number => {
  const left = normalizeVersion(a)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  const right = normalizeVersion(b)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) {
      return diff > 0 ? 1 : -1
    }
  }
  return 0
}

export type ReleaseInfo = {
  /** 归一化后的版本号，如 1.0.1 */
  version: string
  /** 原始 tag，如 v1.0.1 */
  tag: string
  notes: string
  pageUrl: string
  /** release 里上传的 APK 直链，没有则为 null */
  apkUrl: string | null
}

type GithubRelease = {
  tag_name?: unknown
  body?: unknown
  html_url?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: { name?: unknown; browser_download_url?: unknown }[]
}

type Manifest = {
  version?: unknown
  notes?: unknown
  pageUrl?: unknown
  apkUrl?: unknown
  publishedAt?: unknown
}

const parseManifest = (data: Manifest): ReleaseInfo | null => {
  if (typeof data.version !== 'string' || !data.version.trim()) {
    return null
  }
  return {
    version: normalizeVersion(data.version),
    tag: `v${normalizeVersion(data.version)}`,
    notes: typeof data.notes === 'string' ? data.notes : '',
    pageUrl: typeof data.pageUrl === 'string' ? data.pageUrl : '',
    apkUrl: typeof data.apkUrl === 'string' && data.apkUrl ? data.apkUrl : null,
  }
}

/** 优先读 update.json；没有清单（老仓库/发版脚本没跑）时回退到 Releases API */
export const fetchLatestRelease = async (): Promise<ReleaseInfo | null> => {
  try {
    // 加时间戳绕过 CDN 缓存，否则刚发版可能还拿到旧版本号
    const response = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' })
    if (response.ok) {
      const parsed = parseManifest((await response.json()) as Manifest)
      if (parsed) {
        return parsed
      }
    }
  } catch {
    // 清单读不到就走下面的 API
  }
  return fetchLatestFromApi()
}

/** 回退方案：GitHub Releases API（未登录 60 次/小时 / IP，只作兜底） */
const fetchLatestFromApi = async (): Promise<ReleaseInfo | null> => {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    // 结果随时会变，别让 WebView 缓存住
    cache: 'no-store',
  })
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`GitHub ${response.status}`)
  }
  const data = (await response.json()) as GithubRelease
  if (typeof data.tag_name !== 'string' || data.draft === true) {
    return null
  }
  const apk = (data.assets ?? []).find(
    (asset) => typeof asset.name === 'string' && asset.name.toLowerCase().endsWith('.apk')
  )
  return {
    version: normalizeVersion(data.tag_name),
    tag: data.tag_name,
    notes: typeof data.body === 'string' ? data.body : '',
    pageUrl: typeof data.html_url === 'string' ? data.html_url : '',
    apkUrl: typeof apk?.browser_download_url === 'string' ? apk.browser_download_url : null,
  }
}
