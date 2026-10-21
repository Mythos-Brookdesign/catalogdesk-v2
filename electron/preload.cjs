const { contextBridge, ipcRenderer } = require('electron')

let sessionToken = null
const authListeners = new Set()
const taxonomyProgressListeners = new Set()
const taxonomyChangeListeners = new Set()
const auditListeners = new Set()
const productProgressListeners = new Set()
const productChangeListeners = new Set()
ipcRenderer.on('catalog:v2:products-changed', () => {
  for (const listener of productChangeListeners) listener()
})
ipcRenderer.on('catalog:v2:products-progress', (_event, progress) => {
  for (const listener of productProgressListeners) listener(progress)
})
ipcRenderer.on('catalog:v2:audit-appended', () => {
  for (const listener of auditListeners) listener()
})
ipcRenderer.on('catalog:v2:taxonomies-changed', () => {
  for (const listener of taxonomyChangeListeners) listener()
})
ipcRenderer.on('catalog:v2:taxonomies-progress', (_event, progress) => {
  for (const listener of taxonomyProgressListeners) listener(progress)
})
ipcRenderer.on('catalog:v2:auth-expired', () => {
  sessionToken = null
  for (const listener of authListeners) listener()
})

const authorized = (channel, payload) =>
  ipcRenderer.invoke(channel, { sessionToken, payload })

async function authenticate(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload)
  if (!result.ok) return result
  sessionToken = result.sessionToken
  return { ok: true, user: result.user }
}

contextBridge.exposeInMainWorld('catalogDesk', {
  getTheme: () => ipcRenderer.invoke('catalog:v2:theme-get'),
  setTheme: (theme) => authorized('catalog:v2:theme-set', theme),
  shopConnection: () => authorized('catalog:v2:shop-summary'),
  saveShopConnection: (payload) => authorized('catalog:v2:shop-save', payload),
  testShopConnection: (payload) => authorized('catalog:v2:shop-test', payload),
  deleteShopConnection: () => authorized('catalog:v2:shop-delete', { confirmed: true }),
  onAuthExpired: (listener) => { authListeners.add(listener); return () => authListeners.delete(listener) },
  listUsers: () => authorized('catalog:v2:users-list'),
  saveUser: (payload) => authorized('catalog:v2:users-save', payload),
  deleteUser: (id) => authorized('catalog:v2:users-delete', id),
  authState: () => ipcRenderer.invoke('catalog:v2:auth-state', sessionToken),
  bootstrapAdmin: (profile) => authenticate('catalog:v2:auth-bootstrap', profile),
  login: (credentials) => authenticate('catalog:v2:auth-login', credentials),
  developmentLogin: () => authenticate('catalog:v2:auth-dev'),
  logout: async () => {
    const current = sessionToken
    sessionToken = null
    return ipcRenderer.invoke('catalog:v2:auth-logout', current)
  },
  workspaceSummary: () => authorized('catalog:v2:workspace-summary'),
  listProducts: (query) => authorized('catalog:v2:products-list', query),
  importProducts: () => authorized('catalog:v2:products-import'),
  changeProduct: (change) => authorized('catalog:v2:products-change', change),
  syncProducts: (retryFailed = false) => authorized('catalog:v2:products-sync', { retryFailed }),
  discardProductChange: (productId) => authorized('catalog:v2:products-discard', { productId }),
  resolveProductConflict: (resolution) => authorized('catalog:v2:products-resolve', resolution),
  productEditorOptions: () => authorized('catalog:v2:products-editor-options'),
  onProductsChanged: (listener) => { productChangeListeners.add(listener); return () => productChangeListeners.delete(listener) },
  onProductImportProgress: (listener) => { productProgressListeners.add(listener); return () => productProgressListeners.delete(listener) },
  importTaxonomies: () => authorized('catalog:v2:taxonomies-import'),
  taxonomyOverview: () => authorized('catalog:v2:taxonomies-overview'),
  listTaxonomyTerms: (query) => authorized('catalog:v2:taxonomies-terms', query),
  taxonomyTermOptions: (taxonomy) => authorized('catalog:v2:taxonomies-options', { taxonomy }),
  changeTaxonomyTerm: (change) => authorized('catalog:v2:taxonomies-change', change),
  discardTaxonomyChange: (ref) => authorized('catalog:v2:taxonomies-discard', ref),
  syncTaxonomies: (retryFailed = false) => authorized('catalog:v2:taxonomies-sync', { retryFailed }),
  onTaxonomiesChanged: (listener) => { taxonomyChangeListeners.add(listener); return () => taxonomyChangeListeners.delete(listener) },
  listAudit: (query) => authorized('catalog:v2:audit-list', query),
  listModules: () => authorized('catalog:v2:modules-list'),
  setModuleEnabled: (moduleId, enabled) => authorized('catalog:v2:modules-set', { moduleId, enabled }),
  detectModules: () => authorized('catalog:v2:modules-detect'),
  onAuditAppended: (listener) => { auditListeners.add(listener); return () => auditListeners.delete(listener) },
  onTaxonomyImportProgress: (listener) => { taxonomyProgressListeners.add(listener); return () => taxonomyProgressListeners.delete(listener) },
})
