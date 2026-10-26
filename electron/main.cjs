const { app, BrowserWindow, ipcMain, nativeImage, net, protocol, safeStorage } = require('electron')
const { createHash } = require('node:crypto')
const { mkdirSync } = require('node:fs')
const { mkdir, readFile, rm, writeFile } = require('node:fs/promises')
const { randomUUID } = require('node:crypto')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createDatabaseClient } = require('./database-client.cjs')
const { createAuthenticator } = require('./auth.cjs')
const { createShopStore } = require('./shop-store.cjs')
const { WooError, normalizeUrl: normalizeShopUrl, resolveConnection, testConnection } = require('./shop.cjs')
const { fetchNamespaces, fetchPluginStatus, importTaxonomies } = require('./taxonomies.cjs')
const { syncTaxonomyChanges } = require('./taxonomy-sync.cjs')
const { importProducts } = require('./products.cjs')
const { syncProductChanges } = require('./product-sync.cjs')
const { importMediaLibrary, listMediaLibrary, syncMediaChanges, syncMediaDeletions, syncMediaUploads } = require('./media.cjs')
const productFields = require('./product-fields.cjs')

const development = !app.isPackaged && process.argv.includes('--dev')
const entryUrl = development ? 'http://127.0.0.1:5179/' : 'catalog://app/index.html'
let mainWindow
let database
let authenticator
let initialTheme = 'light'

if (!app.isPackaged && process.env.CATALOGDESK_V2_TEST_USER_DATA) {
  mkdirSync(process.env.CATALOGDESK_V2_TEST_USER_DATA, { recursive: true, mode: 0o700 })
  app.setPath('userData', process.env.CATALOGDESK_V2_TEST_USER_DATA)
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'catalog', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  // Thumbnails of the media library, cached on disk so they also show offline.
  { scheme: 'catalog-media', privileges: { standard: true, secure: true } },
])

function validateSender(event) {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== mainWindow.webContents.mainFrame)
    throw new Error('Untrusted IPC sender.')
  const frameUrl = event.senderFrame?.url
  if (!frameUrl) throw new Error('Untrusted IPC sender.')
  const url = new URL(frameUrl)
  if (development && url.origin === 'http://127.0.0.1:5179') return
  if (!development && url.protocol === 'catalog:' && url.host === 'app') return
  throw new Error('Untrusted IPC sender.')
}

function authorize(event, envelope, permission) {
  validateSender(event)
  try {
    return {
      user: authenticator.requireSession(envelope?.sessionToken, permission),
      payload: envelope?.payload,
    }
  } catch (error) {
    if (error.message.startsWith('Sitzung')) event.sender.send('catalog:v2:auth-expired')
    throw error
  }
}

// Image picker and uploads are used from the product editor and the media library page.
function authorizeAny(event, envelope, permissions) {
  let failure
  for (const permission of permissions) {
    try { return authorize(event, envelope, permission) } catch (error) { failure = error; if (error.message.startsWith('Sitzung')) break }
  }
  throw failure
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 860,
    minHeight: 620,
    title: 'CatalogDesk',
    show: false,
    backgroundColor: initialTheme === 'dark' ? '#171b19' : '#f3f5f2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = undefined })
  void mainWindow.loadURL(entryUrl)
}

app.whenReady().then(async () => {
  database = createDatabaseClient(path.join(app.getPath('userData'), 'data', 'catalogdesk-v2.sqlite'))
  authenticator = createAuthenticator((operation, payload) =>
    database.request(operation, payload),
  )
  const shopStore = createShopStore(path.join(app.getPath('userData'), 'credentials'), safeStorage)
  let shopOperationRunning = false
  // Usage history: every action that changes data or touches the shop is recorded here, in Main, where the
  // acting user is known from the session. Secrets (passwords, API keys) are never part of an entry.
  const actor = (user) => user ? { userId: user.id, username: user.username, userName: `${user.firstName} ${user.lastName}` } : {}
  async function audit(user, entry) {
    try {
      await database.request('appendAudit', { ...actor(user), source: user ? 'user' : 'system', ...entry })
      mainWindow?.webContents.send('catalog:v2:audit-appended')
    } catch (error) { console.error('Audit entry could not be written:', error?.message) }
  }
  const changeList = (before, after, labels) => Object.entries(labels)
    .filter(([key]) => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null))
    .map(([key, field]) => ({ field, before: before?.[key] ?? null, after: after?.[key] ?? null }))
  function authorizeShopSettings(event, envelope) {
    return authorize(event, envelope, 'shop').payload
  }
  ipcMain.handle('catalog:v2:theme-get', async (event) => {
    validateSender(event)
    try { return { ok: true, value: await database.request('getTheme') } }
    catch { return { ok: false, error: 'Farbschema konnte nicht geladen werden.' } }
  })
  ipcMain.handle('catalog:v2:theme-set', async (event, envelope) => {
    try {
      const { user, payload } = authorize(event, envelope, 'settings')
      const previous = await database.request('getTheme')
      const theme = await database.request('setTheme', payload)
      initialTheme = theme
      if (previous !== theme) {
        const names = { light: 'Hell', dark: 'Dunkel' }
        void audit(user, { category: 'settings', action: 'settings.theme', summary: `Farbschema auf ${names[theme]} geaendert`, targetType: 'setting', targetId: 'theme', targetLabel: 'Farbschema', details: { changes: [{ field: 'Farbschema', before: names[previous], after: names[theme] }] } })
      }
      mainWindow?.setBackgroundColor(theme === 'dark' ? '#171b19' : '#f3f5f2')
      return { ok: true, value: theme }
    } catch { return { ok: false, error: 'Farbschema konnte nicht gespeichert werden oder Berechtigung fehlt.' } }
  })
  for (const operation of ['summary', 'save', 'test', 'delete']) {
    ipcMain.handle(`catalog:v2:shop-${operation}`, async (event, envelope) => {
      let acquired = false
      let user = null
      let stored = null
      try {
        // Every signed-in user may see whether a shop is connected (URL only, no keys).
        const authorized = authorize(event, envelope, operation === 'summary' ? 'session' : 'shop')
        const payload = authorized.payload
        user = authorized.user
        if (operation === 'summary') return { ok: true, value: await shopStore.summary() }
        if (shopOperationRunning) return { ok: false, error: 'Eine Shopaktion laeuft bereits.' }
        shopOperationRunning = true
        acquired = true
        if (operation === 'delete') {
          if (payload?.confirmed !== true) return { ok: false, error: 'Bestaetigung zum Entfernen fehlt.' }
          const previous = await shopStore.summary().catch(() => null)
          const value = await shopStore.delete()
          void audit(user, { category: 'shop', action: 'shop.connection_delete', summary: 'Shopverbindung entfernt', targetType: 'shop', targetLabel: previous?.url ?? null, shopUrl: previous?.url ?? null })
          return { ok: true, value }
        }
        stored = await shopStore.load()
        const connection = resolveConnection(payload, stored)
        authorizeShopSettings(event, envelope)
        if (operation === 'save') {
          const value = await shopStore.save(connection)
          const keysChanged = !stored || stored.consumerKey !== connection.consumerKey || stored.consumerSecret !== connection.consumerSecret
          const loginChanged = stored?.wpUser !== connection.wpUser || stored?.wpAppPassword !== connection.wpAppPassword
          void audit(user, { category: 'shop', action: 'shop.connection_save', summary: 'Shopverbindung gespeichert', targetType: 'shop', targetLabel: value.url, shopUrl: value.url,
            details: { changes: [...changeList(stored ? { url: stored.url } : null, { url: value.url }, { url: 'Shopadresse' }), ...(keysChanged ? [{ field: 'API-Schluessel', before: stored ? 'gesetzt' : null, after: 'neu gesetzt' }] : []),
              ...(loginChanged ? [{ field: 'Anwendungspasswort', before: stored?.wpUser ? `gesetzt (${stored.wpUser})` : null, after: connection.wpUser ? `gesetzt (${connection.wpUser})` : 'entfernt' }] : [])] } })
          return { ok: true, value }
        }
        const result = await testConnection(connection, (url, options) => net.fetch(url, options))
        void audit(user, result.ok
          ? { category: 'shop', action: 'shop.connection_test', summary: `Shopverbindung geprueft: ${result.productCount} Produkte erreichbar`, targetType: 'shop', targetLabel: result.url, shopUrl: result.url, details: { productCount: result.productCount } }
          : { category: 'shop', action: 'shop.connection_test', summary: 'Shopverbindung geprueft: fehlgeschlagen', outcome: 'failure', targetType: 'shop', targetLabel: connection.url, shopUrl: connection.url, details: { error: result.error } })
        if (!result.ok) return result
        authorizeShopSettings(event, envelope)
        return { ok: true, value: { url: result.url, productCount: result.productCount, checkedAt: result.checkedAt, media: result.media } }
      } catch (error) {
        const message = error.name === 'ZodError' ? 'Shopadresse und API-Schluessel pruefen.' : error.message
        if (user && operation !== 'summary' && !/^Eine Shopaktion/.test(message))
          void audit(user, { category: 'shop', action: `shop.connection_${operation}`, summary: { save: 'Shopverbindung nicht gespeichert', test: 'Shopverbindung geprueft: fehlgeschlagen', delete: 'Shopverbindung nicht entfernt' }[operation], outcome: 'failure', targetType: 'shop', targetLabel: stored?.url ?? null, details: { error: message } })
        return { ok: false, error: message }
      } finally {
        if (acquired) shopOperationRunning = false
      }
    })
  }
  const shopFetch = (url, options) => net.fetch(url, options)
  const databaseCall = (operation, payload) => database.request(operation, payload)
  const safeTaxonomyError = (error) => error instanceof WooError || /^(Sitzung|Fuer diese|Shopverbindung|Gespeicherte|Kein sicherer|Datenbank|Taxonomie|Diese Taxonomie|Begriff|Uebergeordneter|Ein Begriff|Der Slug|Aenderung|Keine Shopverbindung)/.test(error.message ?? '')
  async function currentShopUrl() {
    const saved = await shopStore.summary().catch(() => null)
    if (!saved) throw new Error('Keine Shopverbindung gespeichert. Bitte zuerst unter Shopverbindung einrichten.')
    return saved.url
  }
  // Sends queued term edits when the shop is reachable. Returns null when another shop action holds the lock.
  const operationLabels = { create: 'angelegt', update: 'geaendert', delete: 'geloescht' }
  // Stores a taxonomy import and records plugin modules that appeared or disappeared with it.
  async function storeTaxonomies(result, user) {
    const before = await moduleStates(result.shopUrl)
    const overview = await databaseCall('replaceTaxonomies', result)
    auditModuleChanges(before, (await databaseCall('listModules', { shopUrl: result.shopUrl })).modules, user, result.shopUrl)
    return overview
  }
  const moduleState = (entry) => (entry.detected ? 'detected' : entry.inactive ? 'inactive' : 'missing')
  async function moduleStates(shopUrl) {
    return new Map((await databaseCall('listModules', { shopUrl })).modules.map((entry) => [entry.id, moduleState(entry)]))
  }
  // Records plugin modules that appeared, were deactivated in the shop or disappeared; returns their names for the user feedback.
  function auditModuleChanges(before, modules, user, shopUrl) {
    const changed = { added: [], deactivated: [], removed: [] }
    const summaries = {
      detected: (entry) => `Modul ${entry.name} erkannt${entry.active ? ' und aktiviert' : ''}`,
      inactive: (entry) => `Plugin ${entry.name} ist im Shop deaktiviert`,
      missing: (entry) => `Modul ${entry.name} nicht mehr erkannt`,
    }
    for (const entry of modules) {
      const state = moduleState(entry)
      if (state === (before.get(entry.id) ?? 'missing')) continue
      changed[{ detected: 'added', inactive: 'deactivated', missing: 'removed' }[state]].push(entry.name)
      void audit(user, { category: 'shop', action: { detected: 'shop.module_detected', inactive: 'shop.module_deactivated', missing: 'shop.module_removed' }[state], shopUrl, targetType: 'module', targetId: entry.id, targetLabel: entry.name,
        summary: summaries[state](entry), details: { description: entry.description } })
    }
    return changed
  }
  function auditSync(changes, user, shopUrl) {
    if (!changes.length) return
    const synced = changes.filter((change) => change.outcome === 'success').length
    const rejected = changes.length - synced
    void audit(user, {
      category: 'sync', action: 'sync.taxonomies', shopUrl, outcome: synced ? 'success' : 'failure',
      summary: `${synced} Taxonomie-${synced === 1 ? 'Aenderung' : 'Aenderungen'} an den Shop uebertragen${rejected ? `, ${rejected} abgelehnt` : ''}`,
      details: { transfers: changes.map((change) => ({ taxonomy: change.taxonomyLabel, term: change.name, operation: operationLabels[change.operation], termId: change.termId ?? null, result: change.outcome === 'success' ? 'uebertragen' : `abgelehnt: ${change.error}` })) },
    })
  }
  function auditProductSync(changes, user, shopUrl) {
    if (!changes.length) return
    const synced = changes.filter((change) => change.outcome === 'success').length
    const conflicts = changes.filter((change) => change.outcome === 'conflict').length
    const rejected = changes.length - synced - conflicts
    void audit(user, {
      category: 'sync', action: 'sync.products', shopUrl, outcome: synced || conflicts ? 'success' : 'failure',
      summary: `${synced} Produkt-${synced === 1 ? 'Aenderung' : 'Aenderungen'} an den Shop uebertragen${conflicts ? `, ${conflicts} mit Konflikt` : ''}${rejected ? `, ${rejected} abgelehnt` : ''}`,
      details: { transfers: changes.map((change) => ({ product: change.name, id: change.productId, fields: change.fields.join(', '),
        result: { success: 'uebertragen', conflict: `Konflikt: ${(change.conflicts ?? []).join(', ')} im Shop geaendert`, failure: `abgelehnt: ${change.error}` }[change.outcome] })) },
    })
  }
  // Images picked from the computer wait here (outside the database) until the shop has them.
  const uploadDirectory = path.join(app.getPath('userData'), 'media-uploads')
  const thumbDirectory = path.join(app.getPath('userData'), 'media-cache')
  const uploadPath = (file) => {
    if (!/^[a-f0-9-]{36}\.(jpg|png|gif|webp)$/.test(file)) throw new Error('Ungueltige Upload-Datei.')
    return path.join(uploadDirectory, file)
  }
  function auditMediaSync(changes, user, shopUrl) {
    for (const change of changes)
      void audit(user, { category: 'sync', action: 'sync.media', shopUrl, outcome: change.outcome === 'success' ? 'success' : 'failure', targetType: 'media', targetId: change.mediaId ? String(change.mediaId) : null, targetLabel: change.filename,
        summary: change.outcome === 'success' ? `Bild „${change.filename}“ in die Mediathek hochgeladen` : `Bild „${change.filename}“ nicht hochgeladen`, details: change.error ? { error: change.error } : undefined })
  }
  const mediaLabels = { title: 'Titel', alt: 'Alt-Text', caption: 'Beschriftung', description: 'Beschreibung' }
  function auditMediaChanges(changes, user, shopUrl) {
    if (!changes.length) return
    const synced = changes.filter((change) => change.outcome === 'success').length
    const conflicts = changes.filter((change) => change.outcome === 'conflict').length
    const rejected = changes.length - synced - conflicts
    void audit(user, { category: 'sync', action: 'sync.media_changes', shopUrl, outcome: synced || conflicts ? 'success' : 'failure',
      summary: `${synced} Mediathek-${synced === 1 ? 'Aenderung' : 'Aenderungen'} an WordPress uebertragen${conflicts ? `, ${conflicts} mit Konflikt` : ''}${rejected ? `, ${rejected} abgelehnt` : ''}`,
      details: { transfers: changes.map((change) => ({ image: change.name, id: change.mediaId, fields: change.fields.map((field) => mediaLabels[field] ?? field).join(', '),
        result: { success: 'uebertragen', conflict: `Konflikt: ${(change.conflicts ?? []).map((field) => mediaLabels[field] ?? field).join(', ')} in WordPress geaendert`, failure: `abgelehnt: ${change.error}` }[change.outcome] })) } })
  }
  const emptyProductSync = async (shopUrl) => ({ synced: 0, failed: 0, conflicts: 0, offline: true, changes: [], counts: await databaseCall('productChangeCounts', { shopUrl }) })
  // Sends queued taxonomy edits, then product edits (products may reference new terms).
  // `exclude…` skips changes the caller records itself (the edit that triggered this run).
  async function runShopSync({ notify = true, user = null, excludeTerm = () => false, excludeProduct = () => false, excludeMedia = () => false } = {}) {
    if (shopOperationRunning || !database) return null
    const connection = await shopStore.load().catch(() => null)
    if (!connection) return null
    if (!net.isOnline()) return { synced: 0, failed: 0, offline: true, changes: [], ...(await databaseCall('taxonomyChangeCounts', { shopUrl: connection.url })), products: await emptyProductSync(connection.url) }
    shopOperationRunning = true
    try {
      const result = await syncTaxonomyChanges(connection, databaseCall, shopFetch)
      auditSync(result.changes.filter((change) => !excludeTerm(change)), user, connection.url)
      // Uploads before product edits, which may wait for their media IDs.
      const media = result.offline ? { offline: true, changes: [] } : await syncMediaUploads(connection, databaseCall, shopFetch, (file) => readFile(uploadPath(file)))
      auditMediaSync(media.changes, user, connection.url)
      for (const change of media.changes) if (change.outcome === 'success') void rm(uploadPath(change.file), { force: true }).catch(() => {})
      const mediaEdits = media.offline ? { offline: true, changes: [] } : await syncMediaChanges(connection, databaseCall, shopFetch)
      auditMediaChanges(mediaEdits.changes.filter((change) => !excludeMedia(change)), user, connection.url)
      const products = result.offline || media.offline || mediaEdits.offline ? await emptyProductSync(connection.url) : await syncProductChanges(connection, databaseCall, shopFetch)
      auditProductSync(products.changes.filter((change) => !excludeProduct(change)), user, connection.url)
      // Deletions last: the products that used an image must have it removed in the shop first.
      const deletions = products.offline ? { offline: true, changes: [] } : await syncMediaDeletions(connection, databaseCall, shopFetch)
      for (const change of deletions.changes) {
        const summary = { success: change.trashed ? `Bild „${change.name}“ in den WordPress-Papierkorb verschoben` : `Bild „${change.name}“ in WordPress endgueltig geloescht`,
          held: `Loeschen von „${change.name}“ angehalten: in WordPress noch verwendet`, failure: `Bild „${change.name}“ nicht geloescht` }[change.outcome]
        const details = change.outcome === 'held' ? { places: change.places.map((place) => `${place.kind}: ${place.title} (${place.where})`) }
          : change.outcome === 'success' ? { check: change.forced ? 'Uebersprungen (trotzdem loeschen)' : change.unchecked.length ? `Nicht pruefbar: ${change.unchecked.join(', ')}` : 'Keine Verwendung gefunden', trash: change.trashed ? 'Ja, wiederherstellbar' : 'Nein (MEDIA_TRASH aus)' }
            : { error: change.error }
        void audit(user, { category: 'sync', action: 'sync.media_delete', shopUrl: connection.url, outcome: change.outcome === 'failure' ? 'failure' : 'success', targetType: 'media', targetId: String(change.mediaId), targetLabel: change.name, summary, details })
        if (change.thumbUrl) void rm(path.join(thumbDirectory, createHash('sha256').update(`${connection.url}\u0000${change.thumbUrl}`).digest('hex')), { force: true }).catch(() => {})
      }
      if (notify && (result.synced || result.failed)) mainWindow?.webContents.send('catalog:v2:taxonomies-changed')
      if (notify && (products.changes.length || media.changes.length)) mainWindow?.webContents.send('catalog:v2:products-changed')
      if (notify && (media.changes.length || mediaEdits.changes.length || deletions.changes.length)) mainWindow?.webContents.send('catalog:v2:media-changed')
      return { ...result, products, media: mediaEdits, deletions }
    } finally { shopOperationRunning = false }
  }
  const runTaxonomySync = ({ exclude, ...options } = {}) => runShopSync({ ...options, excludeTerm: exclude })
  setInterval(() => { void runShopSync().catch(() => {}) }, 30_000).unref?.()
  ipcMain.handle('catalog:v2:taxonomies-change', async (event, envelope) => {
    let user = null
    const request = envelope?.payload && typeof envelope.payload === 'object' ? envelope.payload : {}
    try {
      user = authorize(event, envelope, 'taxonomies').user
      const shopUrl = await currentShopUrl()
      const value = await databaseCall('queueTaxonomyChange', { ...request, shopUrl })
      const own = (change) => change.taxonomy === request.taxonomy && change.termRef === value.termId
      const sync = await runTaxonomySync({ notify: false, user, exclude: own })
      const result = sync?.changes.find(own)
      const name = value.after?.name ?? value.before?.name ?? ''
      const labels = { name: 'Name', slug: 'Slug', parentName: 'Uebergeordnet', description: 'Beschreibung' }
      void audit(user, {
        category: 'taxonomies', action: `taxonomies.term_${request.operation}`, shopUrl,
        summary: `Begriff „${name}“ in ${value.taxonomyLabel} ${operationLabels[request.operation]}`,
        outcome: result?.outcome === 'failure' ? 'failure' : 'success',
        targetType: request.taxonomy, targetId: String(result?.termId ?? value.termId), targetLabel: name,
        details: {
          changes: request.operation === 'delete' ? [] : changeList(value.before, value.after, labels),
          shop: result ? (result.outcome === 'success' ? 'Im Shop gespeichert' : `Vom Shop abgelehnt: ${result.error}`) : 'Lokal vorgemerkt, wird spaeter uebertragen',
        },
      })
      // After an immediate sync the created term has its real shop ID.
      return { ok: true, value: { termId: result?.outcome === 'success' && result.termId ? result.termId : value.termId, sync } }
    } catch (error) {
      const message = safeTaxonomyError(error) ? error.message : 'Aenderung konnte nicht gespeichert werden. Eingaben pruefen.'
      if (user) void audit(user, { category: 'taxonomies', action: `taxonomies.term_${['create', 'update', 'delete'].includes(request.operation) ? request.operation : 'change'}`, summary: `Begriff ${request.fields?.name ? `„${String(request.fields.name).slice(0, 200)}“ ` : ''}nicht gespeichert`, outcome: 'failure', targetType: typeof request.taxonomy === 'string' ? request.taxonomy.slice(0, 80) : null, details: { error: message } })
      return { ok: false, error: message }
    }
  })
  ipcMain.handle('catalog:v2:taxonomies-sync', async (event, envelope) => {
    try {
      const { user, payload } = authorize(event, envelope, 'taxonomies')
      if (payload?.retryFailed === true) await databaseCall('retryTaxonomyChanges', { shopUrl: await currentShopUrl() })
      const sync = await runTaxonomySync({ notify: false, user })
      if (!sync) return { ok: false, error: 'Eine Shopaktion laeuft bereits. Bitte gleich erneut versuchen.' }
      return { ok: true, value: sync }
    } catch (error) {
      return { ok: false, error: safeTaxonomyError(error) ? error.message : 'Synchronisation fehlgeschlagen.' }
    }
  })
  ipcMain.handle('catalog:v2:taxonomies-discard', async (event, envelope) => {
    try {
      const { user, payload } = authorize(event, envelope, 'taxonomies')
      const shopUrl = await currentShopUrl()
      const value = await databaseCall('discardTaxonomyChange', { ...(payload && typeof payload === 'object' ? payload : {}), shopUrl })
      void audit(user, { category: 'taxonomies', action: 'taxonomies.change_discard', shopUrl, summary: `Vorgemerkte Aenderung an „${value.name ?? ''}“ in ${value.taxonomyLabel ?? 'Taxonomie'} verworfen`, targetType: payload.taxonomy, targetId: String(payload.termId), targetLabel: value.name, details: { discarded: operationLabels[value.operation] } })
      return { ok: true, value: true }
    } catch (error) {
      return { ok: false, error: safeTaxonomyError(error) ? error.message : 'Aenderung konnte nicht verworfen werden.' }
    }
  })
  ipcMain.handle('catalog:v2:taxonomies-import', async (event, envelope) => {
    let acquired = false
    let user = null
    let shopUrl = null
    try {
      user = authorize(event, envelope, 'taxonomies').user
      if (shopOperationRunning) return { ok: false, error: 'Eine Shopaktion laeuft bereits.' }
      shopOperationRunning = true
      acquired = true
      const connection = await shopStore.load()
      if (!connection) return { ok: false, error: 'Keine Shopverbindung gespeichert. Bitte zuerst unter Shopverbindung einrichten.' }
      shopUrl = connection.url
      // Queued edits go out first so the import does not show stale shop data for them.
      auditSync((await syncTaxonomyChanges(connection, databaseCall, shopFetch)).changes, user, connection.url)
      const result = await importTaxonomies(connection, (url, options) => net.fetch(url, options), (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('catalog:v2:taxonomies-progress', progress)
      })
      authorize(event, envelope, 'taxonomies')
      const overview = await storeTaxonomies(result, user)
      const terms = result.taxonomies.reduce((sum, entry) => sum + entry.terms.length, 0)
      void audit(user, { category: 'taxonomies', action: 'taxonomies.import', shopUrl: result.shopUrl, targetType: 'shop', targetLabel: result.shopUrl,
        summary: `Taxonomien importiert: ${result.taxonomies.length} Taxonomien, ${terms} Begriffe`,
        details: { taxonomies: result.taxonomies.map((entry) => ({ taxonomy: entry.label, key: entry.taxonomy, terms: entry.terms.length, readable: entry.available })) } })
      return { ok: true, value: overview }
    } catch (error) {
      const message = safeTaxonomyError(error) ? error.message : 'Taxonomien konnten nicht importiert werden.'
      if (user && acquired) void audit(user, { category: 'taxonomies', action: 'taxonomies.import', summary: 'Taxonomie-Import fehlgeschlagen', outcome: 'failure', shopUrl, targetType: 'shop', targetLabel: shopUrl, details: { error: message } })
      return { ok: false, error: message }
    } finally {
      if (acquired) shopOperationRunning = false
    }
  })
  for (const [channel, operation] of [['taxonomies-overview', 'taxonomyOverview'], ['taxonomies-terms', 'listTaxonomyTerms'], ['taxonomies-options', 'taxonomyTermOptions']]) {
    ipcMain.handle(`catalog:v2:${channel}`, async (event, envelope) => {
      try {
        const { payload } = authorize(event, envelope, 'taxonomies')
        const shopUrl = (await shopStore.summary().catch(() => null))?.url
        const query = operation === 'taxonomyOverview' ? { shopUrl } : { ...(payload && typeof payload === 'object' ? payload : {}), shopUrl }
        return { ok: true, value: await database.request(operation, query) }
      } catch (error) {
        return { ok: false, error: /^(Sitzung|Fuer diese)/.test(error.message ?? '') ? error.message : 'Taxonomien konnten nicht geladen werden.' }
      }
    })
  }
  ipcMain.handle('catalog:v2:modules-list', async (event, envelope) => {
    try {
      authorize(event, envelope, 'plugins')
      const shopUrl = (await shopStore.summary().catch(() => null))?.url
      return { ok: true, value: await databaseCall('listModules', shopUrl ? { shopUrl } : {}) }
    } catch (error) {
      return { ok: false, error: /^(Sitzung|Fuer diese)/.test(error.message ?? '') ? error.message : 'Module konnten nicht geladen werden.' }
    }
  })
  ipcMain.handle('catalog:v2:modules-detect', async (event, envelope) => {
    let acquired = false
    try {
      const { user } = authorize(event, envelope, 'plugins')
      if (shopOperationRunning) return { ok: false, error: 'Eine Shopaktion laeuft bereits.' }
      shopOperationRunning = true
      acquired = true
      const connection = await shopStore.load()
      if (!connection) return { ok: false, error: 'Keine Shopverbindung gespeichert. Bitte zuerst unter Shopverbindung einrichten.' }
      // Unlike during an import, an unreachable shop must not count as "no plugins": fail instead.
      const [namespaces, plugins] = await Promise.all([
        fetchNamespaces(connection, shopFetch).catch(() => { throw new Error('Modul: Der Shop war nicht erreichbar. Bitte Verbindung pruefen und erneut versuchen.') }),
        fetchPluginStatus(connection, shopFetch),
      ])
      authorize(event, envelope, 'plugins')
      const before = await moduleStates(connection.url)
      const value = await databaseCall('redetectModules', { shopUrl: connection.url, namespaces, plugins, checkedAt: new Date().toISOString() })
      const changes = auditModuleChanges(before, value.modules, user, connection.url)
      return { ok: true, value: { ...value, changes } }
    } catch (error) {
      return { ok: false, error: /^(Sitzung|Fuer diese|Modul)/.test(error.message ?? '') ? error.message : 'Plugins konnten nicht geprueft werden.' }
    } finally {
      if (acquired) shopOperationRunning = false
    }
  })
  ipcMain.handle('catalog:v2:modules-set', async (event, envelope) => {
    let user = null
    try {
      const authorized = authorize(event, envelope, 'plugins')
      user = authorized.user
      const shopUrl = await currentShopUrl()
      const value = await databaseCall('setModuleEnabled', { shopUrl, moduleId: authorized.payload?.moduleId, enabled: authorized.payload?.enabled })
      void audit(user, { category: 'shop', action: value.enabled ? 'shop.module_enabled' : 'shop.module_disabled', shopUrl, targetType: 'module', targetId: value.id, targetLabel: value.name,
        summary: `Modul ${value.name} ${value.enabled ? 'eingeschaltet' : 'ausgeschaltet'}`, details: { changes: [{ field: 'Modul', before: value.enabled ? 'Aus' : 'Ein', after: value.enabled ? 'Ein' : 'Aus' }] } })
      return { ok: true, value }
    } catch (error) {
      const message = /^(Sitzung|Fuer diese|Modul|Keine Shopverbindung)/.test(error.message ?? '') ? error.message : 'Modul konnte nicht umgeschaltet werden.'
      return { ok: false, error: message }
    }
  })
  ipcMain.handle('catalog:v2:audit-list', async (event, envelope) => {
    try {
      const { payload } = authorize(event, envelope, 'history')
      return { ok: true, value: await databaseCall('listAudit', payload && typeof payload === 'object' ? payload : {}) }
    } catch (error) {
      return { ok: false, error: /^(Sitzung|Fuer diese)/.test(error.message ?? '') ? error.message : 'Historie konnte nicht geladen werden.' }
    }
  })
  ipcMain.handle('catalog:v2:auth-state', async (event, sessionToken) => {
    validateSender(event)
    return authenticator.state(sessionToken)
  })
  ipcMain.handle('catalog:v2:auth-bootstrap', async (event, payload) => {
    validateSender(event)
    try {
      const result = await authenticator.bootstrap(payload)
      void audit(result.user, { category: 'auth', action: 'auth.bootstrap', summary: 'Ersten Administrator eingerichtet', targetType: 'user', targetId: result.user.id, targetLabel: result.user.username })
      return { ok: true, ...result }
    } catch (error) {
      return {
        ok: false,
        error: error.message.includes('already configured')
          ? 'Admin ist bereits eingerichtet. Bitte anmelden.'
          : 'Admin konnte nicht eingerichtet werden. Eingaben pruefen.',
      }
    }
  })
  ipcMain.handle('catalog:v2:auth-login', async (event, payload) => {
    validateSender(event)
    try {
      const result = await authenticator.login(payload)
      void audit(result.user, { category: 'auth', action: 'auth.login', summary: 'Angemeldet', targetType: 'user', targetId: result.user.id, targetLabel: result.user.username })
      return { ok: true, ...result }
    } catch (error) {
      const attempted = typeof payload?.username === 'string' ? payload.username.trim().slice(0, 64) : null
      void audit(null, { category: 'auth', action: 'auth.login_failed', source: 'user', username: attempted, summary: `Anmeldung fehlgeschlagen${attempted ? ` fuer „${attempted}“` : ''}`, outcome: 'failure', targetType: 'user', targetLabel: attempted, details: { reason: error.message } })
      return { ok: false, error: error.message }
    }
  })
  // Automatic sign-in for `npm run dev` (unpackaged app with --dev). Never available in a packaged app.
  // CATALOGDESK_V2_DEV_LOGIN=0 turns it off, CATALOGDESK_V2_DEV_USER selects the user (default: first admin).
  const developmentLogin = development && process.env.CATALOGDESK_V2_DEV_LOGIN !== '0'
  ipcMain.handle('catalog:v2:auth-dev', async (event) => {
    validateSender(event)
    if (!developmentLogin || app.isPackaged) return { ok: false, error: 'Nicht verfuegbar.' }
    try {
      const result = await authenticator.developmentLogin(process.env.CATALOGDESK_V2_DEV_USER)
      void audit(result.user, { category: 'auth', action: 'auth.login', summary: 'Angemeldet (Entwicklungsmodus)', targetType: 'user', targetId: result.user.id, targetLabel: result.user.username, details: { method: 'Automatische Anmeldung ohne Passwort (npm run dev)' } })
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })
  ipcMain.handle('catalog:v2:auth-logout', async (event, sessionToken) => {
    validateSender(event)
    const { user } = await authenticator.state(sessionToken)
    if (user) void audit(user, { category: 'auth', action: 'auth.logout', summary: 'Abgemeldet', targetType: 'user', targetId: user.id, targetLabel: user.username })
    return authenticator.logout(sessionToken)
  })
  ipcMain.handle('catalog:v2:workspace-summary', async (event, envelope) => {
    const { user } = authorize(event, envelope, 'session')
    if (user.role !== 'admin' && !user.permissions.some((entry) => ['dashboard', 'products'].includes(entry)))
      throw new Error('Fuer diesen Bereich fehlt die erforderliche Berechtigung.')
    return database.request('workspaceSummary')
  })
  // Full shop import: queued term edits first, then taxonomies (so every product relation can be resolved),
  // then all products and their variations. The local catalog is replaced in one transaction at the end.
  ipcMain.handle('catalog:v2:products-import', async (event, envelope) => {
    let acquired = false
    let user = null
    let shopUrl = null
    const progress = (value) => {
      // Keeps the session alive during long imports and stops them when the session ends.
      authorize(event, envelope, 'products')
      if (!event.sender.isDestroyed()) event.sender.send('catalog:v2:products-progress', value)
    }
    try {
      user = authorize(event, envelope, 'products').user
      if (shopOperationRunning) return { ok: false, error: 'Eine Shopaktion laeuft bereits.' }
      shopOperationRunning = true
      acquired = true
      const connection = await shopStore.load()
      if (!connection) return { ok: false, error: 'Keine Shopverbindung gespeichert. Bitte zuerst unter Shopverbindung einrichten.' }
      shopUrl = connection.url
      const started = Date.now()
      progress({ step: 'taxonomies', label: 'Taxonomien werden aktualisiert ...', completed: 0, total: 1 })
      auditSync((await syncTaxonomyChanges(connection, databaseCall, shopFetch)).changes, user, connection.url)
      // Queued product edits go out first; edits that cannot be sent stay queued over the import.
      auditProductSync((await syncProductChanges(connection, databaseCall, shopFetch)).changes, user, connection.url)
      const taxonomies = await importTaxonomies(connection, shopFetch, (value) => progress({ step: 'taxonomies', label: `Taxonomien: ${value.label}`, completed: value.completed, total: value.total }))
      await storeTaxonomies(taxonomies, user)
      const catalog = await importProducts(connection, shopFetch, progress)
      progress({ step: 'saving', label: 'Katalog wird gespeichert ...', completed: 1, total: 1 })
      authorize(event, envelope, 'products')
      const summary = await databaseCall('replaceCatalog', catalog)
      const termCount = taxonomies.taxonomies.reduce((sum, entry) => sum + entry.terms.length, 0)
      const parents = summary.products - summary.variations
      void audit(user, { category: 'catalog', action: 'catalog.import', shopUrl: catalog.shopUrl, targetType: 'shop', targetLabel: catalog.shopUrl,
        summary: `Produkte importiert: ${parents} Produkte, ${summary.variations} Varianten`,
        details: { products: parents, variable: summary.variable, variations: summary.variations, relations: summary.relations, unresolvedRelations: summary.unresolved,
          taxonomies: `${taxonomies.taxonomies.length} Taxonomien, ${termCount} Begriffe aktualisiert`, duration: `${Math.round((Date.now() - started) / 1000)} s` } })
      return { ok: true, value: summary }
    } catch (error) {
      const message = safeTaxonomyError(error) ? error.message : 'Produkte konnten nicht importiert werden.'
      if (user && acquired) void audit(user, { category: 'catalog', action: 'catalog.import', summary: 'Produktimport fehlgeschlagen', outcome: 'failure', shopUrl, targetType: 'shop', targetLabel: shopUrl, details: { error: message } })
      return { ok: false, error: message }
    } finally {
      if (acquired) shopOperationRunning = false
    }
  })
  const productError = (error, fallback) => safeTaxonomyError(error) || /^(Produkt|Keine Shopverbindung)/.test(error.message ?? '') ? error.message : fallback
  ipcMain.handle('catalog:v2:products-change', async (event, envelope) => {
    let user = null
    const request = envelope?.payload && typeof envelope.payload === 'object' ? envelope.payload : {}
    try {
      user = authorize(event, envelope, 'products').user
      const shopUrl = await currentShopUrl()
      const value = await databaseCall('queueProductChange', { shopUrl, productId: request.productId, values: request.values ?? {}, terms: request.terms ?? {} })
      const own = (change) => change.productId === value.productId
      const sync = value.queued ? await runShopSync({ notify: false, user, excludeProduct: own }) : null
      const result = sync?.products.changes.find(own)
      const changes = Object.keys(value.after).filter((field) => !productFields.same(value.before[field], value.after[field]))
        .map((field) => ({ field: value.labels[field], before: productFields.display(field, value.before[field]), after: productFields.display(field, value.after[field]) }))
      if (changes.length) void audit(user, {
        category: 'catalog', action: 'catalog.product_update', shopUrl, targetType: value.variation ? 'variation' : 'product', targetId: String(value.productId), targetLabel: value.name,
        summary: `${value.variation ? 'Variante' : 'Produkt'} „${value.name}“ geaendert`, outcome: result?.outcome === 'failure' ? 'failure' : 'success',
        details: { changes, shop: !value.queued ? 'Entspricht wieder dem Stand im Shop' : !result ? 'Lokal vorgemerkt, wird spaeter uebertragen'
          : { success: 'Im Shop gespeichert', conflict: `Konflikt: ${(result.conflicts ?? []).map((field) => value.labels[field] ?? field).join(', ')} wurde im Shop geaendert`, failure: `Vom Shop abgelehnt: ${result.error}` }[result.outcome] },
      })
      return { ok: true, value: { queued: value.queued, sync: sync?.products ?? null, outcome: result?.outcome ?? null, conflicts: result?.conflicts ?? [], error: result?.error ?? null } }
    } catch (error) {
      const message = productError(error, 'Aenderung konnte nicht gespeichert werden. Eingaben pruefen.')
      if (user) void audit(user, { category: 'catalog', action: 'catalog.product_update', summary: 'Produktaenderung nicht gespeichert', outcome: 'failure', targetType: 'product', targetId: Number.isSafeInteger(request.productId) ? String(request.productId) : null, details: { error: message } })
      return { ok: false, error: message }
    }
  })
  ipcMain.handle('catalog:v2:products-sync', async (event, envelope) => {
    try {
      const { user, payload } = authorize(event, envelope, 'products')
      if (payload?.retryFailed === true) await databaseCall('retryProductChanges', { shopUrl: await currentShopUrl() })
      const sync = await runShopSync({ notify: false, user })
      if (!sync) return { ok: false, error: 'Eine Shopaktion laeuft bereits. Bitte gleich erneut versuchen.' }
      return { ok: true, value: sync.products }
    } catch (error) {
      return { ok: false, error: productError(error, 'Synchronisation fehlgeschlagen.') }
    }
  })
  ipcMain.handle('catalog:v2:products-discard', async (event, envelope) => {
    try {
      const { user, payload } = authorize(event, envelope, 'products')
      const shopUrl = await currentShopUrl()
      const value = await databaseCall('discardProductChange', { shopUrl, productId: payload?.productId })
      void audit(user, { category: 'catalog', action: 'catalog.product_discard', shopUrl, targetType: 'product', targetId: String(payload.productId), targetLabel: value.name,
        summary: `Vorgemerkte Aenderung an „${value.name}“ verworfen`, details: { fields: value.fields.map((field) => productFields.scalarFields[field]?.label ?? field).join(', ') } })
      return { ok: true, value: true }
    } catch (error) {
      return { ok: false, error: productError(error, 'Aenderung konnte nicht verworfen werden.') }
    }
  })
  ipcMain.handle('catalog:v2:products-resolve', async (event, envelope) => {
    try {
      const { user, payload } = authorize(event, envelope, 'products')
      const shopUrl = await currentShopUrl()
      const value = await databaseCall('resolveProductConflict', { shopUrl, productId: payload?.productId, resolutions: payload?.resolutions ?? {} })
      const label = (field) => productFields.scalarFields[field]?.label ?? field
      void audit(user, { category: 'catalog', action: 'catalog.product_conflict', shopUrl, targetType: 'product', targetId: String(payload.productId), targetLabel: payload.name ? String(payload.name).slice(0, 200) : null,
        summary: `Konflikt bei „${payload.name ? String(payload.name).slice(0, 200) : `#${payload.productId}`}“ geloest`,
        details: { resolutions: [...value.kept.map((field) => ({ field: label(field), decision: 'Meine Aenderung behalten', shopValue: productFields.display(field, value.remote[field]) })), ...value.dropped.map((field) => ({ field: label(field), decision: 'Shop-Wert uebernommen', shopValue: productFields.display(field, value.remote[field]) }))] } })
      const sync = await runShopSync({ notify: false, user })
      return { ok: true, value: sync?.products ?? null }
    } catch (error) {
      return { ok: false, error: productError(error, 'Konflikt konnte nicht geloest werden.') }
    }
  })
  // Media library of the shop for the image picker (online only).
  ipcMain.handle('catalog:v2:media-library', async (event, envelope) => {
    try {
      const { payload } = authorizeAny(event, envelope, ['products', 'media'])
      const connection = await shopStore.load()
      if (!connection) return { ok: false, error: 'Keine Shopverbindung gespeichert. Bitte zuerst unter Shopverbindung einrichten.' }
      const search = typeof payload?.search === 'string' ? payload.search.trim().slice(0, 200) : ''
      const page = Number.isSafeInteger(payload?.page) && payload.page > 0 && payload.page < 10_000 ? payload.page : 1
      return { ok: true, value: { ...(await listMediaLibrary(connection, shopFetch, { search, page })), canUpload: Boolean(connection.wpAppPassword) } }
    } catch (error) {
      if (error instanceof WooError) return { ok: false, error: error.offline ? 'Die Mediathek ist nur mit Verbindung zum Shop erreichbar. Vorgemerkte Uploads lassen sich trotzdem verwenden.' : error.message }
      return { ok: false, error: productError(error, 'Mediathek konnte nicht geladen werden.') }
    }
  })
  ipcMain.handle('catalog:v2:media-pending', async (event, envelope) => {
    try {
      authorizeAny(event, envelope, ['products', 'media'])
      const shop = await shopStore.summary().catch(() => null)
      return { ok: true, value: shop ? await databaseCall('listMediaUploads', { shopUrl: shop.url }) : [] }
    } catch (error) {
      return { ok: false, error: productError(error, 'Vorgemerkte Bilder konnten nicht geladen werden.') }
    }
  })
  // Stores a picked image locally and queues it; the next shop sync uploads it to the media library.
  const uploadTypes = { 'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    'image/png': { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    'image/gif': { ext: 'gif', magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
    'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' } }
  ipcMain.handle('catalog:v2:media-upload', async (event, envelope) => {
    let user = null
    try {
      const authorized = authorizeAny(event, envelope, ['products', 'media'])
      user = authorized.user
      const payload = authorized.payload
      const connection = await shopStore.load()
      if (!connection) return { ok: false, error: 'Keine Shopverbindung gespeichert. Bitte zuerst unter Shopverbindung einrichten.' }
      if (!connection.wpAppPassword) return { ok: false, error: 'Zum Hochladen bitte unter Shopverbindung einen WordPress-Benutzer mit Anwendungspasswort hinterlegen.' }
      const type = uploadTypes[payload?.type]
      const data = payload?.data instanceof Uint8Array ? Buffer.from(payload.data) : null
      const filename = typeof payload?.name === 'string' ? payload.name.replace(/[\\/\u0000-\u001f]/g, '').trim().slice(0, 200) : ''
      if (!type || !data || !filename) return { ok: false, error: 'Bitte ein Bild im Format JPG, PNG, GIF oder WebP waehlen.' }
      if (data.length > 20 * 1024 * 1024) return { ok: false, error: `„${filename}“ ist groesser als 20 MB.` }
      if (!type.magic(data)) return { ok: false, error: `„${filename}“ ist kein gueltiges ${type.ext.toUpperCase()}-Bild.` }
      const image = nativeImage.createFromBuffer(data)
      const thumbnail = image.isEmpty() ? null : image.resize({ width: Math.min(320, image.getSize().width), quality: 'good' }).toDataURL()
      const file = `${randomUUID()}.${type.ext}`
      await mkdir(uploadDirectory, { recursive: true, mode: 0o700 })
      await writeFile(uploadPath(file), data, { mode: 0o600 })
      let value
      try { value = await databaseCall('addMediaUpload', { shopUrl: normalizeShopUrl(connection.url), file, filename, mime: payload.type, size: data.length, thumbnail: thumbnail && thumbnail.length <= 400_000 ? thumbnail : null }) }
      catch (error) { await rm(uploadPath(file), { force: true }).catch(() => {}); throw error }
      void audit(user, { category: 'catalog', action: 'catalog.media_upload', shopUrl: connection.url, targetType: 'media', targetLabel: filename, summary: `Bild „${filename}“ zum Hochladen vorgemerkt`, details: { size: `${Math.round(data.length / 1024)} KB` } })
      void runShopSync({ user }).catch(() => {})
      return { ok: true, value }
    } catch (error) {
      if (user) void audit(user, { category: 'catalog', action: 'catalog.media_upload', summary: 'Bild nicht vorgemerkt', outcome: 'failure', details: { error: error.message?.slice(0, 300) ?? null } })
      return { ok: false, error: productError(error, 'Bild konnte nicht vorgemerkt werden.') }
    }
  })
  const mediaError = (error, fallback) => /^(Sitzung|Fuer diese|Medium|Keine Shopverbindung)/.test(error.message ?? '') ? error.message.replace(/^Medium: /, '') : fallback
  // Local media library (works offline): page with filters, and the image picker.
  ipcMain.handle('catalog:v2:media-list', async (event, envelope) => {
    try {
      const { payload } = authorizeAny(event, envelope, ['media', 'products'])
      const shop = await shopStore.summary().catch(() => null)
      if (!shop) return { ok: true, value: { items: [], total: 0, page: 0, pageSize: 60, imported: false, importedAt: null, syncedAt: null, lastModified: null, count: 0, changeCounts: { pending: 0, failed: 0, conflict: 0 }, canEdit: false } }
      const query = payload && typeof payload === 'object' ? payload : {}
      const value = await databaseCall('listMedia', { shopUrl: shop.url, query: query.query ?? '', filter: query.filter ?? 'all', page: query.page ?? 0, pageSize: query.pageSize ?? 60 })
      return { ok: true, value: { ...value, canEdit: Boolean(shop.wpUser) } }
    } catch (error) {
      return { ok: false, error: mediaError(error, 'Mediathek konnte nicht geladen werden.') }
    }
  })
  ipcMain.handle('catalog:v2:media-detail', async (event, envelope) => {
    try {
      const { payload } = authorize(event, envelope, 'media')
      return { ok: true, value: await databaseCall('mediaDetail', { shopUrl: await currentShopUrl(), mediaId: payload?.mediaId }) }
    } catch (error) {
      return { ok: false, error: mediaError(error, 'Bild konnte nicht geladen werden.') }
    }
  })
  // Reads the media library from WordPress: everything the first time, afterwards only changes (and deletions).
  ipcMain.handle('catalog:v2:media-sync', async (event, envelope) => {
    let acquired = false
    let user = null
    let shopUrl = null
    try {
      const authorized = authorize(event, envelope, 'media')
      user = authorized.user
      if (shopOperationRunning) return { ok: false, error: 'Eine Shopaktion laeuft bereits.' }
      shopOperationRunning = true
      acquired = true
      const connection = await shopStore.load()
      if (!connection) return { ok: false, error: 'Keine Shopverbindung gespeichert. Bitte zuerst unter Shopverbindung einrichten.' }
      shopUrl = connection.url
      const state = await databaseCall('mediaLibraryState', { shopUrl })
      // A full read when asked for, never imported yet, or read without application password before (texts not editable).
      const full = authorized.payload?.full === true || !state.imported || Boolean(connection.wpAppPassword && state.readOnly)
      const result = await importMediaLibrary(connection, shopFetch, { since: full ? null : state.lastModified, onProgress: (progress) => { if (!event.sender.isDestroyed()) event.sender.send('catalog:v2:media-progress', progress) } })
      authorize(event, envelope, 'media')
      const stored = await databaseCall('storeMediaLibrary', { shopUrl, syncedAt: new Date().toISOString(), items: result.items, ids: result.ids })
      void audit(user, { category: 'sync', action: full ? 'sync.media_import' : 'sync.media_refresh', shopUrl, targetType: 'shop', targetLabel: shopUrl,
        summary: full ? `Mediathek importiert: ${stored.count} Bilder` : `Mediathek abgeglichen: ${result.items.length} geaendert, ${stored.removed} entfernt`, details: { images: stored.count, changed: result.items.length, removed: stored.removed, editable: result.editable ? 'Ja' : 'Nein (kein Anwendungspasswort)' } })
      acquired = false
      shopOperationRunning = false
      // Queued edits go out right after reading.
      const sync = await runShopSync({ notify: false, user })
      return { ok: true, value: { ...stored, changed: result.items.length, full, sync: sync?.media ?? null } }
    } catch (error) {
      const message = error instanceof WooError ? error.message : mediaError(error, 'Mediathek konnte nicht abgeglichen werden.')
      if (user && acquired) void audit(user, { category: 'sync', action: 'sync.media_refresh', summary: 'Mediathek-Abgleich fehlgeschlagen', outcome: 'failure', shopUrl, details: { error: message } })
      return { ok: false, error: message }
    } finally {
      if (acquired) shopOperationRunning = false
    }
  })
  ipcMain.handle('catalog:v2:media-change', async (event, envelope) => {
    let user = null
    const request = envelope?.payload && typeof envelope.payload === 'object' ? envelope.payload : {}
    try {
      user = authorize(event, envelope, 'media').user
      const shopUrl = await currentShopUrl()
      const value = await databaseCall('queueMediaChange', { shopUrl, mediaId: request.mediaId, values: request.values ?? {} })
      const own = (change) => change.mediaId === value.mediaId
      const sync = value.queued ? await runShopSync({ notify: false, user, excludeMedia: own }) : null
      const result = sync?.media.changes.find(own)
      const changes = Object.keys(value.after).filter((field) => value.before[field] !== value.after[field]).map((field) => ({ field: value.labels[field], before: value.before[field] || null, after: value.after[field] || null }))
      if (changes.length) void audit(user, {
        category: 'catalog', action: 'catalog.media_update', shopUrl, targetType: 'media', targetId: String(value.mediaId), targetLabel: value.name,
        summary: `Bild „${value.name}“ geaendert`, outcome: result?.outcome === 'failure' ? 'failure' : 'success',
        details: { changes, shop: !value.queued ? 'Entspricht wieder dem Stand in WordPress' : !result ? 'Lokal vorgemerkt, wird spaeter uebertragen'
          : { success: 'In WordPress gespeichert', conflict: `Konflikt: ${(result.conflicts ?? []).map((field) => value.labels[field] ?? field).join(', ')} wurde in WordPress geaendert`, failure: `Von WordPress abgelehnt: ${result.error}` }[result.outcome] },
      })
      return { ok: true, value: { queued: value.queued, outcome: result?.outcome ?? null, conflicts: result?.conflicts ?? [], error: result?.error ?? null } }
    } catch (error) {
      const message = mediaError(error, 'Aenderung konnte nicht gespeichert werden. Eingaben pruefen.')
      if (user) void audit(user, { category: 'catalog', action: 'catalog.media_update', summary: 'Bildaenderung nicht gespeichert', outcome: 'failure', targetType: 'media', targetId: Number.isSafeInteger(request.mediaId) ? String(request.mediaId) : null, details: { error: message } })
      return { ok: false, error: message }
    }
  })
  ipcMain.handle('catalog:v2:media-discard', async (event, envelope) => {
    try {
      const { user, payload } = authorize(event, envelope, 'media')
      const shopUrl = await currentShopUrl()
      const value = await databaseCall('discardMediaChange', { shopUrl, mediaId: payload?.mediaId })
      void audit(user, { category: 'catalog', action: 'catalog.media_discard', shopUrl, targetType: 'media', targetId: String(payload.mediaId), targetLabel: value.name,
        summary: `Vorgemerkte Aenderung an Bild „${value.name}“ verworfen`, details: { fields: value.fields.map((field) => mediaLabels[field] ?? field).join(', ') } })
      return { ok: true, value: true }
    } catch (error) {
      return { ok: false, error: mediaError(error, 'Aenderung konnte nicht verworfen werden.') }
    }
  })
  ipcMain.handle('catalog:v2:media-resolve', async (event, envelope) => {
    try {
      const { user, payload } = authorize(event, envelope, 'media')
      const shopUrl = await currentShopUrl()
      const value = await databaseCall('resolveMediaConflict', { shopUrl, mediaId: payload?.mediaId, resolutions: payload?.resolutions ?? {} })
      const name = payload?.name ? String(payload.name).slice(0, 200) : `#${payload?.mediaId}`
      void audit(user, { category: 'catalog', action: 'catalog.media_conflict', shopUrl, targetType: 'media', targetId: String(payload.mediaId), targetLabel: name, summary: `Konflikt bei Bild „${name}“ geloest`,
        details: { resolutions: [...value.kept.map((field) => ({ field: mediaLabels[field], decision: 'Meine Aenderung behalten', shopValue: value.remote[field] })), ...value.dropped.map((field) => ({ field: mediaLabels[field], decision: 'WordPress-Wert uebernommen', shopValue: value.remote[field] }))] } })
      await runShopSync({ notify: false, user })
      return { ok: true, value: true }
    } catch (error) {
      return { ok: false, error: mediaError(error, 'Konflikt konnte nicht geloest werden.') }
    }
  })
  ipcMain.handle('catalog:v2:media-delete', async (event, envelope) => {
    let user = null
    const mediaId = envelope?.payload?.mediaId
    try {
      user = authorize(event, envelope, 'media').user
      const connection = await shopStore.load()
      if (!connection) return { ok: false, error: 'Keine Shopverbindung gespeichert. Bitte zuerst unter Shopverbindung einrichten.' }
      if (Number(mediaId) > 0 && !connection.wpAppPassword) return { ok: false, error: 'Zum Loeschen unter Shopverbindung einen WordPress-Benutzer mit Anwendungspasswort hinterlegen.' }
      const value = await databaseCall('deleteMedia', { shopUrl: connection.url, mediaId })
      if (value.file) await rm(uploadPath(value.file), { force: true }).catch(() => {})
      void audit(user, { category: 'catalog', action: 'catalog.media_delete', shopUrl: connection.url, targetType: 'media', targetId: String(mediaId), targetLabel: value.name,
        summary: value.queued ? `Bild „${value.name}“ zum Loeschen vorgemerkt` : `Vorgemerkten Upload „${value.name}“ verworfen`,
        details: { removedFrom: value.removedFrom.map((entry) => entry.name).join(', ') || 'keinem Produkt' } })
      const sync = await runShopSync({ notify: false, user })
      const deleted = sync?.deletions?.changes.find((change) => change.mediaId === mediaId)
      return { ok: true, value: { queued: value.queued, removedFrom: value.removedFrom, outcome: !value.queued ? 'success' : deleted?.outcome ?? null, trashed: deleted?.trashed ?? null, places: deleted?.places ?? [], error: deleted?.error ?? null } }
    } catch (error) {
      const message = mediaError(error, 'Bild konnte nicht geloescht werden.')
      if (user) void audit(user, { category: 'catalog', action: 'catalog.media_delete', summary: 'Bild nicht geloescht', outcome: 'failure', targetType: 'media', targetId: Number.isSafeInteger(mediaId) ? String(mediaId) : null, details: { error: message } })
      return { ok: false, error: message }
    }
  })
  // A held deletion: the user saw where WordPress still uses the image and deletes it anyway.
  ipcMain.handle('catalog:v2:media-force-delete', async (event, envelope) => {
    try {
      const { user, payload } = authorize(event, envelope, 'media')
      const shopUrl = await currentShopUrl()
      const value = await databaseCall('forceMediaDeletion', { shopUrl, mediaId: payload?.mediaId })
      void audit(user, { category: 'catalog', action: 'catalog.media_delete_force', shopUrl, targetType: 'media', targetId: String(payload.mediaId), targetLabel: value.name,
        summary: `Bild „${value.name}“ trotz Verwendung zum Loeschen freigegeben`, details: { places: value.places.map((place) => `${place.kind}: ${place.title} (${place.where})`) } })
      const sync = await runShopSync({ notify: false, user })
      const deleted = sync?.deletions?.changes.find((change) => change.mediaId === payload.mediaId)
      return { ok: true, value: { outcome: deleted?.outcome ?? null, trashed: deleted?.trashed ?? null, error: deleted?.error ?? null } }
    } catch (error) {
      return { ok: false, error: mediaError(error, 'Bild konnte nicht geloescht werden.') }
    }
  })
  ipcMain.handle('catalog:v2:media-retry', async (event, envelope) => {
    try {
      const { user } = authorize(event, envelope, 'media')
      await databaseCall('retryMediaChanges', { shopUrl: await currentShopUrl() })
      const sync = await runShopSync({ notify: false, user })
      if (!sync) return { ok: false, error: 'Eine Shopaktion laeuft bereits. Bitte gleich erneut versuchen.' }
      return { ok: true, value: sync.media }
    } catch (error) {
      return { ok: false, error: mediaError(error, 'Synchronisation fehlgeschlagen.') }
    }
  })
  ipcMain.handle('catalog:v2:products-editor-options', async (event, envelope) => {
    try {
      authorize(event, envelope, 'products')
      const shopUrl = (await shopStore.summary().catch(() => null))?.url
      return { ok: true, value: await databaseCall('productEditorOptions', shopUrl ? { shopUrl } : {}) }
    } catch (error) {
      return { ok: false, error: productError(error, 'Bearbeitungsoptionen konnten nicht geladen werden.') }
    }
  })
  ipcMain.handle('catalog:v2:products-list', async (event, envelope) => {
    const { payload } = authorize(event, envelope, 'products')
    return database.request('listProducts', payload)
  })
  for (const [channel, method] of [['users-list', 'listUsers'], ['users-save', 'saveUser'], ['users-delete', 'deleteUser']]) {
    ipcMain.handle(`catalog:v2:${channel}`, async (event, envelope) => {
      let user = null
      let before = null
      try {
        const authorized = authorize(event, envelope, method === 'listUsers' ? 'users' : 'session')
        user = authorized.user
        const { payload } = authorized
        if (method !== 'listUsers') before = (await database.request('listUsers')).find((entry) => entry.id === (payload?.id ?? payload)) ?? null
        const value = await authenticator[method](envelope.sessionToken, payload)
        if (method === 'saveUser') {
          const after = (await database.request('listUsers')).find((entry) => entry.id === value)
          const labels = { firstName: 'Vorname', lastName: 'Name', email: 'E-Mail', username: 'Benutzername', role: 'Rolle', permissions: 'Berechtigungen' }
          const sections = { dashboard: 'Dashboard', products: 'Produkte', media: 'Mediathek', plugins: 'Plugins', orders: 'Bestellungen', customers: 'Kunden', settings: 'Einstellungen', users: 'Benutzer', shop: 'Shopverbindung', taxonomies: 'Taxonomien', sync: 'Synchronisation', history: 'Historie' }
          const readable = (entry) => entry && { ...entry, role: entry.role === 'admin' ? 'Admin' : 'Mitarbeiter', permissions: entry.role === 'admin' ? 'Alle Bereiche' : entry.permissions.map((key) => sections[key] ?? key).join(', ') || 'Keine Bereiche' }
          void audit(user, { category: 'users', action: before ? 'users.update' : 'users.create', summary: `Benutzer „${after.firstName} ${after.lastName}“ ${before ? 'geaendert' : 'angelegt'}`,
            targetType: 'user', targetId: value, targetLabel: after.username,
            details: { changes: [...changeList(readable(before), readable(after), labels), ...(payload?.password ? [{ field: 'Passwort', before: before ? 'gesetzt' : null, after: 'neu gesetzt' }] : [])] } })
        }
        if (method === 'deleteUser' && before)
          void audit(user, { category: 'users', action: 'users.delete', summary: `Benutzer „${before.firstName} ${before.lastName}“ geloescht`, targetType: 'user', targetId: before.id, targetLabel: before.username,
            details: { deleted: { name: `${before.firstName} ${before.lastName}`, email: before.email, role: before.role } } })
        if (method !== 'listUsers' && (payload?.id ?? payload) === user.id)
          event.sender.send('catalog:v2:auth-expired')
        return { ok: true, value }
      } catch (error) {
        const message = error.name === 'ZodError' ? 'Bitte alle Eingaben und das Passwort (mindestens 8 Zeichen) pruefen.' : error.message
        if (user && method !== 'listUsers' && !/^Sitzung/.test(message))
          void audit(user, { category: 'users', action: method === 'deleteUser' ? 'users.delete' : 'users.save', summary: method === 'deleteUser' ? `Benutzer ${before ? `„${before.firstName} ${before.lastName}“ ` : ''}nicht geloescht` : 'Benutzer nicht gespeichert', outcome: 'failure', targetType: 'user', targetId: before?.id ?? null, targetLabel: before?.username ?? null, details: { error: message } })
        return { ok: false, error: message }
      }
    })
  }
  // catalog-media://thumb/<id>: thumbnail of a media library item of the current shop. Loaded once from the
  // shop and kept on disk, so the media library and product list also show images offline.
  protocol.handle('catalog-media', async (request) => {
    try {
      const match = /^catalog-media:\/\/thumb\/(\d{1,12})$/.exec(request.url.replace(/\/$/, ''))
      const shop = await shopStore.summary().catch(() => null)
      if (request.method !== 'GET' || !match || !shop) return new Response('Not found', { status: 404 })
      const thumbUrl = await databaseCall('mediaThumb', { shopUrl: shop.url, mediaId: Number(match[1]) })
      if (!thumbUrl || !/^https:\/\//.test(thumbUrl)) return new Response('Not found', { status: 404 })
      const filename = path.join(thumbDirectory, createHash('sha256').update(`${shop.url}\u0000${thumbUrl}`).digest('hex'))
      const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }
      try { return new Response(await readFile(filename), { headers }) } catch { /* not cached yet */ }
      const response = await net.fetch(thumbUrl, { redirect: 'follow', credentials: 'omit' })
      const type = response.headers.get('content-type') ?? ''
      if (!response.ok || !type.startsWith('image/')) return new Response('Not found', { status: 404 })
      const data = Buffer.from(await response.arrayBuffer())
      if (data.length > 8 * 1024 * 1024) return new Response('Too large', { status: 404 })
      await mkdir(thumbDirectory, { recursive: true, mode: 0o700 })
      await writeFile(filename, data, { mode: 0o600 }).catch(() => {})
      return new Response(data, { headers: { ...headers, 'Content-Type': type } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
  if (!development) {
    protocol.handle('catalog', (request) => {
      try {
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const root = path.resolve(__dirname, '../dist')
        const filename = path.resolve(root, `.${decodeURIComponent(new URL(request.url).pathname)}`)
        if (!filename.startsWith(root + path.sep)) return new Response('Not found', { status: 404 })
        return net.fetch(pathToFileURL(filename).toString())
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })
  }
  try { initialTheme = await database.request('getTheme') }
  catch { initialTheme = 'light' }
  createWindow()
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', (event) => {
  if (!database) return
  event.preventDefault()
  const current = database
  database = null
  void current.close().finally(() => app.quit())
})
