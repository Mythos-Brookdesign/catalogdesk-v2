const { parentPort, workerData } = require('node:worker_threads')
const { openDatabase } = require('./database.cjs')

let database
let startupError
try {
  database = openDatabase(workerData.filename)
} catch {
  startupError = 'Die lokale V2-Datenbank konnte nicht geoeffnet werden.'
}

const operations = new Set([
  'userCount',
  'findUserByUsername',
  'createInitialAdmin',
  'recordLogin',
  'workspaceSummary',
  'listProducts',
  'replaceCatalog',
  'close',
])
parentPort.on('message', ({ id, operation, payload }) => {
  try {
    if (startupError) throw new Error(startupError)
    if (!operations.has(operation)) throw new Error('Unbekannte Datenbankoperation.')
    const result = database[operation](payload)
    parentPort.postMessage({ id, result })
    if (operation === 'close') parentPort.close()
  } catch (error) {
    parentPort.postMessage({ id, error: error.message?.startsWith('Unbekannte') ? error.message : 'Datenbankoperation fehlgeschlagen.' })
  }
})
