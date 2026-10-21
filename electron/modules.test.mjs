import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import databaseModule from './database.cjs'
import modules from './modules/index.cjs'

const shopUrl = 'https://shop.example/'
const directories = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it('detects Germanized by its taxonomies and provides labels and field meanings', () => {
  expect(modules.detectModules({ namespaces: [], taxonomies: ['product_cat', 'product_tag'], productFields: [] })).toEqual([])
  const detected = modules.detectModules({ namespaces: [], taxonomies: ['product_cat', 'product_price_label'], productFields: [] })
  expect(detected).toEqual(['germanized'])
  expect(modules.taxonomyLabel(detected, 'product_price_label')).toBe('Preishinweise')
  expect(modules.taxonomyLabel([], 'product_price_label')).toBeNull()
  expect(modules.termField(detected, 'sale_price_regular_label')).toMatchObject({ taxonomy: 'product_price_label', label: 'Preishinweis regulaer', section: 'Germanized' })
  expect(modules.metaFields(detected)).toEqual([expect.objectContaining({ field: 'meta:_mini_desc', label: 'Warenkorbkurzbeschreibung', type: 'html', section: 'Germanized', scopes: ['product', 'variation'] })])
  expect(modules.hiddenByModules(detected, ['germanized']).fields.has('meta:_mini_desc')).toBe(true)
  expect(modules.describeModules(detected)).toEqual([expect.objectContaining({ id: 'germanized', detected: true, active: true }), expect.objectContaining({ id: 'yoast-seo', detected: false, active: false })])
})

it('uses active modules for editor fields and keeps the generic behaviour without them', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'catalogdesk-v2-modules-'))
  directories.push(directory)
  const database = databaseModule.openDatabase(path.join(directory, 'catalogdesk-v2.sqlite'))
  const term = (id, name) => ({ id, name, slug: name.toLowerCase(), parentId: 0, count: 0, menuOrder: 0, payload: {} })
  const importWith = (detected) => database.replaceTaxonomies({ shopUrl, importedAt: new Date().toISOString(), modules: detected,
    taxonomies: [
      { taxonomy: 'product_cat', kind: 'core', label: 'Kategorien', route: 'wc/v3/products/categories', hierarchical: true, available: true, attribute: null, terms: [term(4, 'Kleidung')] },
      { taxonomy: 'product_price_label', kind: 'custom', label: 'Preishinweise', route: 'wc/v3/products/price_labels', hierarchical: false, available: true, attribute: null, terms: [term(80, 'UVP')] },
    ],
    productFields: [
      { scope: 'product', field: 'categories', multiple: true },
      { scope: 'product', field: 'sale_price_label', multiple: false },
      { scope: 'product', field: 'sale_price_regular_label', multiple: false },
    ] })
  try {
    database.replaceCatalog({ shopUrl, importedAt: new Date().toISOString(), products: [{ id: 1, parentId: null, type: 'simple', sku: 'A', name: 'A', status: 'publish', payload: {}, terms: [] }] })
    const fields = () => database.productEditorOptions({ shopUrl }).termFields.map((field) => [field.field, field.taxonomy, field.label, field.section])
    importWith(['germanized'])
    expect(fields()).toEqual([
      ['categories', 'product_cat', 'Kategorien', null],
      ['sale_price_label', 'product_price_label', 'Preishinweis Angebot', 'Germanized'],
      ['sale_price_regular_label', 'product_price_label', 'Preishinweis regulaer', 'Germanized'],
    ])
    expect(database.listModules({ shopUrl }).modules.find((entry) => entry.id === 'germanized')).toMatchObject({ active: true, detectedAt: expect.any(String) })
    // Without the module the generic naming rule still finds the taxonomy, with neutral labels.
    importWith([])
    expect(fields()).toEqual([
      ['categories', 'product_cat', 'Kategorien', null],
      ['sale_price_label', 'product_price_label', 'Preishinweise (sale_price_label)', null],
      ['sale_price_regular_label', 'product_price_label', 'Preishinweise (sale_price_regular_label)', null],
    ])
    expect(database.listModules({ shopUrl }).modules.find((entry) => entry.id === 'germanized')).toMatchObject({ detected: false, active: false, detectedAt: null })
  } finally { database.close() }
})

it('detects modules for shops imported before modules existed', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'catalogdesk-v2-modules-backfill-'))
  directories.push(directory)
  const filename = path.join(directory, 'catalogdesk-v2.sqlite')
  let database = databaseModule.openDatabase(filename)
  database.replaceTaxonomies({ shopUrl, importedAt: new Date().toISOString(), taxonomies: [
    { taxonomy: 'product_delivery_time', kind: 'custom', label: 'Delivery time', route: 'wc/v3/products/delivery_times', hierarchical: false, available: true, attribute: null, terms: [] },
  ] })
  database.close()
  const raw = new DatabaseSync(filename)
  raw.exec('DELETE FROM shop_modules; PRAGMA user_version = 12;')
  raw.close()
  database = databaseModule.openDatabase(filename)
  try { expect(database.listModules({ shopUrl }).modules.find((entry) => entry.id === 'germanized')).toMatchObject({ active: true }) }
  finally { database.close() }
})

it('hides what a switched-off module owns without a new import and keeps the data', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'catalogdesk-v2-modules-toggle-'))
  directories.push(directory)
  const database = databaseModule.openDatabase(path.join(directory, 'catalogdesk-v2.sqlite'))
  const term = (id, name) => ({ id, name, slug: name.toLowerCase(), parentId: 0, count: 0, menuOrder: 0, payload: {} })
  const importNow = (detected) => database.replaceTaxonomies({ shopUrl, importedAt: new Date().toISOString(), modules: detected,
    taxonomies: [
      { taxonomy: 'product_unit', kind: 'custom', label: 'Unit', labelSource: 'generated', route: 'wc/v3/products/units', hierarchical: false, available: true, attribute: null, terms: [term(60, 'kg')] },
      { taxonomy: 'product_season', kind: 'custom', label: 'Saison', labelSource: 'wordpress', route: 'wc/v3/products/seasons', hierarchical: false, available: true, attribute: null, terms: [term(70, 'Sommer')] },
    ],
    productFields: [{ scope: 'product', field: 'unit', multiple: false }, { scope: 'product', field: 'season', multiple: false }] })
  const labels = () => database.taxonomyOverview({ shopUrl }).taxonomies.map((entry) => entry.label)
  const fields = () => database.productEditorOptions({ shopUrl }).termFields.map((field) => [field.label, field.section]).sort((a, b) => a[0].localeCompare(b[0]))
  try {
    importNow(['germanized'])
    database.replaceCatalog({ shopUrl, importedAt: new Date().toISOString(), products: [{ id: 1, parentId: null, type: 'simple', sku: 'A', name: 'A', status: 'publish', payload: {},
      terms: [{ field: 'unit', id: 60, name: 'kg', slug: 'kg' }, { field: 'season', id: 70, name: 'Sommer', slug: 'sommer' }] }] })
    expect(labels()).toEqual(['Einheiten', 'Saison'])
    expect(fields()).toEqual([['Einheit', 'Germanized'], ['Saison', null]])

    expect(database.setModuleEnabled({ shopUrl, moduleId: 'germanized', enabled: false })).toMatchObject({ detected: true, enabled: false, active: false })
    // Everything Germanized owns is hidden; plugin data no module owns stays visible.
    expect(labels()).toEqual(['Saison'])
    expect(fields()).toEqual([['Saison', null]])
    expect(database.listTaxonomyTerms({ shopUrl, taxonomy: 'product_unit' }).total).toBe(0)
    expect(database.listProducts().products[0].terms.map((entry) => entry.name)).toEqual(['Sommer'])
    expect(() => database.queueTaxonomyChange({ shopUrl, taxonomy: 'product_unit', operation: 'create', fields: { name: 'g', slug: '', parent: 0, description: '' } })).toThrow('Plugin-Modul ist ausgeschaltet')
    expect(() => database.queueProductChange({ shopUrl, productId: 1, values: {}, terms: { unit: 60 } })).toThrow('kann nicht bearbeitet werden')
    // The choice survives a new import, and the data is back when the module is switched on.
    importNow(['germanized'])
    expect(labels()).toEqual(['Saison'])
    database.setModuleEnabled({ shopUrl, moduleId: 'germanized', enabled: true })
    expect(labels()).toEqual(['Einheiten', 'Saison'])
    expect(database.listTaxonomyTerms({ shopUrl, taxonomy: 'product_unit' }).total).toBe(1)
    importNow([])
    expect(() => database.setModuleEnabled({ shopUrl, moduleId: 'germanized', enabled: true })).toThrow('nicht erkannt')
  } finally { database.close() }
})
