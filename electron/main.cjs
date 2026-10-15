const { app, BrowserWindow, ipcMain, net, protocol, safeStorage } = require('electron')
const { mkdirSync } = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createDatabaseClient } = require('./database-client.cjs')
const { createAuthenticator } = require('./auth.cjs')
const { createShopStore } = require('./shop-store.cjs')
const { WooError, resolveConnection, testConnection } = require('./shop.cjs')
const { importTaxonomies } = require('./taxonomies.cjs')
const { syncTaxonomyChanges } = require('./taxonomy-sync.cjs')

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

protocol.registerSchemesAsPrivileged([{ scheme: 'catalog', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

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
        const authorized = authorize(event, envelope, 'shop')
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
          void audit(user, { category: 'shop', action: 'shop.connection_save', summary: 'Shopverbindung gespeichert', targetType: 'shop', targetLabel: value.url, shopUrl: value.url,
            details: { changes: [...changeList(stored ? { url: stored.url } : null, { url: value.url }, { url: 'Shopadresse' }), ...(keysChanged ? [{ field: 'API-Schluessel', before: stored ? 'gesetzt' : null, after: 'neu gesetzt' }] : [])] } })
          return { ok: true, value }
        }
        const result = await testConnection(connection, (url, options) => net.fetch(url, options))
        void audit(user, result.ok
          ? { category: 'shop', action: 'shop.connection_test', summary: `Shopverbindung geprueft: ${result.productCount} Produkte erreichbar`, targetType: 'shop', targetLabel: result.url, shopUrl: result.url, details: { productCount: result.productCount } }
          : { category: 'shop', action: 'shop.connection_test', summary: 'Shopverbindung geprueft: fehlgeschlagen', outcome: 'failure', targetType: 'shop', targetLabel: connection.url, shopUrl: connection.url, details: { error: result.error } })
        if (!result.ok) return result
        authorizeShopSettings(event, envelope)
        return { ok: true, value: { url: result.url, productCount: result.productCount, checkedAt: result.checkedAt } }
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
  // `exclude` skips changes the caller records itself (the edit that triggered this run).
  async function runTaxonomySync({ notify = true, user = null, exclude = () => false } = {}) {
    if (shopOperationRunning || !database) return null
    const connection = await shopStore.load().catch(() => null)
    if (!connection) return null
    if (!net.isOnline()) return { synced: 0, failed: 0, offline: true, changes: [], ...(await databaseCall('taxonomyChangeCounts', { shopUrl: connection.url })) }
    shopOperationRunning = true
    try {
      const result = await syncTaxonomyChanges(connection, databaseCall, shopFetch)
      auditSync(result.changes.filter((change) => !exclude(change)), user, connection.url)
      if (notify && (result.synced || result.failed)) mainWindow?.webContents.send('catalog:v2:taxonomies-changed')
      return result
    } finally { shopOperationRunning = false }
  }
  setInterval(() => { void runTaxonomySync().catch(() => {}) }, 30_000).unref?.()
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
      return { ok: true, value: { termId: value.termId, sync } }
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
      const overview = await database.request('replaceTaxonomies', result)
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
          const sections = { dashboard: 'Dashboard', products: 'Produkte', orders: 'Bestellungen', customers: 'Kunden', settings: 'Einstellungen', users: 'Benutzer', shop: 'Shopverbindung', taxonomies: 'Taxonomien', sync: 'Synchronisation', history: 'Historie' }
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
