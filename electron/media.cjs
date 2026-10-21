const { z } = require('zod')
const { WooError, normalizeUrl, wooRequest } = require('./shop.cjs')
const { decodeEntities } = require('./taxonomies.cjs')

const mediaSchema = z.object({
  id: z.number().int().positive(),
  source_url: z.string().url().max(2048),
  alt_text: z.string().max(1000).optional().default(''),
  title: z.object({ rendered: z.string().max(1000) }).partial().optional(),
  media_details: z.object({ sizes: z.record(z.string(), z.object({ source_url: z.string().url().max(2048) }).passthrough()).optional() }).passthrough().optional(),
}).passthrough()

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
      const { data: answer } = await wooRequest(connection, 'wp/v2/media', {}, fetcher, {
        method: 'POST', wordpress: true, upload: { data, contentType: upload.mime, filename: upload.filename }, maxBytes: 1024 * 1024, timeoutMs: 120_000,
      })
      const media = mediaSchema.safeParse(answer)
      if (!media.success) throw new WooError('Die Antwort der Mediathek war unklar.')
      const done = await database('completeMediaUpload', { uploadId: upload.id, mediaId: media.data.id, sourceUrl: media.data.source_url })
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

module.exports = { listMediaLibrary, syncMediaUploads }
