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

export const productFieldLabels: Record<string, string> = {
  name: 'Name', sku: 'Artikelnummer', status: 'Status', short_description: 'Kurzbeschreibung', description: 'Beschreibung',
  regular_price: 'Regulaerer Preis', sale_price: 'Angebotspreis', manage_stock: 'Bestand verwalten', stock_quantity: 'Bestand',
  stock_status: 'Lagerstatus', weight: 'Gewicht', dimensions: 'Masse (L x B x H)', shipping_class: 'Versandklasse',
}

// Readable value of a product field for change and conflict views.
export function productFieldValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.map((entry) => (entry && typeof entry === 'object' && 'name' in entry ? String(entry.name) : String(entry))).join(', ') || '—'
  if (typeof value === 'object') {
    if ('id' in value) return Number((value as { id: unknown }).id) > 0 ? String((value as { name?: unknown }).name ?? `#${(value as { id: unknown }).id}`) : '—'
    if (field === 'dimensions') return ['length', 'width', 'height'].map((key) => text((value as Record<string, unknown>)[key]) || '–').join(' x ')
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein'
  if (field === 'status') return productStatusLabels[String(value)] ?? String(value)
  if (field === 'stock_status') return stockLabels[String(value)] ?? String(value)
  if (field === 'description' || field === 'short_description') {
    const plain = new DOMParser().parseFromString(String(value), 'text/html').body.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    return plain.length > 120 ? `${plain.slice(0, 117)}...` : plain || '—'
  }
  return String(value)
}

// While a price edit waits for the shop, the shop-calculated price fields are outdated; show the edit instead.
export function displayPrice(product: { payload: Record<string, unknown>; changes: Record<string, unknown> | null }, currency?: string | null) {
  if (!product.changes || !('regular_price' in product.changes || 'sale_price' in product.changes)) return productPrice(product.payload, currency)
  const sale = text(product.payload.sale_price)
  return productPrice({ price: sale || text(product.payload.regular_price) }, currency)
}
