import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import databaseModule from './database.cjs'

const paths = []
afterEach(() => {
  for (const directory of paths.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('opens the new product-first schema with an empty local workspace', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'catalogdesk-v2-db-'))
  paths.push(directory)
  const database = databaseModule.openDatabase(path.join(directory, 'catalogdesk-v2.sqlite'))
  try {
    expect(database.workspaceSummary()).toEqual({ shopCount: 0, latestShopUrl: null, latestImportedAt: null, products: 0, simple: 0, variable: 0, variations: 0 })
    expect(database.listProducts()).toEqual({ products: [], total: 0, page: 0, pageSize: 50 })
  } finally {
    database.close()
  }
})

it('stores product families, variations and taxonomy relations atomically', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'catalogdesk-v2-family-'))
  paths.push(directory)
  const database = databaseModule.openDatabase(path.join(directory, 'catalogdesk-v2.sqlite'))
  try {
    database.replaceCatalog({
      shopUrl: 'https://shop.example/',
      importedAt: new Date().toISOString(),
      products: [
        {
          id: 20,
          parentId: null,
          type: 'variable',
          sku: 'TEE',
          name: 'T-Shirt',
          status: 'publish',
          payload: { id: 20, attributes: [{ name: 'Size', options: ['S', 'M'] }] },
          taxonomies: {
            categories: [{ id: 4, name: 'Clothing', slug: 'clothing' }],
            tags: [],
            brands: [{ id: 9, name: 'Studio', slug: 'studio' }],
          },
        },
        {
          id: 21,
          parentId: 20,
          type: 'variation',
          sku: 'TEE-S',
          name: 'T-Shirt / S',
          status: 'publish',
          payload: { id: 21, parent_id: 20, attributes: [{ name: 'Size', option: 'S' }] },
          taxonomies: { categories: [], tags: [], brands: [] },
        },
        {
          id: 22,
          parentId: 20,
          type: 'variation',
          sku: 'TEE-M',
          name: 'T-Shirt / M',
          status: 'publish',
          payload: { id: 22, parent_id: 20, attributes: [{ name: 'Size', option: 'M' }] },
          taxonomies: { categories: [], tags: [], brands: [] },
        },
      ],
    })

    expect(database.workspaceSummary()).toEqual({
      shopCount: 1,
      latestShopUrl: 'https://shop.example/',
      latestImportedAt: expect.any(String),
      products: 3,
      simple: 0,
      variable: 1,
      variations: 2,
    })
    const variations = database.listProducts({ type: 'variation' })
    expect(variations.total).toBe(2)
    expect(variations.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 21, parentId: 20, sku: 'TEE-S' }),
        expect.objectContaining({ id: 22, parentId: 20, sku: 'TEE-M' }),
      ]),
    )
    expect(database.listProducts({ query: 'studio' }).total).toBe(0)
    expect(database.listProducts({ query: 'TEE-M' }).products[0]).toMatchObject({
      id: 22,
      parentId: 20,
      payload: { parent_id: 20 },
    })
  } finally {
    database.close()
  }
})

  it('allows exactly one initial admin and stores profile data without a plaintext password', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'catalogdesk-v2-admin-'))
    paths.push(directory)
    const database = databaseModule.openDatabase(path.join(directory, 'catalogdesk-v2.sqlite'))
    try {
      expect(database.userCount()).toBe(0)
      const admin = database.createInitialAdmin({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ADA@example.com',
        username: 'Ada.Admin',
        salt: 'a'.repeat(32),
        passwordHash: 'b'.repeat(128),
      })
      expect(admin).toMatchObject({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        username: 'ada.admin',
        role: 'admin',
      })
      expect(database.userCount()).toBe(1)
      expect(database.findUserByUsername('ADA.ADMIN')).toMatchObject({
        passwordHash: 'b'.repeat(128),
        salt: 'a'.repeat(32),
      })
      expect(() => database.createInitialAdmin({
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.com',
        username: 'grace',
        salt: 'c'.repeat(32),
        passwordHash: 'd'.repeat(128),
      })).toThrow('already configured')
    } finally {
      database.close()
    }
  })
