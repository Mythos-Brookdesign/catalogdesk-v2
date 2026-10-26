const { DatabaseSync } = require('node:sqlite')
const { mkdirSync } = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { z } = require('zod')
const { scalarFields, variationStatuses, termFieldName, isMetaField, fieldValue, isImage, isTerm, isTermList, same } = require('./product-fields.cjs')
const modules = require('./modules/index.cjs')
const { humanize } = require('./taxonomies.cjs')
const { findDuplicate } = require('./term-names.cjs')

const shopUrlSchema = z.string().url().max(2048).refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
})
const searchSchema = z.object({
  shopUrl: shopUrlSchema.optional(),
  query: z.string().trim().max(200).default(''),
  type: z.string().regex(/^[a-z0-9_-]{1,40}$/).default('all'),
  page: z.number().int().min(0).max(1_000_000).default(0),
  pageSize: z.number().int().min(1).max(100).default(50),
}).strict()
const productTermSchema = z.union([
  z.object({ field: z.string().max(80), id: z.number().int().positive(), name: z.string().max(1000), slug: z.string().max(1000) }).strict(),
  z.object({ field: z.literal('attribute'), attributeId: z.number().int().positive(), option: z.string().max(1000) }).strict(),
])
const catalogSchema = z.object({
  shopUrl: shopUrlSchema,
  importedAt: z.string().datetime(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  products: z.array(z.object({
    id: z.number().int().positive(),
    parentId: z.number().int().positive().nullable(),
    type: z.enum(['simple', 'variable', 'variation']),
    productType: z.string().regex(/^[a-z0-9_-]{1,80}$/).optional(),
    sku: z.string().max(1000),
    name: z.string().max(1000),
    status: z.string().max(80),
    payload: z.record(z.string(), z.unknown()),
    terms: z.array(productTermSchema).max(5000).default([]),
  }).strict()).min(1).max(100_000),
}).strict()
// Product fields that name their taxonomy; all other term fields are resolved by term ID.
const coreTermFields = { categories: 'product_cat', tags: 'product_tag', brands: 'product_brand', shipping_class: 'product_shipping_class' }
const taxonomyImportSchema = z.object({
  shopUrl: shopUrlSchema,
  importedAt: z.string().datetime(),
  taxonomies: z.array(z.object({
    taxonomy: z.string().min(1).max(200),
    kind: z.enum(['core', 'custom', 'attribute']),
    label: z.string().max(1000),
    labelSource: z.enum(['core', 'wordpress', 'generated']).default('wordpress'),
    route: z.string().max(500),
    hierarchical: z.boolean(),
    available: z.boolean(),
    attribute: z.object({ id: z.number().int().positive(), type: z.string().max(80), orderBy: z.string().max(80), hasArchives: z.boolean() }).strict().nullable(),
    terms: z.array(z.object({
      id: z.number().int().positive(),
      name: z.string().max(1000),
      slug: z.string().max(1000),
      parentId: z.number().int().nonnegative(),
      count: z.number().int().nonnegative(),
      menuOrder: z.number().int(),
      payload: z.record(z.string(), z.unknown()),
    }).strict()).max(50_000),
  }).strict()).min(1).max(1000),
  productFields: z.array(z.object({ scope: z.enum(['product', 'variation']), field: z.string().regex(/^[a-z0-9_]{1,80}$/), multiple: z.boolean() }).strict()).max(500).default([]),
  modules: z.array(z.enum(modules.moduleIds)).max(100).default([]),
  inactiveModules: z.array(z.enum(modules.moduleIds)).max(100).default([]),
}).strict()
const taxonomyTermsQuerySchema = z.object({
  shopUrl: shopUrlSchema.optional(),
  taxonomy: z.string().min(1).max(200),
  query: z.string().trim().max(200).default(''),
  page: z.number().int().min(0).max(1_000_000).default(0),
  pageSize: z.number().int().min(1).max(200).default(100),
}).strict()
const termFieldsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().max(200).default(''),
  parent: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).default(0),
  description: z.string().max(10_000).default(''),
}).strict()
const termChangeSchema = z.object({
  shopUrl: shopUrlSchema,
  taxonomy: z.string().min(1).max(200),
  operation: z.enum(['create', 'update', 'delete']),
  termId: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  fields: termFieldsSchema.optional(),
}).strict()
const termRefSchema = z.object({ shopUrl: shopUrlSchema, taxonomy: z.string().min(1).max(200), termId: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }).strict()
const syncedTermSchema = z.object({
  id: z.number().int().positive(), name: z.string().max(1000), slug: z.string().max(1000),
  parentId: z.number().int().nonnegative(), count: z.number().int().nonnegative(), menuOrder: z.number().int(), payload: z.record(z.string(), z.unknown()),
}).strict()
const auditCategories = ['auth', 'users', 'settings', 'shop', 'taxonomies', 'sync', 'catalog']
const auditEntrySchema = z.object({
  category: z.enum(auditCategories),
  action: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/).max(80),
  summary: z.string().min(1).max(500),
  outcome: z.enum(['success', 'failure']).default('success'),
  source: z.enum(['user', 'system']).default('user'),
  userId: z.string().uuid().nullable().default(null),
  username: z.string().max(64).nullable().default(null),
  userName: z.string().max(200).nullable().default(null),
  targetType: z.string().max(80).nullable().default(null),
  targetId: z.string().max(200).nullable().default(null),
  targetLabel: z.string().max(500).nullable().default(null),
  shopUrl: z.string().max(2048).nullable().default(null),
  details: z.record(z.string(), z.unknown()).nullable().default(null),
}).strict()
const auditQuerySchema = z.object({
  query: z.string().trim().max(200).default(''),
  category: z.enum(auditCategories).optional(),
  userId: z.string().max(64).optional(),
  outcome: z.enum(['success', 'failure']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.number().int().min(0).max(1_000_000).default(0),
  pageSize: z.number().int().min(1).max(200).default(100),
}).strict()
const mediaItemSchema = z.object({
  mediaId: z.number().int().positive(),
  title: z.string().max(1000), alt: z.string().max(1000), caption: z.string().max(10_000), description: z.string().max(50_000),
  filename: z.string().max(500), mime: z.string().max(100),
  width: z.number().int().nonnegative().nullable(), height: z.number().int().nonnegative().nullable(), filesize: z.number().int().nonnegative().nullable(),
  sourceUrl: z.string().url().max(2048), thumbUrl: z.string().url().max(2048),
  uploadedAt: z.string().max(40).nullable(), modifiedAt: z.string().max(40).nullable(), editable: z.boolean(),
}).strict()
// Images a product shows (WooCommerce format: images[] and a variation's image) as provisional media library
// entries: known before the media library is read from WordPress, replaced by the full data when it is.
function productImageItems(payload) {
  const images = [...(Array.isArray(payload?.images) ? payload.images : []), ...(payload?.image && typeof payload.image === 'object' ? [payload.image] : [])]
  return images.flatMap((image) => {
    const id = Number(image?.id)
    const src = typeof image?.src === 'string' ? image.src : ''
    if (!Number.isSafeInteger(id) || id <= 0 || !/^https?:\/\//.test(src) || src.length > 2048) return []
    const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '')
    const thumb = typeof image.thumbnail === 'string' && /^https?:\/\//.test(image.thumbnail) && image.thumbnail.length <= 2048 ? image.thumbnail : src
    let filename = ''
    try { filename = decodeURIComponent(new URL(src).pathname.split('/').pop() ?? '').slice(0, 500) } catch { /* keep empty */ }
    return [{ mediaId: id, title: text(image.name, 1000), alt: text(image.alt, 1000), filename, sourceUrl: src, thumbUrl: thumb, uploadedAt: text(image.date_created_gmt, 40) || null }]
  })
}
const insertProductImage = (database) => database.prepare(`INSERT INTO media_items (shop_url, media_id, title, alt, filename, source_url, thumb_url, uploaded_at, editable)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(shop_url, media_id) DO NOTHING`)

// Editable texts of a media item; the key is the media library field (alt = alt_text).
const mediaFields = { title: 'Titel', alt: 'Alt-Text', caption: 'Beschriftung', description: 'Beschreibung' }
const mediaValuesSchema = z.object({
  title: z.string().trim().max(1000), alt: z.string().trim().max(1000), caption: z.string().trim().max(10_000), description: z.string().trim().max(50_000),
}).partial().strict()
const productChangeSchema = z.object({
  shopUrl: shopUrlSchema,
  productId: z.number().int().positive(),
  values: z.record(z.string(), z.unknown()).default({}),
  // Negative IDs are terms created locally that wait for the shop.
  terms: z.record(z.string().regex(termFieldName), z.union([z.array(z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).refine((id) => id !== 0)).max(1000), z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)])).default({}),
}).strict()
const productRefSchema = z.object({ shopUrl: shopUrlSchema, productId: z.number().int().positive() }).strict()
const catalogProductSchema = catalogSchema.shape.products.element
const usernameSchema = z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9._-]+$/)
const newAdminSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  username: usernameSchema,
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  passwordHash: z.string().regex(/^[a-f0-9]{128}$/),
}).strict()
const menuPermissions = z.array(z.enum(['dashboard', 'products', 'orders', 'customers', 'settings', 'users', 'shop', 'taxonomies', 'sync', 'history', 'plugins', 'media'])).max(12)
const managedUserSchema = newAdminSchema.omit({ salt: true, passwordHash: true }).extend({
  id: z.string().uuid().optional(),
  role: z.enum(['admin', 'employee']),
  permissions: menuPermissions,
  salt: newAdminSchema.shape.salt.optional(),
  passwordHash: newAdminSchema.shape.passwordHash.optional(),
}).strict()

function openDatabase(filename) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(filename)
  try {
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    database.exec('BEGIN IMMEDIATE')
    const version = database.prepare('PRAGMA user_version').get().user_version
    if (version > 20) throw new Error('Database schema is newer than this app.')
    if (version < 1) {
      database.exec(`
        CREATE TABLE shops (
          shop_url TEXT PRIMARY KEY,
          imported_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE products (
          shop_url TEXT NOT NULL REFERENCES shops(shop_url) ON DELETE CASCADE,
          product_id INTEGER NOT NULL CHECK(product_id > 0),
          parent_id INTEGER CHECK(parent_id IS NULL OR parent_id > 0),
          type TEXT NOT NULL CHECK(type IN ('simple', 'variable', 'variation')),
          sku TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          sync_state TEXT NOT NULL DEFAULT 'clean' CHECK(sync_state IN ('clean', 'draft', 'conflict')),
          payload TEXT NOT NULL CHECK(json_valid(payload)),
          PRIMARY KEY(shop_url, product_id)
        ) STRICT;
        CREATE INDEX products_parent ON products(shop_url, parent_id);
        CREATE INDEX products_sku ON products(shop_url, sku);
        CREATE INDEX products_name ON products(shop_url, name);
        CREATE TABLE taxonomy_terms (
          shop_url TEXT NOT NULL REFERENCES shops(shop_url) ON DELETE CASCADE,
          taxonomy TEXT NOT NULL,
          term_id INTEGER NOT NULL CHECK(term_id > 0),
          name TEXT NOT NULL,
          slug TEXT NOT NULL,
          payload TEXT NOT NULL CHECK(json_valid(payload)),
          PRIMARY KEY(shop_url, taxonomy, term_id)
        ) STRICT;
        CREATE TABLE product_taxonomies (
          shop_url TEXT NOT NULL,
          product_id INTEGER NOT NULL,
          taxonomy TEXT NOT NULL,
          term_id INTEGER NOT NULL,
          PRIMARY KEY(shop_url, product_id, taxonomy, term_id),
          FOREIGN KEY(shop_url, product_id) REFERENCES products(shop_url, product_id) ON DELETE CASCADE,
          FOREIGN KEY(shop_url, taxonomy, term_id) REFERENCES taxonomy_terms(shop_url, taxonomy, term_id)
        ) STRICT;
        CREATE TABLE product_attributes (
          shop_url TEXT NOT NULL,
          product_id INTEGER NOT NULL,
          attribute_position INTEGER NOT NULL,
          attribute_id INTEGER,
          name TEXT NOT NULL,
          slug TEXT,
          variation INTEGER NOT NULL CHECK(variation IN (0, 1)),
          options TEXT NOT NULL CHECK(json_valid(options)),
          PRIMARY KEY(shop_url, product_id, attribute_position),
          FOREIGN KEY(shop_url, product_id) REFERENCES products(shop_url, product_id) ON DELETE CASCADE
        ) STRICT;
        PRAGMA user_version = 1;
      `)
    }
    if (version < 2) {
      database.exec(`CREATE TABLE users (
        id TEXT PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('admin', 'editor', 'reader')),
        password_salt TEXT NOT NULL CHECK(length(password_salt) = 32),
        password_hash TEXT NOT NULL CHECK(length(password_hash) = 128),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        created_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 2;`)
    }
    if (version < 3) {
      database.exec(`ALTER TABLE users RENAME TO users_old;
        CREATE TABLE users (
          id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
          email TEXT NOT NULL COLLATE NOCASE UNIQUE, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          role TEXT NOT NULL CHECK(role IN ('admin', 'employee')),
          password_salt TEXT NOT NULL CHECK(length(password_salt) = 32),
          password_hash TEXT NOT NULL CHECK(length(password_hash) = 128),
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)), created_at TEXT NOT NULL,
          permissions TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(permissions))
        ) STRICT;
        INSERT INTO users SELECT id, first_name, last_name, email, username,
          CASE WHEN role = 'admin' THEN 'admin' ELSE 'employee' END,
          password_salt, password_hash, active, created_at,
          CASE WHEN role = 'admin' THEN '[]' ELSE '["dashboard","products"]' END FROM users_old;
        DROP TABLE users_old; PRAGMA user_version = 3;`)
    }
    if (version < 4) {
      database.exec(`CREATE TABLE app_settings (
        key TEXT PRIMARY KEY CHECK(key = 'theme'),
        value TEXT NOT NULL CHECK(value IN ('light', 'dark'))
      ) STRICT;
      INSERT INTO app_settings VALUES ('theme', 'light');
      PRAGMA user_version = 4;`)
    }
    if (version < 5) {
      const columns = new Set(database.prepare('PRAGMA table_info(taxonomy_terms)').all().map((column) => column.name))
      for (const [column, definition] of [
        ['parent_id', 'INTEGER NOT NULL DEFAULT 0 CHECK(parent_id >= 0)'],
        ['product_count', 'INTEGER NOT NULL DEFAULT 0 CHECK(product_count >= 0)'],
        ['menu_order', 'INTEGER NOT NULL DEFAULT 0'],
      ]) if (!columns.has(column)) database.exec(`ALTER TABLE taxonomy_terms ADD COLUMN ${column} ${definition}`)
      database.exec(`CREATE INDEX IF NOT EXISTS taxonomy_terms_parent ON taxonomy_terms(shop_url, taxonomy, parent_id);
        CREATE TABLE IF NOT EXISTS taxonomies (
          shop_url TEXT NOT NULL REFERENCES shops(shop_url) ON DELETE CASCADE,
          taxonomy TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('category', 'tag', 'brand', 'shipping_class', 'attribute')),
          label TEXT NOT NULL,
          hierarchical INTEGER NOT NULL CHECK(hierarchical IN (0, 1)),
          available INTEGER NOT NULL CHECK(available IN (0, 1)),
          attribute TEXT CHECK(attribute IS NULL OR json_valid(attribute)),
          position INTEGER NOT NULL,
          imported_at TEXT NOT NULL,
          PRIMARY KEY(shop_url, taxonomy)
        ) STRICT;
        PRAGMA user_version = 5;`)
    }
    if (version < 6) {
      database.exec(`ALTER TABLE taxonomies RENAME TO taxonomies_v5;
        CREATE TABLE taxonomies (
          shop_url TEXT NOT NULL REFERENCES shops(shop_url) ON DELETE CASCADE,
          taxonomy TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('category', 'tag', 'brand', 'shipping_class', 'delivery_time', 'unit', 'manufacturer', 'price_label', 'attribute')),
          label TEXT NOT NULL,
          hierarchical INTEGER NOT NULL CHECK(hierarchical IN (0, 1)),
          available INTEGER NOT NULL CHECK(available IN (0, 1)),
          attribute TEXT CHECK(attribute IS NULL OR json_valid(attribute)),
          position INTEGER NOT NULL,
          imported_at TEXT NOT NULL,
          PRIMARY KEY(shop_url, taxonomy)
        ) STRICT;
        INSERT INTO taxonomies SELECT shop_url, taxonomy, kind, label, hierarchical, available, attribute, position, imported_at FROM taxonomies_v5;
        DROP TABLE taxonomies_v5;
        PRAGMA user_version = 6;`)
    }
    if (version < 7) {
      // Taxonomies are discovered from the shop, so kinds are generic and the REST route is kept for later syncs.
      database.exec(`ALTER TABLE taxonomies RENAME TO taxonomies_v6;
        CREATE TABLE taxonomies (
          shop_url TEXT NOT NULL REFERENCES shops(shop_url) ON DELETE CASCADE,
          taxonomy TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('core', 'custom', 'attribute')),
          label TEXT NOT NULL,
          route TEXT NOT NULL,
          hierarchical INTEGER NOT NULL CHECK(hierarchical IN (0, 1)),
          available INTEGER NOT NULL CHECK(available IN (0, 1)),
          attribute TEXT CHECK(attribute IS NULL OR json_valid(attribute)),
          position INTEGER NOT NULL,
          imported_at TEXT NOT NULL,
          PRIMARY KEY(shop_url, taxonomy)
        ) STRICT;
        INSERT INTO taxonomies SELECT shop_url, taxonomy,
          CASE WHEN kind = 'attribute' THEN 'attribute' WHEN kind IN ('category', 'tag', 'brand', 'shipping_class') THEN 'core' ELSE 'custom' END,
          label, '', hierarchical, available, attribute, position, imported_at FROM taxonomies_v6;
        DROP TABLE taxonomies_v6;
        PRAGMA user_version = 7;`)
    }
    if (version < 8) {
      // Outbox for term edits: one row per term, sent to WooCommerce immediately or after the connection returns.
      // term_ref is the WooCommerce term ID, or -id for terms created locally that the shop has not confirmed yet.
      database.exec(`CREATE TABLE IF NOT EXISTS taxonomy_changes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_url TEXT NOT NULL,
          taxonomy TEXT NOT NULL,
          term_ref INTEGER NOT NULL,
          operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'delete')),
          payload TEXT NOT NULL CHECK(json_valid(payload)),
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'failed')),
          error TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(shop_url, taxonomy, term_ref)
        ) STRICT;
        PRAGMA user_version = 8;`)
    }
    if (version < 9) {
      // Append-only usage history. Names are stored as snapshots so entries stay readable after users are deleted.
      database.exec(`CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          occurred_at TEXT NOT NULL,
          category TEXT NOT NULL,
          action TEXT NOT NULL,
          summary TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure')),
          source TEXT NOT NULL CHECK(source IN ('user', 'system')),
          user_id TEXT,
          username TEXT,
          user_name TEXT,
          target_type TEXT,
          target_id TEXT,
          target_label TEXT,
          shop_url TEXT,
          details TEXT CHECK(details IS NULL OR json_valid(details))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS audit_log_time ON audit_log(occurred_at);
        CREATE INDEX IF NOT EXISTS audit_log_category ON audit_log(category, occurred_at);
        CREATE INDEX IF NOT EXISTS audit_log_user ON audit_log(user_id, occurred_at);
        CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
        PRAGMA user_version = 9;`)
    }
    if (version < 10) {
      // `type` keeps the family role (simple/variable/variation); product_type is WooCommerce's own type
      // (grouped, external, bundles, subscriptions, ...).
      if (!database.prepare('PRAGMA table_info(products)').all().some((column) => column.name === 'product_type'))
        database.exec("ALTER TABLE products ADD COLUMN product_type TEXT NOT NULL DEFAULT 'simple'")
      if (!database.prepare('PRAGMA table_info(shops)').all().some((column) => column.name === 'currency'))
        database.exec('ALTER TABLE shops ADD COLUMN currency TEXT')
      database.exec(`UPDATE products SET product_type = type WHERE product_type = 'simple' AND type != 'simple';
        CREATE INDEX IF NOT EXISTS products_type ON products(shop_url, product_type);
        PRAGMA user_version = 10;`)
    }
    if (version < 11) {
      // Product edits: one row per product with the changed fields, the shop values they were based on
      // (for conflict detection) and, after a conflict, the shop's current values.
      database.exec(`CREATE TABLE IF NOT EXISTS product_changes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_url TEXT NOT NULL,
          product_id INTEGER NOT NULL,
          changes TEXT NOT NULL CHECK(json_valid(changes)),
          base TEXT NOT NULL CHECK(json_valid(base)),
          remote TEXT CHECK(remote IS NULL OR json_valid(remote)),
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'failed', 'conflict')),
          error TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(shop_url, product_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS product_term_fields (
          shop_url TEXT NOT NULL,
          scope TEXT NOT NULL CHECK(scope IN ('product', 'variation')),
          field TEXT NOT NULL,
          multiple INTEGER NOT NULL CHECK(multiple IN (0, 1)),
          PRIMARY KEY(shop_url, scope, field)
        ) STRICT;`)
      if (!database.prepare('PRAGMA table_info(product_taxonomies)').all().some((column) => column.name === 'field'))
        database.exec('ALTER TABLE product_taxonomies ADD COLUMN field TEXT')
      database.exec('PRAGMA user_version = 11;')
    }
    if (version < 12) {
      // Plugin modules detected per shop during the taxonomy import.
      database.exec(`CREATE TABLE IF NOT EXISTS shop_modules (
          shop_url TEXT NOT NULL,
          module_id TEXT NOT NULL,
          detected_at TEXT NOT NULL,
          PRIMARY KEY(shop_url, module_id)
        ) STRICT;
        PRAGMA user_version = 12;`)
    }
    if (version < 13) {
      // Shops imported before modules existed: detect modules from the stored taxonomies and fields,
      // so they do not need a new import. Namespace-based detection follows with the next import.
      const insertModule = database.prepare('INSERT OR IGNORE INTO shop_modules (shop_url, module_id, detected_at) VALUES (?, ?, ?)')
      for (const { shopUrl } of database.prepare('SELECT DISTINCT shop_url AS shopUrl FROM taxonomies').all()) {
        const detected = modules.detectModules({
          namespaces: [],
          taxonomies: database.prepare('SELECT taxonomy FROM taxonomies WHERE shop_url = ?').all(shopUrl).map((row) => row.taxonomy),
          productFields: database.prepare('SELECT scope, field FROM product_term_fields WHERE shop_url = ?').all(shopUrl),
        })
        for (const id of detected) insertModule.run(shopUrl, id, new Date().toISOString())
      }
      database.exec('PRAGMA user_version = 13;')
    }
    if (version < 14) {
      // Modules can be switched off per shop. Taxonomy labels keep their module-free form (base_label)
      // and source, so module labels can be applied and removed without a new import.
      database.exec(`CREATE TABLE IF NOT EXISTS module_settings (
          shop_url TEXT NOT NULL,
          module_id TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(shop_url, module_id)
        ) STRICT;`)
      const columns = new Set(database.prepare('PRAGMA table_info(taxonomies)').all().map((column) => column.name))
      if (!columns.has('base_label')) database.exec('ALTER TABLE taxonomies ADD COLUMN base_label TEXT')
      if (!columns.has('label_source')) database.exec("ALTER TABLE taxonomies ADD COLUMN label_source TEXT NOT NULL DEFAULT 'wordpress'")
      // Existing labels set by a module were generated names underneath.
      const update = database.prepare('UPDATE taxonomies SET base_label = ?, label_source = ? WHERE shop_url = ? AND taxonomy = ?')
      for (const row of database.prepare('SELECT shop_url AS shopUrl, taxonomy, kind, label FROM taxonomies WHERE base_label IS NULL').all()) {
        const moduleLabel = modules.taxonomyLabel(modules.moduleIds, row.taxonomy)
        if (row.kind === 'core') update.run(row.label, 'core', row.shopUrl, row.taxonomy)
        else if (moduleLabel === row.label || row.label === humanize(row.taxonomy)) update.run(humanize(row.taxonomy), 'generated', row.shopUrl, row.taxonomy)
        else update.run(row.label, 'wordpress', row.shopUrl, row.taxonomy)
      }
      database.exec('PRAGMA user_version = 14;')
    }
    if (version < 15) {
      // Plugins installed in the shop but deactivated (from the shop's plugin list), per shop.
      database.exec(`CREATE TABLE IF NOT EXISTS shop_inactive_modules (
          shop_url TEXT NOT NULL,
          module_id TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          PRIMARY KEY(shop_url, module_id)
        ) STRICT;
        PRAGMA user_version = 15;`)
    }
    if (version < 16) {
      // Images picked from the computer, kept locally until the shop has them (offline-capable like all edits).
      // Product edits reference them as -id until the upload is done.
      database.exec(`CREATE TABLE IF NOT EXISTS media_uploads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_url TEXT NOT NULL,
          file TEXT NOT NULL,
          filename TEXT NOT NULL,
          mime TEXT NOT NULL,
          size INTEGER NOT NULL,
          thumbnail TEXT,
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'failed', 'done')),
          media_id INTEGER,
          source_url TEXT,
          error TEXT,
          created_at TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 16;`)
    }
    if (version < 17) {
      // Local copy of the WordPress media library (images), its queued edits and the sync position.
      // `editable` marks items read with an application password (raw texts, not rendered HTML).
      database.exec(`CREATE TABLE IF NOT EXISTS media_items (
          shop_url TEXT NOT NULL,
          media_id INTEGER NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          alt TEXT NOT NULL DEFAULT '',
          caption TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          filename TEXT NOT NULL DEFAULT '',
          mime TEXT NOT NULL DEFAULT '',
          width INTEGER,
          height INTEGER,
          filesize INTEGER,
          source_url TEXT NOT NULL,
          thumb_url TEXT NOT NULL,
          uploaded_at TEXT,
          modified_at TEXT,
          editable INTEGER NOT NULL DEFAULT 0 CHECK(editable IN (0, 1)),
          PRIMARY KEY(shop_url, media_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS media_changes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_url TEXT NOT NULL,
          media_id INTEGER NOT NULL,
          changes TEXT NOT NULL CHECK(json_valid(changes)),
          base TEXT NOT NULL CHECK(json_valid(base)),
          remote TEXT CHECK(remote IS NULL OR json_valid(remote)),
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'failed', 'conflict')),
          error TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(shop_url, media_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS media_library_state (
          shop_url TEXT PRIMARY KEY,
          imported_at TEXT NOT NULL,
          synced_at TEXT NOT NULL,
          last_modified TEXT
        ) STRICT;
        PRAGMA user_version = 17;`)
    }
    if (version < 18) {
      // Images of products imported before the media library existed belong to it right away.
      const insert = insertProductImage(database)
      for (const row of database.prepare('SELECT shop_url AS shopUrl, payload FROM products').all())
        for (const item of productImageItems(JSON.parse(row.payload))) insert.run(row.shopUrl, item.mediaId, item.title, item.alt, item.filename, item.sourceUrl, item.thumbUrl, item.uploadedAt)
      database.exec('PRAGMA user_version = 18;')
    }
    if (version < 19) {
      // Deleting an image is queued like an edit; `products` are the products it was removed from first.
      const columns = new Set(database.prepare('PRAGMA table_info(media_changes)').all().map((column) => column.name))
      if (!columns.has('operation')) database.exec("ALTER TABLE media_changes ADD COLUMN operation TEXT NOT NULL DEFAULT 'update' CHECK(operation IN ('update', 'delete'))")
      if (!columns.has('products')) database.exec("ALTER TABLE media_changes ADD COLUMN products TEXT NOT NULL DEFAULT '[]'")
      database.exec('PRAGMA user_version = 19;')
    }
    if (version < 20) {
      // A deletion found in use in WordPress is held with its places (`usage`) until the user forces it.
      // `trash`: whether WordPress keeps deleted media in its trash (MEDIA_TRASH), learned from the first deletion.
      const changeColumns = new Set(database.prepare('PRAGMA table_info(media_changes)').all().map((column) => column.name))
      if (!changeColumns.has('usage')) database.exec('ALTER TABLE media_changes ADD COLUMN usage TEXT CHECK(usage IS NULL OR json_valid(usage))')
      if (!changeColumns.has('force')) database.exec('ALTER TABLE media_changes ADD COLUMN force INTEGER NOT NULL DEFAULT 0 CHECK(force IN (0, 1))')
      const stateColumns = new Set(database.prepare('PRAGMA table_info(media_library_state)').all().map((column) => column.name))
      if (!stateColumns.has('trash')) database.exec('ALTER TABLE media_library_state ADD COLUMN trash INTEGER CHECK(trash IS NULL OR trash IN (0, 1))')
      database.exec('PRAGMA user_version = 20;')
    }
    database.exec('COMMIT')
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK')
    database.close()
    throw error
  }

  // Taxonomy imports create a shop row too; only shops with products count as catalog imports.
  const catalogShop = 'EXISTS (SELECT 1 FROM products WHERE products.shop_url = shops.shop_url)'

  // Shop terms with queued edits applied, plus locally created terms (negative IDs) that wait for the shop.
  const mergedTerms = `merged(term_id, name, slug, parent_id, product_count, menu_order, description, state, change_state, error) AS (
      SELECT t.term_id,
        CASE WHEN c.operation = 'update' THEN json_extract(c.payload, '$.name') ELSE t.name END,
        CASE WHEN c.operation = 'update' THEN json_extract(c.payload, '$.slug') ELSE t.slug END,
        CASE WHEN c.operation = 'update' THEN json_extract(c.payload, '$.parent') ELSE t.parent_id END,
        t.product_count, t.menu_order,
        CASE WHEN c.operation = 'update' THEN json_extract(c.payload, '$.description') ELSE coalesce(json_extract(t.payload, '$.description'), '') END,
        coalesce(c.operation, 'clean'), c.state, c.error
      FROM taxonomy_terms t LEFT JOIN taxonomy_changes c ON c.shop_url = t.shop_url AND c.taxonomy = t.taxonomy AND c.term_ref = t.term_id
      WHERE t.shop_url = ?1 AND t.taxonomy = ?2
      UNION ALL
      SELECT c.term_ref, json_extract(c.payload, '$.name'), json_extract(c.payload, '$.slug'), json_extract(c.payload, '$.parent'), 0, 0,
        json_extract(c.payload, '$.description'), 'create', c.state, c.error
      FROM taxonomy_changes c WHERE c.shop_url = ?1 AND c.taxonomy = ?2 AND c.operation = 'create'
    )`

  function queryTerms(shopUrl, taxonomy, hierarchical, query, limit, offset) {
    // Hierarchical terms are ordered as a tree: parents first, children by name below them.
    const tree = `WITH RECURSIVE ${mergedTerms}, tree(term_id, path, sort_key, depth) AS (
        SELECT m.term_id, m.name, lower(m.name) || char(2) || printf('%020d', m.term_id), 0 FROM merged m
        WHERE m.parent_id = 0 OR ?3 = 0 OR NOT EXISTS (SELECT 1 FROM merged p WHERE p.term_id = m.parent_id)
        UNION ALL
        SELECT c.term_id, tree.path || ' › ' || c.name, tree.sort_key || char(1) || lower(c.name) || char(2) || printf('%020d', c.term_id), tree.depth + 1
        FROM merged c JOIN tree ON c.parent_id = tree.term_id
        WHERE ?3 = 1 AND tree.depth < 50
      )`
    const filter = query ? `AND (m.name LIKE ?4 ESCAPE '\\' OR m.slug LIKE ?4 ESCAPE '\\')` : ''
    const values = [shopUrl, taxonomy, hierarchical, ...(query ? [`%${query.replace(/[\\%_]/g, '\\$&')}%`] : [])]
    const from = `FROM tree JOIN merged m ON m.term_id = tree.term_id WHERE 1 = 1 ${filter}`
    const total = database.prepare(`${tree} SELECT COUNT(*) AS total ${from}`).get(...values).total
    const terms = database.prepare(`${tree} SELECT m.term_id AS id, m.name, m.slug, m.parent_id AS parentId, m.product_count AS count, m.menu_order AS menuOrder,
        m.description, m.state, m.change_state AS changeState, m.error, tree.path, tree.depth
      ${from} ORDER BY ${hierarchical ? 'tree.sort_key' : 'm.name COLLATE NOCASE, m.term_id'} LIMIT ${limit} OFFSET ${offset}`).all(...values)
    return { terms, total }
  }

  function editableTaxonomy(shopUrl, taxonomy) {
    if (hiddenByModules(shopUrl).taxonomies.has(taxonomy)) throw new Error('Taxonomie wurde nicht gefunden. Das zugehoerige Plugin-Modul ist ausgeschaltet.')
    const entry = database.prepare('SELECT label, hierarchical, available, route FROM taxonomies WHERE shop_url = ? AND taxonomy = ?').get(shopUrl, taxonomy)
    if (!entry) throw new Error('Taxonomie wurde nicht gefunden. Bitte Taxonomien neu importieren.')
    // Only WooCommerce routes accept the API keys for writes; wp/v2 would need a WordPress login.
    if (!entry.available || !entry.route.startsWith('wc/v3/')) throw new Error('Diese Taxonomie kann in CatalogDesk nur gelesen werden.')
    return entry
  }

  // Children of a removed term move one level up, as WordPress does when a parent term is deleted; also maps
  // local IDs to shop IDs. Internal bookkeeping, so the revision (which tracks user edits) stays unchanged.
  function reparentQueued(shopUrl, taxonomy, from, to) {
    database.prepare(`UPDATE taxonomy_changes SET payload = json_set(payload, '$.parent', ?)
      WHERE shop_url = ? AND taxonomy = ? AND operation IN ('create', 'update') AND json_extract(payload, '$.parent') = ?`).run(to, shopUrl, taxonomy, from)
  }

  // Product edits may reference a term created offline (negative ID). Once the shop created it, the
  // reference gets the real term; when the pending term is dropped, the reference is removed.
  function replaceProductTermRef(shopUrl, ref, replacement) {
    const update = database.prepare('UPDATE product_changes SET changes = ? WHERE id = ?')
    for (const row of database.prepare('SELECT id, changes FROM product_changes WHERE shop_url = ?').all(shopUrl)) {
      const changes = JSON.parse(row.changes)
      let touched = false
      for (const [field, value] of Object.entries(changes)) {
        // Pending uploads use negative IDs as well; they are resolved by completeMediaUpload.
        if (field === 'images' || field === 'image') continue
        if (isTermList(value) && value.some((term) => term.id === ref)) {
          changes[field] = value.flatMap((term) => term.id !== ref ? [term] : replacement ? [replacement] : [])
          touched = true
        } else if (isTerm(value) && value.id === ref) {
          changes[field] = replacement ?? { id: 0, name: '', slug: '' }
          touched = true
        }
      }
      if (touched) update.run(JSON.stringify(changes), row.id)
    }
  }

  // Pending uploads are referenced as -id: in `images`/`image` and in module image ID meta fields
  // (e.g. Yoast's social image), whose paired URL field follows the upload.
  const mediaIdFields = () => modules.metaFields(modules.moduleIds).filter((field) => field.type === 'mediaId')
  function rewriteUploadRefs(changes, ref, media) {
    let touched = false
    const swap = (image) => {
      if (!image || image.id !== ref) return image
      touched = true
      return media ? { ...image, id: media.id, src: media.src } : null
    }
    if (Array.isArray(changes.images)) changes.images = changes.images.map(swap).filter(Boolean)
    if (changes.image && typeof changes.image === 'object') changes.image = swap(changes.image)
    for (const field of mediaIdFields()) {
      if (changes[field.field] !== String(ref)) continue
      touched = true
      changes[field.field] = media ? String(media.id) : ''
      changes[field.imageField] = media ? media.src : ''
    }
    return touched
  }
  function uploadedImage(shopUrl, ref) {
    const row = database.prepare('SELECT id, filename, state, media_id AS mediaId, source_url AS sourceUrl FROM media_uploads WHERE shop_url = ? AND id = ?').get(shopUrl, -ref)
    if (!row) throw new Error('Produkt: Ein vorgemerktes Bild wurde nicht gefunden. Bitte erneut hochladen.')
    return row
  }
  // Images of an edit: pending uploads stay -id, finished ones get their media library ID.
  function resolveImage(shopUrl, image) {
    if (!image || image.id > 0) return image
    const row = uploadedImage(shopUrl, image.id)
    return row.state === 'done' ? { ...image, id: row.mediaId, src: row.sourceUrl ?? '' } : { ...image, src: '', name: image.name || row.filename }
  }

  // Where each media item is used: product images and gallery, variation images and module image fields
  // (e.g. Yoast's social image), with queued edits applied.
  function mediaUsage(shopUrl) {
    const usage = new Map()
    // Negative IDs are uploads that wait for WordPress; they count like media library items.
    const add = (id, entry) => { if (Number(id)) usage.set(Number(id), [...(usage.get(Number(id)) ?? []), entry]) }
    const imageFields = mediaIdFields().filter((field) => activeModuleIds(shopUrl).includes(field.module))
    const rows = database.prepare(`SELECT p.product_id AS id, p.parent_id AS parentId, coalesce(json_extract(c.changes, '$.name'), p.name) AS name,
        CASE WHEN c.id IS NULL THEN p.payload ELSE json_patch(p.payload, c.changes) END AS payload
      FROM products p LEFT JOIN product_changes c ON c.shop_url = p.shop_url AND c.product_id = p.product_id WHERE p.shop_url = ?`).all(shopUrl)
    for (const row of rows) {
      const payload = JSON.parse(row.payload)
      const product = { productId: row.id, parentId: row.parentId, name: row.name }
      if (Array.isArray(payload.images)) payload.images.forEach((image, index) => add(image?.id, { ...product, role: index === 0 ? 'Produktbild' : 'Galerie' }))
      if (payload.image && typeof payload.image === 'object') add(payload.image.id, { ...product, role: 'Variantenbild' })
      for (const field of imageFields) add(fieldValue(payload, field.field), { ...product, role: field.label.replace(/ \(Medien-ID\)$/, '') })
    }
    // Term images (e.g. product categories) are kept as they are when an image is deleted; they hold a deletion.
    for (const term of database.prepare(`SELECT t.term_id AS termId, t.name, coalesce(x.label, t.taxonomy) AS taxonomy, json_extract(t.payload, '$.image.id') AS imageId
      FROM taxonomy_terms t LEFT JOIN taxonomies x ON x.shop_url = t.shop_url AND x.taxonomy = t.taxonomy WHERE t.shop_url = ? AND json_extract(t.payload, '$.image.id') > 0`).all(shopUrl))
      add(term.imageId, { productId: null, parentId: null, termId: term.termId, name: term.name, role: `Bild in ${term.taxonomy}` })
    return usage
  }
  const mediaRow = `m.media_id AS id, coalesce(json_extract(c.changes, '$.title'), m.title) AS title, coalesce(json_extract(c.changes, '$.alt'), m.alt) AS alt,
    coalesce(json_extract(c.changes, '$.caption'), m.caption) AS caption, coalesce(json_extract(c.changes, '$.description'), m.description) AS description,
    m.filename, m.mime, m.width, m.height, m.filesize, m.source_url AS sourceUrl, m.thumb_url AS thumbUrl, m.uploaded_at AS uploadedAt, m.modified_at AS modifiedAt,
    m.editable, c.state AS changeState, c.error AS changeError, c.operation AS changeOperation, c.usage AS blockedBy, c.changes, c.base, c.remote`
  // Uploads that have not reached WordPress, in the form of media library items (negative ID, `upload` state).
  function uploadRows(shopUrl, id = null) {
    return database.prepare(`SELECT id, filename, mime, size, thumbnail, state, error, created_at AS createdAt FROM media_uploads
      WHERE shop_url = ? AND state != 'done' ${id ? 'AND id = ?' : ''} ORDER BY id DESC`).all(...(id ? [shopUrl, id] : [shopUrl])).map((row) => ({
      id: -row.id, title: '', alt: '', caption: '', description: '', filename: row.filename, mime: row.mime, width: null, height: null, filesize: row.size,
      sourceUrl: '', thumbUrl: row.thumbnail ?? '', uploadedAt: null, modifiedAt: null, createdAt: row.createdAt, editable: false,
      changeState: null, changeError: row.error, changes: null, base: null, remote: null, upload: row.state,
    }))
  }
  const toMediaRow = (row) => ({ ...row, editable: row.editable === 1, blockedBy: row.blockedBy ? JSON.parse(row.blockedBy) : null, changes: row.changes ? JSON.parse(row.changes) : null, base: row.base ? JSON.parse(row.base) : null, remote: row.remote ? JSON.parse(row.remote) : null })
  function upsertMediaItems(shopUrl, items) {
    const upsert = database.prepare(`INSERT INTO media_items (shop_url, media_id, title, alt, caption, description, filename, mime, width, height, filesize, source_url, thumb_url, uploaded_at, modified_at, editable)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_url, media_id) DO UPDATE SET title = excluded.title, alt = excluded.alt, caption = excluded.caption, description = excluded.description, filename = excluded.filename,
        mime = excluded.mime, width = excluded.width, height = excluded.height, filesize = excluded.filesize, source_url = excluded.source_url, thumb_url = excluded.thumb_url,
        uploaded_at = excluded.uploaded_at, modified_at = excluded.modified_at, editable = excluded.editable`)
    for (const item of items) upsert.run(shopUrl, item.mediaId, item.title, item.alt, item.caption, item.description, item.filename, item.mime, item.width, item.height, item.filesize, item.sourceUrl, item.thumbUrl, item.uploadedAt, item.modifiedAt, item.editable ? 1 : 0)
  }

  // Re-entrant: an operation that combines others (e.g. deleting an image edits products) runs in one transaction.
  function transaction(action) {
    if (database.isTransaction) return action()
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      database.exec('COMMIT')
      return result
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK')
      throw error
    }
  }

  // Writes one product with its term relations and attributes. Term fields are resolved by term ID
  // (unique across WordPress taxonomies); global attribute options by name or slug of their pa_* terms.
  function productWriter(shopUrl) {
    const byId = new Map()
    for (const term of database.prepare('SELECT taxonomy, term_id AS id, slug FROM taxonomy_terms WHERE shop_url = ?').all(shopUrl)) {
      if (!byId.has(term.id)) byId.set(term.id, [])
      byId.get(term.id).push(term)
    }
    const attributeTaxonomy = new Map(database.prepare("SELECT taxonomy, json_extract(attribute, '$.id') AS id FROM taxonomies WHERE shop_url = ? AND kind = 'attribute'").all(shopUrl).map((row) => [row.id, row.taxonomy]))
    const attributeTerms = new Map()
    for (const term of database.prepare("SELECT taxonomy, term_id AS id, name, slug FROM taxonomy_terms WHERE shop_url = ? AND substr(taxonomy, 1, 3) = 'pa_'").all(shopUrl)) {
      attributeTerms.set(`${term.taxonomy}\u0000${term.name.toLowerCase()}`, term.id)
      attributeTerms.set(`${term.taxonomy}\u0000${term.slug.toLowerCase()}`, term.id)
    }
    const upsertProduct = database.prepare(`INSERT INTO products (shop_url, product_id, parent_id, type, product_type, sku, name, status, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_url, product_id) DO UPDATE SET parent_id = excluded.parent_id, type = excluded.type, product_type = excluded.product_type, sku = excluded.sku, name = excluded.name, status = excluded.status, payload = excluded.payload`)
    const clearRelations = database.prepare('DELETE FROM product_taxonomies WHERE shop_url = ? AND product_id = ?')
    const clearAttributes = database.prepare('DELETE FROM product_attributes WHERE shop_url = ? AND product_id = ?')
    const insertTerm = database.prepare('INSERT INTO taxonomy_terms (shop_url, taxonomy, term_id, name, slug, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(shop_url, taxonomy, term_id) DO NOTHING')
    const insertRelation = database.prepare('INSERT INTO product_taxonomies (shop_url, product_id, taxonomy, term_id, field) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
    const insertAttribute = database.prepare('INSERT INTO product_attributes (shop_url, product_id, attribute_position, attribute_id, name, slug, variation, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const insertImage = insertProductImage(database)
    return (product, stats = { relations: 0, unresolved: 0 }) => {
      upsertProduct.run(shopUrl, product.id, product.parentId, product.type, product.productType ?? product.type, product.sku, product.name, product.status, JSON.stringify(product.payload))
      for (const item of productImageItems(product.payload)) insertImage.run(shopUrl, item.mediaId, item.title, item.alt, item.filename, item.sourceUrl, item.thumbUrl, item.uploadedAt)
      clearRelations.run(shopUrl, product.id)
      clearAttributes.run(shopUrl, product.id)
      for (const term of product.terms) {
        let taxonomy = null
        let termId = null
        if (term.field === 'attribute') {
          taxonomy = attributeTaxonomy.get(term.attributeId) ?? null
          termId = taxonomy ? attributeTerms.get(`${taxonomy}\u0000${term.option.toLowerCase()}`) ?? null : null
        } else {
          termId = term.id
          const known = byId.get(term.id) ?? []
          taxonomy = coreTermFields[term.field] ?? (known.find((entry) => entry.slug === term.slug) ?? known[0])?.taxonomy ?? null
          // Core taxonomies are always known; keep the relation even if their terms were not imported yet.
          if (taxonomy && coreTermFields[term.field] && !known.some((entry) => entry.taxonomy === taxonomy)) {
            insertTerm.run(shopUrl, taxonomy, term.id, term.name, term.slug, JSON.stringify({ id: term.id, name: term.name, slug: term.slug }))
            if (!byId.has(term.id)) byId.set(term.id, [])
            byId.get(term.id).push({ taxonomy, id: term.id, slug: term.slug })
          }
        }
        if (!taxonomy || !termId) { stats.unresolved++; continue }
        if (insertRelation.run(shopUrl, product.id, taxonomy, termId, term.field).changes) stats.relations++
      }
      for (const [position, attribute] of (Array.isArray(product.payload.attributes) ? product.payload.attributes : []).entries()) {
        if (!attribute || typeof attribute.name !== 'string') continue
        const options = Array.isArray(attribute.options) ? attribute.options : typeof attribute.option === 'string' ? [attribute.option] : []
        insertAttribute.run(shopUrl, product.id, position, Number.isSafeInteger(attribute.id) ? attribute.id : null, attribute.name, typeof attribute.slug === 'string' ? attribute.slug : null, attribute.variation === true ? 1 : 0, JSON.stringify(options))
      }
      return stats
    }
  }

  function detectedModules(shopUrl) {
    return database.prepare('SELECT module_id AS id FROM shop_modules WHERE shop_url = ?').all(shopUrl).map((row) => row.id)
  }
  function switchedOffModules(shopUrl) {
    return database.prepare('SELECT module_id AS id FROM module_settings WHERE shop_url = ? AND enabled = 0').all(shopUrl).map((row) => row.id)
  }
  function inactiveModules(shopUrl) {
    return database.prepare('SELECT module_id AS id FROM shop_inactive_modules WHERE shop_url = ?').all(shopUrl).map((row) => row.id)
  }
  function hiddenByModules(shopUrl) {
    return modules.hiddenByModules(detectedModules(shopUrl), switchedOffModules(shopUrl), inactiveModules(shopUrl))
  }
  function storeModuleDetection(shopUrl, detected, inactive, at) {
    // Keep the first detection time of modules that are still present.
    database.prepare('DELETE FROM shop_modules WHERE shop_url = ? AND module_id NOT IN (SELECT value FROM json_each(?))').run(shopUrl, JSON.stringify(detected))
    const insertModule = database.prepare('INSERT OR IGNORE INTO shop_modules (shop_url, module_id, detected_at) VALUES (?, ?, ?)')
    for (const id of detected) insertModule.run(shopUrl, id, at)
    database.prepare('DELETE FROM shop_inactive_modules WHERE shop_url = ?').run(shopUrl)
    const insertInactive = database.prepare('INSERT INTO shop_inactive_modules (shop_url, module_id, checked_at) VALUES (?, ?, ?)')
    for (const id of inactive) insertInactive.run(shopUrl, id, at)
  }
  // Detected and not switched off; licensing is checked by the module registry.
  function activeModuleIds(shopUrl) {
    const off = switchedOffModules(shopUrl)
    return detectedModules(shopUrl).filter((id) => !off.includes(id))
  }
  // Generated taxonomy names get the label of an active module; everything else keeps its base label.
  function applyModuleLabels(shopUrl) {
    const active = activeModuleIds(shopUrl)
    const update = database.prepare('UPDATE taxonomies SET label = ? WHERE shop_url = ? AND taxonomy = ?')
    for (const row of database.prepare('SELECT taxonomy, base_label AS baseLabel, label_source AS source FROM taxonomies WHERE shop_url = ?').all(shopUrl))
      update.run((row.source === 'generated' ? modules.taxonomyLabel(active, row.taxonomy) : null) ?? row.baseLabel, shopUrl, row.taxonomy)
  }

  // Which taxonomy a writable term field belongs to: core fields by name, then active plugin modules,
  // then what imported products show, then naming (delivery_time -> product_delivery_time).
  function termFieldTaxonomies(shopUrl) {
    const detected = activeModuleIds(shopUrl)
    let fields = database.prepare('SELECT scope, field, multiple FROM product_term_fields WHERE shop_url = ?').all(shopUrl).map((row) => ({ ...row, multiple: row.multiple === 1 }))
    if (!fields.length) fields = ['categories', 'tags', 'brands'].map((field) => ({ scope: 'product', field, multiple: true }))
    const taxonomies = database.prepare("SELECT taxonomy, label, hierarchical, route FROM taxonomies WHERE shop_url = ? AND kind != 'attribute' AND available = 1").all(shopUrl)
    const known = new Map(taxonomies.map((entry) => [entry.taxonomy, entry]))
    const observed = new Map()
    for (const row of database.prepare('SELECT field, taxonomy, COUNT(*) AS uses FROM product_taxonomies WHERE shop_url = ? AND field IS NOT NULL GROUP BY field, taxonomy ORDER BY uses DESC').all(shopUrl))
      if (!observed.has(row.field) && known.has(row.taxonomy)) observed.set(row.field, row.taxonomy)
    const tokens = (value) => value.replace(/^product_/, '').split(/[_-]+/).filter(Boolean)
    function resolve(field) {
      if (coreTermFields[field] && known.has(coreTermFields[field])) return coreTermFields[field]
      const fromModule = modules.termField(detected, field)
      if (fromModule && known.has(fromModule.taxonomy)) return fromModule.taxonomy
      if (observed.has(field)) return observed.get(field)
      if (known.has(`product_${field}`)) return `product_${field}`
      const fieldTokens = new Set(tokens(field))
      const candidates = taxonomies.filter((entry) => !Object.values(coreTermFields).includes(entry.taxonomy) && tokens(entry.taxonomy).every((token) => fieldTokens.has(token)))
      return candidates.length === 1 ? candidates[0].taxonomy : null
    }
    const hidden = hiddenByModules(shopUrl)
    const resolved = fields.map((field) => ({ ...field, taxonomy: resolve(field.field) }))
      .filter((field) => field.taxonomy && field.field !== 'shipping_class' && !hidden.fields.has(field.field) && !hidden.taxonomies.has(field.taxonomy))
    // Two fields can point to the same taxonomy (e.g. regular and sale price labels); name them apart.
    return resolved.map((field) => {
      const fromModule = modules.termField(detected, field.field)
      const shared = resolved.filter((other) => other.scope === field.scope && other.taxonomy === field.taxonomy).length > 1
      return {
        ...field,
        label: fromModule?.taxonomy === field.taxonomy ? fromModule.label : shared ? `${known.get(field.taxonomy).label} (${field.field})` : known.get(field.taxonomy).label,
        hierarchical: known.get(field.taxonomy).hierarchical === 1,
        // New terms can be created from the product editor where the shop accepts writes (WooCommerce route).
        editable: known.get(field.taxonomy).route.startsWith('wc/v3/'),
        section: fromModule?.taxonomy === field.taxonomy ? fromModule.section : null,
      }
    })
  }

  // Product meta fields declared by active plugin modules (e.g. Yoast SEO), for one scope.
  function metaFieldDefinitions(shopUrl, scope) {
    return modules.metaFields(activeModuleIds(shopUrl)).filter((field) => field.scopes.includes(scope))
  }

  function setFieldValue(payload, field, value) {
    if (!isMetaField(field)) { payload[field] = value; return }
    const key = field.slice('meta:'.length)
    const meta = Array.isArray(payload.meta_data) ? payload.meta_data : (payload.meta_data = [])
    const entry = meta.find((item) => item?.key === key)
    if (entry) entry.value = value
    else meta.push({ key, value })
    delete payload[field]
  }

  function taxonomyShop(shopUrl) {
    return shopUrl ?? database.prepare('SELECT shop_url FROM taxonomies ORDER BY imported_at DESC LIMIT 1').get()?.shop_url ?? null
  }

  return {
    getTheme() {
      return database.prepare("SELECT value FROM app_settings WHERE key = 'theme'").get().value
    },
    setTheme(input) {
      const theme = z.enum(['light', 'dark']).parse(input)
      database.prepare("UPDATE app_settings SET value = ? WHERE key = 'theme'").run(theme)
      return theme
    },
    listUsers() {
      return database.prepare('SELECT id, first_name AS firstName, last_name AS lastName, email, username, role, permissions FROM users ORDER BY last_name, first_name').all()
        .map((user) => ({ ...user, permissions: JSON.parse(user.permissions) }))
    },
    saveUser(input) {
      const parsed = managedUserSchema.parse(input)
      database.exec('BEGIN IMMEDIATE')
      try {
        const existing = parsed.id ? database.prepare('SELECT role, active FROM users WHERE id = ?').get(parsed.id) : null
        if (parsed.id && !existing) throw new Error('Benutzer wurde nicht gefunden.')
        if (existing?.role === 'admin' && existing.active && parsed.role !== 'admin' && database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get().count <= 1)
          throw new Error('Mindestens ein Administrator muss erhalten bleiben.')
        if (Boolean(parsed.salt) !== Boolean(parsed.passwordHash)) throw new Error('Ungueltige Passwortdaten.')
        const permissions = JSON.stringify(parsed.role === 'admin' ? [] : [...new Set(parsed.permissions)])
        const id = parsed.id ?? randomUUID()
        if (existing) {
          database.prepare('UPDATE users SET first_name = ?, last_name = ?, email = ?, username = ?, role = ?, permissions = ? WHERE id = ?').run(parsed.firstName, parsed.lastName, parsed.email.toLowerCase(), parsed.username.toLowerCase(), parsed.role, permissions, id)
          if (parsed.passwordHash) database.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?').run(parsed.salt, parsed.passwordHash, id)
        } else {
          if (!parsed.salt || !parsed.passwordHash) throw new Error('Passwort erforderlich.')
          database.prepare('INSERT INTO users (id, first_name, last_name, email, username, role, password_salt, password_hash, created_at, permissions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, parsed.firstName, parsed.lastName, parsed.email.toLowerCase(), parsed.username.toLowerCase(), parsed.role, parsed.salt, parsed.passwordHash, new Date().toISOString(), permissions)
        }
        database.exec('COMMIT')
        return id
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK')
        throw error
      }
    },
    deleteUser(id) {
      const parsed = z.string().uuid().parse(id)
      database.exec('BEGIN IMMEDIATE')
      try {
        const user = database.prepare('SELECT role, active FROM users WHERE id = ?').get(parsed)
        if (!user) throw new Error('Benutzer wurde nicht gefunden.')
        if (user.role === 'admin' && user.active && database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get().count <= 1)
          throw new Error('Mindestens ein Administrator muss erhalten bleiben.')
        database.prepare('DELETE FROM users WHERE id = ?').run(parsed)
        database.exec('COMMIT')
        return true
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK')
        throw error
      }
    },
    userCount() {
      return database.prepare('SELECT COUNT(*) AS count FROM users').get().count
    },
    findUserByUsername(username) {
      const parsed = usernameSchema.parse(username)
      return database.prepare(
        'SELECT id, first_name AS firstName, last_name AS lastName, email, username, role, permissions, password_salt AS salt, password_hash AS passwordHash, active FROM users WHERE username = ? COLLATE NOCASE',
      ).get(parsed) ?? null
    },
    createInitialAdmin(input) {
      const parsed = newAdminSchema.parse(input)
      database.exec('BEGIN IMMEDIATE')
      try {
        if (database.prepare('SELECT COUNT(*) AS count FROM users').get().count !== 0)
          throw new Error('Admin account is already configured.')
        const user = {
          id: randomUUID(),
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          email: parsed.email.toLowerCase(),
          username: parsed.username.toLowerCase(),
          role: 'admin',
          salt: parsed.salt,
          passwordHash: parsed.passwordHash,
          active: 1,
          createdAt: new Date().toISOString(),
        }
        database.prepare(
          'INSERT INTO users (id, first_name, last_name, email, username, role, password_salt, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(user.id, user.firstName, user.lastName, user.email, user.username, user.role, user.salt, user.passwordHash, user.active, user.createdAt)
        database.exec('COMMIT')
        return { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, username: user.username, role: user.role }
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK')
        throw error
      }
    },
    recordLogin(userId) {
      database.prepare('UPDATE users SET active = 1 WHERE id = ?').run(z.string().uuid().parse(userId))
      return true
    },
    workspaceSummary() {
      const shops = database.prepare(`SELECT COUNT(*) AS count FROM shops WHERE ${catalogShop}`).get().count
      const counts = database.prepare('SELECT type, COUNT(*) AS count FROM products GROUP BY type').all()
      const latestShop = database.prepare(`SELECT shop_url AS shopUrl, imported_at AS importedAt FROM shops WHERE ${catalogShop} ORDER BY imported_at DESC LIMIT 1`).get() ?? null
      return {
        shopCount: shops,
        latestShopUrl: latestShop?.shopUrl ?? null,
        latestImportedAt: latestShop?.importedAt ?? null,
        products: counts.reduce((total, entry) => total + entry.count, 0),
        simple: counts.find((entry) => entry.type === 'simple')?.count ?? 0,
        variable: counts.find((entry) => entry.type === 'variable')?.count ?? 0,
        variations: counts.find((entry) => entry.type === 'variation')?.count ?? 0,
      }
    },
    listProducts(input = {}) {
      const parsed = searchSchema.parse(input)
      const shopUrl = parsed.shopUrl ?? database.prepare(`SELECT shop_url FROM shops WHERE ${catalogShop} ORDER BY imported_at DESC LIMIT 1`).get()?.shop_url
      if (!shopUrl) return { products: [], total: 0, page: parsed.page, pageSize: parsed.pageSize, currency: null }
      const currency = database.prepare('SELECT currency FROM shops WHERE shop_url = ?').get(shopUrl)?.currency ?? null
      const where = ['p.shop_url = ?']
      const values = [shopUrl]
      if (parsed.type !== 'all') { where.push('p.product_type = ?'); values.push(parsed.type) }
      if (parsed.query) {
        const like = `%${parsed.query.replace(/[\\%_]/g, '\\$&')}%`
        where.push(`(coalesce(json_extract(c.changes, '$.sku'), p.sku) LIKE ? ESCAPE '\\' OR coalesce(json_extract(c.changes, '$.name'), p.name) LIKE ? ESCAPE '\\')`)
        values.push(like, like)
      }
      const whereSql = where.join(' AND ')
      const from = `FROM products p LEFT JOIN products parent ON parent.shop_url = p.shop_url AND parent.product_id = p.parent_id
        LEFT JOIN product_changes c ON c.shop_url = p.shop_url AND c.product_id = p.product_id`
      const total = database.prepare(`SELECT COUNT(*) AS total ${from} WHERE ${whereSql}`).get(...values).total
      // Families stay together: each variable product is followed by its variations.
      const hiddenTaxonomies = hiddenByModules(shopUrl).taxonomies
      // Queued edits are shown right away: their fields are merged over the shop data.
      const products = database.prepare(`SELECT p.product_id AS id, p.parent_id AS parentId, p.type, p.product_type AS productType,
          coalesce(json_extract(c.changes, '$.sku'), p.sku) AS sku, coalesce(json_extract(c.changes, '$.name'), p.name) AS name, coalesce(json_extract(c.changes, '$.status'), p.status) AS status,
          CASE WHEN c.id IS NULL THEN 'clean' WHEN c.state = 'conflict' THEN 'conflict' ELSE 'draft' END AS syncState,
          CASE WHEN c.id IS NULL THEN p.payload ELSE json_patch(p.payload, c.changes) END AS payload,
          c.state AS changeState, c.error AS changeError, c.changes AS changes, c.base AS base, c.remote AS remote,
          (SELECT json_group_array(json_object('taxonomy', r.taxonomy, 'label', coalesce(tx.label, r.taxonomy), 'name', t.name))
            FROM product_taxonomies r JOIN taxonomy_terms t ON t.shop_url = r.shop_url AND t.taxonomy = r.taxonomy AND t.term_id = r.term_id
            LEFT JOIN taxonomies tx ON tx.shop_url = r.shop_url AND tx.taxonomy = r.taxonomy
            WHERE r.shop_url = p.shop_url AND r.product_id = p.product_id) AS terms,
          -- Variable products have no own price; their list price is the range of their variations' current prices.
          (SELECT json_array(min(price), max(price)) FROM (
            SELECT CAST(coalesce(nullif(json_extract(json_patch(v.payload, coalesce(vc.changes, '{}')), '$.sale_price'), ''), nullif(json_extract(json_patch(v.payload, coalesce(vc.changes, '{}')), '$.regular_price'), ''), nullif(json_extract(v.payload, '$.price'), '')) AS REAL) AS price
            FROM products v LEFT JOIN product_changes vc ON vc.shop_url = v.shop_url AND vc.product_id = v.product_id
            WHERE v.shop_url = p.shop_url AND v.parent_id = p.product_id) WHERE price IS NOT NULL) AS priceRange
        ${from} WHERE ${whereSql}
        ORDER BY coalesce(parent.name, p.name) COLLATE NOCASE, coalesce(p.parent_id, p.product_id), p.parent_id IS NOT NULL, p.name COLLATE NOCASE, p.product_id
        LIMIT ? OFFSET ?`).all(...values, parsed.pageSize, parsed.page * parsed.pageSize)
        .map((row) => ({ ...row, payload: JSON.parse(row.payload), terms: JSON.parse(row.terms).filter((term) => !hiddenTaxonomies.has(term.taxonomy)), priceRange: row.priceRange && JSON.parse(row.priceRange)[0] !== null ? JSON.parse(row.priceRange) : null, changes: row.changes ? JSON.parse(row.changes) : null, base: row.base ? JSON.parse(row.base) : null, remote: row.remote ? JSON.parse(row.remote) : null }))
      return { products, total, page: parsed.page, pageSize: parsed.pageSize, currency, changeCounts: this.productChangeCounts({ shopUrl }) }
    },
    replaceCatalog(input) {
      const parsed = catalogSchema.parse(input)
      const ids = new Set()
      for (const product of parsed.products) {
        if (ids.has(product.id)) throw new Error('Duplicate WooCommerce product ID.')
        ids.add(product.id)
      }
      const stats = { relations: 0, unresolved: 0 }
      database.exec('BEGIN IMMEDIATE')
      try {
        database.prepare('INSERT INTO shops (shop_url, imported_at, currency) VALUES (?, ?, ?) ON CONFLICT(shop_url) DO UPDATE SET imported_at = excluded.imported_at, currency = coalesce(excluded.currency, shops.currency)').run(parsed.shopUrl, parsed.importedAt, parsed.currency)
        database.prepare('DELETE FROM products WHERE shop_url = ?').run(parsed.shopUrl)
        const write = productWriter(parsed.shopUrl)
        for (const product of parsed.products) write(product, stats)
        database.exec('COMMIT')
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK')
        throw error
      }
      return { ...this.workspaceSummary(), ...stats }
    },
    replaceTaxonomies(input) {
      const parsed = taxonomyImportSchema.parse(input)
      const keys = new Set()
      let termTotal = 0
      for (const entry of parsed.taxonomies) {
        if (keys.has(entry.taxonomy)) throw new Error('Duplicate WooCommerce taxonomy.')
        keys.add(entry.taxonomy)
        if (new Set(entry.terms.map((term) => term.id)).size !== entry.terms.length) throw new Error('Duplicate WooCommerce term ID.')
        termTotal += entry.terms.length
      }
      if (termTotal > 200_000) throw new Error('Too many taxonomy terms.')
      const imported = new Set(parsed.taxonomies.flatMap((entry) => entry.terms.map((term) => `${entry.taxonomy}\u0000${term.id}`)))
      // Terms of taxonomies the shop did not let us read this time are kept instead of being wiped.
      const unreadable = new Set(parsed.taxonomies.filter((entry) => !entry.available).map((entry) => entry.taxonomy))
      database.exec('BEGIN IMMEDIATE')
      try {
        // Terms with queued edits stay until the edit is synchronized or discarded.
        for (const { taxonomy, termRef } of database.prepare('SELECT taxonomy, term_ref AS termRef FROM taxonomy_changes WHERE shop_url = ? AND term_ref > 0').all(parsed.shopUrl))
          imported.add(`${taxonomy}\u0000${termRef}`)
        database.prepare('INSERT INTO shops (shop_url, imported_at) VALUES (?, ?) ON CONFLICT(shop_url) DO NOTHING').run(parsed.shopUrl, parsed.importedAt)
        const deleteRelations = database.prepare('DELETE FROM product_taxonomies WHERE shop_url = ? AND taxonomy = ? AND term_id = ?')
        const deleteTerm = database.prepare('DELETE FROM taxonomy_terms WHERE shop_url = ? AND taxonomy = ? AND term_id = ?')
        for (const { taxonomy, termId } of database.prepare('SELECT taxonomy, term_id AS termId FROM taxonomy_terms WHERE shop_url = ?').all(parsed.shopUrl)) {
          if (unreadable.has(taxonomy) || imported.has(`${taxonomy}\u0000${termId}`)) continue
          deleteRelations.run(parsed.shopUrl, taxonomy, termId)
          deleteTerm.run(parsed.shopUrl, taxonomy, termId)
        }
        database.prepare('DELETE FROM taxonomies WHERE shop_url = ?').run(parsed.shopUrl)
        database.prepare('DELETE FROM product_term_fields WHERE shop_url = ?').run(parsed.shopUrl)
        storeModuleDetection(parsed.shopUrl, parsed.modules, parsed.inactiveModules, parsed.importedAt)
        const insertField = database.prepare('INSERT OR IGNORE INTO product_term_fields (shop_url, scope, field, multiple) VALUES (?, ?, ?, ?)')
        for (const field of parsed.productFields) insertField.run(parsed.shopUrl, field.scope, field.field, field.multiple ? 1 : 0)
        const insertTaxonomy = database.prepare('INSERT INTO taxonomies (shop_url, taxonomy, kind, label, base_label, label_source, route, hierarchical, available, attribute, position, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        const upsertTerm = database.prepare(`INSERT INTO taxonomy_terms (shop_url, taxonomy, term_id, name, slug, payload, parent_id, product_count, menu_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(shop_url, taxonomy, term_id) DO UPDATE SET name = excluded.name, slug = excluded.slug, payload = excluded.payload, parent_id = excluded.parent_id, product_count = excluded.product_count, menu_order = excluded.menu_order`)
        for (const [position, entry] of parsed.taxonomies.entries()) {
          insertTaxonomy.run(parsed.shopUrl, entry.taxonomy, entry.kind, entry.label, entry.label, entry.labelSource, entry.route, entry.hierarchical ? 1 : 0, entry.available ? 1 : 0, entry.attribute ? JSON.stringify(entry.attribute) : null, position, parsed.importedAt)
          for (const term of entry.terms)
            upsertTerm.run(parsed.shopUrl, entry.taxonomy, term.id, term.name, term.slug, JSON.stringify(term.payload), term.parentId, term.count, term.menuOrder)
        }
        applyModuleLabels(parsed.shopUrl)
        database.exec('COMMIT')
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK')
        throw error
      }
      return this.taxonomyOverview({ shopUrl: parsed.shopUrl })
    },
    taxonomyOverview(input = {}) {
      const parsed = z.object({ shopUrl: shopUrlSchema.optional() }).strict().parse(input)
      const shopUrl = taxonomyShop(parsed.shopUrl)
      if (!shopUrl) return { shopUrl: null, importedAt: null, taxonomies: [] }
      const hidden = hiddenByModules(shopUrl).taxonomies
      const taxonomies = database.prepare(`SELECT t.taxonomy, t.kind, t.label, t.route, t.hierarchical, t.available, t.attribute, t.imported_at AS importedAt,
          (SELECT COUNT(*) FROM taxonomy_terms terms WHERE terms.shop_url = t.shop_url AND terms.taxonomy = t.taxonomy)
            + (SELECT COUNT(*) FROM taxonomy_changes c WHERE c.shop_url = t.shop_url AND c.taxonomy = t.taxonomy AND c.operation = 'create')
            - (SELECT COUNT(*) FROM taxonomy_changes c WHERE c.shop_url = t.shop_url AND c.taxonomy = t.taxonomy AND c.operation = 'delete') AS termCount,
          (SELECT COUNT(*) FROM taxonomy_changes c WHERE c.shop_url = t.shop_url AND c.taxonomy = t.taxonomy AND c.state = 'pending') AS pendingCount,
          (SELECT COUNT(*) FROM taxonomy_changes c WHERE c.shop_url = t.shop_url AND c.taxonomy = t.taxonomy AND c.state = 'failed') AS failedCount
        FROM taxonomies t WHERE t.shop_url = ? ORDER BY t.position`).all(shopUrl)
        .filter((row) => !hidden.has(row.taxonomy))
        .map((row) => ({ ...row, hierarchical: row.hierarchical === 1, available: row.available === 1, editable: row.available === 1 && row.route.startsWith('wc/v3/'), attribute: row.attribute ? JSON.parse(row.attribute) : null }))
      return { shopUrl, importedAt: taxonomies[0]?.importedAt ?? null, taxonomies, ...this.taxonomyChangeCounts({ shopUrl }) }
    },
    listTaxonomyTerms(input) {
      const parsed = taxonomyTermsQuerySchema.parse(input)
      const empty = { terms: [], total: 0, page: parsed.page, pageSize: parsed.pageSize }
      const shopUrl = taxonomyShop(parsed.shopUrl)
      if (!shopUrl) return empty
      const taxonomy = database.prepare('SELECT hierarchical FROM taxonomies WHERE shop_url = ? AND taxonomy = ?').get(shopUrl, parsed.taxonomy)
      if (!taxonomy || hiddenByModules(shopUrl).taxonomies.has(parsed.taxonomy)) return empty
      return { ...queryTerms(shopUrl, parsed.taxonomy, taxonomy.hierarchical, parsed.query, parsed.pageSize, parsed.page * parsed.pageSize), page: parsed.page, pageSize: parsed.pageSize }
    },
    taxonomyTermOptions(input) {
      const parsed = taxonomyTermsQuerySchema.pick({ shopUrl: true, taxonomy: true }).strict().parse(input)
      const shopUrl = taxonomyShop(parsed.shopUrl)
      const taxonomy = shopUrl && database.prepare('SELECT hierarchical FROM taxonomies WHERE shop_url = ? AND taxonomy = ?').get(shopUrl, parsed.taxonomy)
      if (!taxonomy || hiddenByModules(shopUrl).taxonomies.has(parsed.taxonomy)) return []
      return queryTerms(shopUrl, parsed.taxonomy, taxonomy.hierarchical, '', 20_000, 0).terms
        .filter((term) => term.state !== 'delete').map(({ id, name, slug, path, depth }) => ({ id, name, slug, path, depth }))
    },
    taxonomyChangeCounts(input = {}) {
      const parsed = z.object({ shopUrl: shopUrlSchema.optional() }).strict().parse(input)
      const rows = database.prepare(`SELECT state, COUNT(*) AS count FROM taxonomy_changes ${parsed.shopUrl ? 'WHERE shop_url = ?' : ''} GROUP BY state`).all(...(parsed.shopUrl ? [parsed.shopUrl] : []))
      return { pendingChanges: rows.find((row) => row.state === 'pending')?.count ?? 0, failedChanges: rows.find((row) => row.state === 'failed')?.count ?? 0 }
    },
    queueTaxonomyChange(input) {
      const parsed = termChangeSchema.parse(input)
      return transaction(() => {
        const { shopUrl, taxonomy, operation, termId } = parsed
        const entry = editableTaxonomy(shopUrl, taxonomy)
        const terms = new Map(database.prepare(`WITH ${mergedTerms} SELECT term_id AS id, name, slug, parent_id AS parentId, description, state FROM merged`).all(shopUrl, taxonomy).map((term) => [term.id, term]))
        const now = new Date().toISOString()
        const term = termId === undefined ? null : terms.get(termId)
        if (operation !== 'create' && (!term || term.state === 'delete')) throw new Error('Begriff wurde nicht gefunden.')
        const existing = term ? database.prepare('SELECT id, operation FROM taxonomy_changes WHERE shop_url = ? AND taxonomy = ? AND term_ref = ?').get(shopUrl, taxonomy, termId) : null
        // Returned for the usage history: the term as the user saw it before and after the edit.
        const snapshot = (value) => value && { name: value.name, slug: value.slug, parent: value.parentId ?? value.parent, parentName: terms.get(value.parentId ?? value.parent)?.name ?? null, description: value.description ?? '' }
        const audit = (result, after = null) => ({ ...result, taxonomyLabel: entry.label, before: snapshot(term), after: snapshot(after) })

        if (operation === 'delete') {
          if (termId < 0) {
            reparentQueued(shopUrl, taxonomy, termId, term.parentId)
            replaceProductTermRef(shopUrl, termId, null)
            database.prepare('DELETE FROM taxonomy_changes WHERE id = ?').run(existing.id)
          } else if (existing) {
            database.prepare("UPDATE taxonomy_changes SET operation = 'delete', payload = '{}', state = 'pending', error = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(now, existing.id)
          } else {
            database.prepare("INSERT INTO taxonomy_changes (shop_url, taxonomy, term_ref, operation, payload, created_at, updated_at) VALUES (?, ?, ?, 'delete', '{}', ?, ?)").run(shopUrl, taxonomy, termId, now, now)
          }
          return audit({ termId })
        }

        if (!parsed.fields) throw new Error('Begriff: Name fehlt.')
        const fields = { ...parsed.fields, parent: entry.hierarchical ? parsed.fields.parent : 0 }
        if (operation === 'update' && !fields.slug) fields.slug = term.slug
        if (fields.parent !== 0 && (!terms.has(fields.parent) || terms.get(fields.parent).state === 'delete'))
          throw new Error('Uebergeordneter Begriff wurde nicht gefunden.')
        for (let parent = fields.parent, steps = 0; parent !== 0 && steps < 100; parent = terms.get(parent)?.parentId ?? 0, steps++)
          if (parent === termId) throw new Error('Ein Begriff kann nicht unter sich selbst eingeordnet werden.')
        // A term exists only once per taxonomy: same name (ignoring case and spaces) or the same slug.
        const others = [...terms.values()].filter((other) => other.state !== 'delete')
        const duplicate = findDuplicate(others, fields, termId ?? null)
        if (duplicate) throw new Error(`Ein Begriff „${duplicate.name}“ existiert in ${entry.label} bereits.`)
        const payload = JSON.stringify(fields)
        if (operation === 'create') {
          const { lastInsertRowid } = database.prepare("INSERT INTO taxonomy_changes (shop_url, taxonomy, term_ref, operation, payload, created_at, updated_at) VALUES (?, ?, 0, 'create', ?, ?, ?)").run(shopUrl, taxonomy, payload, now, now)
          database.prepare('UPDATE taxonomy_changes SET term_ref = ? WHERE id = ?').run(-Number(lastInsertRowid), lastInsertRowid)
          return audit({ termId: -Number(lastInsertRowid) }, fields)
        }
        if (existing) database.prepare("UPDATE taxonomy_changes SET payload = ?, state = 'pending', error = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(payload, now, existing.id)
        else database.prepare("INSERT INTO taxonomy_changes (shop_url, taxonomy, term_ref, operation, payload, created_at, updated_at) VALUES (?, ?, ?, 'update', ?, ?, ?)").run(shopUrl, taxonomy, termId, payload, now, now)
        return audit({ termId }, fields)
      })
    },
    discardTaxonomyChange(input) {
      const parsed = termRefSchema.parse(input)
      return transaction(() => {
        const change = database.prepare(`SELECT c.id, c.operation, c.payload, coalesce(json_extract(c.payload, '$.name'), tt.name) AS name, t.label AS taxonomyLabel
          FROM taxonomy_changes c LEFT JOIN taxonomy_terms tt ON tt.shop_url = c.shop_url AND tt.taxonomy = c.taxonomy AND tt.term_id = c.term_ref
          LEFT JOIN taxonomies t ON t.shop_url = c.shop_url AND t.taxonomy = c.taxonomy
          WHERE c.shop_url = ? AND c.taxonomy = ? AND c.term_ref = ?`).get(parsed.shopUrl, parsed.taxonomy, parsed.termId)
        if (!change) throw new Error('Aenderung wurde nicht gefunden.')
        if (change.operation === 'create') {
          reparentQueued(parsed.shopUrl, parsed.taxonomy, parsed.termId, JSON.parse(change.payload).parent ?? 0)
          replaceProductTermRef(parsed.shopUrl, parsed.termId, null)
        }
        database.prepare('DELETE FROM taxonomy_changes WHERE id = ?').run(change.id)
        return { operation: change.operation, name: change.name, taxonomyLabel: change.taxonomyLabel }
      })
    },
    retryTaxonomyChanges(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema }).strict().parse(input)
      database.prepare("UPDATE taxonomy_changes SET state = 'pending', error = NULL WHERE shop_url = ? AND state = 'failed'").run(parsed.shopUrl)
      return true
    },
    pendingTaxonomyChanges(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema }).strict().parse(input)
      return database.prepare(`SELECT c.id, c.taxonomy, c.term_ref AS termRef, c.operation, c.payload, c.revision, t.route, t.hierarchical, t.label AS taxonomyLabel,
          coalesce(json_extract(c.payload, '$.name'), tt.name) AS name
        FROM taxonomy_changes c JOIN taxonomies t ON t.shop_url = c.shop_url AND t.taxonomy = c.taxonomy
        LEFT JOIN taxonomy_terms tt ON tt.shop_url = c.shop_url AND tt.taxonomy = c.taxonomy AND tt.term_id = c.term_ref
        WHERE c.shop_url = ? AND c.state = 'pending' ORDER BY c.id`).all(parsed.shopUrl)
        .map((row) => ({ ...row, hierarchical: row.hierarchical === 1, payload: JSON.parse(row.payload) }))
    },
    completeTaxonomyChange(input) {
      const parsed = z.object({ changeId: z.number().int().positive(), revision: z.number().int().nonnegative(), term: syncedTermSchema.nullable() }).strict().parse(input)
      return transaction(() => {
        const change = database.prepare('SELECT id, shop_url AS shopUrl, taxonomy, term_ref AS termRef, operation, revision FROM taxonomy_changes WHERE id = ?').get(parsed.changeId)
        if (!change) return false
        const { shopUrl, taxonomy, termRef } = change
        if (parsed.term) {
          const term = parsed.term
          database.prepare(`INSERT INTO taxonomy_terms (shop_url, taxonomy, term_id, name, slug, payload, parent_id, product_count, menu_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(shop_url, taxonomy, term_id) DO UPDATE SET name = excluded.name, slug = excluded.slug, payload = excluded.payload, parent_id = excluded.parent_id, product_count = excluded.product_count, menu_order = excluded.menu_order`)
            .run(shopUrl, taxonomy, term.id, term.name, term.slug, JSON.stringify(term.payload), term.parentId, term.count, term.menuOrder)
          if (termRef < 0) {
            reparentQueued(shopUrl, taxonomy, termRef, term.id)
            replaceProductTermRef(shopUrl, termRef, { id: term.id, name: term.name, slug: term.slug })
            // Edited again while the request was running: keep the newer edit as an update of the created term.
            if (change.revision !== parsed.revision) {
              database.prepare("UPDATE taxonomy_changes SET term_ref = ?, operation = 'update' WHERE id = ?").run(term.id, change.id)
              return true
            }
          }
        } else {
          const parent = database.prepare('SELECT parent_id AS parentId FROM taxonomy_terms WHERE shop_url = ? AND taxonomy = ? AND term_id = ?').get(shopUrl, taxonomy, termRef)?.parentId ?? 0
          database.prepare('UPDATE taxonomy_terms SET parent_id = ? WHERE shop_url = ? AND taxonomy = ? AND parent_id = ?').run(parent, shopUrl, taxonomy, termRef)
          reparentQueued(shopUrl, taxonomy, termRef, parent)
          database.prepare('DELETE FROM product_taxonomies WHERE shop_url = ? AND taxonomy = ? AND term_id = ?').run(shopUrl, taxonomy, termRef)
          database.prepare('DELETE FROM taxonomy_terms WHERE shop_url = ? AND taxonomy = ? AND term_id = ?').run(shopUrl, taxonomy, termRef)
        }
        if (change.revision === parsed.revision) database.prepare('DELETE FROM taxonomy_changes WHERE id = ?').run(change.id)
        return true
      })
    },
    failTaxonomyChange(input) {
      const parsed = z.object({ changeId: z.number().int().positive(), revision: z.number().int().nonnegative(), error: z.string().max(500) }).strict().parse(input)
      database.prepare("UPDATE taxonomy_changes SET state = 'failed', error = ? WHERE id = ? AND revision = ?").run(parsed.error, parsed.changeId, parsed.revision)
      return true
    },
    listModules(input = {}) {
      const parsed = z.object({ shopUrl: shopUrlSchema.optional() }).strict().parse(input)
      const shopUrl = taxonomyShop(parsed.shopUrl)
      const rows = shopUrl ? database.prepare('SELECT module_id AS id, detected_at AS detectedAt FROM shop_modules WHERE shop_url = ?').all(shopUrl) : []
      // Detection runs with imports; without one the shop has simply not been checked yet.
      const checked = Boolean(shopUrl && database.prepare('SELECT 1 FROM taxonomies WHERE shop_url = ? LIMIT 1').get(shopUrl))
      return { shopUrl, checked, modules: modules.describeModules(rows.map((row) => row.id), shopUrl ? switchedOffModules(shopUrl) : [], shopUrl ? inactiveModules(shopUrl) : []).map((entry) => ({ ...entry, detectedAt: rows.find((row) => row.id === entry.id)?.detectedAt ?? null })) }
    },
    // Manual re-check (e.g. after installing a plugin): fresh REST namespaces plus the stored taxonomies
    // and fields of the last import, without importing taxonomies again.
    redetectModules(input) {
      const folders = z.array(z.string().max(500)).max(2000)
      const parsed = z.object({
        shopUrl: shopUrlSchema, namespaces: z.array(z.string().max(200)).max(1000), checkedAt: z.string().datetime(),
        plugins: z.object({ active: folders, inactive: folders }).strict().nullable().default(null),
      }).strict().parse(input)
      return transaction(() => {
        const taxonomies = database.prepare('SELECT taxonomy FROM taxonomies WHERE shop_url = ?').all(parsed.shopUrl).map((row) => row.taxonomy)
        if (!taxonomies.length) throw new Error('Modul: Bitte zuerst die Taxonomien importieren.')
        const context = { namespaces: parsed.namespaces, taxonomies, productFields: database.prepare('SELECT scope, field FROM product_term_fields WHERE shop_url = ?').all(parsed.shopUrl), plugins: parsed.plugins }
        storeModuleDetection(parsed.shopUrl, modules.detectModules(context), modules.inactiveModules(context), parsed.checkedAt)
        applyModuleLabels(parsed.shopUrl)
        return this.listModules({ shopUrl: parsed.shopUrl })
      })
    },
    setModuleEnabled(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema, moduleId: z.enum(modules.moduleIds), enabled: z.boolean() }).strict().parse(input)
      return transaction(() => {
        if (inactiveModules(parsed.shopUrl).includes(parsed.moduleId)) throw new Error('Modul: Das Plugin ist im Shop deaktiviert. Bitte zuerst in WordPress aktivieren.')
        if (!detectedModules(parsed.shopUrl).includes(parsed.moduleId)) throw new Error('Modul: Das Plugin wurde in diesem Shop nicht erkannt.')
        database.prepare(`INSERT INTO module_settings (shop_url, module_id, enabled, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(shop_url, module_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`).run(parsed.shopUrl, parsed.moduleId, parsed.enabled ? 1 : 0, new Date().toISOString())
        applyModuleLabels(parsed.shopUrl)
        return this.listModules({ shopUrl: parsed.shopUrl }).modules.find((entry) => entry.id === parsed.moduleId)
      })
    },
    productChangeCounts(input = {}) {
      const parsed = z.object({ shopUrl: shopUrlSchema.optional() }).strict().parse(input)
      const rows = database.prepare(`SELECT state, COUNT(*) AS count FROM product_changes ${parsed.shopUrl ? 'WHERE shop_url = ?' : ''} GROUP BY state`).all(...(parsed.shopUrl ? [parsed.shopUrl] : []))
      const count = (state) => rows.find((row) => row.state === state)?.count ?? 0
      return { pending: count('pending'), failed: count('failed'), conflict: count('conflict') }
    },
    productEditorOptions(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema.optional() }).strict().parse(input ?? {})
      const shopUrl = parsed.shopUrl ?? database.prepare(`SELECT shop_url FROM shops WHERE ${catalogShop} ORDER BY imported_at DESC LIMIT 1`).get()?.shop_url
      if (!shopUrl) return { termFields: [], shippingClasses: [], metaFields: [], previews: [] }
      const termFields = termFieldTaxonomies(shopUrl).map((field) => ({
        ...field,
        terms: queryTerms(shopUrl, field.taxonomy, field.hierarchical ? 1 : 0, '', 20_000, 0).terms.filter((term) => term.state !== 'delete').map(({ id, name, slug, path, depth }) => ({ id, name, slug, path, depth })),
      }))
      const shippingClasses = database.prepare("SELECT slug, name FROM taxonomy_terms WHERE shop_url = ? AND taxonomy = 'product_shipping_class' ORDER BY name COLLATE NOCASE").all(shopUrl)
      const active = activeModuleIds(shopUrl)
      return { termFields, shippingClasses, metaFields: modules.metaFields(active), previews: modules.previews(active) }
    },
    queueProductChange(input) {
      const parsed = productChangeSchema.parse(input)
      return transaction(() => {
        const { shopUrl, productId } = parsed
        const product = database.prepare('SELECT product_id AS id, parent_id AS parentId, name, payload FROM products WHERE shop_url = ? AND product_id = ?').get(shopUrl, productId)
        if (!product) throw new Error('Produkt wurde nicht gefunden. Bitte Produkte neu importieren.')
        const variation = product.parentId !== null
        const payload = JSON.parse(product.payload)
        const existing = database.prepare('SELECT id, changes, base, state FROM product_changes WHERE shop_url = ? AND product_id = ?').get(shopUrl, productId)
        const changes = existing ? JSON.parse(existing.changes) : {}
        const base = existing ? JSON.parse(existing.base) : {}
        const current = { ...payload, ...changes }
        const next = {}
        const metaDefinitions = new Map(metaFieldDefinitions(shopUrl, variation ? 'variation' : 'product').map((definition) => [definition.field, definition]))
        for (const [field, raw] of Object.entries(parsed.values)) {
          if (isMetaField(field)) {
            const definition = metaDefinitions.get(field)
            if (!definition) throw new Error(`Produktfeld ${field} kann nicht bearbeitet werden.`)
            const value = typeof raw === 'string' ? raw.trim() : raw === null || raw === undefined ? '' : null
            if (value === null || value.length > 10_000) throw new Error(`Produkt: ${definition.label} ist ungueltig.`)
            if (definition.type === 'select' && !definition.options.some((option) => option.value === value)) throw new Error(`Produkt: ${definition.label} ist ungueltig.`)
            if (definition.type === 'url' && value && !/^https?:\/\/[^\s]+$/i.test(value)) throw new Error(`Produkt: ${definition.label} muss eine vollstaendige Adresse sein (https://...).`)
            if (definition.type === 'primaryTerm' && value && !/^\d+$/.test(value)) throw new Error(`Produkt: ${definition.label} ist ungueltig.`)
            if (definition.type === 'image' && value && !/^https?:\/\/[^\s]+$/i.test(value)) throw new Error(`Produkt: ${definition.label} ist ungueltig.`)
            if (definition.type === 'mediaId' && value && !/^-?\d+$/.test(value)) throw new Error(`Produkt: ${definition.label} ist ungueltig.`)
            if (definition.type === 'flags') {
              // Several options in one comma-separated value, stored in the order of the options.
              const flags = value.split(',').map((entry) => entry.trim()).filter((entry) => entry && !(definition.empty ?? []).includes(entry))
              if (flags.some((flag) => !definition.options.some((option) => option.value === flag))) throw new Error(`Produkt: ${definition.label} ist ungueltig.`)
              next[field] = definition.options.filter((option) => flags.includes(option.value)).map((option) => option.value).join(',')
              continue
            }
            next[field] = value
            continue
          }
          const definition = scalarFields[field]
          if (!definition || (variation && !definition.variation) || (!variation && definition.product === false)) throw new Error(`Produktfeld ${field} kann nicht bearbeitet werden.`)
          const value = definition.schema.safeParse(raw)
          if (!value.success) throw new Error(`Produkt: ${definition.label} ist ungueltig. ${value.error.issues[0]?.message ?? ''}`.trim())
          if (field === 'status' && variation && !variationStatuses.has(value.data)) throw new Error('Produkt: Varianten koennen nur veroeffentlicht oder privat sein.')
          next[field] = field === 'images' ? value.data.map((image) => resolveImage(shopUrl, image)) : field === 'image' ? resolveImage(shopUrl, value.data) : value.data
        }
        // Image ID meta pointing to an upload: finished uploads get their media ID and URL, pending ones must exist.
        for (const [field, definition] of metaDefinitions) {
          if (definition.type !== 'mediaId' || !(field in next) || !/^-\d+$/.test(next[field])) continue
          const row = uploadedImage(shopUrl, Number(next[field]))
          if (row.state === 'done') { next[field] = String(row.mediaId); next[definition.imageField] = row.sourceUrl ?? '' }
          else next[definition.imageField] = ''
        }
        // Term fields are stored in the shop's own format ({ id, name, slug }) so the merged payload stays readable.
        const termFields = new Map(termFieldTaxonomies(shopUrl).filter((field) => field.scope === (variation ? 'variation' : 'product')).map((field) => [field.field, field]))
        const shopTerm = database.prepare('SELECT term_id AS id, name, slug FROM taxonomy_terms WHERE shop_url = ? AND taxonomy = ? AND term_id = ?')
        const pendingTerm = database.prepare("SELECT term_ref AS id, json_extract(payload, '$.name') AS name, json_extract(payload, '$.slug') AS slug FROM taxonomy_changes WHERE shop_url = ? AND taxonomy = ? AND term_ref = ? AND operation = 'create'")
        const termLookup = { get: (shop, taxonomy, id) => (id < 0 ? pendingTerm : shopTerm).get(shop, taxonomy, id) }
        for (const [field, raw] of Object.entries(parsed.terms)) {
          const definition = termFields.get(field)
          if (!definition) throw new Error(`Produktfeld ${field} kann nicht bearbeitet werden.`)
          const ids = Array.isArray(raw) ? [...new Set(raw)] : raw ? [raw] : []
          if (!definition.multiple && Array.isArray(raw)) throw new Error(`Produkt: ${definition.label} erlaubt nur einen Begriff.`)
          const terms = ids.map((id) => termLookup.get(shopUrl, definition.taxonomy, id) ?? (() => { throw new Error(`Produkt: Begriff ${id} gehoert nicht zu ${definition.label}.`) })())
          next[field] = definition.multiple ? terms : terms[0] ?? { id: 0, name: '', slug: '' }
        }
        if (next.shipping_class && !database.prepare("SELECT 1 FROM taxonomy_terms WHERE shop_url = ? AND taxonomy = 'product_shipping_class' AND slug = ?").get(shopUrl, next.shipping_class))
          throw new Error('Produkt: Versandklasse wurde nicht gefunden.')
        const merged = { ...current, ...next }
        // A primary term must be one of the product's terms of that field (e.g. Yoast's main category).
        for (const [field, definition] of metaDefinitions) {
          const value = fieldValue(merged, field)
          if (definition.type !== 'primaryTerm' || !value || !(field in next)) continue
          if (!(Array.isArray(merged[definition.of]) ? merged[definition.of] : []).some((term) => String(term.id) === String(value)))
            throw new Error(`Produkt: ${definition.label} muss zu den zugeordneten ${definition.ofLabel ?? 'Begriffen'} gehoeren.`)
        }
        if (merged.sale_price && merged.regular_price && Number(merged.sale_price) >= Number(merged.regular_price))
          throw new Error('Produkt: Der Angebotspreis muss kleiner als der regulaere Preis sein.')
        if (next.sku) {
          const duplicate = database.prepare(`SELECT p.product_id FROM products p LEFT JOIN product_changes c ON c.shop_url = p.shop_url AND c.product_id = p.product_id
            WHERE p.shop_url = ? AND p.product_id != ? AND lower(coalesce(json_extract(c.changes, '$.sku'), p.sku)) = lower(?)`).get(shopUrl, productId, next.sku)
          if (duplicate) throw new Error('Produkt: Die Artikelnummer ist bereits vergeben.')
        }
        const before = {}
        for (const [field, value] of Object.entries(next)) {
          before[field] = fieldValue(current, field)
          const original = field in base ? base[field] : fieldValue(payload, field)
          // Setting a field back to the shop value removes it from the change.
          if (same(value, original)) { delete changes[field]; delete base[field] }
          else { changes[field] = value; base[field] = original }
        }
        const now = new Date().toISOString()
        const labels = Object.fromEntries(Object.keys(next).map((field) => [field, scalarFields[field]?.label ?? termFields.get(field)?.label ?? metaDefinitions.get(field)?.label ?? field]))
        const result = { productId, name: merged.name || product.name, variation, before, after: next, labels }
        if (!Object.keys(changes).length) {
          if (existing) database.prepare('DELETE FROM product_changes WHERE id = ?').run(existing.id)
          return { ...result, queued: false }
        }
        if (existing) database.prepare("UPDATE product_changes SET changes = ?, base = ?, remote = NULL, state = 'pending', error = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(changes), JSON.stringify(base), now, existing.id)
        else database.prepare('INSERT INTO product_changes (shop_url, product_id, changes, base, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(shopUrl, productId, JSON.stringify(changes), JSON.stringify(base), now, now)
        return { ...result, queued: true }
      })
    },
    discardProductChange(input) {
      const parsed = productRefSchema.parse(input)
      const change = database.prepare('SELECT c.id, c.changes, p.name FROM product_changes c JOIN products p ON p.shop_url = c.shop_url AND p.product_id = c.product_id WHERE c.shop_url = ? AND c.product_id = ?').get(parsed.shopUrl, parsed.productId)
      if (!change) throw new Error('Aenderung wurde nicht gefunden.')
      database.prepare('DELETE FROM product_changes WHERE id = ?').run(change.id)
      return { name: change.name, fields: Object.keys(JSON.parse(change.changes)) }
    },
    // After a conflict: "mine" keeps the edit and accepts the shop value as new base, "shop" drops the edit.
    resolveProductConflict(input) {
      const parsed = productRefSchema.extend({ resolutions: z.record(z.string().max(80), z.enum(['mine', 'shop'])) }).strict().parse(input)
      return transaction(() => {
        const change = database.prepare("SELECT id, changes, base, remote FROM product_changes WHERE shop_url = ? AND product_id = ? AND state = 'conflict'").get(parsed.shopUrl, parsed.productId)
        if (!change) throw new Error('Aenderung wurde nicht gefunden.')
        const changes = JSON.parse(change.changes)
        const base = JSON.parse(change.base)
        const remote = JSON.parse(change.remote ?? '{}')
        for (const field of Object.keys(remote)) if (!parsed.resolutions[field]) throw new Error('Aenderung: Bitte jeden Konflikt entscheiden.')
        const kept = []
        const dropped = []
        for (const [field, choice] of Object.entries(parsed.resolutions)) {
          if (!(field in remote)) continue
          if (choice === 'mine') { base[field] = remote[field]; kept.push(field) }
          else { delete changes[field]; delete base[field]; dropped.push(field) }
        }
        // Shop values taken over are written into the local copy so the list shows them before the next import.
        if (dropped.length) {
          const row = database.prepare('SELECT payload FROM products WHERE shop_url = ? AND product_id = ?').get(parsed.shopUrl, parsed.productId)
          const payload = JSON.parse(row.payload)
          for (const field of dropped) setFieldValue(payload, field, remote[field])
          database.prepare('UPDATE products SET payload = ?, name = coalesce(?, name), sku = coalesce(?, sku), status = coalesce(?, status) WHERE shop_url = ? AND product_id = ?')
            .run(JSON.stringify(payload), dropped.includes('name') ? remote.name : null, dropped.includes('sku') ? remote.sku : null, dropped.includes('status') ? remote.status : null, parsed.shopUrl, parsed.productId)
        }
        if (!Object.keys(changes).length) database.prepare('DELETE FROM product_changes WHERE id = ?').run(change.id)
        else database.prepare("UPDATE product_changes SET changes = ?, base = ?, remote = NULL, state = 'pending', error = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(changes), JSON.stringify(base), new Date().toISOString(), change.id)
        return { kept, dropped, remote }
      })
    },
    retryProductChanges(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema }).strict().parse(input)
      database.prepare("UPDATE product_changes SET state = 'pending', error = NULL WHERE shop_url = ? AND state = 'failed'").run(parsed.shopUrl)
      database.prepare("UPDATE media_uploads SET state = 'pending', error = NULL WHERE shop_url = ? AND state = 'failed'").run(parsed.shopUrl)
      return true
    },
    pendingProductChanges(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema }).strict().parse(input)
      return database.prepare(`SELECT c.id, c.product_id AS productId, c.changes, c.base, c.revision, p.parent_id AS parentId, p.name, parent.name AS parentName
        FROM product_changes c JOIN products p ON p.shop_url = c.shop_url AND p.product_id = c.product_id
        LEFT JOIN products parent ON parent.shop_url = p.shop_url AND parent.product_id = p.parent_id
        WHERE c.shop_url = ? AND c.state = 'pending' ORDER BY c.id`).all(parsed.shopUrl)
        .map((row) => ({ ...row, changes: JSON.parse(row.changes), base: JSON.parse(row.base) }))
    },
    // Stores the shop's answer. Fields the shop did not take over stay as a failed change.
    completeProductChange(input) {
      const parsed = z.object({ changeId: z.number().int().positive(), revision: z.number().int().nonnegative(), product: catalogProductSchema, ignored: z.array(z.string().max(80)).default([]) }).strict().parse(input)
      return transaction(() => {
        const change = database.prepare('SELECT id, shop_url AS shopUrl, changes, base, revision FROM product_changes WHERE id = ?').get(parsed.changeId)
        if (!change) return false
        productWriter(change.shopUrl)(parsed.product)
        const changes = JSON.parse(change.changes)
        const base = JSON.parse(change.base)
        const sent = parsed.product.payload
        if (change.revision === parsed.revision) {
          const remaining = Object.fromEntries(parsed.ignored.filter((field) => field in changes).map((field) => [field, changes[field]]))
          if (!Object.keys(remaining).length) database.prepare('DELETE FROM product_changes WHERE id = ?').run(change.id)
          else database.prepare("UPDATE product_changes SET changes = ?, base = ?, state = 'failed', error = ? WHERE id = ?")
            .run(JSON.stringify(remaining), JSON.stringify(Object.fromEntries(Object.keys(remaining).map((field) => [field, fieldValue(sent, field)]))), `Der Shop hat ${Object.keys(remaining).map((field) => scalarFields[field]?.label ?? termFieldTaxonomies(change.shopUrl).find((entry) => entry.field === field)?.label ?? modules.metaFields(activeModuleIds(change.shopUrl)).find((entry) => entry.field === field)?.label ?? field).join(', ')} nicht uebernommen.`, change.id)
          return true
        }
        // Edited again while the request was running: the shop's answer is the new base for the sent fields.
        for (const field of Object.keys(base)) base[field] = fieldValue(sent, field)
        for (const field of Object.keys(changes)) if (same(changes[field], fieldValue(sent, field))) { delete changes[field]; delete base[field] }
        if (!Object.keys(changes).length) database.prepare('DELETE FROM product_changes WHERE id = ?').run(change.id)
        else database.prepare('UPDATE product_changes SET changes = ?, base = ? WHERE id = ?').run(JSON.stringify(changes), JSON.stringify(base), change.id)
        return true
      })
    },
    markProductChange(input) {
      const parsed = z.object({ changeId: z.number().int().positive(), revision: z.number().int().nonnegative(), state: z.enum(['failed', 'conflict']), error: z.string().max(500).nullable().default(null), remote: z.record(z.string(), z.unknown()).nullable().default(null) }).strict().parse(input)
      database.prepare('UPDATE product_changes SET state = ?, error = ?, remote = ? WHERE id = ? AND revision = ?').run(parsed.state, parsed.error, parsed.remote ? JSON.stringify(parsed.remote) : null, parsed.changeId, parsed.revision)
      return true
    },
    // Stores media read from WordPress. `ids` (all IDs currently in the library) removes deleted items;
    // without it only the given items are added or updated.
    storeMediaLibrary(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema, syncedAt: z.string().datetime(), items: z.array(mediaItemSchema).max(200_000), ids: z.array(z.number().int().positive()).max(200_000).nullable() }).strict().parse(input)
      return transaction(() => {
        upsertMediaItems(parsed.shopUrl, parsed.items)
        let removed = 0
        if (parsed.ids) {
          const ids = JSON.stringify(parsed.ids)
          removed = database.prepare('DELETE FROM media_items WHERE shop_url = ? AND media_id NOT IN (SELECT value FROM json_each(?))').run(parsed.shopUrl, ids).changes
          database.prepare('DELETE FROM media_changes WHERE shop_url = ? AND media_id NOT IN (SELECT value FROM json_each(?))').run(parsed.shopUrl, ids)
        }
        const lastModified = database.prepare('SELECT max(modified_at) AS last FROM media_items WHERE shop_url = ?').get(parsed.shopUrl).last
        database.prepare(`INSERT INTO media_library_state (shop_url, imported_at, synced_at, last_modified) VALUES (?, ?, ?, ?)
          ON CONFLICT(shop_url) DO UPDATE SET synced_at = excluded.synced_at, last_modified = excluded.last_modified`).run(parsed.shopUrl, parsed.syncedAt, parsed.syncedAt, lastModified)
        return { stored: parsed.items.length, removed, ...this.mediaLibraryState({ shopUrl: parsed.shopUrl }) }
      })
    },
    mediaThumb(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema, mediaId: z.number().int().positive() }).strict().parse(input)
      return database.prepare('SELECT thumb_url AS thumbUrl FROM media_items WHERE shop_url = ? AND media_id = ?').get(parsed.shopUrl, parsed.mediaId)?.thumbUrl ?? null
    },
    mediaLibraryState(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema }).strict().parse(input)
      const state = database.prepare('SELECT imported_at AS importedAt, synced_at AS syncedAt, last_modified AS lastModified, trash FROM media_library_state WHERE shop_url = ?').get(parsed.shopUrl)
      const { count, readOnly } = database.prepare('SELECT COUNT(*) AS count, coalesce(sum(editable = 0), 0) AS readOnly FROM media_items WHERE shop_url = ?').get(parsed.shopUrl)
      const uploads = database.prepare("SELECT COUNT(*) AS count FROM media_uploads WHERE shop_url = ? AND state != 'done'").get(parsed.shopUrl).count
      return { imported: Boolean(state), importedAt: state?.importedAt ?? null, syncedAt: state?.syncedAt ?? null, lastModified: state?.lastModified ?? null, trash: state?.trash === undefined || state?.trash === null ? null : state.trash === 1, count, readOnly, uploads, changeCounts: this.mediaChangeCounts({ shopUrl: parsed.shopUrl }) }
    },
    // Media library page and image picker: queued edits applied, filtered and paged in memory (usage needs all products).
    listMedia(input) {
      const parsed = z.object({
        shopUrl: shopUrlSchema, query: z.string().trim().max(200).default(''), filter: z.enum(['all', 'unused', 'noAlt', 'changed', 'pending']).default('all'),
        page: z.number().int().nonnegative().max(100_000).default(0), pageSize: z.number().int().min(1).max(200).default(60),
      }).strict().parse(input)
      const usage = mediaUsage(parsed.shopUrl)
      const needle = parsed.query.toLowerCase()
      // Uploads still waiting for WordPress come first; they are part of the library from the moment they are picked.
      const library = database.prepare(`SELECT ${mediaRow} FROM media_items m LEFT JOIN media_changes c ON c.shop_url = m.shop_url AND c.media_id = m.media_id
        WHERE m.shop_url = ? ORDER BY coalesce(m.uploaded_at, '') DESC, m.media_id DESC`).all(parsed.shopUrl).map(toMediaRow)
      const matches = {
        all: () => true, unused: (row) => !row.usage, noAlt: (row) => !row.upload && !row.alt.trim(),
        changed: (row) => Boolean(row.changeState || row.upload), pending: (row) => Boolean(row.upload),
      }[parsed.filter]
      const rows = [...uploadRows(parsed.shopUrl), ...library]
        .map((row) => ({ ...row, usage: usage.get(row.id)?.length ?? 0 }))
        .filter((row) => !needle || [row.title, row.alt, row.filename].some((value) => value.toLowerCase().includes(needle)))
        .filter(matches)
      return { items: rows.slice(parsed.page * parsed.pageSize, (parsed.page + 1) * parsed.pageSize), total: rows.length, page: parsed.page, pageSize: parsed.pageSize, ...this.mediaLibraryState({ shopUrl: parsed.shopUrl }) }
    },
    mediaDetail(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema, mediaId: z.number().int().refine((id) => id !== 0) }).strict().parse(input)
      const usedIn = mediaUsage(parsed.shopUrl).get(parsed.mediaId) ?? []
      if (parsed.mediaId < 0) {
        const [upload] = uploadRows(parsed.shopUrl, -parsed.mediaId)
        if (!upload) throw new Error('Medium: Das Bild ist bereits in WordPress. Bitte die Mediathek neu laden.')
        return { ...upload, usedIn }
      }
      const row = database.prepare(`SELECT ${mediaRow} FROM media_items m LEFT JOIN media_changes c ON c.shop_url = m.shop_url AND c.media_id = m.media_id WHERE m.shop_url = ? AND m.media_id = ?`).get(parsed.shopUrl, parsed.mediaId)
      if (!row) throw new Error('Medium: Das Bild ist nicht (mehr) in der Mediathek. Bitte abgleichen.')
      return { ...toMediaRow(row), usedIn }
    },
    mediaChangeCounts(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema }).strict().parse(input)
      const rows = database.prepare('SELECT state, COUNT(*) AS count FROM media_changes WHERE shop_url = ? GROUP BY state').all(parsed.shopUrl)
      const count = (state) => rows.find((row) => row.state === state)?.count ?? 0
      return { pending: count('pending'), failed: count('failed'), conflict: count('conflict') }
    },
    queueMediaChange(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema, mediaId: z.number().int().positive(), values: mediaValuesSchema }).strict().parse(input)
      return transaction(() => {
        const item = database.prepare('SELECT title, alt, caption, description, filename, editable FROM media_items WHERE shop_url = ? AND media_id = ?').get(parsed.shopUrl, parsed.mediaId)
        if (!item) throw new Error('Medium: Das Bild ist nicht (mehr) in der Mediathek. Bitte abgleichen.')
        const existing = database.prepare('SELECT id, changes, base, operation FROM media_changes WHERE shop_url = ? AND media_id = ?').get(parsed.shopUrl, parsed.mediaId)
        if (existing?.operation === 'delete') throw new Error('Medium: Das Bild ist zum Loeschen vorgemerkt.')
        if (!item.editable) throw new Error('Medium: Zum Bearbeiten bitte ein Anwendungspasswort hinterlegen und die Mediathek abgleichen.')
        const changes = existing ? JSON.parse(existing.changes) : {}
        const base = existing ? JSON.parse(existing.base) : {}
        const before = {}
        for (const [field, value] of Object.entries(parsed.values)) {
          before[field] = field in changes ? changes[field] : item[field]
          const original = field in base ? base[field] : item[field]
          if (value === original) { delete changes[field]; delete base[field] }
          else { changes[field] = value; base[field] = original }
        }
        const result = { mediaId: parsed.mediaId, name: (changes.title ?? item.title) || item.filename, before, after: parsed.values, labels: mediaFields }
        const now = new Date().toISOString()
        if (!Object.keys(changes).length) {
          if (existing) database.prepare('DELETE FROM media_changes WHERE id = ?').run(existing.id)
          return { ...result, queued: false }
        }
        if (existing) database.prepare("UPDATE media_changes SET changes = ?, base = ?, remote = NULL, state = 'pending', error = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(changes), JSON.stringify(base), now, existing.id)
        else database.prepare('INSERT INTO media_changes (shop_url, media_id, changes, base, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(parsed.shopUrl, parsed.mediaId, JSON.stringify(changes), JSON.stringify(base), now, now)
        return { ...result, queued: true }
      })
    },
    discardMediaChange(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema, mediaId: z.number().int().positive() }).strict().parse(input)
      const change = database.prepare('SELECT c.id, c.changes, c.operation, m.title, m.filename FROM media_changes c JOIN media_items m ON m.shop_url = c.shop_url AND m.media_id = c.media_id WHERE c.shop_url = ? AND c.media_id = ?').get(parsed.shopUrl, parsed.mediaId)
      if (!change) throw new Error('Medium: Aenderung wurde nicht gefunden.')
      database.prepare('DELETE FROM media_changes WHERE id = ?').run(change.id)
      return { name: change.title || change.filename, fields: Object.keys(JSON.parse(change.changes)), operation: change.operation }
    },
    // After a conflict: "mine" keeps the edit on top of the WordPress value, "shop" takes the WordPress value.
    resolveMediaConflict(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema, mediaId: z.number().int().positive(), resolutions: z.partialRecord(z.enum(Object.keys(mediaFields)), z.enum(['mine', 'shop'])) }).strict().parse(input)
      return transaction(() => {
        const change = database.prepare("SELECT id, changes, base, remote FROM media_changes WHERE shop_url = ? AND media_id = ? AND state = 'conflict'").get(parsed.shopUrl, parsed.mediaId)
        if (!change) throw new Error('Medium: Aenderung wurde nicht gefunden.')
        const changes = JSON.parse(change.changes)
        const base = JSON.parse(change.base)
        const remote = JSON.parse(change.remote ?? '{}')
        for (const field of Object.keys(remote)) if (!parsed.resolutions[field]) throw new Error('Medium: Bitte jeden Konflikt entscheiden.')
        const kept = []
        const dropped = []
        const update = database.prepare('UPDATE media_items SET title = CASE WHEN ? = \'title\' THEN ? ELSE title END, alt = CASE WHEN ? = \'alt\' THEN ? ELSE alt END, caption = CASE WHEN ? = \'caption\' THEN ? ELSE caption END, description = CASE WHEN ? = \'description\' THEN ? ELSE description END WHERE shop_url = ? AND media_id = ?')
        for (const [field, choice] of Object.entries(parsed.resolutions)) {
          if (!(field in remote)) continue
          if (choice === 'mine') { base[field] = remote[field]; kept.push(field) }
          else { delete changes[field]; delete base[field]; dropped.push(field) }
          update.run(field, remote[field], field, remote[field], field, remote[field], field, remote[field], parsed.shopUrl, parsed.mediaId)
        }
        if (!Object.keys(changes).length) database.prepare('DELETE FROM media_changes WHERE id = ?').run(change.id)
        else database.prepare("UPDATE media_changes SET changes = ?, base = ?, remote = NULL, state = 'pending', error = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(changes), JSON.stringify(base), new Date().toISOString(), change.id)
        return { kept, dropped, remote }
      })
    },
    retryMediaChanges(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema }).strict().parse(input)
      database.prepare("UPDATE media_changes SET state = 'pending', error = NULL WHERE shop_url = ? AND state = 'failed'").run(parsed.shopUrl)
      database.prepare("UPDATE media_uploads SET state = 'pending', error = NULL WHERE shop_url = ? AND state = 'failed'").run(parsed.shopUrl)
      return true
    },
    pendingMediaChanges(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema }).strict().parse(input)
      return database.prepare(`SELECT c.id, c.media_id AS mediaId, c.changes, c.base, c.revision, coalesce(nullif(m.title, ''), m.filename) AS name
        FROM media_changes c JOIN media_items m ON m.shop_url = c.shop_url AND m.media_id = c.media_id WHERE c.shop_url = ? AND c.state = 'pending' AND c.operation = 'update' ORDER BY c.id`).all(parsed.shopUrl)
        .map((row) => ({ ...row, changes: JSON.parse(row.changes), base: JSON.parse(row.base) }))
    },
    // Stores WordPress's answer; fields it did not take over stay as a failed change.
    completeMediaChange(input) {
      const parsed = z.object({ changeId: z.number().int().positive(), revision: z.number().int().nonnegative(), item: mediaItemSchema, ignored: z.array(z.enum(Object.keys(mediaFields))).default([]) }).strict().parse(input)
      return transaction(() => {
        const change = database.prepare('SELECT id, shop_url AS shopUrl, changes, revision FROM media_changes WHERE id = ?').get(parsed.changeId)
        if (!change) return false
        upsertMediaItems(change.shopUrl, [parsed.item])
        const changes = JSON.parse(change.changes)
        if (change.revision !== parsed.revision) {
          // Edited again meanwhile: the answer is the new base; fields already equal are done.
          const next = Object.fromEntries(Object.entries(changes).filter(([field, value]) => parsed.item[field] !== value))
          if (!Object.keys(next).length) database.prepare('DELETE FROM media_changes WHERE id = ?').run(change.id)
          else database.prepare('UPDATE media_changes SET changes = ?, base = ? WHERE id = ?').run(JSON.stringify(next), JSON.stringify(Object.fromEntries(Object.keys(next).map((field) => [field, parsed.item[field]]))), change.id)
          return true
        }
        const remaining = Object.fromEntries(parsed.ignored.filter((field) => field in changes).map((field) => [field, changes[field]]))
        if (!Object.keys(remaining).length) database.prepare('DELETE FROM media_changes WHERE id = ?').run(change.id)
        else database.prepare("UPDATE media_changes SET changes = ?, base = ?, state = 'failed', error = ? WHERE id = ?")
          .run(JSON.stringify(remaining), JSON.stringify(Object.fromEntries(Object.keys(remaining).map((field) => [field, parsed.item[field]]))), `WordPress hat ${Object.keys(remaining).map((field) => mediaFields[field]).join(', ')} nicht uebernommen.`, change.id)
        return true
      })
    },
    markMediaChange(input) {
      const parsed = z.object({ changeId: z.number().int().positive(), revision: z.number().int().nonnegative(), state: z.enum(['failed', 'conflict']), error: z.string().max(500).nullable().default(null), remote: z.record(z.string(), z.string()).nullable().default(null), item: mediaItemSchema.nullable().default(null) }).strict().parse(input)
      return transaction(() => {
        const change = database.prepare('SELECT shop_url AS shopUrl FROM media_changes WHERE id = ?').get(parsed.changeId)
        if (change && parsed.item) upsertMediaItems(change.shopUrl, [parsed.item])
        database.prepare('UPDATE media_changes SET state = ?, error = ?, remote = ? WHERE id = ? AND revision = ?').run(parsed.state, parsed.error, parsed.remote ? JSON.stringify(parsed.remote) : null, parsed.changeId, parsed.revision)
        return true
      })
    },
    addMediaUpload(input) {
      const parsed = z.object({
        shopUrl: shopUrlSchema, file: z.string().regex(/^[a-f0-9-]{36}\.(jpg|png|gif|webp)$/), filename: z.string().min(1).max(255),
        mime: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']), size: z.number().int().positive().max(20 * 1024 * 1024),
        thumbnail: z.string().startsWith('data:image/').max(400_000).nullable(),
      }).strict().parse(input)
      const row = database.prepare('INSERT INTO media_uploads (shop_url, file, filename, mime, size, thumbnail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
        .get(parsed.shopUrl, parsed.file, parsed.filename, parsed.mime, parsed.size, parsed.thumbnail, new Date().toISOString())
      return { id: -row.id, name: parsed.filename, thumbnail: parsed.thumbnail, state: 'pending', error: null }
    },
    // Deletes an image: first it is removed from every product that uses it (queued product edits),
    // then the deletion in WordPress is queued; it is sent once those product edits reached the shop.
    // A pending upload is simply dropped.
    deleteMedia(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema, mediaId: z.number().int().refine((id) => id !== 0) }).strict().parse(input)
      return transaction(() => {
        const { shopUrl, mediaId } = parsed
        const upload = mediaId < 0 ? database.prepare("SELECT id, file, filename FROM media_uploads WHERE shop_url = ? AND id = ? AND state != 'done'").get(shopUrl, -mediaId) : null
        const item = mediaId > 0 ? database.prepare('SELECT title, filename FROM media_items WHERE shop_url = ? AND media_id = ?').get(shopUrl, mediaId) : null
        if (!upload && !item) throw new Error('Medium: Das Bild ist nicht (mehr) in der Mediathek.')
        const name = upload ? upload.filename : item.title || item.filename
        const imageFields = mediaIdFields().filter((field) => activeModuleIds(shopUrl).includes(field.module))
        const merged = database.prepare(`SELECT p.parent_id AS parentId, CASE WHEN c.id IS NULL THEN p.payload ELSE json_patch(p.payload, c.changes) END AS payload
          FROM products p LEFT JOIN product_changes c ON c.shop_url = p.shop_url AND c.product_id = p.product_id WHERE p.shop_url = ? AND p.product_id = ?`)
        const products = [...new Map((mediaUsage(shopUrl).get(mediaId) ?? []).filter((entry) => entry.productId).map((entry) => [entry.productId, entry])).values()]
        // An open conflict must be decided first; removing the image would silently override it.
        const inConflict = products.filter((entry) => database.prepare("SELECT 1 FROM product_changes WHERE shop_url = ? AND product_id = ? AND state = 'conflict'").get(shopUrl, entry.productId))
        if (inConflict.length) throw new Error(`Medium: Bitte zuerst den Konflikt bei ${inConflict.map((entry) => `„${entry.name}“`).join(', ')} loesen.`)
        for (const product of products) {
          const row = merged.get(shopUrl, product.productId)
          const payload = JSON.parse(row.payload)
          const values = {}
          if (row.parentId === null && Array.isArray(payload.images) && payload.images.some((image) => Number(image?.id) === mediaId))
            values.images = payload.images.filter((image) => Number(image?.id) !== mediaId)
          if (row.parentId !== null && Number(payload.image?.id) === mediaId) values.image = null
          for (const field of imageFields) if (String(fieldValue(payload, field.field) ?? '') === String(mediaId)) { values[field.field] = ''; values[field.imageField] = '' }
          if (Object.keys(values).length) this.queueProductChange({ shopUrl, productId: product.productId, values, terms: {} })
        }
        const removedFrom = products.map((entry) => ({ productId: entry.productId, parentId: entry.parentId, name: entry.name }))
        if (upload) {
          database.prepare('DELETE FROM media_uploads WHERE id = ?').run(upload.id)
          return { name, removedFrom, file: upload.file, queued: false }
        }
        const now = new Date().toISOString()
        database.prepare(`INSERT INTO media_changes (shop_url, media_id, changes, base, operation, products, created_at, updated_at) VALUES (?, ?, '{}', '{}', 'delete', ?, ?, ?)
          ON CONFLICT(shop_url, media_id) DO UPDATE SET changes = '{}', base = '{}', remote = NULL, operation = 'delete', products = excluded.products, usage = NULL, force = 0, state = 'pending', error = NULL, revision = revision + 1, updated_at = excluded.updated_at`)
          .run(shopUrl, mediaId, JSON.stringify(removedFrom.map((entry) => entry.productId)), now, now)
        return { name, removedFrom, file: null, queued: true }
      })
    },
    // Deletions whose products have no queued edits left (the removal reached the shop).
    pendingMediaDeletions(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema }).strict().parse(input)
      const usage = mediaUsage(parsed.shopUrl)
      return database.prepare(`SELECT c.id, c.media_id AS mediaId, c.revision, c.force, coalesce(nullif(m.title, ''), m.filename) AS name, m.thumb_url AS thumbUrl, m.source_url AS sourceUrl
        FROM media_changes c JOIN media_items m ON m.shop_url = c.shop_url AND m.media_id = c.media_id
        WHERE c.shop_url = ? AND c.state = 'pending' AND c.operation = 'delete'
          AND NOT EXISTS (SELECT 1 FROM product_changes pc, json_each(c.products) affected WHERE pc.shop_url = c.shop_url AND pc.product_id = affected.value)
        ORDER BY c.id`).all(parsed.shopUrl)
        // Places known locally that the deletion would break (product uses are removed beforehand).
        .map((row) => ({ ...row, force: row.force === 1, localPlaces: (usage.get(row.mediaId) ?? []).map((entry) => ({ kind: entry.productId ? 'Produkt' : 'Begriff', title: entry.name, where: entry.role })) }))
    },
    // Found in use in WordPress: held until the user forces the deletion (or cancels it).
    holdMediaDeletion(input) {
      const place = z.object({ kind: z.string().max(200), title: z.string().max(500), where: z.string().max(200), link: z.string().max(2048).optional() }).strict()
      const parsed = z.object({ changeId: z.number().int().positive(), revision: z.number().int().nonnegative(), places: z.array(place).min(1).max(200), error: z.string().max(500) }).strict().parse(input)
      database.prepare("UPDATE media_changes SET state = 'failed', usage = ?, error = ? WHERE id = ? AND revision = ? AND operation = 'delete'").run(JSON.stringify(parsed.places), parsed.error, parsed.changeId, parsed.revision)
      return true
    },
    forceMediaDeletion(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema, mediaId: z.number().int().positive() }).strict().parse(input)
      const changed = database.prepare("UPDATE media_changes SET force = 1, state = 'pending', error = NULL, revision = revision + 1, updated_at = ? WHERE shop_url = ? AND media_id = ? AND operation = 'delete'")
        .run(new Date().toISOString(), parsed.shopUrl, parsed.mediaId).changes
      if (!changed) throw new Error('Medium: Das Bild ist nicht zum Loeschen vorgemerkt.')
      const row = database.prepare('SELECT coalesce(nullif(title, \'\'), filename) AS name, usage FROM media_items m JOIN media_changes c USING (shop_url, media_id) WHERE m.shop_url = ? AND m.media_id = ?').get(parsed.shopUrl, parsed.mediaId)
      return { name: row?.name ?? `#${parsed.mediaId}`, places: row?.usage ? JSON.parse(row.usage) : [] }
    },
    completeMediaDeletion(input) {
      const parsed = z.object({ changeId: z.number().int().positive(), trashed: z.boolean() }).strict().parse(input)
      return transaction(() => {
        const change = database.prepare("SELECT shop_url AS shopUrl, media_id AS mediaId FROM media_changes WHERE id = ? AND operation = 'delete'").get(parsed.changeId)
        if (!change) return false
        database.prepare('UPDATE media_library_state SET trash = ? WHERE shop_url = ?').run(parsed.trashed ? 1 : 0, change.shopUrl)
        database.prepare('DELETE FROM media_items WHERE shop_url = ? AND media_id = ?').run(change.shopUrl, change.mediaId)
        database.prepare('DELETE FROM media_changes WHERE id = ?').run(parsed.changeId)
        return true
      })
    },
    // Uploads that have not reached the shop yet, with their preview for the editor.
    listMediaUploads(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema }).strict().parse(input)
      return database.prepare("SELECT -id AS id, filename AS name, thumbnail, state, error FROM media_uploads WHERE shop_url = ? AND state != 'done' ORDER BY id DESC").all(parsed.shopUrl)
    },
    pendingMediaUploads(input) {
      const parsed = z.object({ shopUrl: shopUrlSchema }).strict().parse(input)
      return database.prepare("SELECT id, file, filename, mime FROM media_uploads WHERE shop_url = ? AND state = 'pending' ORDER BY id").all(parsed.shopUrl)
    },
    // The shop has the file: queued edits get the real media ID (internal bookkeeping, revisions stay).
    completeMediaUpload(input) {
      const parsed = z.object({ uploadId: z.number().int().positive(), mediaId: z.number().int().positive(), sourceUrl: z.string().url().max(2048), item: mediaItemSchema.nullable().default(null) }).strict().parse(input)
      return transaction(() => {
        const upload = database.prepare('SELECT shop_url AS shopUrl, file, filename FROM media_uploads WHERE id = ?').get(parsed.uploadId)
        if (!upload) return null
        // The new image belongs to the local media library right away, imported or not.
        if (parsed.item) upsertMediaItems(upload.shopUrl, [parsed.item])
        database.prepare("UPDATE media_uploads SET state = 'done', media_id = ?, source_url = ?, error = NULL, thumbnail = NULL WHERE id = ?").run(parsed.mediaId, parsed.sourceUrl, parsed.uploadId)
        const update = database.prepare('UPDATE product_changes SET changes = ? WHERE id = ?')
        for (const row of database.prepare('SELECT id, changes FROM product_changes WHERE shop_url = ?').all(upload.shopUrl)) {
          const changes = JSON.parse(row.changes)
          if (rewriteUploadRefs(changes, -parsed.uploadId, { id: parsed.mediaId, src: parsed.sourceUrl })) update.run(JSON.stringify(changes), row.id)
        }
        return upload
      })
    },
    // Rejected by the shop: the upload and every edit that needs it are shown as failed (retry resets both).
    failMediaUpload(input) {
      const parsed = z.object({ uploadId: z.number().int().positive(), error: z.string().max(500) }).strict().parse(input)
      return transaction(() => {
        const upload = database.prepare('SELECT shop_url AS shopUrl, filename FROM media_uploads WHERE id = ?').get(parsed.uploadId)
        if (!upload) return null
        database.prepare("UPDATE media_uploads SET state = 'failed', error = ? WHERE id = ?").run(parsed.error, parsed.uploadId)
        const fail = database.prepare("UPDATE product_changes SET state = 'failed', error = ? WHERE id = ?")
        for (const row of database.prepare("SELECT id, changes FROM product_changes WHERE shop_url = ? AND state = 'pending'").all(upload.shopUrl))
          if (rewriteUploadRefs(JSON.parse(row.changes), -parsed.uploadId, null)) fail.run(`Bild „${upload.filename}“ konnte nicht hochgeladen werden: ${parsed.error}`.slice(0, 500), row.id)
        return upload
      })
    },
    appendAudit(input) {
      const entry = auditEntrySchema.parse(input)
      const details = entry.details ? JSON.stringify(entry.details) : null
      if (details && details.length > 64 * 1024) throw new Error('Audit details too large.')
      database.prepare(`INSERT INTO audit_log (occurred_at, category, action, summary, outcome, source, user_id, username, user_name, target_type, target_id, target_label, shop_url, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(new Date().toISOString(), entry.category, entry.action, entry.summary, entry.outcome, entry.source,
        entry.userId, entry.username, entry.userName, entry.targetType, entry.targetId, entry.targetLabel, entry.shopUrl, details)
      return true
    },
    listAudit(input = {}) {
      const parsed = auditQuerySchema.parse(input)
      const where = []
      const values = []
      if (parsed.category) { where.push('category = ?'); values.push(parsed.category) }
      if (parsed.outcome) { where.push('outcome = ?'); values.push(parsed.outcome) }
      if (parsed.userId === 'system') where.push("source = 'system'")
      else if (parsed.userId) { where.push('user_id = ?'); values.push(parsed.userId) }
      if (parsed.from) { where.push('occurred_at >= ?'); values.push(parsed.from) }
      if (parsed.to) { where.push('occurred_at < ?'); values.push(parsed.to) }
      if (parsed.query) {
        const like = `%${parsed.query.replace(/[\\%_]/g, '\\$&')}%`
        where.push(`(summary LIKE ? ESCAPE '\\' OR target_label LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' OR user_name LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\')`)
        values.push(like, like, like, like, like)
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const total = database.prepare(`SELECT COUNT(*) AS total FROM audit_log ${whereSql}`).get(...values).total
      const entries = database.prepare(`SELECT id, occurred_at AS occurredAt, category, action, summary, outcome, source, user_id AS userId, username, user_name AS userName,
          target_type AS targetType, target_id AS targetId, target_label AS targetLabel, shop_url AS shopUrl, details
        FROM audit_log ${whereSql} ORDER BY occurred_at DESC, id DESC LIMIT ${parsed.pageSize} OFFSET ${parsed.page * parsed.pageSize}`).all(...values)
        .map((entry) => ({ ...entry, details: entry.details ? JSON.parse(entry.details) : null }))
      const users = database.prepare(`SELECT user_id AS id, max(user_name) AS name, max(username) AS username FROM audit_log WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY name COLLATE NOCASE`).all()
      return { entries, total, page: parsed.page, pageSize: parsed.pageSize, users }
    },
    close() { database.close() },
  }
}

module.exports = { openDatabase }
