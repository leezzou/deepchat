import type { Nodes } from 'mdast'
import { parseMarkdown } from '../markdown/parse.js'

/** Text for the system share sheet and clipboard. Code and escaped punctuation are literal. */
export function asPlainText(markdown: string): string {
  const root = parseMarkdown(markdown)
  const definitions = new Map<string, string>()
  const collect = (node: Nodes) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url)
    }
    if ('children' in node) {
      node.children.forEach(collect)
    }
  }
  collect(root)
  // A plain-text destination has no clickable label, so keep the address available.
  const link = (label: string, url?: string) =>
    !url || label === url ? label : `${label} (${url})`
  function render(node: Nodes): string {
    const children = (separator = '') =>
      'children' in node ? node.children.map(render).join(separator) : ''
    switch (node.type) {
      case 'root':
      case 'blockquote':
      case 'listItem':
        return node.children.map(render).filter(Boolean).join('\n\n')
      case 'footnoteDefinition':
        return `[${node.label ?? node.identifier}] ${children('\n\n')}`
      case 'list':
        return node.children
          .map((item, index) => {
            const marker = node.ordered ? `${(node.start ?? 1) + index}. ` : '• '
            const check = typeof item.checked === 'boolean' ? (item.checked ? '☑ ' : '☐ ') : ''
            return marker + check + render(item).replace(/\n/g, '\n  ')
          })
          .join('\n')
      case 'table':
        return children('\n')
      case 'tableRow':
        return children('\t')
      case 'break':
        return '\n'
      case 'thematicBreak':
        return '────────'
      case 'definition':
        return ''
      case 'footnoteReference':
        return `[${node.label ?? node.identifier}]`
      case 'link':
        return link(children(), node.url)
      case 'image':
        return link(node.alt || node.url, node.url)
      case 'linkReference':
        return link(children(), definitions.get(node.identifier))
      case 'imageReference':
        return link(node.alt || node.label || '', definitions.get(node.identifier))
      case 'citation':
        return String(node.source.index)
      case 'html':
        return /^<br\s*\/?\s*>$/i.test(node.value) ? '\n' : node.value
      default:
        return 'value' in node ? node.value : children()
    }
  }
  return render(root)
}
