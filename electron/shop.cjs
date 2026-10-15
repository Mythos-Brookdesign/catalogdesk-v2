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

async function testConnection(connection, fetcher) {
  const parsed = connectionSchema.safeParse(connection)
  if (!parsed.success) return { ok: false, error: 'Ungueltige Shopverbindung.' }
  const { url, consumerKey, consumerSecret } = parsed.data
  const endpoint = new URL('wp-json/wc/v3/products', normalizeUrl(url))
  endpoint.search = new URLSearchParams({ per_page: '1', page: '1', status: 'any', _fields: 'id,sku' }).toString()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetcher(endpoint.toString(), {
      method: 'GET', headers: { Authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`, Accept: 'application/json' },
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      return { ok: false, error: response.status === 401 || response.status === 403
        ? 'Zugriff verweigert. API-Schluessel und Leserechte pruefen.'
        : `WooCommerce antwortet mit HTTP ${response.status}. Shopadresse und REST-API pruefen.` }
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      await response.body?.cancel()
      return { ok: false, error: 'Der Shop liefert kein JSON.' }
    }
    const reader = response.body?.getReader()
    if (!reader) return { ok: false, error: 'Die API-Antwort ist leer.' }
    const chunks = []
    let bytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 64 * 1024) { await reader.cancel(); return { ok: false, error: 'Die API-Antwort ist zu gross.' } }
      chunks.push(Buffer.from(value))
    }
    const products = z.array(z.object({ id: z.number().int().positive(), sku: z.string() })).max(1).safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const total = response.headers.get('x-wp-total')
    if (!products.success || total === null || !/^\d+$/.test(total) || !Number.isSafeInteger(Number(total)) || Number(total) < products.data.length)
      return { ok: false, error: 'Die Antwort entspricht nicht dem WooCommerce-Format.' }
    return { ok: true, url: normalizeUrl(url), productCount: Number(total), checkedAt: new Date().toISOString() }
  } catch {
    return { ok: false, error: controller.signal.aborted ? 'Zeitlimit erreicht. Der Shop antwortet nicht.' : 'Verbindung fehlgeschlagen. HTTPS-Zertifikat und Erreichbarkeit pruefen. Weiterleitungen sind nicht erlaubt.' }
  } finally { clearTimeout(timeout) }
}

module.exports = { connectionSchema, resolveConnection, testConnection }