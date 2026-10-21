// Markup the visual editor keeps unchanged. Anything else (inline styles, classes, tables, block comments
// from Gutenberg, embeds) would be dropped on the first edit, so such texts open in the HTML view.
const supportedTags = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'STRIKE', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'A', 'BLOCKQUOTE', 'HR'])
const supportedAttributes: Record<string, string[]> = { A: ['href', 'target', 'rel'] }
const blockTags = /<(p|div|h[1-6]|ul|ol|li|blockquote|pre|table|hr)\b/i

export function isLosslessForEditor(html: string) {
  const body = new DOMParser().parseFromString(html, 'text/html').body
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.COMMENT_NODE) return false
    const element = node as Element
    if (!supportedTags.has(element.tagName)) return false
    if ([...element.attributes].some((attribute) => !(supportedAttributes[element.tagName] ?? []).includes(attribute.name))) return false
  }
  return true
}

// WordPress often stores paragraphs as blank lines and adds the <p> tags only when rendering (wpautop).
export function withParagraphs(html: string) {
  if (!html.trim() || blockTags.test(html)) return html
  return html.trim().split(/\n\s*\n/).map((block) => `<p>${block.trim().replace(/\n/g, '<br>')}</p>`).join('')
}
