import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import databaseModule from './database.cjs'
import products from './products.cjs'

const shopUrl = 'https://shop.example/'
const connection = { url: 'https://shop.example', consumerKey: 'ck_' + 'a'.repeat(40), consumerSecret: 'cs_' + 'b'.repeat(40) }
const directories = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const json = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } })

const shirt = {
  id: 20, name: 'T-Shirt &amp; Co', type: 'variable', status: 'publish', sku: 'TEE', variations: [21, 22],
  categories: [{ id: 4, name: 'Kleidung', slug: 'kleidung' }], tags: [], brands: [],
  delivery_time: { id: 45, name: '3-4 Tage', slug: '3-4-tage', html: '' }, manufacturer: { id: 52, name: 'Studio GmbH', slug: 'studio-gmbh' },
  images: [{ id: 99, name: 'shirt', src: 'https://shop.example/a.jpg', alt: '' }], meta_data: [{ id: 1, key: '_x', value: 'y' }],
  shipping_class: 'paket', shipping_class_id: '11',
  attributes: [{ id: 1, name: 'Farbe', options: ['Rot', 'Blau'], variation: true }, { id: 0, name: 'Material', options: ['Baumwolle'] }],
}
const routes = {
  'wc/v3/products': (page) => json(page === 1
    ? [shirt]
    : [{ id: 30, name: 'Gutschein', type: 'external', status: 'draft', sku: '', categories: [{ id: 4, name: 'Kleidung', slug: 'kleidung' }] }], { 'x-wp-totalpages': '2' }),
  'wc/v3/data/currencies/current': () => json({ code: 'EUR', name: 'Euro', symbol: '€' }),
  'wc/v3/products/20/variations': () => json([
    { id: 21, name: '', status: 'publish', sku: 'TEE-R', attributes: [{ id: 1, name: 'Farbe', option: 'Rot' }], delivery_time: { id: 45, name: '3-4 Tage', slug: '3-4-tage' } },
    { id: 22, name: 'T-Shirt - Blau', status: 'private', sku: 'TEE-B', attributes: [{ id: 1, name: 'Farbe', option: 'blau' }] },
  ]),
}
const fetcher = () => vi.fn(async (url, options) => {
  const { pathname, searchParams } = new URL(url)
  expect(options).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
  if (pathname.endsWith('/currencies/current')) return routes['wc/v3/data/currencies/current']()
  expect(searchParams.get('status')).toBe('any')
  return routes[pathname.replace('/wp-json/', '')](Number(searchParams.get('page')))
})

it('loads all product pages and variations and finds plugin term fields without a field list', async () => {
  const progress = vi.fn()
  const result = await products.importProducts(connection, fetcher(), progress)
  expect(result.products.map((product) => [product.id, product.parentId, product.type, product.productType, product.name, product.status])).toEqual([
    [20, null, 'variable', 'variable', 'T-Shirt & Co', 'publish'],
    [30, null, 'simple', 'external', 'Gutschein', 'draft'],
    [21, 20, 'variation', 'variation', 'T-Shirt & Co – Rot', 'publish'],
    [22, 20, 'variation', 'variation', 'T-Shirt - Blau', 'private'],
  ])
  expect(result.products[0].terms).toEqual([
    { field: 'categories', id: 4, name: 'Kleidung', slug: 'kleidung' },
    { field: 'delivery_time', id: 45, name: '3-4 Tage', slug: '3-4-tage' },
    { field: 'manufacturer', id: 52, name: 'Studio GmbH', slug: 'studio-gmbh' },
    { field: 'shipping_class', id: 11, name: 'paket', slug: 'paket' },
    { field: 'attribute', attributeId: 1, option: 'Rot' },
    { field: 'attribute', attributeId: 1, option: 'Blau' },
  ])
  expect(result.currency).toBe('EUR')
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ step: 'products', label: 'Produkte werden geladen (Seite 2 von 2)' }))
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ step: 'variations', completed: 1, total: 1 }))
})

it('stores the catalog with relations resolved through imported taxonomies', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'catalogdesk-v2-products-'))
  directories.push(directory)
  const database = databaseModule.openDatabase(path.join(directory, 'catalogdesk-v2.sqlite'))
  const term = (id, name, slug = name.toLowerCase()) => ({ id, name, slug, parentId: 0, count: 0, menuOrder: 0, payload: { id, name, slug } })
  const taxonomy = (key, kind, terms, attribute = null) => ({ taxonomy: key, kind, label: key, route: `wc/v3/${key}`, hierarchical: false, available: true, attribute, terms })
  try {
    database.replaceTaxonomies({ shopUrl, importedAt: new Date().toISOString(), taxonomies: [
      taxonomy('product_cat', 'core', [term(4, 'Kleidung')]),
      taxonomy('product_delivery_time', 'custom', [term(45, '3-4 Tage', '3-4-tage')]),
      taxonomy('pa_farbe', 'attribute', [term(30, 'Rot'), term(31, 'Blau')], { id: 1, type: 'select', orderBy: 'menu_order', hasArchives: false }),
    ] })
    const catalog = await products.importProducts(connection, fetcher())
    const summary = database.replaceCatalog(catalog)
    // Manufacturer 52 belongs to a taxonomy that was not imported, so it stays unresolved.
    expect(summary).toMatchObject({ products: 4, variable: 1, variations: 2, shopCount: 1, relations: 9, unresolved: 1 })
    expect(database.listProducts().currency).toBe('EUR')
    expect(database.listProducts({ type: 'external' }).products).toEqual([expect.objectContaining({ id: 30, productType: 'external', status: 'draft' })])
    const list = database.listProducts()
    expect(list.products.map((product) => product.id)).toEqual([30, 20, 21, 22])
    expect(list.products[1].terms).toEqual(expect.arrayContaining([
      { taxonomy: 'product_delivery_time', label: 'product_delivery_time', name: '3-4 Tage' },
      { taxonomy: 'product_shipping_class', label: 'product_shipping_class', name: 'paket' },
      { taxonomy: 'pa_farbe', label: 'pa_farbe', name: 'Blau' },
    ]))
    expect(list.products[3].terms).toEqual([{ taxonomy: 'pa_farbe', label: 'pa_farbe', name: 'Blau' }])
  } finally { database.close() }
})
