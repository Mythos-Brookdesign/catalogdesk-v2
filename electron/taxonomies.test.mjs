import { expect, it, vi } from 'vitest'
import taxonomies from './taxonomies.cjs'

const connection = { url: 'https://shop.example', consumerKey: 'ck_' + 'a'.repeat(40), consumerSecret: 'cs_' + 'b'.repeat(40) }
const json = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } })
const termArgs = { context: {}, page: {}, per_page: {}, orderby: {}, order: {}, hide_empty: {} }
const termRoute = (title, properties, args = termArgs) => ({ endpoints: [{ methods: ['GET'], args }, { methods: ['POST'], args: [] }], schema: { title, properties: Object.fromEntries(properties.map((key) => [key, {}])) } })
const index = {
  routes: {
    '/wc/v3': { endpoints: [{ methods: ['GET'], args: [] }] },
    '/wc/v3/products/categories': termRoute('product_cat', ['id', 'name', 'slug', 'parent', 'count']),
    '/wc/v3/products/tags': termRoute('product_tag', ['id', 'name', 'slug', 'count']),
    '/wc/v3/products/reviews': { endpoints: [{ methods: ['GET'], args: { page: {} } }], schema: { title: 'product_review', properties: { id: {}, review: {} } } },
    '/wc/v3/products/delivery_times': termRoute('product_delivery_time', ['id', 'name', 'slug', 'count']),
    '/wc/v3/nutrients': termRoute('product_nutrient', ['id', 'name', 'slug', 'unit'], { hide_empty: {} }),
    '/wc/v3/products/attributes/(?P<attribute_id>[\\d]+)/terms': termRoute('product_attribute_term', ['id', 'name', 'slug']),
  },
}

function shop(routes) {
  return vi.fn(async (url) => {
    const { pathname, searchParams } = new URL(url)
    const handler = routes[pathname.replace('/wp-json/', '')]
    if (!handler) return new Response('{"code":"rest_no_route"}', { status: 404, headers: { 'content-type': 'application/json' } })
    return handler(Number(searchParams.get('page') ?? 1), searchParams)
  })
}
const base = {
  'wc/v3': () => json(index),
  'wp/v2/taxonomies': () => json({
    product_cat: { slug: 'product_cat', name: 'Produktkategorien', hierarchical: true, rest_base: 'product_cat', rest_namespace: 'wp/v2' },
    product_season: { slug: 'product_season', name: 'Saison &amp; Anlass', hierarchical: true, rest_base: 'seasons', rest_namespace: 'wp/v2' },
  }),
  'wc/v3/products/categories': (page) => json(page === 1
    ? [{ id: 4, name: 'Kleidung &amp; Mode', slug: 'kleidung', parent: 0, count: 3 }]
    : [{ id: 5, name: 'Shirts', slug: 'shirts', parent: 4, count: 2 }], { 'x-wp-totalpages': '2' }),
  'wc/v3/products/tags': () => json([{ id: 8, name: 'Sale', slug: 'sale', count: 1 }]),
  'wc/v3/products/shipping_classes': () => json([]),
  'wc/v3/products/delivery_times': () => json([{ id: 50, name: '2-3 Werktage', slug: '2-3-werktage', count: 6 }]),
  'wc/v3/nutrients': () => json([{ id: 60, name: 'Fett', slug: 'fett', unit: 'g' }]),
  'wp/v2/seasons': () => json([{ id: 70, name: 'Sommer', slug: 'sommer', parent: 0, count: 2 }]),
  'wc/v3/products/attributes': () => json([{ id: 1, name: 'Farbe', slug: 'pa_farbe', type: 'select', order_by: 'menu_order', has_archives: false }]),
  'wc/v3/products/attributes/1/terms': () => json([{ id: 30, name: 'Rot', slug: 'rot', menu_order: 2, count: 4 }]),
}

it('discovers all product taxonomies from the REST index, WordPress and global attributes', async () => {
  const fetcher = shop(base)
  const progress = vi.fn()
  const result = await taxonomies.importTaxonomies(connection, fetcher, progress)
  expect(result.shopUrl).toBe('https://shop.example/')
  expect(result.taxonomies.map((entry) => [entry.taxonomy, entry.kind, entry.label, entry.terms.length])).toEqual([
    ['product_cat', 'core', 'Kategorien', 2], ['product_tag', 'core', 'Schlagwoerter', 1],
    ['product_delivery_time', 'custom', 'Lieferzeiten', 1], ['product_nutrient', 'custom', 'Naehrwerte', 1],
    ['product_season', 'custom', 'Saison & Anlass', 1], ['pa_farbe', 'attribute', 'Farbe', 1],
  ])
  expect(result.taxonomies[0].terms).toEqual([
    expect.objectContaining({ id: 4, name: 'Kleidung & Mode', parentId: 0, count: 3 }),
    expect.objectContaining({ id: 5, parentId: 4 }),
  ])
  expect(result.taxonomies[3].terms[0].payload).toMatchObject({ unit: 'g' })
  expect(result.taxonomies[4]).toMatchObject({ route: 'wp/v2/seasons', hierarchical: true })
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ label: 'Farbe' }))
  const nutrients = fetcher.mock.calls.find(([url]) => url.includes('/nutrients'))[0]
  expect(nutrients).not.toContain('per_page')
  for (const [url, options] of fetcher.mock.calls) {
    expect(url).not.toContain(connection.consumerKey)
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
    expect(Boolean(options.headers.Authorization)).toBe(new URL(url).pathname.startsWith('/wp-json/wc/'))
  }
})

it('falls back to core taxonomies without index and keeps unreadable plugin taxonomies marked', async () => {
  const fallback = await taxonomies.importTaxonomies(connection, shop({ ...base, 'wc/v3': () => new Response('', { status: 404 }), 'wp/v2/taxonomies': () => new Response('', { status: 401 }) }))
  expect(fallback.taxonomies.map((entry) => entry.taxonomy)).toEqual(['product_cat', 'product_tag', 'product_shipping_class', 'pa_farbe'])
  const forbidden = await taxonomies.importTaxonomies(connection, shop({ ...base, 'wc/v3/nutrients': () => new Response('', { status: 403 }) }))
  expect(forbidden.taxonomies.find((entry) => entry.taxonomy === 'product_nutrient')).toMatchObject({ available: false, terms: [] })
  await expect(taxonomies.importTaxonomies(connection, shop({ ...base, 'wc/v3/products/tags': () => new Response(connection.consumerSecret, { status: 403 }) })))
    .rejects.toThrow('Zugriff verweigert')
  await expect(taxonomies.importTaxonomies(connection, shop({ ...base, 'wc/v3/products/categories': () => json([{ id: 'x' }]) })))
    .rejects.toThrow('WooCommerce-Format')
})

it('decodes HTML entities in term names', () => {
  expect(taxonomies.decodeEntities('A &amp; B &#8211; C &#x2019; &unknown;')).toBe('A & B – C ’ &unknown;')
})
