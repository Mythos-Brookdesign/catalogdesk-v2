const { WooError, normalizeUrl, wooRequest } = require('./shop.cjs')
const { toProduct } = require('./products.cjs')
const { fieldValue, isMetaField, same, toRequestBody } = require('./product-fields.cjs')

// Sends queued product edits. Before writing, the product is read from the shop: a field that was changed
// there since the edit was based on it (e.g. stock after an order) is a conflict and is not overwritten.
// Only changed fields are sent, and the shop's answer is checked field by field.
async function syncProductChanges(connection, database, fetcher) {
  const shopUrl = normalizeUrl(connection.url)
  const result = { synced: 0, failed: 0, conflicts: 0, offline: false, changes: [] }
  for (const change of await database('pendingProductChanges', { shopUrl })) {
    // References a term created offline or an image upload that has not reached the shop yet; send on a later run.
    // Module image ID meta (e.g. Yoast's social image) holds a pending upload as "-id".
    if (Object.entries(change.changes).some(([field, value]) => (Array.isArray(value) ? value : [value]).some((entry) =>
      entry && typeof entry === 'object' ? Number(entry.id) < 0 : isMetaField(field) && typeof entry === 'string' && /^-\d+$/.test(entry)))) continue
    const route = change.parentId ? `wc/v3/products/${change.parentId}/variations/${change.productId}` : `wc/v3/products/${change.productId}`
    const record = (outcome, extra = {}) => result.changes.push({ productId: change.productId, name: change.name, variation: Boolean(change.parentId), fields: Object.keys(change.changes), outcome, ...extra })
    try {
      const { data: current } = await wooRequest(connection, route, {}, fetcher, { maxBytes: 8 * 1024 * 1024 })
      if (!current || typeof current !== 'object' || current.id !== change.productId) throw new WooError('Die Antwort des Shops war unklar.')
      const conflicts = Object.keys(change.changes).filter((field) => !same(fieldValue(current, field), change.base[field]) && !same(fieldValue(current, field), change.changes[field]))
      if (conflicts.length) {
        await database('markProductChange', { changeId: change.id, revision: change.revision, state: 'conflict', error: null, remote: Object.fromEntries(conflicts.map((field) => [field, fieldValue(current, field)])) })
        result.conflicts++
        record('conflict', { conflicts })
        continue
      }
      const { data: updated } = await wooRequest(connection, route, {}, fetcher, { method: 'PUT', body: toRequestBody(change.changes), maxBytes: 8 * 1024 * 1024 })
      if (!updated || typeof updated !== 'object' || updated.id !== change.productId) throw new WooError('Die Antwort des Shops war unklar. Bitte Produkte neu importieren.')
      const ignored = Object.keys(change.changes).filter((field) => !same(fieldValue(updated, field), change.changes[field]))
      const product = toProduct(updated, change.parentId ? { id: change.parentId, name: change.parentName ?? '' } : null)
      await database('completeProductChange', { changeId: change.id, revision: change.revision, product, ignored })
      if (ignored.length) { result.failed++; record('failure', { error: 'Shop hat Felder nicht uebernommen', ignored }) }
      else { result.synced++; record('success') }
    } catch (error) {
      if (error instanceof WooError && error.offline) { result.offline = true; break }
      const message = error instanceof WooError
        ? error.status === 404 ? 'Das Produkt existiert im Shop nicht mehr.' : error.message
        : 'Aenderung konnte nicht uebertragen werden.'
      await database('markProductChange', { changeId: change.id, revision: change.revision, state: 'failed', error: message })
      result.failed++
      record('failure', { error: message })
      if (error instanceof WooError && (error.status === 401 || error.status === 403)) break
    }
  }
  return { ...result, counts: await database('productChangeCounts', { shopUrl }) }
}

module.exports = { syncProductChanges }
