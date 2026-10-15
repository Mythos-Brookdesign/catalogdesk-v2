const { contextBridge, ipcRenderer } = require('electron')

let sessionToken = null

const authorized = (channel, payload) =>
  ipcRenderer.invoke(channel, { sessionToken, payload })

async function authenticate(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload)
  if (!result.ok) return result
  sessionToken = result.sessionToken
  return { ok: true, user: result.user }
}

contextBridge.exposeInMainWorld('catalogDesk', {
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
