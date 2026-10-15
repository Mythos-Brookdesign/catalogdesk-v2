const { z } = require('zod')

const shopUrlSchema = z.string().trim().url().max(2048).refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
})
const connectionSchema = z.object({
  url: shopUrlSchema,
  consumerKey: z.string().trim().regex(/^ck_[a-f0-9]{40}$/),
  consumerSecret: z.string().trim().regex(/^cs_[a-f0-9]{40}$/),
}).strict()
const updateSchema = z.object({
  url: shopUrlSchema,
  consumerKey: z.string().trim().max(43),
  consumerSecret: z.string().trim().max(43),
}).strict()

class WooError extends Error {
  constructor(message, status = null) {
    super(message)
    this.name = 'WooError'
    this.status = status
  }
}

function normalizeUrl(value) {
  const url = new URL(shopUrlSchema.parse(value))
  url.pathname = url.pathname.replace(/\/+$/, '') + '/'
  return url.toString()
}

function resolveConnection(input, stored) {
  if (input === null && stored) return connectionSchema.parse(stored)
  const parsed = updateSchema.safeParse(input)
  if (!parsed.success) throw new Error('HTTPS-Shopadresse und API-Schluessel pruefen.')
  const url = normalizeUrl(parsed.data.url)
  if (!parsed.data.consumerKey && !parsed.data.consumerSecret) {
    if (!stored || url !== normalizeUrl(stored.url))
      throw new Error('Fuer diese Shopadresse muessen beide API-Schluessel eingegeben werden.')
    return connectionSchema.parse({ ...stored, url })
  }
  const connection = connectionSchema.safeParse({ ...parsed.data, url })
  if (!connection.success) throw new Error('Consumer Key und Consumer Secret gemeinsam und vollstaendig eingeben.')
  return connection.data
}

// Read-only GET below wp-json/ with timeout, size bound and no redirects. Errors never contain secrets.
// Requests outside wc/ are sent without credentials: WordPress would reject WooCommerce keys there.
async function wooRequest(connection, route, params, fetcher, { maxBytes = 64 * 1024, timeoutMs = 15_000 } = {}) {
  const parsed = connectionSchema.safeParse(connection)
  if (!parsed.success) throw new WooError('Ungueltige Shopverbindung.')
  const { url, consumerKey, consumerSecret } = parsed.data
  const endpoint = new URL(`wp-json/${route}`, normalizeUrl(url))
  endpoint.search = new URLSearchParams(params).toString()
  const authenticated = route === 'wc/v3' || route.startsWith('wc/v3/')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(endpoint.toString(), {
      method: 'GET',
      headers: authenticated ? { Authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`, Accept: 'application/json' } : { Accept: 'application/json' },
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new WooError(response.status === 401 || response.status === 403
        ? 'Zugriff verweigert. API-Schluessel und Leserechte pruefen.'
        : `WooCommerce antwortet mit HTTP ${response.status}. Shopadresse und REST-API pruefen.`, response.status)
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      await response.body?.cancel()
      throw new WooError('Der Shop liefert kein JSON.')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new WooError('Die API-Antwort ist leer.')
    const chunks = []
    let bytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) { await reader.cancel(); throw new WooError('Die API-Antwort ist zu gross.') }
      chunks.push(Buffer.from(value))
    }
    let data
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new WooError('Die Antwort entspricht nicht dem WooCommerce-Format.') }
    return { data, headers: response.headers }
  } catch (error) {
    if (error instanceof WooError) throw error
    throw new WooError(controller.signal.aborted ? 'Zeitlimit erreicht. Der Shop antwortet nicht.' : 'Verbindung fehlgeschlagen. HTTPS-Zertifikat und Erreichbarkeit pruefen. Weiterleitungen sind nicht erlaubt.')
  } finally { clearTimeout(timeout) }
}

async function testConnection(connection, fetcher) {
  if (!connectionSchema.safeParse(connection).success) return { ok: false, error: 'Ungueltige Shopverbindung.' }
  try {
    const { data, headers } = await wooRequest(connection, 'wc/v3/products', { per_page: '1', page: '1', status: 'any', _fields: 'id,sku' }, fetcher)
    const products = z.array(z.object({ id: z.number().int().positive(), sku: z.string() })).max(1).safeParse(data)
    const total = headers.get('x-wp-total')
    if (!products.success || total === null || !/^\d+$/.test(total) || !Number.isSafeInteger(Number(total)) || Number(total) < products.data.length)
      return { ok: false, error: 'Die Antwort entspricht nicht dem WooCommerce-Format.' }
    return { ok: true, url: normalizeUrl(connection.url), productCount: Number(total), checkedAt: new Date().toISOString() }
  } catch (error) {
    return { ok: false, error: error instanceof WooError ? error.message : 'Verbindung fehlgeschlagen.' }
  }
}

module.exports = { WooError, connectionSchema, normalizeUrl, resolveConnection, testConnection, wooRequest }
