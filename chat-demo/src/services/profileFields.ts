// Native is the authority for sign-in. Project only public display fields from its status frame.
export const profileName = (value: unknown): string =>
  typeof value === 'string'
    ? Array.from(value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '').trim())
        .slice(0, 80)
        .join('')
    : ''

export function profileAvatar(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !value.startsWith('https://') ||
    /[\\\s]/u.test(value)
  ) {
    return null
  }
  try {
    const url = new URL(value)
    if (
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !/^[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z]{2,}$/i.test(url.hostname) ||
      /\.(?:local|localhost)$/i.test(url.hostname)
    ) {
      return null
    }
    for (const param of url.searchParams.keys()) {
      const key = param.toLowerCase().replace(/[_-]/g, '')
      if (
        /^(?:(?:access|refresh|id|auth|xdshauth)?token|authorization|apikey|password)$/.test(key)
      ) {
        return null
      }
    }
    return url.href
  } catch {
    return null
  }
}

export const validRevision = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
