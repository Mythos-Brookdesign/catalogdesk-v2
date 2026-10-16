import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import databaseModule from './database.cjs'
import products from './products.cjs'
import productSync from './product-sync.cjs'
import modules from './modules/index.cjs'

const shopUrl = 'https://shop.example/'
const connection = { url: shopUrl, consumerKey: 'ck_' + 'a'.repeat(40), consumerSecret: 'cs_' + 'b'.repeat(40) }
const directories = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const hoodie = {
  id: 60, name: 'Hoodie', type: 'simple', status: 'publish', sku: 'HOOD', categories: [{ id: 4, name: 'Kleidung', slug: 'kleidung' }, { id: 5, name: 'Sport', slug: 'sport' }],
  meta_data: [{ id: 1, key: '_yoast_wpseo_title', value: '%%title%% %%sep%% Shop' }, { id: 2, key: '_yoast_wpseo_focuskw', value: 'hoodie' }, { id: 3, key: '_other_plugin', value: 'x' }],
}

function setup(detected = ['yoast-seo']) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'catalogdesk-v2-yoast-'))
  directories.push(directory)
  const database = databaseModule.openDatabase(path.join(directory, 'catalogdesk-v2.sqlite'))
  const term = (id, name) => ({ id, name, slug: name.toLowerCase(), parentId: 0, count: 0, menuOrder: 0, payload: {} })
  database.replaceTaxonomies({ shopUrl, importedAt: new Date().toISOString(), modules: detected,
    taxonomies: [{ taxonomy: 'product_cat', kind: 'core', label: 'Kategorien', route: 'wc/v3/products/categories', hierarchical: true, available: true, attribute: null, terms: [term(4, 'Kleidung'), term(5, 'Sport'), term(6, 'Outdoor')] }],
    productFields: [{ scope: 'product', field: 'categories', multiple: true }] })
  database.replaceCatalog({ shopUrl, importedAt: new Date().toISOString(), products: [products.toProduct(JSON.parse(JSON.stringify(hoodie)))] })
  return { database, call: (operation, payload) => Promise.resolve(database[operation](payload)) }
}

it('is detected by the Yoast REST namespace', () => {
  expect(modules.detectModules({ namespaces: ['wc/v3', 'yoast/v1'], taxonomies: [], productFields: [] })).toEqual(['yoast-seo'])
  expect(modules.detectModules({ namespaces: ['wc/v3'], taxonomies: [], productFields: [] })).toEqual([])
})

it('edits Yoast meta fields with validation and sends only the changed meta keys', async () => {
  const { database, call } = setup()
  try {
    const options = database.productEditorOptions({ shopUrl })
    expect(options.metaFields.map((field) => field.field)).toContain('meta:_yoast_wpseo_metadesc')
    expect(options.previews).toEqual([expect.objectContaining({ type: 'search-snippet', title: 'meta:_yoast_wpseo_title', section: 'Yoast SEO' })])
    const change = (values) => database.queueProductChange({ shopUrl, productId: 60, values, terms: {} })
    expect(() => change({ 'meta:_yoast_wpseo_canonical': 'shop.example/x' })).toThrow('vollstaendige Adresse')
    expect(() => change({ 'meta:_yoast_wpseo_meta-robots-noindex': '7' })).toThrow('ungueltig')
    expect(() => change({ 'meta:_yoast_wpseo_primary_product_cat': '6' })).toThrow('zugeordneten Kategorien')
    expect(() => change({ 'meta:_unknown_plugin': 'x' })).toThrow('kann nicht bearbeitet werden')
    const result = change({ 'meta:_yoast_wpseo_metadesc': 'Warmer Hoodie aus Bio-Baumwolle.', 'meta:_yoast_wpseo_focuskw': 'hoodie', 'meta:_yoast_wpseo_primary_product_cat': '5' })
    expect(result).toMatchObject({ queued: true, labels: { 'meta:_yoast_wpseo_metadesc': 'Meta-Beschreibung' }, before: { 'meta:_yoast_wpseo_metadesc': null } })
    // The unchanged focus keyphrase is not part of the edit.
    expect(Object.keys(database.listProducts().products[0].changes)).toEqual(['meta:_yoast_wpseo_metadesc', 'meta:_yoast_wpseo_primary_product_cat'])

    const shop = JSON.parse(JSON.stringify(hoodie))
    let body
    const fetcher = vi.fn(async (_url, options) => {
      if (options.method === 'PUT') {
        body = JSON.parse(options.body)
        for (const { key, value } of body.meta_data) {
          const entry = shop.meta_data.find((item) => item.key === key)
          if (entry) entry.value = value
          else shop.meta_data.push({ id: shop.meta_data.length + 1, key, value })
        }
      }
      return json(shop)
    })
    expect(await productSync.syncProductChanges(connection, call, fetcher)).toMatchObject({ synced: 1, failed: 0 })
    expect(body).toEqual({ meta_data: [{ key: '_yoast_wpseo_metadesc', value: 'Warmer Hoodie aus Bio-Baumwolle.' }, { key: '_yoast_wpseo_primary_product_cat', value: '5' }] })
    expect(database.listProducts().products[0]).toMatchObject({ syncState: 'clean' })
    expect(shop.meta_data.find((item) => item.key === '_other_plugin').value).toBe('x')

    // A Yoast value changed in the shop meanwhile is a conflict like any other field.
    change({ 'meta:_yoast_wpseo_title': 'Neuer Titel' })
    shop.meta_data[0].value = 'Im Shop geaendert'
    expect(await productSync.syncProductChanges(connection, call, fetcher)).toMatchObject({ conflicts: 1 })
    expect(database.listProducts().products[0].remote).toEqual({ 'meta:_yoast_wpseo_title': 'Im Shop geaendert' })
  } finally { database.close() }
})

it('hides Yoast fields while the module is switched off', () => {
  const { database } = setup()
  try {
    database.setModuleEnabled({ shopUrl, moduleId: 'yoast-seo', enabled: false })
    expect(database.productEditorOptions({ shopUrl })).toMatchObject({ metaFields: [], previews: [] })
    expect(() => database.queueProductChange({ shopUrl, productId: 60, values: { 'meta:_yoast_wpseo_title': 'x' }, terms: {} })).toThrow('kann nicht bearbeitet werden')
  } finally { database.close() }
})
