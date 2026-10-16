const { z } = require('zod')

// Editable WooCommerce product fields shared by validation, conflict checks, sync and history.
const decimal = z.string().trim().transform((value) => value.replace(',', '.')).pipe(z.string().regex(/^(\d{1,12}(\.\d{1,6})?)?$/, 'Bitte eine Zahl eingeben.'))
const scalarFields = {
  name: { label: 'Name', variation: false, schema: z.string().trim().min(1, 'Der Name darf nicht leer sein.').max(1000) },
  sku: { label: 'Artikelnummer', variation: true, schema: z.string().trim().max(100) },
  status: { label: 'Status', variation: true, schema: z.enum(['publish', 'draft', 'pending', 'private']) },
  short_description: { label: 'Kurzbeschreibung', variation: false, schema: z.string().max(100_000) },
  description: { label: 'Beschreibung', variation: true, schema: z.string().max(500_000) },
  regular_price: { label: 'Regulaerer Preis', variation: true, schema: decimal },
  sale_price: { label: 'Angebotspreis', variation: true, schema: decimal },
  manage_stock: { label: 'Lager verwalten', variation: true, schema: z.boolean() },
  stock_quantity: { label: 'Bestand', variation: true, schema: z.number().int().min(-1_000_000_000).max(1_000_000_000).nullable() },
  stock_status: { label: 'Lagerstatus', variation: true, schema: z.enum(['instock', 'outofstock', 'onbackorder']) },
  weight: { label: 'Gewicht', variation: true, schema: decimal },
  dimensions: { label: 'Masse (L x B x H)', variation: true, schema: z.object({ length: decimal, width: decimal, height: decimal }).strict() },
  shipping_class: { label: 'Versandklasse', variation: true, schema: z.string().max(200) },
}
const variationStatuses = new Set(['publish', 'private'])
const termFieldName = /^[a-z0-9_]{1,80}$/

// Plugin data stored as product meta is addressed as `meta:<key>` (declared by plugin modules).
const metaPrefix = 'meta:'
const isMetaField = (field) => field.startsWith(metaPrefix)

// Value of a field in a WooCommerce product object, including meta fields from `meta_data`.
function fieldValue(item, field) {
  if (!item || typeof item !== 'object') return null
  if (!isMetaField(field)) return item[field] ?? null
  if (field in item) return item[field]
  const entry = (Array.isArray(item.meta_data) ? item.meta_data : []).find((meta) => meta?.key === field.slice(metaPrefix.length))
  return entry ? entry.value ?? null : null
}

const isTermList = (value) => Array.isArray(value) && value.every((entry) => entry && typeof entry === 'object' && 'id' in entry)
const isTerm = (value) => value && typeof value === 'object' && !Array.isArray(value) && 'id' in value

// Canonical form for comparisons: shop and app format numbers, empty values and term objects differently.
function normalize(value) {
  if (value === null || value === undefined || value === '') return ''
  // Negative IDs are terms created offline and count like real ones; 0 means "no term".
  if (isTermList(value)) return value.map((entry) => Number(entry.id)).filter((id) => Number.isFinite(id) && id !== 0).sort((a, b) => a - b).join(',')
  if (isTerm(value)) return Number(value.id) ? String(Number(value.id)) : ''
  if (typeof value === 'object') return Object.keys(value).sort().map((key) => `${key}=${normalize(value[key])}`).join(';')
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const text = String(value).trim()
  return /^-?\d+(\.\d+)?$/.test(text) ? String(Number(text)) : text
}
const same = (a, b) => normalize(a) === normalize(b)

// Request body for WooCommerce: terms are sent by ID only.
// Meta fields are collected into `meta_data`, which WooCommerce updates by key (other meta stays as it is).
function toRequestBody(changes) {
  const meta = []
  const body = Object.fromEntries(Object.entries(changes).flatMap(([field, value]) => {
    if (isMetaField(field)) { meta.push({ key: field.slice(metaPrefix.length), value: value ?? '' }); return [] }
    if (isTermList(value)) return [[field, value.map((entry) => ({ id: entry.id }))]]
    if (isTerm(value)) return [[field, { id: value.id }]]
    return [[field, value]]
  }))
  return meta.length ? { ...body, meta_data: meta } : body
}

// Readable values for the history and conflict views.
function display(field, value) {
  if (value === null || value === undefined || value === '') return null
  if (isTermList(value)) return value.map((entry) => entry.name ?? `#${entry.id}`).join(', ') || null
  if (isTerm(value)) return Number(value.id) > 0 ? value.name ?? `#${value.id}` : null
  if (field === 'dimensions') return ['length', 'width', 'height'].map((key) => value[key] || '–').join(' x ')
  if (field === 'manage_stock') return value ? 'Ja' : 'Nein'
  if (field === 'status') return { publish: 'Veroeffentlicht', draft: 'Entwurf', pending: 'Ausstehend', private: 'Privat' }[value] ?? value
  if (field === 'stock_status') return { instock: 'Vorraetig', outofstock: 'Nicht vorraetig', onbackorder: 'Lieferrueckstand' }[value] ?? value
  if (field === 'description' || field === 'short_description') {
    const text = String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    return text.length > 160 ? `${text.slice(0, 157)}...` : text
  }
  return String(value)
}

module.exports = { scalarFields, variationStatuses, termFieldName, metaPrefix, isMetaField, fieldValue, isTerm, isTermList, normalize, same, toRequestBody, display }
