const { app, BrowserWindow, ipcMain, net, protocol, safeStorage } = require('electron')
const { mkdirSync } = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createDatabaseClient } = require('./database-client.cjs')
const { createAuthenticator } = require('./auth.cjs')
const { createShopStore } = require('./shop-store.cjs')
const { WooError, resolveConnection, testConnection } = require('./shop.cjs')
const { importTaxonomies } = require('./taxonomies.cjs')

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
      const { payload } = authorize(event, envelope, 'settings')
      const theme = await database.request('setTheme', payload)
      initialTheme = theme
      mainWindow?.setBackgroundColor(theme === 'dark' ? '#171b19' : '#f3f5f2')
      return { ok: true, value: theme }
    } catch { return { ok: false, error: 'Farbschema konnte nicht gespeichert werden oder Berechtigung fehlt.' } }
  })
  for (const operation of ['summary', 'save', 'test', 'delete']) {
    ipcMain.handle(`catalog:v2:shop-${operation}`, async (event, envelope) => {
      let acquired = false
      try {
        const payload = authorizeShopSettings(event, envelope)
        if (operation === 'summary') return { ok: true, value: await shopStore.summary() }
        if (shopOperationRunning) return { ok: false, error: 'Eine Shopaktion laeuft bereits.' }
        shopOperationRunning = true
        acquired = true
        if (operation === 'delete') {
          if (payload?.confirmed !== true) return { ok: false, error: 'Bestaetigung zum Entfernen fehlt.' }
          return { ok: true, value: await shopStore.delete() }
        }
        const stored = await shopStore.load()
        const connection = resolveConnection(payload, stored)
        authorizeShopSettings(event, envelope)
        if (operation === 'save') return { ok: true, value: await shopStore.save(connection) }
        const result = await testConnection(connection, (url, options) => net.fetch(url, options))
        if (!result.ok) return result
        authorizeShopSettings(event, envelope)
        return { ok: true, value: { url: result.url, productCount: result.productCount, checkedAt: result.checkedAt } }
      } catch (error) {
        return { ok: false, error: error.name === 'ZodError' ? 'Shopadresse und API-Schluessel pruefen.' : error.message }
      } finally {
        if (acquired) shopOperationRunning = false
      }
    })
  }
  ipcMain.handle('catalog:v2:taxonomies-import', async (event, envelope) => {
    let acquired = false
    try {
      authorize(event, envelope, 'taxonomies')
      if (shopOperationRunning) return { ok: false, error: 'Eine Shopaktion laeuft bereits.' }
      shopOperationRunning = true
      acquired = true
      const connection = await shopStore.load()
      if (!connection) return { ok: false, error: 'Keine Shopverbindung gespeichert. Bitte zuerst unter Shopverbindung einrichten.' }
      const result = await importTaxonomies(connection, (url, options) => net.fetch(url, options), (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('catalog:v2:taxonomies-progress', progress)
      })
      authorize(event, envelope, 'taxonomies')
      return { ok: true, value: await database.request('replaceTaxonomies', result) }
    } catch (error) {
      const safe = error instanceof WooError || /^(Sitzung|Fuer diese|Shopverbindung|Gespeicherte|Kein sicherer|Datenbank)/.test(error.message ?? '')
      return { ok: false, error: safe ? error.message : 'Taxonomien konnten nicht importiert werden.' }
    } finally {
      if (acquired) shopOperationRunning = false
    }
  })
  for (const [channel, operation] of [['taxonomies-overview', 'taxonomyOverview'], ['taxonomies-terms', 'listTaxonomyTerms']]) {
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
  ipcMain.handle('catalog:v2:auth-state', async (event, sessionToken) => {
    validateSender(event)
    return authenticator.state(sessionToken)
  })
  ipcMain.handle('catalog:v2:auth-bootstrap', async (event, payload) => {
    validateSender(event)
    try {
      return { ok: true, ...(await authenticator.bootstrap(payload)) }
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
      return { ok: true, ...(await authenticator.login(payload)) }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })
  ipcMain.handle('catalog:v2:auth-logout', async (event, sessionToken) => {
    validateSender(event)
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
      try {
        const { user, payload } = authorize(event, envelope, method === 'listUsers' ? 'users' : 'session')
        const value = await authenticator[method](envelope.sessionToken, payload)
        if (method !== 'listUsers' && (payload?.id ?? payload) === user.id)
          event.sender.send('catalog:v2:auth-expired')
        return { ok: true, value }
      } catch (error) {
        return { ok: false, error: error.name === 'ZodError' ? 'Bitte alle Eingaben und das Passwort (mindestens 8 Zeichen) pruefen.' : error.message }
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
