const { z } = require('zod')

const shopUrlSchema = z.string().trim().url().max(2048).refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
})
// Optional WordPress application password (user profile > application passwords): WooCommerce keys only
// work below wc/, so uploading images to the media library (wp/v2/media) needs a WordPress login.
const wpUserSchema = z.string().trim().min(1).max(60)
const appPasswordSchema = z.string().regex(/^[A-Za-z0-9]{24}$/)
const connectionSchema = z.object({
  url: shopUrlSchema,
  consumerKey: z.string().trim().regex(/^ck_[a-f0-9]{40}$/),
  consumerSecret: z.string().trim().regex(/^cs_[a-f0-9]{40}$/),
  wpUser: wpUserSchema.optional(),
  wpAppPassword: appPasswordSchema.optional(),
}).strict().refine((value) => Boolean(value.wpUser) === Boolean(value.wpAppPassword))
const updateSchema = z.object({
  url: shopUrlSchema,
  consumerKey: z.string().trim().max(43),
  consumerSecret: z.string().trim().max(43),
  wpUser: z.string().trim().max(60).optional().default(''),
  wpAppPassword: z.string().max(60).optional().default(''),
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
  const sameShop = Boolean(stored && url === normalizeUrl(stored.url))
  let keys
  if (!parsed.data.consumerKey && !parsed.data.consumerSecret) {
    if (!sameShop) throw new Error('Fuer diese Shopadresse muessen beide API-Schluessel eingegeben werden.')
    keys = { consumerKey: stored.consumerKey, consumerSecret: stored.consumerSecret }
  } else keys = { consumerKey: parsed.data.consumerKey, consumerSecret: parsed.data.consumerSecret }
  // Application password: an empty user removes it; an empty password keeps the stored one of the same user.
  const wpUser = parsed.data.wpUser
  const password = parsed.data.wpAppPassword.replace(/\s+/g, '')
  let login = {}
  if (wpUser) {
    if (password) login = { wpUser, wpAppPassword: password }
    else if (sameShop && stored.wpUser === wpUser && stored.wpAppPassword) login = { wpUser, wpAppPassword: stored.wpAppPassword }
    else throw new Error('Bitte das Anwendungspasswort fuer diesen WordPress-Benutzer eingeben.')
    if (!appPasswordSchema.safeParse(login.wpAppPassword).success) throw new Error('Das Anwendungspasswort hat 24 Zeichen (Leerzeichen sind egal).')
  }
  const connection = connectionSchema.safeParse({ url, ...keys, ...login })
  if (!connection.success) throw new Error('Consumer Key und Consumer Secret gemeinsam und vollstaendig eingeben.')
  return connection.data
}

async function readJson(response, maxBytes) {
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
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new WooError('Die Antwort entspricht nicht dem WooCommerce-Format.') }
}

// WordPress error bodies carry a readable message (e.g. duplicate term names); it never contains the API keys.
async function shopMessage(response) {
  try {
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) return null
    const body = await readJson(response, 16 * 1024)
    const message = typeof body?.message === 'string' ? body.message.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300) : ''
    return message || null
  } catch { return null }
}

// GET/POST/PUT/DELETE below wp-json/ with timeout, size bound and no redirects. Errors never contain secrets.
// Requests outside wc/ are sent without credentials: WordPress would reject WooCommerce keys there.
// `wordpress: true` signs them with the application password instead (e.g. media uploads).
// `upload` sends a file as the raw body ({ data, contentType, filename }), as wp/v2/media expects it.
// Network failures and timeouts are flagged with `offline` so callers can queue work for later.
async function wooRequest(connection, route, params, fetcher, { maxBytes = 64 * 1024, timeoutMs = 15_000, method = 'GET', body, upload, wordpress = false } = {}) {
  const parsed = connectionSchema.safeParse(connection)
  if (!parsed.success) throw new WooError('Ungueltige Shopverbindung.')
  const { url, consumerKey, consumerSecret, wpUser, wpAppPassword } = parsed.data
  const endpoint = new URL(`wp-json/${route}`, normalizeUrl(url))
  endpoint.search = new URLSearchParams(params).toString()
  const authenticated = route === 'wc/v3' || route.startsWith('wc/v3/')
  const headers = { Accept: 'application/json' }
  if (wordpress) {
    if (!wpAppPassword) throw new WooError('Kein Anwendungspasswort gespeichert. Bitte unter Shopverbindung hinterlegen.')
    headers.Authorization = `Basic ${Buffer.from(`${wpUser}:${wpAppPassword}`).toString('base64')}`
  } else if (authenticated) headers.Authorization = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (upload) {
    headers['Content-Type'] = upload.contentType
    // ASCII fallback plus the UTF-8 name; WordPress takes the file name for the media title and URL.
    const fallback = upload.filename.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'bild'
    headers['Content-Disposition'] = `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(upload.filename)}`
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(endpoint.toString(), {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : upload ? { body: upload.data } : {}),
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
    })
    if (!response.ok) {
      const message = await shopMessage(response)
      await response.body?.cancel().catch(() => {})
      throw new WooError(response.status === 401 || response.status === 403
        ? wordpress
          ? `Zugriff verweigert. WordPress-Benutzer, Anwendungspasswort und Berechtigung zum Hochladen pruefen.${message ? ` (${message})` : ''}`
          : `Zugriff verweigert. API-Schluessel und ${method === 'GET' ? 'Leserechte' : 'Schreibrechte'} pruefen.${message ? ` (${message})` : ''}`
        : message ?? `WooCommerce antwortet mit HTTP ${response.status}. Shopadresse und REST-API pruefen.`, response.status)
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      await response.body?.cancel()
      throw new WooError('Der Shop liefert kein JSON.')
    }
    return { data: await readJson(response, maxBytes), headers: response.headers }
  } catch (error) {
    if (error instanceof WooError) throw error
    const failure = new WooError(controller.signal.aborted ? 'Zeitlimit erreicht. Der Shop antwortet nicht.' : 'Verbindung fehlgeschlagen. HTTPS-Zertifikat und Erreichbarkeit pruefen. Weiterleitungen sind nicht erlaubt.')
    failure.offline = true
    throw failure
  } finally { clearTimeout(timeout) }
}

// With an application password: may this WordPress user upload images? Null without one.
async function testMediaAccess(connection, fetcher) {
  if (!connection.wpAppPassword) return null
  try {
    const { data } = await wooRequest(connection, 'wp/v2/users/me', { context: 'edit', _fields: 'name,capabilities' }, fetcher, { wordpress: true })
    const user = z.object({ name: z.string().max(200), capabilities: z.record(z.string(), z.boolean()) }).safeParse(data)
    if (!user.success) return { ok: false, error: 'Die Antwort von WordPress war unklar.' }
    return user.data.capabilities.upload_files ? { ok: true, user: user.data.name } : { ok: false, error: `${user.data.name} darf keine Medien hochladen.` }
  } catch (error) {
    return { ok: false, error: error instanceof WooError ? error.message : 'Anmeldung bei WordPress fehlgeschlagen.' }
  }
}

async function testConnection(connection, fetcher) {
  if (!connectionSchema.safeParse(connection).success) return { ok: false, error: 'Ungueltige Shopverbindung.' }
  try {
    const { data, headers } = await wooRequest(connection, 'wc/v3/products', { per_page: '1', page: '1', status: 'any', _fields: 'id,sku' }, fetcher)
    const products = z.array(z.object({ id: z.number().int().positive(), sku: z.string() })).max(1).safeParse(data)
    const total = headers.get('x-wp-total')
    if (!products.success || total === null || !/^\d+$/.test(total) || !Number.isSafeInteger(Number(total)) || Number(total) < products.data.length)
      return { ok: false, error: 'Die Antwort entspricht nicht dem WooCommerce-Format.' }
    return { ok: true, url: normalizeUrl(connection.url), productCount: Number(total), checkedAt: new Date().toISOString(), media: await testMediaAccess(connection, fetcher) }
  } catch (error) {
    return { ok: false, error: error instanceof WooError ? error.message : 'Verbindung fehlgeschlagen.' }
  }
}

module.exports = { WooError, connectionSchema, normalizeUrl, resolveConnection, testConnection, wooRequest }
