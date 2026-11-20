import { clip, type SearchHit } from './search.js'

const comparisonIntent =
  /比较|对比|哪[款个台家种]|谁更|更划算|这两|它们|分别|各[卖要]|\b(?:compare|versus|vs|which)\b/i
const freshIntent =
  /最近|近期|最新|目前|现在|当前|今天|今日|本月|今年|这周|本周|\b(?:recent|latest|currently|today|this (?:week|month|year))\b/i
const priced = /多少[钱元]|售价|现价|价格|到手价|贵不贵|划算|\b(?:cost|price|pricing)\b/i
const measured = /续航|规格|性能|参数|实测|\b(?:specifications?|benchmark|battery life)\b/i
export function taskSignals(question: string, now = new Date()) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const fresh = freshIntent.test(question)
  const explicitWindow =
    /(?:19|20)\d{2}|(?:最近|过去|近)\s*[一二三四五六七八九十两半\d]+\s*(?:天|周|个月|月|年)|(?:last|past)\s+\d+\s+(?:days?|weeks?|months?|years?)/i.test(
      question
    )
  const dateHint =
    !fresh || explicitWindow
      ? ''
      : /今天|今日|\btoday\b/i.test(question)
        ? today
        : /今年|this year/i.test(question)
          ? today.slice(0, 4)
          : today.slice(0, 7)
  return {
    today,
    fresh,
    dateHint,
    rankByRecency: fresh && !explicitWindow,
    thorough:
      /逐[一篇页条个项]|每[篇页个一项]|详细(?:核对|核实|查证)|全面|全部|所有|\b(?:each|every|all sources|comprehensive)\b/i.test(
        question
      ),
    compare: comparisonIntent.test(question),
    price: priced.test(question),
    measured: measured.test(question),
  }
}
export type Signals = ReturnType<typeof taskSignals>

type Focus = { signals: Signals; subjects: string[]; queries: string[]; evidenceTerms?: string[] }
const normalize = (text: string) => text.normalize('NFKC').toLowerCase()
const identity = (text: string) => normalize(text).replace(/[^\p{L}\p{N}]/gu, '')
const stop =
  /^(?:最近|最新|官方|国内|新闻|哪款|这两|两款|它们|多少|可以|帮我|the|and|for|source|documentation|primary|current|20\d\d|\d)$/
function keywords(query: string) {
  const terms = new Set<string>()
  for (const block of normalize(query).match(/[\u3400-\u9fff]+|[\p{L}\p{N}]+/gu) || []) {
    if (/^[\u3400-\u9fff]/u.test(block)) {
      for (let i = 0; i + 1 < block.length; i++) {
        terms.add(block.slice(i, i + 2))
      }
    } else {
      terms.add(block)
    }
  }
  return [...terms].filter((term) => !stop.test(term)).slice(0, 40)
}
function overlap(terms: string[], text: string) {
  const lower = normalize(text)
  return terms.reduce((count, term) => count + Number(lower.includes(normalize(term))), 0)
}

// Score the title/snippet against this turn. Tencent rank breaks ties and unknown dates stay unknown.
export function assessHits(hits: SearchHit[], focus: Focus) {
  const terms = focus.queries.map(keywords)
  const longestFirst = [...focus.subjects].sort((a, b) => b.length - a.length)
  return hits
    .map((hit) => {
      const { title, snippet, page_age } = hit.source
      const text = `${title} ${snippet}`
      const key = identity(text)
      // A listing for a Plus/Pro variant does not also establish a price for the base model.
      let rest = key
      const subjects = longestFirst.filter((name) => {
        const term = identity(name)
        if (!term || !rest.includes(term)) {
          return false
        }
        rest = rest.split(term).join(' ')
        return true
      })
      const matches = Math.max(0, ...terms.map((query) => overlap(query, text)))
      let age = NaN
      if (focus.signals.rankByRecency && page_age) {
        const date = /\b(20\d\d)[年/-](\d{1,2})[月/-](\d{1,2})/.exec(page_age)
        if (date) {
          age =
            (Date.parse(focus.signals.today) - Date.UTC(+date[1], +date[2] - 1, +date[3])) /
            86400000
        }
      }
      const stale = age > 180
      const relevant = !stale && (focus.subjects.length ? subjects.length > 0 : matches > 0)
      const score =
        (stale ? -10 : age >= 0 && age <= 45 ? 2 : 0) +
        (subjects.length ? 5 : 0) +
        Math.min(6, matches) +
        Number(terms.some((query) => overlap(query, title) > 0))
      return { hit, score, relevant, subjects, stale }
    })
    .sort((a, b) => b.score - a.score)
}

export function enoughEvidence(ranked: ReturnType<typeof assessHits>, focus: Focus) {
  const useful = ranked.filter(
    ({ relevant, hit }) => relevant && hit.source.snippet.trim().length >= 20
  )
  if (new Set(useful.map(({ hit }) => hit.source.snippet.trim())).size < 2) {
    return false
  }
  if (focus.signals.compare && !focus.subjects.length) {
    return false
  }
  return focus.subjects.every((name) => useful.some((row) => row.subjects.includes(name)))
}

export function readOrder(
  ranked: ReturnType<typeof assessHits>,
  subjects: string[],
  thorough: boolean
) {
  let available = ranked.filter(({ hit }) => hit.readKey)
  if (!thorough && available.some((row) => row.relevant)) {
    available = available.filter((row) => row.relevant)
  }
  const priority = new Set<SearchHit>()
  for (const subject of subjects) {
    const first = available.find((row) => row.subjects.includes(subject))
    if (first) {
      priority.add(first.hit)
    }
  }
  const sites = new Set([...priority].map((hit) => hit.source.site_name))
  for (const { hit } of available) {
    if (!sites.has(hit.source.site_name)) {
      sites.add(hit.source.site_name)
      priority.add(hit)
    }
  }
  return [...new Set([...priority, ...available.map(({ hit }) => hit)])]
}

// Retain the strongest contiguous passage, including conditions/units surrounding the match.
export function pagePassage(text: string, focus: Focus, limit: number) {
  const query = focus.queries.join(' ')
  const terms = keywords(query)
  const anchors = focus.evidenceTerms || []
  const battery = /续航|电池|battery|runtime/i.test(query)
  const cleaned = text.replace(/\r\n/g, '\n').trim()
  if (new TextEncoder().encode(cleaned).length <= limit) {
    return cleaned
  }
  const size = Math.max(100, Math.floor(limit / 5))
  let best = 0,
    bestScore = -1
  for (let i = 0; i < cleaned.length; i += Math.max(1, Math.floor(size / 2))) {
    const chunk = cleaned.slice(i, i + size)
    let score = overlap(terms, chunk) + 4 * overlap(anchors, chunk)
    if (
      focus.signals.price &&
      /(?:\d[\d,.]*\s*(?:元|美元|港币|人民币|USD|CNY)|[¥￥$]\s*\d)/i.test(chunk)
    ) {
      score += 6
    }
    if (battery) {
      if (/电池|battery|连续播放|视频播放|播放时间|续航/i.test(chunk)) {
        score += 4
      }
      if (/\d+(?:\.\d+)?\s*(?:小时|分钟|hours?|minutes?|hrs?\b)/i.test(chunk)) {
        score += 6
      }
    } else if (focus.signals.measured && /\d+(?:\.\d+)?\s*(?:GB|W|kg|km)\b/i.test(chunk)) {
      score += 2
    }
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  const before = cleaned.lastIndexOf('\n', best)
  const start = before >= Math.max(0, best - 80) ? before + 1 : best
  return clip(cleaned.slice(start).trimStart(), limit)
}

export function supplemental(query: string, s: Signals) {
  const zh = /[\u3400-\u9fff]/u.test(query)
  const angle = s.price
    ? zh
      ? '在售 报价'
      : 'current retail price'
    : s.measured || s.compare
      ? zh
        ? '规格 独立实测'
        : 'specifications independent review'
      : s.fresh
        ? zh
          ? '最新公告'
          : 'latest announcement'
        : zh
          ? '官方资料'
          : 'primary source documentation'
  return `${clip(query, 190)} ${angle}`
}
