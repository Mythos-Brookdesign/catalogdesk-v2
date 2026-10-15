const { DatabaseSync } = require('node:sqlite')
const { mkdirSync } = require('node:fs')
const path = require('node:path')
const { z } = require('zod')

const shopUrlSchema = z.string().url().max(2048).refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
})
const searchSchema = z.object({
  shopUrl: shopUrlSchema.optional(),
  query: z.string().trim().max(200).default(''),
  type: z.enum(['all', 'simple', 'variable', 'variation']).default('all'),
  page: z.number().int().min(0).max(1_000_000).default(0),
  pageSize: z.number().int().min(1).max(100).default(50),
}).strict()
const catalogSchema = z.object({
  shopUrl: shopUrlSchema,
  importedAt: z.string().datetime(),
  products: z.array(z.object({
    id: z.number().int().positive(),
    parentId: z.number().int().positive().nullable(),
    type: z.enum(['simple', 'variable', 'variation']),
    sku: z.string().max(255),
    name: z.string().max(1000),
    status: z.string().max(80),
    payload: z.record(z.string(), z.unknown()),
    taxonomies: z.object({
      categories: z.array(z.object({ id: z.number().int().positive(), name: z.string(), slug: z.string() }).strict()).max(1000),
      tags: z.array(z.object({ id: z.number().int().positive(), name: z.string(), slug: z.string() }).strict()).max(1000),
      brands: z.array(z.object({ id: z.number().int().positive(), name: z.string(), slug: z.string() }).strict()).max(1000),
    }).strict(),
  }).strict()).min(1).max(50_000),
}).strict()

function openDatabase(filename) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(filename)
  try {
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    database.exec('BEGIN IMMEDIATE')
    const version = database.prepare('PRAGMA user_version').get().user_version
    if (version > 1) throw new Error('Database schema is newer than this app.')
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
    database.exec('COMMIT')
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK')
    database.close()
    throw error
  }

  return {
    workspaceSummary() {
      const shops = database.prepare('SELECT COUNT(*) AS count FROM shops').get().count
      const counts = database.prepare('SELECT type, COUNT(*) AS count FROM products GROUP BY type').all()
      const latestShop = database.prepare('SELECT shop_url AS shopUrl, imported_at AS importedAt FROM shops ORDER BY imported_at DESC LIMIT 1').get() ?? null
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
      const shopUrl = parsed.shopUrl ?? database.prepare('SELECT shop_url FROM shops ORDER BY imported_at DESC LIMIT 1').get()?.shop_url
      if (!shopUrl) return { products: [], total: 0, page: parsed.page, pageSize: parsed.pageSize }
      const where = ['shop_url = ?']
      const values = [shopUrl]
      if (parsed.type !== 'all') { where.push('type = ?'); values.push(parsed.type) }
      if (parsed.query) {
        where.push('(sku LIKE ? ESCAPE \'\\\' OR name LIKE ? ESCAPE \'\\\')')
        values.push(`%${parsed.query.replace(/[\\%_]/g, '\\$&')}%`, `%${parsed.query.replace(/[\\%_]/g, '\\$&')}%`)
      }
      const whereSql = where.join(' AND ')
      const total = database.prepare(`SELECT COUNT(*) AS total FROM products WHERE ${whereSql}`).get(...values).total
      const products = database.prepare(`SELECT product_id AS id, parent_id AS parentId, type, sku, name, status, sync_state AS syncState, payload FROM products WHERE ${whereSql} ORDER BY name COLLATE NOCASE, product_id LIMIT ? OFFSET ?`).all(...values, parsed.pageSize, parsed.page * parsed.pageSize).map((row) => ({ ...row, payload: JSON.parse(row.payload) }))
      return { products, total, page: parsed.page, pageSize: parsed.pageSize }
    },
    replaceCatalog(input) {
      const parsed = catalogSchema.parse(input)
      const ids = new Set()
      for (const product of parsed.products) {
        if (ids.has(product.id)) throw new Error('Duplicate WooCommerce product ID.')
        ids.add(product.id)
      }
      database.exec('BEGIN IMMEDIATE')
      try {
        database.prepare('INSERT INTO shops (shop_url, imported_at) VALUES (?, ?) ON CONFLICT(shop_url) DO UPDATE SET imported_at = excluded.imported_at').run(parsed.shopUrl, parsed.importedAt)
        database.prepare('DELETE FROM products WHERE shop_url = ?').run(parsed.shopUrl)
        const insertProduct = database.prepare('INSERT INTO products (shop_url, product_id, parent_id, type, sku, name, status, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        const insertTerm = database.prepare('INSERT INTO taxonomy_terms (shop_url, taxonomy, term_id, name, slug, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(shop_url, taxonomy, term_id) DO UPDATE SET name = excluded.name, slug = excluded.slug, payload = excluded.payload')
        const insertRelation = database.prepare('INSERT INTO product_taxonomies (shop_url, product_id, taxonomy, term_id) VALUES (?, ?, ?, ?)')
        const insertAttribute = database.prepare('INSERT INTO product_attributes (shop_url, product_id, attribute_position, attribute_id, name, slug, variation, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        for (const product of parsed.products) {
          insertProduct.run(parsed.shopUrl, product.id, product.parentId, product.type, product.sku, product.name, product.status, JSON.stringify(product.payload))
          for (const taxonomy of ['categories', 'tags', 'brands']) {
            const taxonomyName = taxonomy === 'categories' ? 'product_cat' : taxonomy === 'tags' ? 'product_tag' : 'product_brand'
            for (const term of product.taxonomies[taxonomy]) {
              insertTerm.run(parsed.shopUrl, taxonomyName, term.id, term.name, term.slug, JSON.stringify(term))
              insertRelation.run(parsed.shopUrl, product.id, taxonomyName, term.id)
            }
          }
          for (const [position, attribute] of (Array.isArray(product.payload.attributes) ? product.payload.attributes : []).entries()) {
            if (!attribute || typeof attribute.name !== 'string') continue
            insertAttribute.run(parsed.shopUrl, product.id, position, Number.isSafeInteger(attribute.id) ? attribute.id : null, attribute.name, typeof attribute.slug === 'string' ? attribute.slug : null, attribute.variation === true ? 1 : 0, JSON.stringify(Array.isArray(attribute.options) ? attribute.options : []))
          }
        }
        database.exec('COMMIT')
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK')
        throw error
      }
      return this.workspaceSummary()
    },
    close() { database.close() },
  }
}

module.exports = { openDatabase }
