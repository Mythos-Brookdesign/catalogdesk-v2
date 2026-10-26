const { z } = require('zod')
const { WooError, normalizeUrl, wooRequest } = require('./shop.cjs')
const { decodeEntities } = require('./taxonomies.cjs')

const text = z.object({ raw: z.string().max(50_000), rendered: z.string().max(100_000) }).partial()
const mediaSchema = z.object({
  id: z.number().int().positive(),
  source_url: z.string().url().max(2048),
  alt_text: z.string().max(1000).optional().default(''),
  title: text.optional(), caption: text.optional(), description: text.optional(),
  mime_type: z.string().max(100).optional(), date_gmt: z.string().max(40).nullable().optional(), modified: z.string().max(40).optional(),
  media_details: z.object({
    sizes: z.record(z.string(), z.object({ source_url: z.string().url().max(2048) }).passthrough()).optional(),
    width: z.number().int().nonnegative().optional(), height: z.number().int().nonnegative().optional(), filesize: z.number().int().nonnegative().optional(), file: z.string().max(500).optional(),
  }).passthrough().optional(),
}).passthrough()
const fieldsParam = 'id,source_url,alt_text,title,caption,description,mime_type,date_gmt,modified,media_details'
const plain = (html) => decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())

// Local form of a media item. Read with an application password (context=edit) the texts are raw and
// editable; otherwise only the rendered HTML is available and the item is read-only.
function toMediaItem(media) {
  const details = media.media_details ?? {}
  const sizes = details.sizes ?? {}
  const raw = (value) => (value && typeof value.raw === 'string' ? value.raw : null)
  const editable = [media.title, media.caption, media.description].every((value) => raw(value) !== null)
  const textOf = (value, limit) => (raw(value) ?? plain(value?.rendered)).slice(0, limit)
  return {
    mediaId: media.id, title: textOf(media.title, 1000), alt: media.alt_text.slice(0, 1000), caption: textOf(media.caption, 10_000), description: textOf(media.description, 50_000),
    filename: (details.file ?? new URL(media.source_url).pathname).split('/').pop().slice(0, 500), mime: media.mime_type ?? '',
    width: details.width ?? null, height: details.height ?? null, filesize: details.filesize ?? null,
    sourceUrl: media.source_url, thumbUrl: (sizes.medium ?? sizes.thumbnail ?? sizes.woocommerce_thumbnail)?.source_url ?? media.source_url,
    uploadedAt: media.date_gmt ?? null, modifiedAt: media.modified ?? null, editable,
  }
}

const toItem = (media) => {
  const sizes = media.media_details?.sizes ?? {}
  return {
    id: media.id, src: media.source_url, alt: media.alt_text,
    name: decodeEntities(media.title?.rendered ?? '').slice(0, 500),
    thumb: (sizes.medium ?? sizes.thumbnail ?? sizes.woocommerce_thumbnail)?.source_url ?? media.source_url,
  }
}

// Images of the WordPress media library, newest first. Readable without login; with an application
// password also images attached to drafts and private products.
async function listMediaLibrary(connection, fetcher, { search = '', page = 1 } = {}) {
  const params = { media_type: 'image', per_page: '40', page: String(page), orderby: 'date', order: 'desc', _fields: 'id,source_url,alt_text,title,media_details' }
  if (search) params.search = search
  const { data, headers } = await wooRequest(connection, 'wp/v2/media', params, fetcher, { maxBytes: 4 * 1024 * 1024, wordpress: Boolean(connection.wpAppPassword) })
  const items = z.array(mediaSchema).max(100).safeParse(data)
  if (!items.success) throw new WooError('Die Mediathek liefert ein unbekanntes Format.')
  const pages = Number(headers.get('x-wp-totalpages'))
  return { items: items.data.map(toItem), page, pages: Number.isSafeInteger(pages) && pages > 0 ? pages : 1 }
}

// Reads the media library into the local copy. With `since` (last known modification, site time) only
// changed items are read; the list of all IDs is always read to find deleted items.
async function importMediaLibrary(connection, fetcher, { since = null, onProgress = () => {} } = {}) {
  const wordpress = Boolean(connection.wpAppPassword)
  async function pages(params, label) {
    const items = []
    for (let page = 1, total = 1; page <= total; page++) {
      onProgress({ label, page, pages: total })
      const { data, headers } = await wooRequest(connection, 'wp/v2/media', { media_type: 'image', per_page: '100', page: String(page), orderby: 'id', order: 'asc', ...params }, fetcher, { maxBytes: 16 * 1024 * 1024, timeoutMs: 60_000, wordpress })
      if (!Array.isArray(data)) throw new WooError('Die Mediathek liefert ein unbekanntes Format.')
      items.push(...data)
      const count = Number(headers.get('x-wp-totalpages'))
      total = Number.isSafeInteger(count) && count > 0 ? Math.min(count, 2000) : 1
    }
    return items
  }
  // A minute of overlap: modified_after is exclusive and has second precision.
  const after = since ? new Date(Date.parse(`${since}Z`) - 60_000).toISOString().slice(0, 19) : null
  const read = await pages({ _fields: fieldsParam, ...(wordpress ? { context: 'edit' } : {}), ...(after ? { modified_after: after } : {}) }, after ? 'Geaenderte Bilder' : 'Bilder')
  const items = z.array(mediaSchema).safeParse(read)
  if (!items.success) throw new WooError('Die Mediathek liefert ein unbekanntes Format.')
  const ids = z.array(z.object({ id: z.number().int().positive() }).passthrough()).safeParse(after ? await pages({ _fields: 'id' }, 'Abgleich geloeschter Bilder') : read)
  if (!ids.success) throw new WooError('Die Mediathek liefert ein unbekanntes Format.')
  return { items: items.data.map(toMediaItem), ids: ids.data.map((entry) => entry.id), editable: wordpress }
}

const mediaFieldNames = { title: 'title', alt: 'alt_text', caption: 'caption', description: 'description' }
// WordPress filters texts on save (whitespace, entities); such differences are not edits.
const normalized = (value) => decodeEntities(String(value ?? '')).replace(/\s+/g, ' ').trim()
const sameText = (a, b) => normalized(a) === normalized(b)

// Sends queued text edits of media items. Like product edits: read first, fields changed in WordPress
// since the edit was based on them are conflicts, only changed fields are sent, the answer is checked.
async function syncMediaChanges(connection, database, fetcher) {
  const shopUrl = normalizeUrl(connection.url)
  const result = { synced: 0, failed: 0, conflicts: 0, offline: false, changes: [] }
  const pending = await database('pendingMediaChanges', { shopUrl })
  if (!pending.length || !connection.wpAppPassword) return result
  for (const change of pending) {
    const record = (outcome, extra = {}) => result.changes.push({ mediaId: change.mediaId, name: change.name, fields: Object.keys(change.changes), outcome, ...extra })
    const route = `wp/v2/media/${change.mediaId}`
    try {
      const read = mediaSchema.safeParse((await wooRequest(connection, route, { context: 'edit', _fields: fieldsParam }, fetcher, { wordpress: true, maxBytes: 1024 * 1024 })).data)
      if (!read.success || read.data.id !== change.mediaId) throw new WooError('Die Antwort der Mediathek war unklar.')
      const current = toMediaItem(read.data)
      const conflicts = Object.keys(change.changes).filter((field) => !sameText(current[field], change.base[field]) && !sameText(current[field], change.changes[field]))
      if (conflicts.length) {
        await database('markMediaChange', { changeId: change.id, revision: change.revision, state: 'conflict', remote: Object.fromEntries(conflicts.map((field) => [field, current[field]])) })
        result.conflicts++
        record('conflict', { conflicts })
        continue
      }
      const body = Object.fromEntries(Object.entries(change.changes).map(([field, value]) => [mediaFieldNames[field], value]))
      const answer = mediaSchema.safeParse((await wooRequest(connection, route, { context: 'edit', _fields: fieldsParam }, fetcher, { method: 'POST', body, wordpress: true, maxBytes: 1024 * 1024 })).data)
      if (!answer.success || answer.data.id !== change.mediaId) throw new WooError('Die Antwort der Mediathek war unklar. Bitte abgleichen.')
      const item = toMediaItem(answer.data)
      const ignored = Object.keys(change.changes).filter((field) => !sameText(item[field], change.changes[field]))
      await database('completeMediaChange', { changeId: change.id, revision: change.revision, item, ignored })
      if (ignored.length) { result.failed++; record('failure', { error: 'WordPress hat Felder nicht uebernommen', ignored }) }
      else { result.synced++; record('success') }
    } catch (error) {
      if (error instanceof WooError && error.offline) { result.offline = true; break }
      const message = error instanceof WooError ? (error.status === 404 ? 'Das Bild existiert in WordPress nicht mehr.' : error.message) : 'Aenderung konnte nicht uebertragen werden.'
      await database('markMediaChange', { changeId: change.id, revision: change.revision, state: 'failed', error: message })
      result.failed++
      record('failure', { error: message })
      if (error instanceof WooError && (error.status === 401 || error.status === 403)) break
    }
  }
  return result
}

// Where WordPress itself still uses an image, checked right before it is deleted. Looks into the content of
// every searchable post type (block editor: class wp-image-<id>, "id":<id>; pasted URLs: the upload path),
// featured images, block templates, site logo and icon. Page builders and theme settings store images in
// their own data and cannot be found; `unchecked` names what could not be read.
const skippedTypes = new Set(['attachment', 'nav_menu_item', 'wp_global_styles', 'wp_navigation', 'wp_font_family', 'wp_font_face'])
const uploadPath = (sourceUrl) => {
  const match = /\/wp-content\/uploads\/(.+?)(?:-scaled)?\.[a-z0-9]+$/i.exec(new URL(sourceUrl).pathname)
  return match ? decodeURIComponent(match[1]) : null
}
async function findMediaUsage(connection, fetcher, { mediaId, sourceUrl }) {
  const wordpress = Boolean(connection.wpAppPassword)
  const places = []
  const unchecked = []
  const path = uploadPath(sourceUrl)
  const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const inContent = new RegExp([`wp-image-${mediaId}(?!\\d)`, `"id":${mediaId}(?!\\d)`, ...(path ? [`${escaped(path)}(?:-\\d+x\\d+)?\\.`] : [])].join('|'))
  const read = async (route, params) => {
    const { data, headers } = await wooRequest(connection, route, params, fetcher, { maxBytes: 16 * 1024 * 1024, timeoutMs: 60_000, wordpress })
    return { data: Array.isArray(data) ? data : [], pages: Number(headers.get('x-wp-totalpages')) || 1 }
  }
  // Drafts and private content need the application password; without it only published content is seen.
  const listed = async (route, params) => {
    try { return await read(route, { ...params, ...(wordpress ? { status: 'any', context: 'edit' } : {}) }) }
    catch (error) { if (wordpress && error instanceof WooError && error.status === 400) return read(route, params); throw error }
  }
  const text = (value) => (typeof value === 'string' ? value : value?.raw ?? value?.rendered ?? '')
  const title = (entry) => plain(text(entry.title)) || `#${entry.id}`
  const { data: types } = await wooRequest(connection, 'wp/v2/types', {}, fetcher, { maxBytes: 1024 * 1024, wordpress })
  for (const [slug, type] of Object.entries(types && typeof types === 'object' ? types : {})) {
    if (skippedTypes.has(slug) || typeof type?.rest_base !== 'string' || !/^[a-z0-9_-]+$/i.test(type.rest_base)) continue
    const route = `${type.rest_namespace ?? 'wp/v2'}/${type.rest_base}`
    const kind = typeof type.name === 'string' ? type.name : slug
    try {
      if (slug === 'wp_template' || slug === 'wp_template_part') {
        // Block templates have no search; a site has few of them.
        const { data } = await read(route, { per_page: '100', ...(wordpress ? { context: 'edit' } : {}) })
        for (const entry of data) if (inContent.test(text(entry.content))) places.push({ kind, title: title(entry), where: 'Inhalt' })
        continue
      }
      const seen = new Set()
      for (const term of [`wp-image-${mediaId}`, ...(path ? [path] : [])]) {
        const { data } = await listed(route, { search: term, per_page: '100', _fields: 'id,title,content,link' })
        for (const entry of data) if (!seen.has(entry.id) && inContent.test(text(entry.content))) { seen.add(entry.id); places.push({ kind, title: title(entry), where: 'Inhalt', ...(entry.link ? { link: entry.link } : {}) }) }
      }
      // Featured images: product images are known locally, so products are skipped here.
      if (slug === 'product') continue
      for (let page = 1, pages = 1; page <= pages; page++) {
        if (page > 30) { unchecked.push(`Beitragsbilder ab Eintrag 3001 (${kind})`); break }
        const result = await listed(route, { per_page: '100', page: String(page), _fields: 'id,title,featured_media,link' })
        pages = result.pages
        for (const entry of result.data) if (Number(entry.featured_media) === mediaId) places.push({ kind, title: title(entry), where: 'Beitragsbild', ...(entry.link ? { link: entry.link } : {}) })
      }
    } catch (error) {
      if (error instanceof WooError && error.offline) throw error
      unchecked.push(kind)
    }
  }
  try {
    const { data } = await wooRequest(connection, 'wp/v2/settings', { _fields: 'site_logo,site_icon' }, fetcher, { maxBytes: 64 * 1024, wordpress: true })
    if (Number(data?.site_logo) === mediaId) places.push({ kind: 'Website', title: 'Logo', where: 'Einstellungen' })
    if (Number(data?.site_icon) === mediaId) places.push({ kind: 'Website', title: 'Website-Icon', where: 'Einstellungen' })
  } catch (error) {
    if (error instanceof WooError && error.offline) throw error
    unchecked.push('Logo und Website-Icon')
  }
  return { places, unchecked }
}

// Deletes images in WordPress. Only deletions whose products already have the image removed in the shop
// are handed over. Unless forced, WordPress is checked for other uses first; found ones hold the deletion.
// With MEDIA_TRASH the image goes to the trash (restorable), otherwise it is deleted for good.
async function syncMediaDeletions(connection, database, fetcher) {
  const shopUrl = normalizeUrl(connection.url)
  const result = { deleted: 0, failed: 0, held: 0, offline: false, changes: [] }
  const pending = await database('pendingMediaDeletions', { shopUrl })
  if (!pending.length || !connection.wpAppPassword) return result
  for (const deletion of pending) {
    try {
      let unchecked = []
      if (!deletion.force) {
        const found = await findMediaUsage(connection, fetcher, deletion)
        unchecked = found.unchecked
        const places = [...deletion.localPlaces, ...found.places]
        if (places.length) {
          await database('holdMediaDeletion', { changeId: deletion.id, revision: deletion.revision, places: places.slice(0, 200),
            error: `Wird noch verwendet: ${places.slice(0, 3).map((place) => `${place.title} (${place.where})`).join(', ')}${places.length > 3 ? ` und ${places.length - 3} weitere` : ''}.` })
          result.held++
          result.changes.push({ mediaId: deletion.mediaId, name: deletion.name, outcome: 'held', places })
          continue
        }
      }
      const route = `wp/v2/media/${deletion.mediaId}`
      let trashed = true
      try {
        try { await wooRequest(connection, route, {}, fetcher, { method: 'DELETE', wordpress: true, maxBytes: 1024 * 1024 }) }
        catch (error) {
          // 501: this WordPress has no media trash (MEDIA_TRASH off), so the image is deleted for good.
          if (!(error instanceof WooError && error.status === 501)) throw error
          trashed = false
          await wooRequest(connection, route, { force: 'true' }, fetcher, { method: 'DELETE', wordpress: true, maxBytes: 1024 * 1024 })
        }
      } catch (error) {
        // Already gone in WordPress: the deletion has reached its goal.
        if (!(error instanceof WooError && error.status === 404)) throw error
      }
      await database('completeMediaDeletion', { changeId: deletion.id, trashed })
      result.deleted++
      result.changes.push({ mediaId: deletion.mediaId, name: deletion.name, thumbUrl: deletion.thumbUrl, outcome: 'success', trashed, unchecked, forced: deletion.force })
    } catch (error) {
      if (error instanceof WooError && error.offline) { result.offline = true; break }
      const message = error instanceof WooError ? error.message : 'Bild konnte nicht geloescht werden.'
      await database('markMediaChange', { changeId: deletion.id, revision: deletion.revision, state: 'failed', error: message })
      result.failed++
      result.changes.push({ mediaId: deletion.mediaId, name: deletion.name, outcome: 'failure', error: message })
      if (error instanceof WooError && (error.status === 401 || error.status === 403)) break
    }
  }
  return result
}

// Sends images picked from the computer to the media library. Queued edits waiting for an upload
// get its media ID from the database afterwards. `readUpload(file)` returns the stored file.
async function syncMediaUploads(connection, database, fetcher, readUpload) {
  const shopUrl = normalizeUrl(connection.url)
  const result = { uploaded: 0, failed: 0, offline: false, changes: [] }
  const pending = await database('pendingMediaUploads', { shopUrl })
  // Without an application password uploads stay queued; the upload dialog asks for one beforehand.
  if (!pending.length || !connection.wpAppPassword) return result
  for (const upload of pending) {
    try {
      const data = await readUpload(upload.file)
      const { data: answer } = await wooRequest(connection, 'wp/v2/media', { context: 'edit', _fields: fieldsParam }, fetcher, {
        method: 'POST', wordpress: true, upload: { data, contentType: upload.mime, filename: upload.filename }, maxBytes: 1024 * 1024, timeoutMs: 120_000,
      })
      const media = mediaSchema.safeParse(answer)
      if (!media.success) throw new WooError('Die Antwort der Mediathek war unklar.')
      const done = await database('completeMediaUpload', { uploadId: upload.id, mediaId: media.data.id, sourceUrl: media.data.source_url, item: toMediaItem(media.data) })
      result.uploaded++
      result.changes.push({ uploadId: upload.id, filename: upload.filename, file: done?.file ?? upload.file, mediaId: media.data.id, outcome: 'success' })
    } catch (error) {
      if (error instanceof WooError && error.offline) { result.offline = true; break }
      const message = error instanceof WooError ? error.message : error?.code === 'ENOENT' ? 'Die lokale Datei fehlt. Bitte erneut hochladen.' : 'Bild konnte nicht hochgeladen werden.'
      await database('failMediaUpload', { uploadId: upload.id, error: message })
      result.failed++
      result.changes.push({ uploadId: upload.id, filename: upload.filename, outcome: 'failure', error: message })
      if (error instanceof WooError && (error.status === 401 || error.status === 403)) break
    }
  }
  return result
}

module.exports = { findMediaUsage, importMediaLibrary, listMediaLibrary, syncMediaChanges, syncMediaDeletions, syncMediaUploads, toMediaItem }
