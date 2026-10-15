const { Worker } = require('node:worker_threads')
const path = require('node:path')

function createDatabaseClient(filename) {
  const worker = new Worker(path.join(__dirname, 'database-worker.cjs'), { workerData: { filename } })
  const pending = new Map()
  let nextId = 0
  let closed = false
  worker.on('message', ({ id, result, error }) => {
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    if (error) request.reject(new Error(error))
    else request.resolve(result)
  })
  worker.on('error', () => {
    closed = true
    for (const request of pending.values()) request.reject(new Error('Datenbank-Worker ausgefallen.'))
    pending.clear()
  })
  function request(operation, payload) {
    if (closed) return Promise.reject(new Error('Datenbankverbindung ist geschlossen.'))
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, operation, payload })
    })
  }
  return {
    request,
    async close() {
      if (closed) return
      const completion = request('close')
      closed = true
      try { await completion } finally { await worker.terminate() }
    },
  }
}

module.exports = { createDatabaseClient }
