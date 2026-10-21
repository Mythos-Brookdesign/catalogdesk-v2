const { readFile, writeFile, mkdir, rename, rm } = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { connectionSchema } = require('./shop.cjs')

function createShopStore(directory, encryption, platform = process.platform) {
  const filename = path.join(directory, 'shop-connection.enc')
  let queue = Promise.resolve()
  function secure() {
    if (!encryption.isEncryptionAvailable() || (platform === 'linux' && !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(encryption.getSelectedStorageBackend())))
      throw new Error('Kein sicherer Systemspeicher verfuegbar. Die Verbindung kann nicht gespeichert werden.')
  }
  function serial(action) {
    const result = queue.then(action)
    queue = result.catch(() => {})
    return result
  }
  async function load() {
    let buffer
    try { buffer = await readFile(filename) }
    catch (error) {
      if (error.code === 'ENOENT') return null
      throw new Error('Gespeicherte Shopverbindung konnte nicht gelesen werden.')
    }
    secure()
    try {
      if (buffer.length > 16 * 1024) throw new Error('Invalid storage')
      return connectionSchema.parse(JSON.parse(encryption.decryptString(buffer)))
    } catch { throw new Error('Shopverbindung konnte nicht entschluesselt werden. Bitte entfernen und neu einrichten.') }
  }
  return {
    load: () => serial(load),
    // Never the secrets: only whether an application password (and for which user) is stored.
    summary: () => serial(async () => { const saved = await load(); return saved ? { url: saved.url, wpUser: saved.wpUser ?? null } : null }),
    save: (input) => serial(async () => {
      const parsed = connectionSchema.safeParse(input)
      if (!parsed.success) throw new Error('Ungueltige Shopverbindung.')
      secure()
      const filenameTemporary = `${filename}.${randomUUID()}.tmp`
      try {
        const encrypted = encryption.encryptString(JSON.stringify(parsed.data))
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await writeFile(filenameTemporary, encrypted, { mode: 0o600 })
        await rename(filenameTemporary, filename)
      } catch {
        await rm(filenameTemporary, { force: true }).catch(() => {})
        throw new Error('Shopverbindung konnte nicht sicher gespeichert werden.')
      }
      return { url: parsed.data.url }
    }),
    delete: () => serial(async () => {
      try { await rm(filename, { force: true }); return true }
      catch { throw new Error('Shopverbindung konnte nicht entfernt werden.') }
    }),
  }
}

module.exports = { createShopStore }