const { z } = require('zod')
const { WooError, normalizeUrl, wooRequest } = require('./shop.cjs')
const { decodeEntities } = require('./taxonomies.cjs')

const pageSize = 100
const maxPages = 500
const maxPageBytes = 32 * 1024 * 1024
const variationConcurrency = 4
const formatError = 'Die Produktdaten entsprechen nicht dem WooCommerce-Format.'

const productSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().max(10_000).optional().default(''),
  type: z.string().max(80).optional().default('simple'),
  status: z.string().max(80).optional().default('publish'),
  sku: z.string().max(1000).optional().default(''),
  parent_id: z.number().int().nonnegative().optional().default(0),
  variations: z.array(z.number().int().positive()).optional().default([]),
}).passthrough()

// Fields that hold WordPress terms ({ id, name, slug }) without naming their taxonomy. Plugins such as
// Germanized expose their taxonomies this way (delivery_time, manufacturer, unit, ...); the database
// resolves the taxonomy by the term ID, which WordPress keeps unique across all taxonomies.
const skippedFields = new Set(['attributes', 'default_attributes', 'meta_data', 'images', 'image', 'downloads'])
const isTerm = (value) => value && typeof value === 'object' && Number.isSafeInteger(value.id) && value.id > 0 && typeof value.slug === 'string' && typeof value.name === 'string'

function extractTerms(item) {
  const terms = []
  for (const [field, value] of Object.entries(item)) {
    if (skippedFields.has(field) || !/^[a-z0-9_]{1,80}$/.test(field)) continue
    for (const entry of Array.isArray(value) ? value : [value])
      if (isTerm(entry)) terms.push({ field, id: entry.id, name: decodeEntities(entry.name).slice(0, 1000), slug: entry.slug.slice(0, 1000) })
  }
  const shippingClass = Number(item.shipping_class_id)
  if (Number.isSafeInteger(shippingClass) && shippingClass > 0 && typeof item.shipping_class === 'string')
    terms.push({ field: 'shipping_class', id: shippingClass, name: item.shipping_class.slice(0, 1000), slug: item.shipping_class.slice(0, 1000) })
  // Global attributes (id > 0) are pa_* taxonomies; products list option names, variations a single option.
  for (const attribute of Array.isArray(item.attributes) ? item.attributes : []) {
    if (!Number.isSafeInteger(attribute?.id) || attribute.id <= 0) continue
    const options = Array.isArray(attribute.options) ? attribute.options : typeof attribute.option === 'string' ? [attribute.option] : []
    for (const option of options) if (typeof option === 'string' && option) terms.push({ field: 'attribute', attributeId: attribute.id, option: option.slice(0, 1000) })
  }
  return terms
}

async function fetchPages(connection, route, fetcher, onPage) {
  const items = new Map()
  for (let page = 1; page <= maxPages; page++) {
    const { data, headers } = await wooRequest(connection, route, { per_page: String(pageSize), page: String(page), status: 'any', orderby: 'id', order: 'asc' }, fetcher, { maxBytes: maxPageBytes, timeoutMs: 60_000 })
    const parsed = z.array(productSchema).max(pageSize).safeParse(data)
    if (!parsed.success) throw new WooError(formatError)
    const before = items.size
    for (const item of parsed.data) items.set(item.id, item)
    const totalPages = Number(headers.get('x-wp-totalpages'))
    onPage?.(page, Number.isSafeInteger(totalPages) && totalPages > 0 ? totalPages : null)
    const hasMore = Number.isSafeInteger(totalPages) && totalPages > 0 ? page < totalPages : parsed.data.length === pageSize
    if (!hasMore || items.size === before) return [...items.values()]
  }
  throw new WooError('Zu viele Produkte fuer einen Import.')
}

function toProduct(item, parent = null) {
  const name = decodeEntities(item.name || '')
  const variationName = parent && !name
    ? `${decodeEntities(parent.name)} – ${(Array.isArray(item.attributes) ? item.attributes : []).map((attribute) => attribute?.option).filter(Boolean).join(', ')}`
    : name
  return {
    id: item.id,
    parentId: parent ? parent.id : null,
    // `type` is the family role the schema models; `productType` keeps WooCommerce's (or a plugin's) type.
    type: parent ? 'variation' : item.type === 'variable' ? 'variable' : 'simple',
    productType: parent ? 'variation' : item.type,
    sku: item.sku ?? '',
    name: variationName.slice(0, 1000),
    status: item.status,
    payload: item,
    terms: extractTerms(item),
  }
}

async function importProducts(connection, fetcher, onProgress = () => {}) {
  const parents = await fetchPages(connection, 'wc/v3/products', fetcher, (page, total) =>
    onProgress({ step: 'products', label: total ? `Produkte werden geladen (Seite ${page} von ${total})` : `Produkte werden geladen (Seite ${page})`, completed: page, total: total ?? page }))
  const variable = parents.filter((product) => product.type === 'variable' && product.variations.length)
  const products = parents.map((product) => toProduct(product))
  let completed = 0
  let next = 0
  onProgress({ step: 'variations', label: `Varianten werden geladen (0 von ${variable.length} Produkten)`, completed: 0, total: variable.length })
  // A few parallel requests keep large shops fast without flooding them.
  let stopped = false
  async function worker() {
    while (!stopped && next < variable.length) {
      const parent = variable[next++]
      let variations
      try { variations = await fetchPages(connection, `wc/v3/products/${parent.id}/variations`, fetcher) }
      catch (error) { stopped = true; throw error }
      for (const variation of variations) products.push(toProduct(variation, parent))
      completed++
      onProgress({ step: 'variations', label: `Varianten werden geladen (${completed} von ${variable.length} Produkten)`, completed, total: variable.length })
    }
  }
  await Promise.all(Array.from({ length: Math.min(variationConcurrency, variable.length) }, worker))
  if (!products.length) throw new WooError('Der Shop enthaelt keine Produkte.')
  // Variations carry no formatted price, so the shop currency is stored once for local formatting.
  let currency = null
  try {
    const { data } = await wooRequest(connection, 'wc/v3/data/currencies/current', {}, fetcher)
    const parsed = z.object({ code: z.string().regex(/^[A-Z]{3}$/) }).passthrough().safeParse(data)
    if (parsed.success) currency = parsed.data.code
  } catch (error) { if (!(error instanceof WooError) || error.offline) throw error }
  return { shopUrl: normalizeUrl(connection.url), importedAt: new Date().toISOString(), currency, products }
}

module.exports = { extractTerms, importProducts, toProduct }
