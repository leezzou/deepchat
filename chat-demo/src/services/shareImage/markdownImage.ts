import type { Nodes, PhrasingContent } from 'mdast'
import { parseMarkdown } from '../markdown/parse.js'

export type Ink = {
  bold?: boolean
  italic?: boolean
  code?: boolean
  link?: boolean
  strike?: boolean
  math?: boolean
}
export type Run = Ink & { text: string }
export type Paragraph = {
  type: 'paragraph'
  runs: Run[]
  heading?: number
  code?: boolean
  math?: boolean
}
export type Block =
  | Paragraph
  | { type: 'rule' }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; items: { marker: string; blocks: Block[] }[] }
  | { type: 'table'; rows: Run[][][]; align: ('left' | 'center' | 'right' | null)[] }

// Canvas has no math layout engine. Use lossless Unicode equivalents for simple expressions.
// Keep unsupported TeX intact, including grouping, and never interpret it as Markdown or HTML.
const mathSymbols: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  phi: 'φ',
  omega: 'ω',
  Delta: 'Δ',
  Sigma: 'Σ',
  Omega: 'Ω',
  times: '×',
  cdot: '·',
  pm: '±',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  infty: '∞',
  approx: '≈',
  to: '→',
  rightarrow: '→',
}
function formula(value: string) {
  const supers = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻',
    subs = '₀₁₂₃₄₅₆₇₈₉₊₋'
  const result = value
    .replace(/\\([a-zA-Z]+)\s*/g, (original, name: string) =>
      Object.hasOwn(mathSymbols, name) ? mathSymbols[name] : original
    )
    .replace(
      /([_^])(?:\{([+\-0-9]+)\}|([0-9]))/g,
      (_, op: string, many: string | undefined, one: string) =>
        Array.from(
          many ?? one,
          (ch) => (op === '^' ? supers : subs)['0123456789+-'.indexOf(ch)]
        ).join('')
    )
  return /[\\{}_^%&#~]/.test(result) ? value : result
}

/** Only text and presentation survive this boundary. No HTML elements, URLs or resource loaders. */
export function imageMarkdown(source: string, citationIndices?: readonly number[]): Block[] {
  const citations = citationIndices && new Set(citationIndices)
  function inline(nodes: PhrasingContent[], ink: Ink = {}): Run[] {
    return nodes.flatMap((node): Run[] => {
      switch (node.type) {
        case 'strong':
          return inline(node.children, { ...ink, bold: true })
        case 'emphasis':
          return inline(node.children, { ...ink, italic: true })
        case 'delete':
          return inline(node.children, { ...ink, strike: true })
        case 'link':
        case 'linkReference':
          return inline(node.children, { ...ink, link: true })
        case 'image':
        case 'imageReference':
          return [{ ...ink, text: node.alt ?? '' }]
        case 'inlineCode':
          return [{ ...ink, code: true, text: node.value }]
        case 'inlineMath':
          return [{ ...ink, math: true, text: formula(node.value) }]
        case 'break':
          return [{ ...ink, text: '\n' }]
        case 'html':
          return [{ ...ink, text: /^<br\s*\/?\s*>$/i.test(node.value) ? '\n' : node.value }]
        case 'footnoteReference':
          return [{ ...ink, text: `[${node.label ?? node.identifier}]` }]
        case 'citation':
          return [{ ...ink, text: `[${node.source.index}]` }]
        case 'text':
          return [
            {
              ...ink,
              text: citations
                ? node.value.replace(/\[citation:(\d+)\]/g, (_, id: string) =>
                    citations.has(Number(id)) ? `[${Number(id)}]` : ''
                  )
                : node.value,
            },
          ]
      }
    })
  }
  function blocks(nodes: Nodes[]): Block[] {
    return nodes.flatMap((node): Block[] => {
      switch (node.type) {
        case 'root':
        case 'listItem':
          return blocks(node.children)
        case 'blockquote':
          return [{ type: 'quote', blocks: blocks(node.children) }]
        case 'list':
          return [
            {
              type: 'list',
              items: node.children.map((item, i) => ({
                marker:
                  typeof item.checked === 'boolean'
                    ? item.checked
                      ? '☑'
                      : '☐'
                    : node.ordered
                      ? `${(node.start ?? 1) + i}.`
                      : '•',
                blocks: blocks(item.children),
              })),
            },
          ]
        case 'heading':
          return [{ type: 'paragraph', heading: node.depth, runs: inline(node.children) }]
        case 'paragraph':
          return [{ type: 'paragraph', runs: inline(node.children) }]
        case 'code':
          return [{ type: 'paragraph', code: true, runs: [{ code: true, text: node.value }] }]
        case 'math':
          return [
            { type: 'paragraph', math: true, runs: [{ math: true, text: formula(node.value) }] },
          ]
        case 'thematicBreak':
          return [{ type: 'rule' }]
        case 'table':
          return [
            {
              type: 'table',
              align: node.align ?? [],
              rows: node.children.map((row) => row.children.map((cell) => inline(cell.children))),
            },
          ]
        case 'footnoteDefinition':
          return [
            { type: 'paragraph', runs: [{ text: `[${node.label ?? node.identifier}]` }] },
            ...blocks(node.children),
          ]
        case 'html':
          return [
            {
              type: 'paragraph',
              runs: [{ text: /^<br\s*\/?\s*>$/i.test(node.value) ? '\n' : node.value }],
            },
          ]
        default:
          return []
      }
    })
  }
  return blocks(parseMarkdown(source).children)
}
