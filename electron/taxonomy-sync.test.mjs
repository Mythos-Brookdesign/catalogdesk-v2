import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import databaseModule from './database.cjs'
import syncModule from './taxonomy-sync.cjs'

const shopUrl = 'https://shop.example/'
const connection = { url: shopUrl, consumerKey: 'ck_' + 'a'.repeat(40), consumerSecret: 'cs_' + 'b'.repeat(40) }
const directories = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'catalogdesk-v2-term-sync-'))
  directories.push(directory)
  const database = databaseModule.openDatabase(path.join(directory, 'catalogdesk-v2.sqlite'))
  const term = (id, name, parentId = 0, count = 0) => ({ id, name, slug: name.toLowerCase(), parentId, count, menuOrder: 0, payload: { id, name, description: '' } })
  database.replaceTaxonomies({
    shopUrl, importedAt: new Date().toISOString(),
    taxonomies: [
      { taxonomy: 'product_cat', kind: 'core', label: 'Kategorien', route: 'wc/v3/products/categories', hierarchical: true, available: true, attribute: null, terms: [term(4, 'Kleidung', 0, 3), term(5, 'Shirts', 4, 2)] },
      { taxonomy: 'product_material', kind: 'custom', label: 'Material', route: 'wp/v2/materials', hierarchical: false, available: true, attribute: null, terms: [] },
    ],
  })
  const call = (operation, payload) => Promise.resolve(database[operation](payload))
  const list = () => database.listTaxonomyTerms({ shopUrl, taxonomy: 'product_cat' }).terms.map((entry) => [entry.name, entry.id > 0 ? entry.id : 'local', entry.depth, entry.state, entry.changeState])
  return { database, call, list }
}

it('queues edits offline, shows them merged and validates names, slugs, parents and cycles', () => {
  const { database, list } = setup()
  try {
    const change = (input) => database.queueTaxonomyChange({ shopUrl, taxonomy: 'product_cat', ...input })
    const fields = (name, parent = 0, slug = '') => ({ name, slug, parent, description: '' })
    const { termId: hosen } = change({ operation: 'create', fields: fields('Hosen', 4) })
    expect(hosen).toBeLessThan(0)
    const { termId: jeans } = change({ operation: 'create', fields: fields('Jeans', hosen) })
    change({ operation: 'update', termId: 5, fields: fields('T-Shirts', 4) })
    expect(list()).toEqual([
      ['Kleidung', 4, 0, 'clean', null], ['Hosen', 'local', 1, 'create', 'pending'], ['Jeans', 'local', 2, 'create', 'pending'], ['T-Shirts', 5, 1, 'update', 'pending'],
    ])
    expect(database.listTaxonomyTerms({ shopUrl, taxonomy: 'product_cat', query: 'T-Shirt' }).terms[0]).toMatchObject({ id: 5, slug: 'shirts' })
    expect(() => change({ operation: 'create', fields: fields('hosen', 4) })).toThrow('existiert auf dieser Ebene')
    expect(() => change({ operation: 'create', fields: fields('Neu', 0, 'shirts') })).toThrow('Slug ist bereits vergeben')
    expect(() => change({ operation: 'update', termId: 4, fields: fields('Kleidung', jeans) })).toThrow('unter sich selbst')
    expect(() => change({ operation: 'create', fields: fields('X', 999) })).toThrow('Uebergeordneter Begriff')
    expect(() => database.queueTaxonomyChange({ shopUrl, taxonomy: 'product_material', operation: 'create', fields: fields('Holz') })).toThrow('nur gelesen')

    change({ operation: 'delete', termId: hosen })
    expect(list().find(([name]) => name === 'Jeans')).toEqual(['Jeans', 'local', 1, 'create', 'pending'])
    change({ operation: 'delete', termId: 5 })
    expect(list().find(([name]) => name === 'Shirts')).toEqual(['Shirts', 5, 1, 'delete', 'pending'])
    expect(() => change({ operation: 'update', termId: 5, fields: fields('Shirts', 4) })).toThrow('nicht gefunden')
    database.discardTaxonomyChange({ shopUrl, taxonomy: 'product_cat', termId: 5 })
    expect(list().find(([name]) => name === 'Shirts')).toEqual(['Shirts', 5, 1, 'clean', null])
    expect(database.taxonomyOverview({ shopUrl })).toMatchObject({ pendingChanges: 1, failedChanges: 0, taxonomies: [{ termCount: 3, pendingCount: 1, editable: true }, { editable: false }] })
  } finally { database.close() }
})

it('syncs creates parent-first, maps local IDs, keeps edits on failure and stops when offline', async () => {
  const { database, call, list } = setup()
  try {
    const change = (input) => database.queueTaxonomyChange({ shopUrl, taxonomy: 'product_cat', ...input })
    const { termId: hosen } = change({ operation: 'create', fields: { name: 'Hosen', slug: '', parent: 4, description: '' } })
    change({ operation: 'create', fields: { name: 'Jeans', slug: '', parent: hosen, description: 'Denim' } })
    change({ operation: 'update', termId: 5, fields: { name: 'T-Shirts', slug: '', parent: 4, description: '' } })
    change({ operation: 'delete', termId: 4 })

    const offline = vi.fn(async () => { throw new TypeError('net::ERR_INTERNET_DISCONNECTED') })
    expect(await syncModule.syncTaxonomyChanges(connection, call, offline)).toMatchObject({ synced: 0, offline: true, pendingChanges: 4 })

    let nextId = 100
    const requests = []
    const shop = vi.fn(async (url, options) => {
      const { pathname, searchParams } = new URL(url)
      const body = options.body ? JSON.parse(options.body) : null
      requests.push([options.method, pathname.replace('/wp-json/wc/v3/products/categories', ''), body, searchParams.get('force')])
      if (options.method === 'POST') return json({ id: nextId++, ...body, slug: body.name.toLowerCase(), count: 0 }, 201)
      if (options.method === 'PUT') return json({ code: 'term_exists', message: 'Ein Begriff mit diesem Namen existiert bereits.' }, 400)
      return json({ deleted: true })
    })
    expect(await syncModule.syncTaxonomyChanges(connection, call, shop)).toMatchObject({ synced: 3, failed: 1, offline: false, pendingChanges: 0, failedChanges: 1 })
    expect(requests).toEqual([
      ['POST', '', { name: 'Hosen', description: '', parent: 4 }, null],
      ['POST', '', { name: 'Jeans', description: 'Denim', parent: 100 }, null],
      ['PUT', '/5', { name: 'T-Shirts', description: '', slug: 'shirts', parent: 4 }, null],
      ['DELETE', '/4', null, 'true'],
    ])
    for (const [, options] of shop.mock.calls) expect(options).toMatchObject({ redirect: 'error', credentials: 'omit' })
    expect(list()).toEqual([
      ['Hosen', 100, 0, 'clean', null], ['Jeans', 101, 1, 'clean', null], ['T-Shirts', 5, 0, 'update', 'failed'],
    ])
    expect(database.listTaxonomyTerms({ shopUrl, taxonomy: 'product_cat', query: 'T-Shirts' }).terms[0].error).toContain('existiert bereits')

    const denied = vi.fn(async () => json({ code: 'woocommerce_rest_cannot_edit', message: 'Keine Berechtigung.' }, 401))
    database.retryTaxonomyChanges({ shopUrl })
    expect(await syncModule.syncTaxonomyChanges(connection, call, denied)).toMatchObject({ failed: 1, failedChanges: 1 })
    expect(database.listTaxonomyTerms({ shopUrl, taxonomy: 'product_cat', query: 'T-Shirts' }).terms[0].error).toContain('Schreibrechte')
  } finally { database.close() }
})

it('keeps an edit made while the create request was running', async () => {
  const { database, call, list } = setup()
  try {
    const { termId } = database.queueTaxonomyChange({ shopUrl, taxonomy: 'product_cat', operation: 'create', fields: { name: 'Hosen', slug: '', parent: 0, description: '' } })
    const shop = vi.fn(async (_url, options) => {
      database.queueTaxonomyChange({ shopUrl, taxonomy: 'product_cat', operation: 'update', termId, fields: { name: 'Hosen & Jeans', slug: '', parent: 0, description: '' } })
      return json({ id: 200, ...JSON.parse(options.body), slug: 'hosen' }, 201)
    })
    await syncModule.syncTaxonomyChanges(connection, call, shop)
    expect(list().find(([, id]) => id === 200)).toEqual(['Hosen & Jeans', 200, 0, 'update', 'pending'])
  } finally { database.close() }
})
