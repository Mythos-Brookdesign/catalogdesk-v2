// Plugin modules: declarative knowledge about WordPress plugins (names, field meanings, editor
// sections). The core stays generic and works without any module; modules only add meaning.
// Modules ship with the app and are never loaded from outside.
const registry = [require('./germanized.cjs'), require('./yoast-seo.cjs')]

const moduleIds = registry.map((module) => module.id)

// Whether the customer may use a module. Licensing (booked modules) hooks in here; until it exists,
// every module is licensed. Whether a licensed module is switched on is a per-shop user setting.
function isLicensed() {
  return true
}

// context: { namespaces: string[], taxonomies: string[], productFields: { scope, field }[], plugins?: { active: string[], inactive: string[] } | null }
// `plugins` (plugin folders from the shop's system status) is authoritative when known: only an active plugin
// counts, even if taxonomies of an earlier import are still stored. Without it, modules recognise their plugin
// by REST namespaces and taxonomies.
function detectModules(context) {
  return registry.filter((module) => {
    if (context.plugins && module.plugin) return context.plugins.active.includes(module.plugin)
    try { return module.detect(context) } catch { return false }
  }).map((module) => module.id)
}

// Modules whose plugin is installed in the shop but deactivated.
function inactiveModules(context) {
  if (!context.plugins) return []
  return registry.filter((module) => module.plugin && context.plugins.inactive.includes(module.plugin) && !context.plugins.active.includes(module.plugin)).map((module) => module.id)
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

// `switchedOff`: ids the user turned off for this shop; `inactive`: plugin installed but deactivated in the shop.
function describeModules(detected, switchedOff = [], inactive = []) {
  return registry.map((module) => {
    const licensed = isLicensed(module.id)
    const enabled = !switchedOff.includes(module.id)
    return { id: module.id, name: module.name, description: module.description, detected: detected.includes(module.id), inactive: !detected.includes(module.id) && inactive.includes(module.id), licensed, enabled, active: detected.includes(module.id) && licensed && enabled }
  })
}

// A module owns its taxonomies and term fields. While a detected module is switched off or not licensed,
// or its plugin is deactivated in the shop, everything it owns is hidden (the data stays stored).
// Plugin data no module owns is always shown.
function hiddenByModules(detected, switchedOff = [], inactive = []) {
  const taxonomies = new Set()
  const fields = new Set()
  for (const module of registry) {
    const deactivated = inactive.includes(module.id) && !detected.includes(module.id)
    if (!deactivated && (!detected.includes(module.id) || (isLicensed(module.id) && !switchedOff.includes(module.id)))) continue
    for (const taxonomy of Object.keys(module.taxonomyLabels ?? {})) taxonomies.add(taxonomy)
    for (const field of Object.keys(module.termFields ?? {})) fields.add(field)
    for (const field of module.metaFields ?? []) {
      fields.add(`meta:${field.meta}`)
      if (field.idMeta) fields.add(`meta:${field.idMeta}`)
    }
  }
  return { taxonomies, fields }
}

// Product meta fields (meta_data entries) of active modules, as editable product fields `meta:<key>`.
// An image field stores the URL and, in `idMeta`, the media ID (plugins like Yoast prefer the ID): it becomes
// the visible image field plus a hidden `mediaId` field that is always edited together with it.
function metaFields(active) {
  return activeModules(active).flatMap((module) => (module.metaFields ?? []).flatMap((field) => {
    const shared = { section: module.editorSection ?? module.name, module: module.id, scopes: field.scopes ?? ['product'] }
    const visible = { ...field, ...shared, field: `meta:${field.meta}`, ...(field.idMeta ? { idField: `meta:${field.idMeta}` } : {}) }
    if (!field.idMeta) return [visible]
    return [visible, { meta: field.idMeta, label: `${field.label} (Medien-ID)`, type: 'mediaId', hidden: true, imageField: visible.field, field: visible.idField, ...shared, group: field.group }]
  }))
}

function previews(active) {
  return activeModules(active).filter((module) => module.preview).map((module) => ({
    ...module.preview, module: module.id, section: module.editorSection ?? module.name,
    title: module.preview.title ? `meta:${module.preview.title}` : null, description: module.preview.description ? `meta:${module.preview.description}` : null,
  }))
}

module.exports = { moduleIds, detectModules, inactiveModules, activeModules, taxonomyLabel, termField, describeModules, hiddenByModules, metaFields, previews }
