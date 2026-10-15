import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import shop from './shop.cjs'
import storage from './shop-store.cjs'

const connection = { url: 'https://shop.example/', consumerKey: 'ck_' + 'a'.repeat(40), consumerSecret: 'cs_' + 'b'.repeat(40) }
const directories = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const key = randomBytes(32)
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString(value) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()])
  },
  decryptString(buffer) {
    const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12))
    decipher.setAuthTag(buffer.subarray(-16))
    return Buffer.concat([decipher.update(buffer.subarray(12, -16)), decipher.final()]).toString('utf8')
  },
}

it('preserves saved keys only for the same HTTPS shop and requires complete replacements', () => {
  expect(shop.resolveConnection({ url: 'https://shop.example', consumerKey: '', consumerSecret: '' }, connection)).toEqual(connection)
  expect(() => shop.resolveConnection({ url: 'https://other.example', consumerKey: '', consumerSecret: '' }, connection)).toThrow('beide API-Schluessel')
  expect(() => shop.resolveConnection({ ...connection, consumerSecret: '' }, connection)).toThrow('gemeinsam')
  expect(() => shop.resolveConnection({ ...connection, url: 'http://shop.example' }, null)).toThrow()
  expect(shop.resolveConnection({ ...connection, consumerSecret: 'cs_' + 'c'.repeat(40) }, connection).consumerSecret).toBe('cs_' + 'c'.repeat(40))
})

it('stores only encrypted keys, supports replacement and keeps the last valid file on errors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'catalogdesk-v2-shop-'))
  directories.push(directory)
  const store = storage.createShopStore(directory, encryption, 'darwin')
  expect(await store.summary()).toBeNull()
  await store.save(connection)
  expect(await store.summary()).toEqual({ url: connection.url })
  const filename = path.join(directory, 'shop-connection.enc')
  const bytes = await readFile(filename)
  expect(bytes.includes(Buffer.from(connection.consumerSecret))).toBe(false)
  expect(bytes.includes(Buffer.from(connection.consumerKey))).toBe(false)
  expect(await storage.createShopStore(directory, encryption, 'darwin').load()).toEqual(connection)
  const failing = storage.createShopStore(directory, { ...encryption, encryptString() { throw new Error('failure') } }, 'darwin')
  await expect(failing.save(connection)).rejects.toThrow('sicher gespeichert')
  expect(await readFile(filename)).toEqual(bytes)
  await store.save({ ...connection, consumerSecret: 'cs_' + 'c'.repeat(40) })
  expect((await store.load()).consumerSecret).toBe('cs_' + 'c'.repeat(40))
  await store.delete()
  expect(await store.summary()).toBeNull()
  await writeFile(filename, 'invalid')
  await expect(store.load()).rejects.toThrow('entschluesselt')
})

it('refuses storage without encryption and insecure Linux fallback backends', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'catalogdesk-v2-shop-security-'))
  directories.push(directory)
  for (const backend of [
    { ...encryption, isEncryptionAvailable: () => false },
    { ...encryption, getSelectedStorageBackend: () => 'basic_text' },
  ]) await expect(storage.createShopStore(directory, backend, 'linux').save(connection)).rejects.toThrow('Systemspeicher')
})

it('tests WooCommerce read-only without redirects or secrets in errors', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify([{ id: 1, sku: 'A' }]), { headers: { 'content-type': 'application/json', 'x-wp-total': '20' } }))
  expect(await shop.testConnection(connection, fetcher)).toMatchObject({ ok: true, productCount: 20 })
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' })
  expect(fetcher.mock.calls[0][0]).not.toContain(connection.consumerKey)
  for (const invalid of [
    new Response(connection.consumerSecret, { status: 403 }),
    new Response('not json', { headers: { 'content-type': 'text/html' } }),
    new Response('x'.repeat(70 * 1024), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const result = await shop.testConnection(connection, async () => invalid)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(connection.consumerSecret)
  }
  const failure = await shop.testConnection(connection, async () => { throw new Error(connection.consumerSecret) })
  expect(JSON.stringify(failure)).not.toContain(connection.consumerSecret)
})