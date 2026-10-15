const { DatabaseSync } = require('node:sqlite')
const { mkdirSync } = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
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
const taxonomyImportSchema = z.object({
  shopUrl: shopUrlSchema,
  importedAt: z.string().datetime(),
  taxonomies: z.array(z.object({
    taxonomy: z.string().min(1).max(200),
    kind: z.enum(['core', 'custom', 'attribute']),
    label: z.string().max(1000),
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
}).strict()
const taxonomyTermsQuerySchema = z.object({
  shopUrl: shopUrlSchema.optional(),
  taxonomy: z.string().min(1).max(200),
  query: z.string().trim().max(200).default(''),
  page: z.number().int().min(0).max(1_000_000).default(0),
  pageSize: z.number().int().min(1).max(200).default(100),
}).strict()
const usernameSchema = z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9._-]+$/)
const newAdminSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  username: usernameSchema,
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  passwordHash: z.string().regex(/^[a-f0-9]{128}$/),
}).strict()
const menuPermissions = z.array(z.enum(['dashboard', 'products', 'orders', 'customers', 'settings', 'users', 'shop', 'taxonomies', 'sync'])).max(9)
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
    if (version > 7) throw new Error('Database schema is newer than this app.')
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
    database.exec('COMMIT')
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK')
    database.close()
    throw error
  }

  // Taxonomy imports create a shop row too; only shops with products count as catalog imports.
  const catalogShop = 'EXISTS (SELECT 1 FROM products WHERE products.shop_url = shops.shop_url)'

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
        const insertTerm = database.prepare('INSERT INTO taxonomy_terms (shop_url, taxonomy, term_id, name, slug, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(shop_url, taxonomy, term_id) DO UPDATE SET name = excluded.name, slug = excluded.slug')
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
        database.prepare('INSERT INTO shops (shop_url, imported_at) VALUES (?, ?) ON CONFLICT(shop_url) DO NOTHING').run(parsed.shopUrl, parsed.importedAt)
        const deleteRelations = database.prepare('DELETE FROM product_taxonomies WHERE shop_url = ? AND taxonomy = ? AND term_id = ?')
        const deleteTerm = database.prepare('DELETE FROM taxonomy_terms WHERE shop_url = ? AND taxonomy = ? AND term_id = ?')
        for (const { taxonomy, termId } of database.prepare('SELECT taxonomy, term_id AS termId FROM taxonomy_terms WHERE shop_url = ?').all(parsed.shopUrl)) {
          if (unreadable.has(taxonomy) || imported.has(`${taxonomy}\u0000${termId}`)) continue
          deleteRelations.run(parsed.shopUrl, taxonomy, termId)
          deleteTerm.run(parsed.shopUrl, taxonomy, termId)
        }
        database.prepare('DELETE FROM taxonomies WHERE shop_url = ?').run(parsed.shopUrl)
        const insertTaxonomy = database.prepare('INSERT INTO taxonomies (shop_url, taxonomy, kind, label, route, hierarchical, available, attribute, position, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        const upsertTerm = database.prepare(`INSERT INTO taxonomy_terms (shop_url, taxonomy, term_id, name, slug, payload, parent_id, product_count, menu_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(shop_url, taxonomy, term_id) DO UPDATE SET name = excluded.name, slug = excluded.slug, payload = excluded.payload, parent_id = excluded.parent_id, product_count = excluded.product_count, menu_order = excluded.menu_order`)
        for (const [position, entry] of parsed.taxonomies.entries()) {
          insertTaxonomy.run(parsed.shopUrl, entry.taxonomy, entry.kind, entry.label, entry.route, entry.hierarchical ? 1 : 0, entry.available ? 1 : 0, entry.attribute ? JSON.stringify(entry.attribute) : null, position, parsed.importedAt)
          for (const term of entry.terms)
            upsertTerm.run(parsed.shopUrl, entry.taxonomy, term.id, term.name, term.slug, JSON.stringify(term.payload), term.parentId, term.count, term.menuOrder)
        }
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
      const taxonomies = database.prepare(`SELECT t.taxonomy, t.kind, t.label, t.route, t.hierarchical, t.available, t.attribute, t.imported_at AS importedAt,
          (SELECT COUNT(*) FROM taxonomy_terms terms WHERE terms.shop_url = t.shop_url AND terms.taxonomy = t.taxonomy) AS termCount
        FROM taxonomies t WHERE t.shop_url = ? ORDER BY t.position`).all(shopUrl)
        .map((row) => ({ ...row, hierarchical: row.hierarchical === 1, available: row.available === 1, attribute: row.attribute ? JSON.parse(row.attribute) : null }))
      return { shopUrl, importedAt: taxonomies[0]?.importedAt ?? null, taxonomies }
    },
    listTaxonomyTerms(input) {
      const parsed = taxonomyTermsQuerySchema.parse(input)
      const empty = { terms: [], total: 0, page: parsed.page, pageSize: parsed.pageSize }
      const shopUrl = taxonomyShop(parsed.shopUrl)
      if (!shopUrl) return empty
      const taxonomy = database.prepare('SELECT hierarchical FROM taxonomies WHERE shop_url = ? AND taxonomy = ?').get(shopUrl, parsed.taxonomy)
      if (!taxonomy) return empty
      // Hierarchical terms are ordered as a tree: parents first, children by name below them.
      const tree = `WITH RECURSIVE tree(term_id, path, sort_key, depth) AS (
          SELECT t.term_id, t.name, lower(t.name) || char(2) || printf('%012d', t.term_id), 0 FROM taxonomy_terms t
          WHERE t.shop_url = ?1 AND t.taxonomy = ?2 AND (t.parent_id = 0 OR ?3 = 0 OR NOT EXISTS (
            SELECT 1 FROM taxonomy_terms p WHERE p.shop_url = t.shop_url AND p.taxonomy = t.taxonomy AND p.term_id = t.parent_id))
          UNION ALL
          SELECT c.term_id, tree.path || ' › ' || c.name, tree.sort_key || char(1) || lower(c.name) || char(2) || printf('%012d', c.term_id), tree.depth + 1
          FROM taxonomy_terms c JOIN tree ON c.parent_id = tree.term_id
          WHERE ?3 = 1 AND c.shop_url = ?1 AND c.taxonomy = ?2 AND tree.depth < 50
        )`
      const filter = parsed.query ? `AND (t.name LIKE ?4 ESCAPE '\\' OR t.slug LIKE ?4 ESCAPE '\\')` : ''
      const values = [shopUrl, parsed.taxonomy, taxonomy.hierarchical, ...(parsed.query ? [`%${parsed.query.replace(/[\\%_]/g, '\\$&')}%`] : [])]
      const from = `FROM tree JOIN taxonomy_terms t ON t.shop_url = ?1 AND t.taxonomy = ?2 AND t.term_id = tree.term_id WHERE 1 = 1 ${filter}`
      const total = database.prepare(`${tree} SELECT COUNT(*) AS total ${from}`).get(...values).total
      const terms = database.prepare(`${tree} SELECT t.term_id AS id, t.name, t.slug, t.parent_id AS parentId, t.product_count AS count, t.menu_order AS menuOrder, tree.path, tree.depth
        ${from} ORDER BY ${taxonomy.hierarchical ? 'tree.sort_key' : 't.name COLLATE NOCASE, t.term_id'} LIMIT ${parsed.pageSize} OFFSET ${parsed.page * parsed.pageSize}`).all(...values)
      return { terms, total, page: parsed.page, pageSize: parsed.pageSize }
    },
    close() { database.close() },
  }
}

module.exports = { openDatabase }
