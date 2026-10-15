const { contextBridge, ipcRenderer } = require('electron')

let sessionToken = null
const authListeners = new Set()
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
  logout: async () => {
    const current = sessionToken
    sessionToken = null
    return ipcRenderer.invoke('catalog:v2:auth-logout', current)
  },
  workspaceSummary: () => authorized('catalog:v2:workspace-summary'),
  listProducts: (query) => authorized('catalog:v2:products-list', query),
})
