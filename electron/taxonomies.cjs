const { z } = require('zod')
const { WooError, normalizeUrl, wooRequest } = require('./shop.cjs')

const pageSize = 100
const maxPages = 200
const maxPageBytes = 4 * 1024 * 1024
const formatError = 'Die Antwort entspricht nicht dem WooCommerce-Format.'

const coreLabels = { product_cat: 'Kategorien', product_tag: 'Schlagwoerter', product_brand: 'Marken', product_shipping_class: 'Versandklassen' }
// Display names only; discovery never depends on this list. Unknown taxonomies get the shop's WordPress label or a readable slug.
const knownLabels = {
  product_delivery_time: 'Lieferzeiten', product_unit: 'Einheiten', product_manufacturer: 'Hersteller', product_price_label: 'Preishinweise',
  product_deposit_type: 'Pfandtypen', product_nutrient: 'Naehrwerte', product_allergen: 'Allergene',
}
// Used when the REST index is unavailable (e.g. blocked by a security plugin).
const fallbackSources = [
  { taxonomy: 'product_cat', route: 'wc/v3/products/categories', hierarchical: true },
  { taxonomy: 'product_tag', route: 'wc/v3/products/tags', hierarchical: false },
  { taxonomy: 'product_brand', route: 'wc/v3/products/brands', hierarchical: true },
  { taxonomy: 'product_shipping_class', route: 'wc/v3/products/shipping_classes', hierarchical: false },
]

const taxonomyName = z.string().regex(/^[a-z0-9_-]{1,32}$/)
const routePath = z.string().regex(/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/)
const termSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().max(1000),
  slug: z.string().max(1000),
  parent: z.number().int().nonnegative().optional().default(0),
  menu_order: z.number().int().optional().default(0),
  count: z.number().int().nonnegative().optional().default(0),
}).passthrough()
const indexSchema = z.object({ routes: z.record(z.string(), z.unknown()) }).passthrough()
// Routes are checked one by one: plugins register all kinds of shapes (PHP serializes empty args as []).
const termRouteSchema = z.object({
  endpoints: z.array(z.unknown()),
  schema: z.object({ title: taxonomyName, properties: z.record(z.string(), z.unknown()) }).passthrough(),
}).passthrough()
const readEndpointSchema = z.object({ methods: z.array(z.string()), args: z.record(z.string(), z.unknown()) }).passthrough()
const wpTaxonomiesSchema = z.record(z.string(), z.object({
  slug: z.string(), name: z.string().max(1000), hierarchical: z.boolean(),
  rest_base: z.string().nullable().optional(), rest_namespace: z.string().nullable().optional(),
}).passthrough())
const attributeSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().max(1000),
  slug: z.string().min(1).max(200),
  type: z.string().max(80).optional().default('select'),
  order_by: z.string().max(80).optional().default('menu_order'),
  has_archives: z.boolean().optional().default(false),
})

const namedEntities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return namedEntities[entity.toLowerCase()] ?? match
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : match
  })
}

function humanize(taxonomy) {
  const words = taxonomy.replace(/^(product|pwb|wc|yith)[_-]/, '').replace(/[_-]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : taxonomy
}

// Every WooCommerce term collection (WC_REST_Terms_Controller and plugin subclasses) accepts `hide_empty`
// and names its taxonomy in the schema title, so the REST index reveals all product taxonomies of the shop.
async function discoverWooTaxonomies(connection, fetcher) {
  let index
  try {
    const { data } = await wooRequest(connection, 'wc/v3', { context: 'help' }, fetcher, { maxBytes: 32 * 1024 * 1024, timeoutMs: 30_000 })
    index = indexSchema.parse(data)
  } catch (error) {
    if (error instanceof WooError && (error.status === 401 || error.status === 403)) throw error
    return fallbackSources.map((source) => ({ ...source, args: ['per_page', 'page', 'orderby', 'order'], fields: null, optional: source.taxonomy === 'product_brand' }))
  }
  const found = new Map()
  for (const [path, value] of Object.entries(index.routes)) {
    const relative = path.replace(/^\//, '')
    const route = termRouteSchema.safeParse(value)
    if (!route.success || !routePath.safeParse(relative).success || !relative.startsWith('wc/v3/')) continue
    const read = route.data.endpoints.map((endpoint) => readEndpointSchema.safeParse(endpoint)).find((endpoint) => endpoint.success && endpoint.data.methods.includes('GET'))?.data
    const taxonomy = route.data.schema.title
    const properties = Object.keys(route.data.schema.properties)
    if (!read || !('hide_empty' in read.args) || !['id', 'name', 'slug'].every((key) => properties.includes(key))) continue
    if (found.has(taxonomy) && !relative.startsWith('wc/v3/products/')) continue
    found.set(taxonomy, {
      taxonomy, route: relative, hierarchical: properties.includes('parent'), args: Object.keys(read.args),
      fields: properties.filter((key) => /^[a-z0-9_]+$/.test(key)).slice(0, 100).join(','),
    })
  }
  return [...found.values()]
}

// Taxonomies registered with show_in_rest (themes, custom code) appear in wp/v2 even without a WooCommerce controller.
async function discoverWordPressTaxonomies(connection, fetcher) {
  try {
    const { data } = await wooRequest(connection, 'wp/v2/taxonomies', { type: 'product', context: 'view' }, fetcher, { maxBytes: maxPageBytes })
    return Object.values(wpTaxonomiesSchema.parse(data)).filter((entry) => taxonomyName.safeParse(entry.slug).success)
  } catch { return [] }
}

async function fetchTerms(connection, source, fetcher) {
  const terms = new Map()
  const params = Object.fromEntries([
    ['per_page', String(pageSize)], ['orderby', 'id'], ['order', 'asc'],
  ].filter(([key]) => source.args.includes(key)))
  if (source.fields) params._fields = source.fields
  for (let page = 1; page <= maxPages; page++) {
    const { data, headers } = await wooRequest(connection, source.route, { ...params, ...(source.args.includes('page') ? { page: String(page) } : {}) }, fetcher, { maxBytes: maxPageBytes })
    const parsed = z.array(termSchema).max(1000).safeParse(data)
    if (!parsed.success) throw new WooError(formatError)
    const before = terms.size
    for (const term of parsed.data) terms.set(term.id, term)
    const totalPages = Number(headers.get('x-wp-totalpages'))
    const hasMore = Number.isSafeInteger(totalPages) && totalPages > 0 ? page < totalPages : parsed.data.length === pageSize
    if (!source.args.includes('page') || !hasMore || terms.size === before) return [...terms.values()]
  }
  throw new WooError('Zu viele Taxonomie-Begriffe. Import abgebrochen.')
}

function toTerm(term, hierarchical) {
  return {
    id: term.id,
    name: decodeEntities(term.name),
    slug: term.slug,
    parentId: hierarchical ? term.parent : 0,
    count: term.count,
    menuOrder: term.menu_order,
    payload: term,
  }
}

async function importTaxonomies(connection, fetcher, onProgress = () => {}) {
  const [woo, wordpress] = await Promise.all([discoverWooTaxonomies(connection, fetcher), discoverWordPressTaxonomies(connection, fetcher)])
  const labels = new Map(wordpress.map((entry) => [entry.slug, decodeEntities(entry.name)]))
  const sources = [...woo]
  for (const entry of wordpress) {
    const route = `${entry.rest_namespace ?? 'wp/v2'}/${entry.rest_base ?? entry.slug}`
    if (entry.slug.startsWith('pa_') || sources.some((source) => source.taxonomy === entry.slug) || !routePath.safeParse(route).success) continue
    sources.push({ taxonomy: entry.slug, route, hierarchical: entry.hierarchical, args: ['per_page', 'page', 'orderby', 'order'], fields: `id,name,slug,description,count${entry.hierarchical ? ',parent' : ''}` })
  }
  // Core taxonomies first, then plugin and custom taxonomies alphabetically.
  const core = Object.keys(coreLabels)
  sources.sort((a, b) => (core.includes(a.taxonomy) ? core.indexOf(a.taxonomy) : 99) - (core.includes(b.taxonomy) ? core.indexOf(b.taxonomy) : 99) || a.taxonomy.localeCompare(b.taxonomy))

  const taxonomies = []
  let completed = 0
  let total = sources.length + 1
  const progress = (label) => onProgress({ label, completed, total })
  for (const source of sources) {
    const label = coreLabels[source.taxonomy] ?? labels.get(source.taxonomy) ?? knownLabels[source.taxonomy] ?? humanize(source.taxonomy)
    progress(label)
    let terms = []
    let available = true
    try { terms = await fetchTerms(connection, source, fetcher) }
    catch (error) {
      // Plugin taxonomies may be unreadable (custom permissions); core taxonomies must import completely.
      if (!(error instanceof WooError) || (core.includes(source.taxonomy) && !(source.optional && error.status === 404))) throw error
      available = false
    }
    if (available || !source.optional)
      taxonomies.push({
        taxonomy: source.taxonomy, kind: core.includes(source.taxonomy) ? 'core' : 'custom', label, route: source.route,
        hierarchical: source.hierarchical, available, attribute: null, terms: terms.map((term) => toTerm(term, source.hierarchical)),
      })
    completed++
  }

  progress('Attribute')
  const { data } = await wooRequest(connection, 'wc/v3/products/attributes', {}, fetcher, { maxBytes: maxPageBytes })
  const attributes = z.array(attributeSchema).max(1000).safeParse(data)
  if (!attributes.success) throw new WooError(formatError)
  completed++
  total += attributes.data.length
  for (const attribute of attributes.data) {
    const label = decodeEntities(attribute.name)
    progress(label)
    const route = `wc/v3/products/attributes/${attribute.id}/terms`
    const terms = await fetchTerms(connection, { route, args: ['per_page', 'page', 'orderby', 'order'], fields: 'id,name,slug,description,menu_order,count' }, fetcher)
    taxonomies.push({
      taxonomy: attribute.slug.startsWith('pa_') ? attribute.slug : `pa_${attribute.slug}`,
      kind: 'attribute', label, route, hierarchical: false, available: true,
      attribute: { id: attribute.id, type: attribute.type, orderBy: attribute.order_by, hasArchives: attribute.has_archives },
      terms: terms.map((term) => toTerm(term, false)),
    })
    completed++
  }
  progress('Speichern')
  return { shopUrl: normalizeUrl(connection.url), importedAt: new Date().toISOString(), taxonomies }
}

module.exports = { decodeEntities, importTaxonomies, termSchema, toTerm }
