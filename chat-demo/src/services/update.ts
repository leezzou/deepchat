/**
 * 检查更新：优先读 Gitee 镜像清单，失败后走 ghfast/GitHub raw，最后回退 GitHub Releases API。
 * 发版流程见 scripts/release.sh（GitHub 主仓库 + Gitee 镜像双发）。
 */

/** 本项目的 GitHub 仓库，发版与检查更新都指向它 */
export const GITHUB_REPO = 'leezzou/deepchat'

/**
 * 版本清单：仓库根目录的 update.json。
 * 国内优先读 Gitee 镜像，失败再走 ghfast/GitHub raw，最后才用 GitHub Releases API 兜底。
 */
const GITEE_MANIFEST_URL = 'https://gitee.com/api/v5/repos/yllzz/deepchat/contents/update.json'
const GITHUB_MANIFEST_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/update.json`
const GITHUB_MANIFEST_URLS = [
  `https://ghfast.top/${GITHUB_MANIFEST_URL}`,
  GITHUB_MANIFEST_URL,
]

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
  /** APK 下载兜底地址 */
  apkUrlFallback: string | null
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
  apkUrlFallback?: unknown
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
    apkUrlFallback:
      typeof data.apkUrlFallback === 'string' && data.apkUrlFallback
        ? data.apkUrlFallback
        : null,
  }
}

/** 优先读 update.json；没有清单（老仓库/发版脚本没跑）时回退到 Releases API */
const fetchGiteeManifest = async (): Promise<ReleaseInfo | null> => {
  try {
    const response = await fetch(`${GITEE_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' })
    if (!response.ok) {
      return null
    }
    const file = (await response.json()) as { content?: unknown; encoding?: unknown }
    if (file.encoding !== 'base64' || typeof file.content !== 'string') {
      return null
    }
    const binary = atob(file.content.replace(/\s/g, ''))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return parseManifest(JSON.parse(new TextDecoder().decode(bytes)) as Manifest)
  } catch {
    return null
  }
}

const fetchLatestReleaseUncached = async (): Promise<ReleaseInfo | null> => {
  const mirrored = await fetchGiteeManifest()
  if (mirrored) {
    return mirrored
  }
  for (const manifestUrl of GITHUB_MANIFEST_URLS) {
    try {
      // 加时间戳绕过 CDN 缓存，否则刚发版可能还拿到旧版本号
      const response = await fetch(`${manifestUrl}?t=${Date.now()}`, { cache: 'no-store' })
      if (response.ok) {
        const parsed = parseManifest((await response.json()) as Manifest)
        if (parsed) {
          return parsed
        }
      }
    } catch {
      // 当前清单源不可用，继续尝试下一个
    }
  }
  return fetchLatestFromApi()
}

/** Gitee API 未登录限流约 60 次/小时，前台每 60 秒检查一次，缓存两分钟避免打满。 */
const MANIFEST_CACHE_MS = 2 * 60 * 1000
let manifestCache: { at: number; result: Promise<ReleaseInfo | null> } | null = null

export const fetchLatestRelease = async (): Promise<ReleaseInfo | null> => {
  const now = Date.now()
  if (manifestCache && now - manifestCache.at < MANIFEST_CACHE_MS) {
    return manifestCache.result
  }
  const result = fetchLatestReleaseUncached()
  manifestCache = { at: now, result }
  try {
    return await result
  } catch (error) {
    if (manifestCache?.result === result) {
      manifestCache = null
    }
    throw error
  }
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
    apkUrlFallback: null,
  }
}
