import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import databaseModule from './database.cjs'
import products from './products.cjs'
import productSync from './product-sync.cjs'
import media from './media.cjs'
import productFields from './product-fields.cjs'

const shopUrl = 'https://shop.example/'
const connection = { url: shopUrl, consumerKey: 'ck_' + 'a'.repeat(40), consumerSecret: 'cs_' + 'b'.repeat(40), wpUser: 'redaktion', wpAppPassword: 'abcdEFGH1234ijklMNOP5678' }
const directories = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const json = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } })
const image = (id, alt = '') => ({ id, src: `https://shop.example/wp-content/uploads/${id}.jpg`, name: `Bild ${id}`, alt })
const mug = { id: 70, name: 'Tasse', type: 'simple', status: 'publish', sku: 'MUG', images: [image(11, 'Vorne'), image(12)], meta_data: [] }
const shirt = { id: 80, name: 'Shirt', type: 'variable', status: 'publish', sku: 'SHIRT', images: [], meta_data: [] }
const red = { id: 81, parent_id: 80, name: 'Rot', type: 'variation', status: 'publish', sku: 'SHIRT-R', image: null, meta_data: [] }

function setup(detected = []) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'catalogdesk-v2-media-'))
  directories.push(directory)
  const database = databaseModule.openDatabase(path.join(directory, 'catalogdesk-v2.sqlite'))
  database.replaceTaxonomies({ shopUrl, importedAt: new Date().toISOString(), modules: detected,
    taxonomies: [{ taxonomy: 'product_cat', kind: 'core', label: 'Kategorien', route: 'wc/v3/products/categories', hierarchical: true, available: true, attribute: null, terms: [] }] })
  database.replaceCatalog({ shopUrl, importedAt: new Date().toISOString(), products: [
    products.toProduct(structuredClone(mug)), products.toProduct(structuredClone(shirt)), products.toProduct(structuredClone(red), { id: 80, name: 'Shirt' }),
  ] })
  return { database, call: (operation, payload) => Promise.resolve(database[operation](payload)) }
}
const upload = (database, filename = 'neu.png') => database.addMediaUpload({ shopUrl, file: '00000000-0000-4000-8000-000000000000.png', filename, mime: 'image/png', size: 10, thumbnail: null })

it('compares images by order and alt text and sends only IDs and non-empty alt texts', () => {
  expect(productFields.same([image(11), image(12)], [image(12), image(11)])).toBe(false)
  expect(productFields.same([image(11, 'A')], [{ id: 11, src: '', name: '', alt: 'A' }])).toBe(true)
  expect(productFields.same([], null)).toBe(true)
  expect(productFields.toRequestBody({ images: [image(12, 'Seite'), image(11)], image: null })).toEqual({ images: [{ id: 12, alt: 'Seite' }, { id: 11 }], image: { id: 0 } })
  expect(productFields.display('images', [image(11), { id: -1, src: '', name: '', alt: '' }])).toBe('Bild 11, Neues Bild')
})

it('reorders product images, keeps them per field and rejects the wrong image field', () => {
  const { database } = setup()
  try {
    const change = (productId, values) => database.queueProductChange({ shopUrl, productId, values, terms: {} })
    expect(() => change(70, { image: image(11) })).toThrow('kann nicht bearbeitet werden')
    expect(() => change(81, { images: [image(11)] })).toThrow('kann nicht bearbeitet werden')
    expect(() => change(70, { images: [image(11), image(11)] })).toThrow('nur einmal')
    // Setting the shop order again is no change.
    expect(change(70, { images: [image(12), image(11, 'Vorne')] })).toMatchObject({ queued: true })
    expect(change(70, { images: [image(11, 'Vorne'), image(12)] })).toMatchObject({ queued: false })
    expect(change(81, { image: image(12) })).toMatchObject({ queued: true })
    expect(database.listProducts().products.find((entry) => entry.id === 81).payload.image).toMatchObject({ id: 12 })
  } finally { database.close() }
})

it('waits for an upload, then sends the edit with the new media ID', async () => {
  const { database, call } = setup()
  try {
    const pending = upload(database)
    expect(pending).toMatchObject({ id: -1, name: 'neu.png', state: 'pending' })
    expect(() => database.queueProductChange({ shopUrl, productId: 70, values: { images: [{ ...image(-7), src: '' }] }, terms: {} })).toThrow('nicht gefunden')
    database.queueProductChange({ shopUrl, productId: 70, values: { images: [{ id: -1, src: '', name: '', alt: 'Neu' }, image(11, 'Vorne')] }, terms: {} })
    expect(database.listMediaUploads({ shopUrl })).toEqual([expect.objectContaining({ id: -1, name: 'neu.png', state: 'pending' })])

    const shop = structuredClone(mug)
    let body
    const fetcher = vi.fn(async (url, options) => {
      if (options.method === 'PUT') {
        body = JSON.parse(options.body)
        shop.images = body.images.map((entry) => ({ ...image(entry.id), alt: entry.alt ?? (entry.id === 11 ? 'Vorne' : '') }))
      }
      return json(shop)
    })
    // The product edit is skipped while the image is not in the shop yet.
    expect(await productSync.syncProductChanges(connection, call, fetcher)).toMatchObject({ synced: 0 })
    expect(fetcher).not.toHaveBeenCalled()

    const uploadFetcher = vi.fn(async () => json({ id: 99, source_url: 'https://shop.example/wp-content/uploads/neu.png', alt_text: '', title: { rendered: 'neu' } }))
    expect(await media.syncMediaUploads(connection, call, uploadFetcher, async () => Buffer.from('png'))).toMatchObject({ uploaded: 1, failed: 0 })
    expect(uploadFetcher.mock.calls[0][1].headers['Content-Disposition']).toContain('neu.png')
    expect(database.listMediaUploads({ shopUrl })).toEqual([])
    expect(database.listProducts().products.find((entry) => entry.id === 70).changes.images.map((entry) => entry.id)).toEqual([99, 11])

    expect(await productSync.syncProductChanges(connection, call, fetcher)).toMatchObject({ synced: 1, failed: 0 })
    expect(body).toEqual({ images: [{ id: 99, alt: 'Neu' }, { id: 11, alt: 'Vorne' }] })
  } finally { database.close() }
})

it('marks edits that need a rejected upload as failed and retries both together', async () => {
  const { database, call } = setup()
  try {
    upload(database, 'kaputt.png')
    database.queueProductChange({ shopUrl, productId: 81, values: { image: { id: -1, src: '', name: '', alt: '' } }, terms: {} })
    const rejecting = vi.fn(async () => new Response(JSON.stringify({ message: 'Dateityp nicht erlaubt' }), { status: 400, headers: { 'content-type': 'application/json' } }))
    expect(await media.syncMediaUploads(connection, call, rejecting, async () => Buffer.from('x'))).toMatchObject({ uploaded: 0, failed: 1 })
    expect(database.listProducts().products.find((entry) => entry.id === 81)).toMatchObject({ changeState: 'failed', changeError: expect.stringContaining('kaputt.png') })
    database.retryProductChanges({ shopUrl })
    expect(database.listMediaUploads({ shopUrl })[0]).toMatchObject({ state: 'pending', error: null })
    // Without an application password nothing is sent.
    const fetcher = vi.fn()
    expect(await media.syncMediaUploads({ ...connection, wpUser: undefined, wpAppPassword: undefined }, call, fetcher, async () => Buffer.from('x'))).toMatchObject({ uploaded: 0 })
    expect(fetcher).not.toHaveBeenCalled()
  } finally { database.close() }
})

it('sets Yoast social images with URL and media ID, also for a pending upload', async () => {
  const { database, call } = setup(['yoast-seo'])
  try {
    const change = (values) => database.queueProductChange({ shopUrl, productId: 70, values, terms: {} })
    expect(() => change({ 'meta:_yoast_wpseo_opengraph-image-id': 'abc' })).toThrow('ungueltig')
    upload(database, 'social.jpg')
    change({ 'meta:_yoast_wpseo_opengraph-image': '', 'meta:_yoast_wpseo_opengraph-image-id': '-1' })
    await media.syncMediaUploads(connection, call, async () => json({ id: 55, source_url: 'https://shop.example/wp-content/uploads/social.jpg' }), async () => Buffer.from('x'))
    expect(database.listProducts().products.find((entry) => entry.id === 70).changes).toEqual({
      'meta:_yoast_wpseo_opengraph-image': 'https://shop.example/wp-content/uploads/social.jpg', 'meta:_yoast_wpseo_opengraph-image-id': '55',
    })
    const meta = productFields.toRequestBody(database.listProducts().products.find((entry) => entry.id === 70).changes).meta_data
    expect(Object.fromEntries(meta.map((entry) => [entry.key, entry.value]))).toEqual({ '_yoast_wpseo_opengraph-image': 'https://shop.example/wp-content/uploads/social.jpg', '_yoast_wpseo_opengraph-image-id': '55' })
  } finally { database.close() }
})

it('lists the media library with thumbnails and page count', async () => {
  const fetcher = vi.fn(async () => json([{ id: 5, source_url: 'https://shop.example/a.jpg', alt_text: 'A', title: { rendered: 'Tasse &amp; Teller' }, media_details: { sizes: { medium: { source_url: 'https://shop.example/a-300.jpg' } } } }], { 'x-wp-totalpages': '3' }))
  expect(await media.listMediaLibrary(connection, fetcher, { search: 'tasse', page: 2 })).toEqual({ items: [{ id: 5, src: 'https://shop.example/a.jpg', thumb: 'https://shop.example/a-300.jpg', alt: 'A', name: 'Tasse & Teller' }], page: 2, pages: 3 })
  const url = new URL(fetcher.mock.calls[0][0])
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ media_type: 'image', search: 'tasse', page: '2' })
})
