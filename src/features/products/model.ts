export type { LocalProduct as ProductSummary, ProductPage, ProductQuery } from '../../types/desktop'

export const productTypeLabels: Record<string, string> = {
  simple: 'Einfach', variable: 'Variabel', variation: 'Variante', grouped: 'Gruppiert', external: 'Extern',
}
export const productStatusLabels: Record<string, string> = {
  publish: 'Veroeffentlicht', draft: 'Entwurf', pending: 'Ausstehend', private: 'Privat', future: 'Geplant',
}
export const stockLabels: Record<string, string> = { instock: 'Vorraetig', outofstock: 'Nicht vorraetig', onbackorder: 'Lieferrueckstand' }

const text = (value: unknown) => (typeof value === 'string' ? value : '')

// price_html carries the shop's own currency formatting; only its text is used, never the markup.
export function productPrice(payload: Record<string, unknown>, currency?: string | null) {
  const html = text(payload.price_html)
  if (html) {
    const value = new DOMParser().parseFromString(html, 'text/html').body.textContent?.replace(/\s+/g, ' ').trim()
    if (value) return value
  }
  const price = Number(text(payload.price))
  if (!text(payload.price) || !Number.isFinite(price)) return '—'
  return currency ? price.toLocaleString('de-DE', { style: 'currency', currency }) : price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function productStock(payload: Record<string, unknown>) {
  const status = stockLabels[text(payload.stock_status)] ?? '—'
  return payload.manage_stock === true && typeof payload.stock_quantity === 'number' ? `${status} (${payload.stock_quantity})` : status
}
