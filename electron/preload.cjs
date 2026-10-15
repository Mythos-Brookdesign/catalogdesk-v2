const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('catalogDesk', {
  workspaceSummary: () => ipcRenderer.invoke('catalog:v2:workspace-summary'),
  listProducts: (query) => ipcRenderer.invoke('catalog:v2:products-list', query),
})
