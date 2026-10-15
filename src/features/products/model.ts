export type { LocalProduct as ProductSummary, ProductPage, ProductQuery } from '../../types/desktop'

export const productTypeLabels: Record<string, string> = {
  simple: 'Einfach', variable: 'Variabel', variation: 'Variante', grouped: 'Gruppiert', external: 'Extern',
}
export const productStatusLabels: Record<string, string> = {
  publish: 'Veroeffentlicht', draft: 'Entwurf', pending: 'Ausstehend', private: 'Privat', future: 'Geplant',
}
export const stockLabels: Record<string, string> = { instock: 'Vorraetig', outofstock: 'Nicht vorraetig', onbackorder: 'Lieferrueckstand' }

const text = (value: unknown) => (typeof value === 'string' ? value : '')

export type ProductPrice =
  | { kind: 'none' }
  | { kind: 'single'; price: string }
  | { kind: 'sale'; regular: string; sale: string }
  | { kind: 'range'; min: string; max: string }

function money(value: unknown, currency?: string | null) {
  const amount = Number(text(value) || value)
  if (text(value) === '' && typeof value !== 'number') return null
  if (!Number.isFinite(amount)) return null
  return currency ? amount.toLocaleString('de-DE', { style: 'currency', currency }) : amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Built from the structured price fields: the shop's price_html contains hidden screen-reader text and
// is outdated while a price edit is queued.
export function productPrice(product: { payload: Record<string, unknown>; priceRange?: [number, number] | null; productType?: string }, currency?: string | null): ProductPrice {
  const { payload } = product
  if (product.priceRange) {
    const [min, max] = product.priceRange.map((value) => money(value, currency))
    return !min || !max ? { kind: 'none' } : min === max ? { kind: 'single', price: min } : { kind: 'range', min, max }
  }
  const regular = money(payload.regular_price, currency)
  const sale = money(payload.sale_price, currency)
  if (sale && regular && Number(payload.sale_price) < Number(payload.regular_price) && payload.on_sale !== false) return { kind: 'sale', regular, sale }
  const single = regular ?? money(payload.price, currency)
  return single ? { kind: 'single', price: single } : { kind: 'none' }
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
