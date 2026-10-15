const { WooError, normalizeUrl, wooRequest } = require('./shop.cjs')
const { termSchema, toTerm } = require('./taxonomies.cjs')

// Sends queued term edits to WooCommerce in creation order. Stops on connection loss so the
// remaining changes stay queued; shop-side rejections are stored per change with the shop's message.
async function syncTaxonomyChanges(connection, database, fetcher) {
  const shopUrl = normalizeUrl(connection.url)
  const result = { synced: 0, failed: 0, offline: false }
  const created = new Map()
  const key = (taxonomy, ref) => `${taxonomy}\u0000${ref}`
  for (const change of await database('pendingTaxonomyChanges', { shopUrl })) {
    const { payload } = change
    const parent = payload.parent < 0 ? created.get(key(change.taxonomy, payload.parent)) : payload.parent
    // The parent was created offline and has not reached the shop yet; retry on the next run.
    if (change.operation !== 'delete' && parent === undefined) continue
    const body = change.operation === 'delete' ? undefined : {
      name: payload.name, description: payload.description, ...(payload.slug ? { slug: payload.slug } : {}), ...(change.hierarchical ? { parent } : {}),
    }
    const route = change.operation === 'create' ? change.route : `${change.route}/${change.termRef}`
    const method = { create: 'POST', update: 'PUT', delete: 'DELETE' }[change.operation]
    try {
      let term = null
      try {
        const { data } = await wooRequest(connection, route, change.operation === 'delete' ? { force: 'true' } : {}, fetcher, { method, body, maxBytes: 1024 * 1024 })
        if (change.operation !== 'delete') {
          const parsed = termSchema.safeParse(data)
          if (!parsed.success) throw new WooError('Die Antwort des Shops war unklar. Bitte Taxonomien neu importieren.')
          term = toTerm(parsed.data, change.hierarchical)
        }
      } catch (error) {
        // Already gone in the shop: the delete has reached its goal.
        if (!(change.operation === 'delete' && error instanceof WooError && error.status === 404)) throw error
      }
      await database('completeTaxonomyChange', { changeId: change.id, revision: change.revision, term })
      if (term && change.termRef < 0) created.set(key(change.taxonomy, change.termRef), term.id)
      result.synced++
    } catch (error) {
      if (error instanceof WooError && error.offline) { result.offline = true; break }
      const message = error instanceof WooError ? error.message
        : 'Aenderung konnte nicht uebertragen werden.'
      await database('failTaxonomyChange', { changeId: change.id, revision: change.revision, error: change.operation === 'update' && error.status === 404 ? 'Der Begriff existiert im Shop nicht mehr.' : message })
      result.failed++
      // Missing write permission affects every change; stop instead of failing them one by one.
      if (error instanceof WooError && (error.status === 401 || error.status === 403)) break
    }
  }
  return { ...result, ...(await database('taxonomyChangeCounts', { shopUrl })) }
}

module.exports = { syncTaxonomyChanges }
