import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import databaseModule from './database.cjs'
import products from './products.cjs'
import productSync from './product-sync.cjs'

const shopUrl = 'https://shop.example/'
const connection = { url: shopUrl, consumerKey: 'ck_' + 'a'.repeat(40), consumerSecret: 'cs_' + 'b'.repeat(40) }
const directories = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const clone = (value) => JSON.parse(JSON.stringify(value))

const hoodie = {
  id: 60, name: 'Hoodie', type: 'simple', status: 'publish', sku: 'HOOD', regular_price: '49.90', sale_price: '', manage_stock: true, stock_quantity: 10, stock_status: 'instock',
  weight: '0.5', dimensions: { length: '', width: '', height: '' }, shipping_class: '', categories: [{ id: 4, name: 'Kleidung', slug: 'kleidung' }],
  delivery_time: { id: 45, name: '3-4 Tage', slug: '3-4-tage' }, date_modified_gmt: '2026-10-15T10:00:00',
}

function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'catalogdesk-v2-product-sync-'))
  directories.push(directory)
  const database = databaseModule.openDatabase(path.join(directory, 'catalogdesk-v2.sqlite'))
  const term = (id, name) => ({ id, name, slug: name.toLowerCase(), parentId: 0, count: 0, menuOrder: 0, payload: { id, name } })
  const taxonomy = (key, terms) => ({ taxonomy: key, kind: key === 'product_cat' ? 'core' : 'custom', label: key === 'product_cat' ? 'Kategorien' : 'Lieferzeiten', route: `wc/v3/${key}`, hierarchical: false, available: true, attribute: null, terms })
  database.replaceTaxonomies({ shopUrl, importedAt: new Date().toISOString(),
    taxonomies: [taxonomy('product_cat', [term(4, 'Kleidung'), term(5, 'Sport')]), taxonomy('product_delivery_time', [term(45, '3-4 Tage'), term(46, 'Sofort')])],
    productFields: [{ scope: 'product', field: 'categories', multiple: true }, { scope: 'product', field: 'delivery_time', multiple: false }, { scope: 'variation', field: 'delivery_time', multiple: false }] })
  database.replaceCatalog({ shopUrl, importedAt: new Date().toISOString(), products: [products.toProduct(hoodie), products.toProduct({ id: 70, name: 'Socken', type: 'simple', status: 'draft', sku: 'SOCK' })] })
  const call = (operation, payload) => Promise.resolve(database[operation](payload))
  return { database, call }
}

it('queues validated edits, shows them merged and removes fields set back to the shop value', () => {
  const { database } = setup()
  try {
    const change = (values, terms = {}) => database.queueProductChange({ shopUrl, productId: 60, values, terms })
    expect(database.productEditorOptions({ shopUrl }).termFields.map((field) => [field.scope, field.field, field.taxonomy, field.label, field.terms.length]))
      .toEqual([['product', 'categories', 'product_cat', 'Kategorien', 2], ['product', 'delivery_time', 'product_delivery_time', 'Lieferzeiten', 2], ['variation', 'delivery_time', 'product_delivery_time', 'Lieferzeiten', 2]])
    const result = change({ name: 'Hoodie Pro', regular_price: '59,90', stock_quantity: 8 }, { categories: [4, 5], delivery_time: 46 })
    expect(result).toMatchObject({ queued: true, before: { name: 'Hoodie', regular_price: '49.90', stock_quantity: 10 }, after: { regular_price: '59.90', delivery_time: { id: 46, name: 'Sofort' } } })
    let row = database.listProducts({ query: 'Pro' }).products[0]
    expect(row).toMatchObject({ id: 60, name: 'Hoodie Pro', syncState: 'draft', changeState: 'pending', payload: { regular_price: '59.90', stock_quantity: 8, categories: [{ id: 4 }, { id: 5 }] } })
    expect(database.listProducts().changeCounts).toEqual({ pending: 1, failed: 0, conflict: 0 })
    change({ name: 'Hoodie' })
    expect(Object.keys(database.listProducts({ query: 'HOOD' }).products[0].changes)).toEqual(['regular_price', 'stock_quantity', 'categories', 'delivery_time'])
    expect(() => change({ sale_price: '70' })).toThrow('Angebotspreis muss kleiner')
    expect(() => change({ sku: 'sock' })).toThrow('Artikelnummer ist bereits vergeben')
    expect(() => change({ regular_price: 'abc' })).toThrow('Regulaerer Preis ist ungueltig')
    expect(() => change({}, { delivery_time: 4 })).toThrow('gehoert nicht zu Lieferzeiten')
    expect(() => change({ menu_order: 3 })).toThrow('kann nicht bearbeitet werden')
    change({ regular_price: '49.90', stock_quantity: 10 }, { categories: [4], delivery_time: 45 })
    row = database.listProducts({ query: 'HOOD' }).products[0]
    expect(row).toMatchObject({ syncState: 'clean', changes: null })
  } finally { database.close() }
})

it('sends only changed fields, detects conflicts per field and resolves them', async () => {
  const { database, call } = setup()
  try {
    database.queueProductChange({ shopUrl, productId: 60, values: { regular_price: '59.90', stock_quantity: 8 }, terms: { delivery_time: 46 } })
    const offline = vi.fn(async () => { throw new TypeError('offline') })
    expect(await productSync.syncProductChanges(connection, call, offline)).toMatchObject({ offline: true, counts: { pending: 1 } })

    // An order reduced the stock in the shop meanwhile: stock is a conflict, price and delivery time are not.
    let shop = { ...clone(hoodie), stock_quantity: 7 }
    const requests = []
    const fetcher = vi.fn(async (url, options) => {
      requests.push([options.method, new URL(url).pathname, options.body ? JSON.parse(options.body) : null])
      if (options.method === 'PUT') { shop = { ...shop, ...JSON.parse(options.body), delivery_time: { id: 46, name: 'Sofort', slug: 'sofort' } }; return json(shop) }
      return json(shop)
    })
    expect(await productSync.syncProductChanges(connection, call, fetcher)).toMatchObject({ conflicts: 1, synced: 0, counts: { conflict: 1 } })
    let row = database.listProducts({ query: 'HOOD' }).products[0]
    expect(row).toMatchObject({ syncState: 'conflict', remote: { stock_quantity: 7 } })
    expect(requests.map(([method]) => method)).toEqual(['GET'])

    database.resolveProductConflict({ shopUrl, productId: 60, resolutions: { stock_quantity: 'shop' } })
    expect(await productSync.syncProductChanges(connection, call, fetcher)).toMatchObject({ synced: 1, conflicts: 0, counts: { pending: 0, conflict: 0 } })
    expect(requests.at(-1)).toEqual(['PUT', '/wp-json/wc/v3/products/60', { regular_price: '59.90', delivery_time: { id: 46 } }])
    row = database.listProducts({ query: 'HOOD' }).products[0]
    expect(row).toMatchObject({ syncState: 'clean', payload: { regular_price: '59.90', stock_quantity: 7 } })
    expect(row.terms).toEqual(expect.arrayContaining([{ taxonomy: 'product_delivery_time', label: 'Lieferzeiten', name: 'Sofort' }]))

    // "Mine" keeps the edit and overwrites the shop value on the next run.
    database.queueProductChange({ shopUrl, productId: 60, values: { stock_quantity: 20 } })
    shop.stock_quantity = 5
    await productSync.syncProductChanges(connection, call, fetcher)
    database.resolveProductConflict({ shopUrl, productId: 60, resolutions: { stock_quantity: 'mine' } })
    expect(await productSync.syncProductChanges(connection, call, fetcher)).toMatchObject({ synced: 1 })
    expect(shop.stock_quantity).toBe(20)
  } finally { database.close() }
})

it('reports fields the shop ignores and shop rejections', async () => {
  const { database, call } = setup()
  try {
    database.queueProductChange({ shopUrl, productId: 60, values: { regular_price: '55' }, terms: { delivery_time: 0 } })
    const shop = clone(hoodie)
    // The shop keeps the delivery time although it was cleared.
    const ignoring = vi.fn(async (_url, options) => json(options.method === 'PUT' ? { ...shop, regular_price: '55' } : shop))
    expect(await productSync.syncProductChanges(connection, call, ignoring)).toMatchObject({ failed: 1, counts: { failed: 1 } })
    const row = database.listProducts({ query: 'HOOD' }).products[0]
    expect(row).toMatchObject({ changeState: 'failed', changes: { delivery_time: { id: 0 } }, payload: { regular_price: '55' } })
    expect(row.changeError).toContain('Lieferzeit')

    database.retryProductChanges({ shopUrl })
    const rejecting = vi.fn(async (_url, options) => options.method === 'PUT' ? json({ code: 'product_invalid_sku', message: 'Ungueltige oder doppelte Artikelnummer.' }, 400) : json(shop))
    await productSync.syncProductChanges(connection, call, rejecting)
    expect(database.listProducts({ query: 'HOOD' }).products[0].changeError).toBe('Ungueltige oder doppelte Artikelnummer.')
    expect(database.discardProductChange({ shopUrl, productId: 60 })).toEqual({ name: 'Hoodie', fields: ['delivery_time'] })
  } finally { database.close() }
})

it('assigns a term created offline and sends the product once the shop created the term', async () => {
  const { database, call } = setup()
  const taxonomySync = (await import('./taxonomy-sync.cjs')).default
  try {
    const { termId } = database.queueTaxonomyChange({ shopUrl, taxonomy: 'product_cat', operation: 'create', fields: { name: 'Winter', slug: '', parent: 0, description: '' } })
    expect(termId).toBeLessThan(0)
    expect(database.productEditorOptions({ shopUrl }).termFields[0].terms.map((term) => term.name)).toContain('Winter')
    database.queueProductChange({ shopUrl, productId: 60, values: {}, terms: { categories: [4, termId] } })
    expect(database.listProducts({ query: 'HOOD' }).products[0].payload.categories.map((term) => term.name)).toEqual(['Kleidung', 'Winter'])

    let shop = clone(hoodie)
    const requests = []
    const fetcher = vi.fn(async (url, options) => {
      const { pathname } = new URL(url)
      requests.push([options.method, pathname, options.body ? JSON.parse(options.body) : null])
      if (pathname.endsWith('/product_cat') && options.method === 'POST') return json({ id: 90, ...JSON.parse(options.body), slug: 'winter', parent: 0, count: 0 }, 201)
      if (options.method === 'PUT') { shop = { ...shop, categories: JSON.parse(options.body).categories.map(({ id }) => ({ id, name: id === 90 ? 'Winter' : 'Kleidung', slug: '' })) }; return json(shop) }
      return json(shop)
    })
    // The product waits while its new term has not reached the shop.
    expect(await productSync.syncProductChanges(connection, call, fetcher)).toMatchObject({ synced: 0, counts: { pending: 1 } })
    await taxonomySync.syncTaxonomyChanges(connection, call, fetcher)
    expect(await productSync.syncProductChanges(connection, call, fetcher)).toMatchObject({ synced: 1, counts: { pending: 0 } })
    expect(requests.find(([method]) => method === 'PUT')[2]).toEqual({ categories: [{ id: 4 }, { id: 90 }] })

    // Dropping a pending term removes it from waiting product edits.
    const { termId: other } = database.queueTaxonomyChange({ shopUrl, taxonomy: 'product_cat', operation: 'create', fields: { name: 'Fruehling', slug: '', parent: 0, description: '' } })
    database.queueProductChange({ shopUrl, productId: 70, values: {}, terms: { categories: [other] } })
    database.discardTaxonomyChange({ shopUrl, taxonomy: 'product_cat', termId: other })
    expect(database.listProducts({ query: 'SOCK' }).products[0].changes).toEqual({ categories: [] })
  } finally { database.close() }
})
