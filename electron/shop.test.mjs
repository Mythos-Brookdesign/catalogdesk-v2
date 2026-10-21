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

it('keeps, replaces and removes the WordPress application password', () => {
  const password = 'abcd EFGH 1234 ijkl MNOP 5678'
  const withLogin = shop.resolveConnection({ url: connection.url, consumerKey: '', consumerSecret: '', wpUser: 'redaktion', wpAppPassword: password }, connection)
  expect(withLogin).toMatchObject({ wpUser: 'redaktion', wpAppPassword: 'abcdEFGH1234ijklMNOP5678', consumerKey: connection.consumerKey })
  // Empty password keeps the stored one of the same user; another user needs a new one; no user removes it.
  expect(shop.resolveConnection({ url: connection.url, consumerKey: '', consumerSecret: '', wpUser: 'redaktion' }, withLogin).wpAppPassword).toBe('abcdEFGH1234ijklMNOP5678')
  expect(() => shop.resolveConnection({ url: connection.url, consumerKey: '', consumerSecret: '', wpUser: 'admin' }, withLogin)).toThrow('Anwendungspasswort')
  expect(shop.resolveConnection({ url: connection.url, consumerKey: '', consumerSecret: '' }, withLogin)).toEqual(connection)
  expect(() => shop.resolveConnection({ url: connection.url, consumerKey: '', consumerSecret: '', wpUser: 'redaktion', wpAppPassword: 'zu kurz' }, connection)).toThrow('24 Zeichen')
})

it('uploads files with the application password and never sends WooCommerce keys to WordPress routes', async () => {
  const login = { ...connection, wpUser: 'redaktion', wpAppPassword: 'abcdEFGH1234ijklMNOP5678' }
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 9 }), { headers: { 'content-type': 'application/json' } }))
  await shop.wooRequest(login, 'wp/v2/media', {}, fetcher, { method: 'POST', wordpress: true, upload: { data: Buffer.from('x'), contentType: 'image/png', filename: 'Grüne Tasse.png' } })
  const [, options] = fetcher.mock.calls[0]
  expect(options.headers.Authorization).toBe(`Basic ${Buffer.from('redaktion:abcdEFGH1234ijklMNOP5678').toString('base64')}`)
  expect(options.headers['Content-Type']).toBe('image/png')
  expect(options.headers['Content-Disposition']).toBe(`attachment; filename="Grune-Tasse.png"; filename*=UTF-8''${encodeURIComponent('Grüne Tasse.png')}`)
  await expect(shop.wooRequest(connection, 'wp/v2/media', {}, fetcher, { wordpress: true })).rejects.toThrow('Kein Anwendungspasswort')
})

it('stores only encrypted keys, supports replacement and keeps the last valid file on errors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'catalogdesk-v2-shop-'))
  directories.push(directory)
  const store = storage.createShopStore(directory, encryption, 'darwin')
  expect(await store.summary()).toBeNull()
  await store.save(connection)
  expect(await store.summary()).toEqual({ url: connection.url, wpUser: null })
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