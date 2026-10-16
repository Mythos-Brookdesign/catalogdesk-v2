// Plugin modules: declarative knowledge about WordPress plugins (names, field meanings, editor
// sections). The core stays generic and works without any module; modules only add meaning.
// Modules ship with the app and are never loaded from outside.
const registry = [require('./germanized.cjs')]

const moduleIds = registry.map((module) => module.id)

// Whether the customer may use a module. Licensing (booked modules) hooks in here; until it exists,
// every module is licensed. Whether a licensed module is switched on is a per-shop user setting.
function isLicensed() {
  return true
}

// context: { namespaces: string[], taxonomies: string[], productFields: { scope, field }[] }
function detectModules(context) {
  return registry.filter((module) => {
    try { return module.detect(context) } catch { return false }
  }).map((module) => module.id)
}

// `active`: ids of modules that are detected, licensed and switched on (see database `activeModules`).
function activeModules(active) {
  return registry.filter((module) => active.includes(module.id) && isLicensed(module.id))
}

function taxonomyLabel(detected, taxonomy) {
  for (const module of activeModules(detected)) if (module.taxonomyLabels?.[taxonomy]) return module.taxonomyLabels[taxonomy]
  return null
}

function termField(detected, field) {
  for (const module of activeModules(detected)) {
    const definition = module.termFields?.[field]
    if (definition) return { ...definition, section: module.editorSection ?? module.name, module: module.id }
  }
  return null
}

// `switchedOff`: ids the user turned off for this shop.
function describeModules(detected, switchedOff = []) {
  return registry.map((module) => {
    const licensed = isLicensed(module.id)
    const enabled = !switchedOff.includes(module.id)
    return { id: module.id, name: module.name, description: module.description, detected: detected.includes(module.id), licensed, enabled, active: detected.includes(module.id) && licensed && enabled }
  })
}

// A module owns its taxonomies and term fields. While a detected module is switched off or not licensed,
// everything it owns is hidden (the data stays stored). Plugin data no module owns is always shown.
function hiddenByModules(detected, switchedOff = []) {
  const taxonomies = new Set()
  const fields = new Set()
  for (const module of registry) {
    if (!detected.includes(module.id) || (isLicensed(module.id) && !switchedOff.includes(module.id))) continue
    for (const taxonomy of Object.keys(module.taxonomyLabels ?? {})) taxonomies.add(taxonomy)
    for (const field of Object.keys(module.termFields ?? {})) fields.add(field)
  }
  return { taxonomies, fields }
}

module.exports = { moduleIds, detectModules, activeModules, taxonomyLabel, termField, describeModules, hiddenByModules }
