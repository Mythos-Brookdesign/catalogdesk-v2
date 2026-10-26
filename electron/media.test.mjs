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
// WordPress with posts, pages, block templates and settings; `trash` switches MEDIA_TRASH on.
function fakeWordPress({ posts = [], pages = [], templates = [], settings = { site_logo: 0, site_icon: 0 }, trash = false } = {}) {
  const deletes = []
  const types = {
    post: { name: 'Beitraege', rest_base: 'posts', rest_namespace: 'wp/v2' }, page: { name: 'Seiten', rest_base: 'pages', rest_namespace: 'wp/v2' },
    attachment: { name: 'Medien', rest_base: 'media', rest_namespace: 'wp/v2' }, wp_template: { name: 'Templates', rest_base: 'templates', rest_namespace: 'wp/v2' },
  }
  const fetcher = vi.fn(async (url, options) => {
    const { pathname, searchParams } = new URL(url)
    const route = pathname.replace('/wp-json/', '')
    if (options.method === 'DELETE') {
      const force = searchParams.get('force') === 'true'
      deletes.push({ id: Number(route.split('/').pop()), force })
      if (!force && !trash) return new Response(JSON.stringify({ code: 'rest_trash_not_supported', message: 'no trash' }), { status: 501, headers: { 'content-type': 'application/json' } })
      return json({ deleted: true })
    }
    if (route === 'wp/v2/types') return json(types)
    if (route === 'wp/v2/settings') return json(settings)
    if (route === 'wp/v2/templates') return json(templates)
    const list = { 'wp/v2/posts': posts, 'wp/v2/pages': pages }[route] ?? []
    const search = searchParams.get('search')
    return json(search ? list.filter((entry) => entry.content.raw.includes(search)) : list, { 'x-wp-totalpages': '1' })
  })
  return { fetcher, deletes }
}
// The queued edit of a product reached the shop (the shop now has `images`).
function pushed(database, productId, images) {
  const change = database.pendingProductChanges({ shopUrl }).find((entry) => entry.productId === productId)
  database.completeProductChange({ changeId: change.id, revision: change.revision, product: products.toProduct({ ...structuredClone(mug), id: productId, images }) })
}
const entry = (id, title, content = '', featured = 0) => ({ id, title: { raw: title }, content: { raw: content }, featured_media: featured, link: `https://shop.example/?p=${id}` })

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

const wpMedia = (id, { title = `Bild ${id}`, alt = '', modified = '2026-10-01T10:00:00', raw = true } = {}) => ({
  id, source_url: `https://shop.example/wp-content/uploads/${id}.jpg`, alt_text: alt, mime_type: 'image/jpeg', date_gmt: '2026-10-01T08:00:00', modified,
  title: raw ? { raw: title, rendered: title } : { rendered: title }, caption: raw ? { raw: '', rendered: '' } : { rendered: '' }, description: raw ? { raw: '', rendered: '' } : { rendered: '' },
  media_details: { width: 800, height: 600, filesize: 1234, file: `2026/10/${id}.jpg`, sizes: { medium: { source_url: `https://shop.example/wp-content/uploads/${id}-300.jpg` } } },
})

it('imports the media library, refreshes only changes and removes deleted images', async () => {
  const { database } = setup(['yoast-seo'])
  try {
    const fetcher = vi.fn(async (url) => {
      const params = new URL(url).searchParams
      if (params.get('_fields') === 'id') return json([{ id: 11 }, { id: 13 }], { 'x-wp-totalpages': '1' })
      if (params.get('modified_after')) return json([wpMedia(13, { modified: '2026-10-05T09:00:00' })], { 'x-wp-totalpages': '1' })
      return json([wpMedia(11, { alt: 'Vorne' }), wpMedia(12), wpMedia(14, { raw: false })], { 'x-wp-totalpages': '1' })
    })
    const first = await media.importMediaLibrary(connection, fetcher)
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('context')).toBe('edit')
    expect(first.items[0]).toMatchObject({ mediaId: 11, alt: 'Vorne', filename: '11.jpg', thumbUrl: 'https://shop.example/wp-content/uploads/11-300.jpg', width: 800, editable: true })
    expect(first.items[2]).toMatchObject({ mediaId: 14, editable: false })
    database.storeMediaLibrary({ shopUrl, syncedAt: new Date().toISOString(), items: first.items, ids: first.ids })
    expect(database.mediaLibraryState({ shopUrl })).toMatchObject({ imported: true, count: 3, lastModified: '2026-10-01T10:00:00' })

    // Usage comes from the products: Tasse uses 11 (product image) and 12 (gallery); a queued Yoast image counts too.
    database.queueProductChange({ shopUrl, productId: 70, values: { 'meta:_yoast_wpseo_opengraph-image': 'https://shop.example/wp-content/uploads/14.jpg', 'meta:_yoast_wpseo_opengraph-image-id': '14' }, terms: {} })
    const list = (query) => database.listMedia({ shopUrl, ...query })
    expect(list({}).items.map((item) => [item.id, item.usage])).toEqual([[14, 1], [12, 1], [11, 1]])
    expect(database.mediaDetail({ shopUrl, mediaId: 11 }).usedIn).toEqual([{ productId: 70, parentId: null, name: 'Tasse', role: 'Produktbild' }])
    expect(database.mediaDetail({ shopUrl, mediaId: 14 }).usedIn[0]).toMatchObject({ role: 'Social-Bild' })
    expect(list({ filter: 'noAlt' }).items.map((item) => item.id)).toEqual([14, 12])
    expect(list({ query: 'bild 12' }).items.map((item) => item.id)).toEqual([12])

    const refresh = await media.importMediaLibrary(connection, fetcher, { since: '2026-10-01T10:00:00' })
    expect(new URL(fetcher.mock.calls.at(-2)[0]).searchParams.get('modified_after')).toBe('2026-10-01T09:59:00')
    database.storeMediaLibrary({ shopUrl, syncedAt: new Date().toISOString(), items: refresh.items, ids: refresh.ids })
    expect(list({}).items.map((item) => item.id)).toEqual([13, 11])
    expect(list({ filter: 'unused' }).items.map((item) => item.id)).toEqual([13])
  } finally { database.close() }
})

it('edits media texts through the queue with conflict check and only for editable items', async () => {
  const { database, call } = setup()
  try {
    database.storeMediaLibrary({ shopUrl, syncedAt: new Date().toISOString(), items: [media.toMediaItem(wpMedia(11, { alt: 'Alt' })), media.toMediaItem(wpMedia(14, { raw: false }))], ids: null })
    expect(() => database.queueMediaChange({ shopUrl, mediaId: 14, values: { alt: 'x' } })).toThrow('Anwendungspasswort')
    expect(database.queueMediaChange({ shopUrl, mediaId: 11, values: { alt: '' , title: 'Bild 11' } })).toMatchObject({ queued: true })
    expect(database.listMedia({ shopUrl, filter: 'changed' }).items).toEqual([expect.objectContaining({ id: 11, alt: '', changeState: 'pending' })])

    const shop = wpMedia(11, { alt: 'Alt' })
    let body
    const fetcher = vi.fn(async (_url, options) => {
      if (options.method === 'POST') {
        body = JSON.parse(options.body)
        if ('alt_text' in body) shop.alt_text = body.alt_text
        for (const field of ['title', 'caption', 'description']) if (field in body) shop[field] = { raw: body[field], rendered: body[field] }
      }
      return json(shop)
    })
    expect(await media.syncMediaChanges(connection, call, fetcher)).toMatchObject({ synced: 1 })
    // The alt text can be emptied here, unlike through WooCommerce.
    expect(body).toEqual({ alt_text: '' })
    expect(fetcher.mock.calls[0][1].headers.Authorization).toContain('Basic ')
    expect(database.mediaLibraryState({ shopUrl }).changeCounts).toEqual({ pending: 0, failed: 0, conflict: 0 })

    // Changed in WordPress meanwhile: conflict, then "mine" keeps the edit.
    database.queueMediaChange({ shopUrl, mediaId: 11, values: { caption: 'Mein Text' } })
    shop.caption = { raw: 'Aus WordPress', rendered: '<p>Aus WordPress</p>' }
    expect(await media.syncMediaChanges(connection, call, fetcher)).toMatchObject({ conflicts: 1 })
    expect(database.mediaDetail({ shopUrl, mediaId: 11 })).toMatchObject({ changeState: 'conflict', remote: { caption: 'Aus WordPress' } })
    database.resolveMediaConflict({ shopUrl, mediaId: 11, resolutions: { caption: 'mine' } })
    expect(await media.syncMediaChanges(connection, call, fetcher)).toMatchObject({ synced: 1 })
    expect(body).toEqual({ caption: 'Mein Text' })
  } finally { database.close() }
})

it('lists uploads that have not reached WordPress as part of the library and guards discarding them', () => {
  const { database } = setup()
  try {
    // Not imported yet: the upload is still listed.
    upload(database, 'tasse-neu.png')
    upload(database, 'reserve.png')
    database.queueProductChange({ shopUrl, productId: 70, values: { images: [{ id: -1, src: '', name: '', alt: '' }] }, terms: {} })
    const list = database.listMedia({ shopUrl })
    // Uploads first, then the images the imported products already show (provisional, read-only).
    expect(list).toMatchObject({ imported: false, uploads: 2, total: 4 })
    expect(list.items.map((item) => [item.id, item.filename, item.upload ?? null, item.usage])).toEqual([[-2, 'reserve.png', 'pending', 0], [-1, 'tasse-neu.png', 'pending', 1], [12, '12.jpg', null, 0], [11, '11.jpg', null, 0]])
    expect(list.items[3]).toMatchObject({ title: 'Bild 11', alt: 'Vorne', editable: false })
    expect(database.listMedia({ shopUrl, filter: 'pending', query: 'tasse' }).items.map((item) => item.id)).toEqual([-1])
    expect(database.mediaDetail({ shopUrl, mediaId: -1 }).usedIn).toEqual([{ productId: 70, parentId: null, name: 'Tasse', role: 'Produktbild' }])
    // Deleting an upload drops it and removes it from the product edit that waited for it.
    expect(database.deleteMedia({ shopUrl, mediaId: -1 })).toMatchObject({ name: 'tasse-neu.png', queued: false, removedFrom: [{ productId: 70, name: 'Tasse' }] })
    expect(database.listMedia({ shopUrl, filter: 'pending' }).items.map((item) => item.id)).toEqual([-2])
    // Tasse's queued edit only had that upload left, so it now has no images.
    expect(database.listProducts().products.find((entry) => entry.id === 70).changes).toEqual({ images: [] })
  } finally { database.close() }
})

it('deletes an image: removes it from products first, then deletes it in WordPress', async () => {
  const { database, call } = setup(['yoast-seo'])
  try {
    database.storeMediaLibrary({ shopUrl, syncedAt: new Date().toISOString(), items: [], ids: null })
    // 11 is the product image of Tasse, the variation image of Rot and Tasse's social image.
    database.queueProductChange({ shopUrl, productId: 81, values: { image: image(11) }, terms: {} })
    database.queueProductChange({ shopUrl, productId: 70, values: { 'meta:_yoast_wpseo_opengraph-image': image(11).src, 'meta:_yoast_wpseo_opengraph-image-id': '11' }, terms: {} })
    database.deleteMedia({ shopUrl, mediaId: 11 })
    const changes = (id) => database.listProducts().products.find((entry) => entry.id === id).changes
    expect(changes(70)).toEqual({ images: [expect.objectContaining({ id: 12 })] })
    expect(changes(81)).toBeNull()
    expect(database.listMedia({ shopUrl }).items.find((item) => item.id === 11)).toMatchObject({ changeOperation: 'delete', changeState: 'pending' })
    expect(() => database.queueMediaChange({ shopUrl, mediaId: 11, values: { alt: 'x' } })).toThrow('Loeschen vorgemerkt')
    // Nothing is deleted while the product edit has not reached the shop.
    expect(database.pendingMediaDeletions({ shopUrl })).toEqual([])
    const wordpress = fakeWordPress()
    pushed(database, 70, [image(12)])
    expect(database.pendingMediaDeletions({ shopUrl })).toEqual([expect.objectContaining({ mediaId: 11 })])
    expect(await media.syncMediaDeletions(connection, call, wordpress.fetcher)).toMatchObject({ deleted: 1, held: 0 })
    // No media trash in this WordPress: the trash attempt answers 501, then the image is deleted for good.
    expect(wordpress.deletes).toEqual([{ id: 11, force: false }, { id: 11, force: true }])
    expect(database.mediaLibraryState({ shopUrl }).trash).toBe(false)
    expect(database.listMedia({ shopUrl }).items.map((item) => item.id)).toEqual([12])
  } finally { database.close() }
})

it('holds a deletion while WordPress still uses the image and deletes it only when forced', async () => {
  const { database, call } = setup()
  try {
    database.storeMediaLibrary({ shopUrl, syncedAt: new Date().toISOString(), items: [media.toMediaItem(wpMedia(30)), media.toMediaItem(wpMedia(31)), media.toMediaItem(wpMedia(32))], ids: null })
    const wordpress = fakeWordPress({
      trash: true,
      // 30: in a page's content (block editor) and via its URL in a post; 300 must not count as 30.
      pages: [entry(1, 'Ueber uns', '<!-- wp:image {"id":30} --><img class="wp-image-30" src="x"/>'), entry(2, 'Galerie', '<img class="wp-image-300"/>')],
      posts: [entry(3, 'News', '<img src="https://shop.example/wp-content/uploads/2026/10/30-300x200.jpg"/>'), entry(4, 'Herbst', '', 31)],
      templates: [entry(5, 'Footer', '<img class="wp-image-32"/>')],
      settings: { site_logo: 31, site_icon: 0 },
    })
    for (const id of [30, 31, 32]) database.deleteMedia({ shopUrl, mediaId: id })
    expect(await media.syncMediaDeletions(connection, call, wordpress.fetcher)).toMatchObject({ deleted: 0, held: 3 })
    expect(wordpress.deletes).toEqual([])
    const held = (id) => database.mediaDetail({ shopUrl, mediaId: id })
    expect(held(30)).toMatchObject({ changeState: 'failed', blockedBy: [{ kind: 'Beitraege', title: 'News', where: 'Inhalt' }, { kind: 'Seiten', title: 'Ueber uns', where: 'Inhalt' }] })
    expect(held(31).blockedBy).toEqual([{ kind: 'Beitraege', title: 'Herbst', where: 'Beitragsbild', link: 'https://shop.example/?p=4' }, { kind: 'Website', title: 'Logo', where: 'Einstellungen' }])
    expect(held(32).blockedBy).toEqual([{ kind: 'Templates', title: 'Footer', where: 'Inhalt' }])

    // Forced: no check, and with MEDIA_TRASH the image goes to the trash.
    database.forceMediaDeletion({ shopUrl, mediaId: 30 })
    expect(await media.syncMediaDeletions(connection, call, wordpress.fetcher)).toMatchObject({ deleted: 1 })
    expect(wordpress.deletes).toEqual([{ id: 30, force: false }])
    expect(database.mediaLibraryState({ shopUrl }).trash).toBe(true)
  } finally { database.close() }
})

it('holds a deletion for an image used by a product category', async () => {
  const { database, call } = setup()
  try {
    database.replaceTaxonomies({ shopUrl, importedAt: new Date().toISOString(), taxonomies: [{ taxonomy: 'product_cat', kind: 'core', label: 'Kategorien', route: 'wc/v3/products/categories', hierarchical: true, available: true, attribute: null,
      terms: [{ id: 4, name: 'Tassen', slug: 'tassen', parentId: 0, count: 1, menuOrder: 0, payload: { id: 4, image: { id: 12, src: 'https://shop.example/12.jpg' } } }] }] })
    expect(database.mediaDetail({ shopUrl, mediaId: 12 }).usedIn).toEqual(expect.arrayContaining([{ productId: null, parentId: null, termId: 4, name: 'Tassen', role: 'Bild in Kategorien' }]))
    database.deleteMedia({ shopUrl, mediaId: 12 })
    pushed(database, 70, [image(11, 'Vorne')])
    expect(await media.syncMediaDeletions(connection, call, fakeWordPress().fetcher)).toMatchObject({ held: 1 })
    expect(database.mediaDetail({ shopUrl, mediaId: 12 }).blockedBy).toEqual([{ kind: 'Begriff', title: 'Tassen', where: 'Bild in Kategorien' }])
  } finally { database.close() }
})

it('adds uploaded images to the media library, imported or not', async () => {
  const { database, call } = setup()
  try {
    upload(database)
    await media.syncMediaUploads(connection, call, async () => json(wpMedia(99, { title: 'neu' })), async () => Buffer.from('png'))
    expect(database.listMedia({ shopUrl }).items.find((item) => item.id === 99)).toMatchObject({ title: 'neu', usage: 0, editable: true })
  } finally { database.close() }
})
