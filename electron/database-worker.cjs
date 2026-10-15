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
  'getTheme',
  'setTheme',
  'findUserByUsername',
  'createInitialAdmin',
  'recordLogin',
  'listUsers',
  'saveUser',
  'deleteUser',
  'workspaceSummary',
  'listProducts',
  'replaceCatalog',
  'replaceTaxonomies',
  'taxonomyOverview',
  'listTaxonomyTerms',
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
    const safe = ['Unbekannte', 'Mindestens ein Administrator', 'Benutzer wurde nicht gefunden', 'Passwort erforderlich'].some((prefix) => error.message?.startsWith(prefix))
    const fallback = operation === 'saveUser' || operation === 'createInitialAdmin'
      ? 'Datenbankoperation fehlgeschlagen. Benutzername oder E-Mail eventuell bereits vergeben.'
      : 'Datenbankoperation fehlgeschlagen.'
    parentPort.postMessage({ id, error: safe ? error.message : fallback })
  }
})
