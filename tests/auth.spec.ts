import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { ElectronApplication, Page } from 'playwright'

const testPassword = 'catalogdesk8'

async function mockWooCommerce(application: ElectronApplication, key: string, secret: string) {
  await application.evaluate(({ net }, credentials) => {
    const original = net.fetch.bind(net)
    net.fetch = async (input, options) => {
      const url = new URL(String(input))
      if (url.origin !== 'https://shop.example') return original(input, options)
      const expected = `Basic ${Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')}`
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-wp-totalpages': '1' } })
      if (options?.method !== 'GET' || options.redirect !== 'error')
        throw new Error('Unexpected shop request')
      // WordPress core routes are read without WooCommerce keys.
      if (url.pathname.startsWith('/wp-json/wp/v2/')) {
        if (options.headers?.Authorization) throw new Error('Keys sent outside WooCommerce')
        if (url.pathname === '/wp-json/wp/v2/taxonomies') return json({ product_material: { slug: 'product_material', name: 'Materialien', hierarchical: false, rest_base: 'materials', rest_namespace: 'wp/v2' } })
        if (url.pathname === '/wp-json/wp/v2/materials') return json([{ id: 40, name: 'Baumwolle', slug: 'baumwolle', count: 6 }])
        return json({ code: 'rest_no_route' }, 404)
      }
      if (options.headers?.Authorization !== expected) throw new Error('Unexpected shop request')
      const termRoute = (title: string, properties: string[]) => ({ endpoints: [{ methods: ['GET'], args: { page: {}, per_page: {}, orderby: {}, order: {}, hide_empty: {} } }], schema: { title, properties: Object.fromEntries(properties.map((key) => [key, {}])) } })
      if (url.pathname === '/wp-json/wc/v3') return json({ routes: {
        '/wc/v3/products/categories': termRoute('product_cat', ['id', 'name', 'slug', 'parent', 'count']),
        '/wc/v3/products/tags': termRoute('product_tag', ['id', 'name', 'slug', 'count']),
        '/wc/v3/products/shipping_classes': termRoute('product_shipping_class', ['id', 'name', 'slug', 'count']),
        '/wc/v3/products/delivery_times': termRoute('product_delivery_time', ['id', 'name', 'slug', 'count']),
        '/wc/v3/products/seasons': termRoute('product_season', ['id', 'name', 'slug', 'count']),
        '/wc/v3/marketplace/featured': { endpoints: [{ methods: ['GET'], args: [] }] },
      } })
      const taxonomyRoutes: Record<string, unknown[]> = {
        '/wp-json/wc/v3/products/categories': [{ id: 4, name: 'Kleidung &amp; Mode', slug: 'kleidung', parent: 0, count: 12 }, { id: 5, name: 'Shirts', slug: 'shirts', parent: 4, count: 7 }],
        '/wp-json/wc/v3/products/tags': [{ id: 8, name: 'Sale', slug: 'sale', count: 3 }],
        '/wp-json/wc/v3/products/shipping_classes': [{ id: 11, name: 'Paket', slug: 'paket', count: 9 }],
        '/wp-json/wc/v3/products/delivery_times': [{ id: 12, name: '2-3 Werktage', slug: '2-3-werktage', count: 5 }],
        '/wp-json/wc/v3/products/attributes': [{ id: 1, name: 'Farbe', slug: 'pa_farbe', type: 'select', order_by: 'menu_order', has_archives: false }],
        '/wp-json/wc/v3/products/attributes/1/terms': [{ id: 30, name: 'Rot', slug: 'rot', menu_order: 0, count: 4 }, { id: 31, name: 'Blau', slug: 'blau', menu_order: 1, count: 2 }],
      }
      if (url.pathname === '/wp-json/wc/v3/products/seasons') return json({ code: 'rest_forbidden' }, 403)
      if (taxonomyRoutes[url.pathname]) return json(taxonomyRoutes[url.pathname])
      return new Response(JSON.stringify([{ id: 1, sku: 'A' }]), { headers: { 'content-type': 'application/json', 'x-wp-total': '25' } })
    }
  }, { key, secret })
}

async function launchApp(
  playwright: { _electron: { launch: (options: { args: string[]; env: NodeJS.ProcessEnv }) => Promise<ElectronApplication> } },
  userData: string,
) {
  const application = await playwright._electron.launch({
    args: ['.', '--dev'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', CATALOGDESK_V2_TEST_USER_DATA: userData },
  })
  return { application, page: await application.firstWindow() }
}

async function fillLogin(page: Page) {
  await page.getByLabel('Benutzername').fill('ada.admin')
  await page.locator('input[type="password"]').fill(testPassword)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
}

test('creates the first admin before showing the app and requires login on the next start', async ({ playwright }, testInfo) => {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'catalogdesk-v2-auth-'))
  let application: ElectronApplication | undefined
  try {
    let page: Page
    ;({ application, page } = await launchApp(playwright, userData))
    await expect(page.getByRole('heading', { name: 'Admin einrichten', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toHaveCount(0)
    await page.getByLabel('Vorname').fill('Ada')
    await page.getByLabel('Name', { exact: true }).fill('Lovelace')
    await page.getByLabel('E-Mail').fill('ada@example.com')
    await page.getByLabel('Benutzername').fill('Ada.Admin')
    const password = page.locator('input[type="password"]')
    await expect(password.nth(0)).toHaveAttribute('minlength', '8')
    await password.nth(0).fill(testPassword)
    await password.nth(1).fill('different8')
    await expect(page.getByRole('alert')).toContainText('Passwoerter stimmen')
    await expect(page.getByRole('button', { name: 'Admin-Konto anlegen' })).toBeDisabled()
    await password.nth(1).fill(testPassword)
    await page.getByRole('button', { name: 'Admin-Konto anlegen' }).click()
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
    await expect(page.getByText('Ada Lovelace', { exact: true })).toBeVisible()
    const key = 'ck_' + 'a'.repeat(40)
    const secret = 'cs_' + 'b'.repeat(40)
    await page.getByRole('button', { name: 'Einstellungen', exact: true }).click()
    await expect(page.getByLabel('Shopadresse (HTTPS)')).toHaveCount(0)
    await page.getByRole('radio', { name: 'Dunkel', exact: true }).check()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.screenshot({ path: testInfo.outputPath('appearance-dark.png') })
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('dashboard-dark.png') })
    await page.getByRole('button', { name: 'Shopverbindung', exact: true }).click()
    await page.getByLabel('Shopadresse (HTTPS)').fill('https://shop.example')
    await page.getByLabel('Consumer Key', { exact: true }).fill(key)
    await page.getByLabel('Consumer Secret', { exact: true }).fill(secret)
    await mockWooCommerce(application, key, secret)
    await page.getByRole('button', { name: 'Verbindung pruefen', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('25 Produkte')
    await page.getByRole('button', { name: 'Verbindung speichern', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Shopverbindung gespeichert')
    await expect(page.getByLabel('Consumer Secret', { exact: true })).toHaveValue('')
    const encrypted = await readFile(path.join(userData, 'credentials', 'shop-connection.enc'))
    expect(encrypted.includes(Buffer.from(secret))).toBe(false)
    expect(encrypted.includes(Buffer.from(key))).toBe(false)
    await application.close()

    ;({ application, page } = await launchApp(playwright, userData))
    await expect(page.getByRole('heading', { name: 'Anmelden', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.screenshot({ path: testInfo.outputPath('login-dark.png') })
    await expect(page.getByRole('heading', { name: 'Admin einrichten', exact: true })).toHaveCount(0)
    await fillLogin(page)
    await page.getByRole('button', { name: 'Einstellungen', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Dunkel', exact: true })).toBeChecked()
    await page.getByRole('radio', { name: 'Hell', exact: true }).check()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    expect(await page.evaluate(() => window.catalogDesk!.getTheme())).toEqual({ ok: true, value: 'light' })
    await page.screenshot({ path: testInfo.outputPath('appearance-light.png') })
    await page.getByRole('radio', { name: 'Dunkel', exact: true }).check()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('button', { name: 'Shopverbindung', exact: true }).click()
    await expect(page.getByLabel('Shopadresse (HTTPS)')).toHaveValue('https://shop.example/')
    await expect(page.getByLabel('Consumer Key', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('Consumer Secret', { exact: true })).toHaveValue('')
    await mockWooCommerce(application, key, secret)
    await page.getByRole('button', { name: 'Verbindung pruefen', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('25 Produkte')
    const unsafeChange = await page.evaluate(() => window.catalogDesk!.saveShopConnection({ url: 'https://other.example/', consumerKey: '', consumerSecret: '' }))
    expect(unsafeChange).toMatchObject({ ok: false })
    const replacementKey = 'ck_' + 'c'.repeat(40)
    const replacementSecret = 'cs_' + 'd'.repeat(40)
    await page.getByLabel('Consumer Key', { exact: true }).fill(replacementKey)
    await page.getByLabel('Consumer Secret', { exact: true }).fill(replacementSecret)
    await page.getByRole('button', { name: 'Verbindung speichern', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Shopverbindung gespeichert')
    await mockWooCommerce(application, replacementKey, replacementSecret)
    await page.getByRole('button', { name: 'Verbindung pruefen', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('25 Produkte')
    await page.screenshot({ path: testInfo.outputPath('shop-settings-desktop.png') })
    await page.getByRole('button', { name: 'Taxonomien', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Noch keine Taxonomien importiert' })).toBeVisible()
    await page.getByRole('button', { name: 'Taxonomien importieren', exact: true }).click()
    await expect(page.getByText('7 Taxonomien mit 8 Begriffen importiert.')).toBeVisible()
    await expect(page.getByRole('cell', { name: '↳ Shirts' })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'Kleidung & Mode', exact: true })).toBeVisible()
    await page.getByRole('navigation', { name: 'Taxonomien' }).getByRole('button', { name: /Farbe/ }).click()
    await expect(page.getByRole('cell', { name: 'Blau', exact: true })).toBeVisible()
    await page.getByRole('navigation', { name: 'Taxonomien' }).getByRole('button', { name: /Lieferzeiten/ }).click()
    await expect(page.getByRole('cell', { name: '2-3 Werktage', exact: true })).toBeVisible()
    await expect(page.getByText('PLUGINS & EIGENE', { exact: true })).toBeVisible()
    await page.getByRole('navigation', { name: 'Taxonomien' }).getByRole('button', { name: /Materialien/ }).click()
    await expect(page.getByRole('cell', { name: 'Baumwolle', exact: true })).toBeVisible()
    await page.getByRole('navigation', { name: 'Taxonomien' }).getByRole('button', { name: /Season/ }).click()
    await expect(page.getByRole('note')).toContainText('nicht lesbar')
    await page.getByRole('navigation', { name: 'Taxonomien' }).getByRole('button', { name: /Kategorien/ }).click()
    await expect(page.getByRole('cell', { name: '↳ Shirts' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('taxonomies-desktop.png') })
    await page.setViewportSize({ width: 600, height: 850 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('taxonomies-narrow.png') })
    await page.setViewportSize({ width: 1440, height: 920 })
    await page.setViewportSize({ width: 600, height: 850 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('shop-settings-narrow.png') })
    await page.setViewportSize({ width: 1440, height: 920 })
    await page.getByRole('button', { name: 'Benutzer', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Benutzer', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Loeschen: ada.admin' })).toBeDisabled()
    await page.getByRole('button', { name: 'Benutzer anlegen', exact: true }).click()
    let dialog = page.getByRole('dialog')
    await dialog.getByLabel('Vorname', { exact: true }).fill('Grace')
    await dialog.getByLabel('Name', { exact: true }).fill('Hopper')
    await dialog.getByLabel('E-Mail', { exact: true }).fill('grace@example.com')
    await dialog.getByLabel('Benutzername', { exact: true }).fill('grace')
    await dialog.getByLabel('Rolle', { exact: true }).selectOption('employee')
    await dialog.getByLabel('Dashboard', { exact: true }).uncheck()
    await dialog.getByLabel('Produkte', { exact: true }).check()
    await dialog.getByLabel('Passwort', { exact: true }).fill('password8')
    await dialog.getByLabel('Passwort wiederholen', { exact: true }).fill('password8')
    await page.screenshot({ path: testInfo.outputPath('users-desktop.png') })
    await page.setViewportSize({ width: 600, height: 850 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('users-narrow.png') })
    await page.setViewportSize({ width: 1440, height: 920 })
    await dialog.getByRole('button', { name: 'Speichern', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Bearbeiten: grace' })).toBeVisible()
    await page.getByRole('button', { name: 'Bearbeiten: grace' }).click()
    dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Produkte', { exact: true })).toBeChecked()
    await dialog.getByLabel('Name', { exact: true }).fill('Mitarbeiter')
    await dialog.getByRole('button', { name: 'Speichern', exact: true }).click()
    await expect(page.getByRole('cell', { name: 'Grace Mitarbeiter', exact: true })).toBeVisible()

    const lastAdmin = await page.evaluate(async () => {
      const users = await window.catalogDesk!.listUsers()
      if (!users.ok) throw new Error(users.error)
      return window.catalogDesk!.deleteUser(users.value.find((user) => user.role === 'admin')!.id)
    })
    expect(lastAdmin).toMatchObject({ ok: false, error: expect.stringContaining('Mindestens ein Administrator') })
    await page.getByRole('button', { name: 'Abmelden', exact: true }).click()
    await page.getByLabel('Benutzername').fill('grace')
    await page.locator('input[type="password"]').fill('password8')
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Produkte', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Produkte', exact: true })).toBeVisible()
    for (const title of ['Dashboard', 'Benutzer', 'Bestellungen', 'Kunden', 'Einstellungen', 'Shopverbindung', 'Taxonomien', 'Synchronisation']) {
      await expect(page.getByRole('button', { name: title, exact: true })).toHaveCount(0)
    }
    await expect(page.getByText('EINSTELLUNGEN', { exact: true })).toHaveCount(0)
    const rejected = await page.evaluate(() => window.catalogDesk!.saveUser({ firstName: 'Fake', lastName: 'Admin', email: 'fake@example.com', username: 'fake', role: 'admin', permissions: [], password: 'password8' }))
    expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining('Nur Administratoren') })
    expect(await page.evaluate(() => window.catalogDesk!.shopConnection())).toMatchObject({ ok: false, error: expect.stringContaining('Benutzerrolle') })
    expect(await page.evaluate(() => window.catalogDesk!.setTheme('light'))).toMatchObject({ ok: false })
    expect(await page.evaluate(() => window.catalogDesk!.getTheme())).toEqual({ ok: true, value: 'dark' })
    expect(await page.evaluate(() => window.catalogDesk!.testShopConnection(null))).toMatchObject({ ok: false })
    expect(await page.evaluate(() => window.catalogDesk!.saveShopConnection({ url: 'https://other.example/', consumerKey: 'ck_' + 'a'.repeat(40), consumerSecret: 'cs_' + 'b'.repeat(40) }))).toMatchObject({ ok: false })
    expect(await page.evaluate(() => window.catalogDesk!.deleteShopConnection())).toMatchObject({ ok: false })
    expect(await page.evaluate(() => window.catalogDesk!.importTaxonomies())).toMatchObject({ ok: false, error: expect.stringContaining('Benutzerrolle') })
    expect(await page.evaluate(() => window.catalogDesk!.taxonomyOverview())).toMatchObject({ ok: false })
    await page.getByRole('button', { name: 'Abmelden', exact: true }).click()
    await fillLogin(page)
    await page.getByRole('button', { name: 'Benutzer', exact: true }).click()
    await page.getByRole('button', { name: 'Loeschen: grace' }).click()
    const confirmation = page.getByRole('alertdialog')
    await confirmation.getByRole('button', { name: 'Endgueltig loeschen' }).click()
    await expect(page.getByRole('button', { name: 'Bearbeiten: grace' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Shopverbindung', exact: true }).click()
    await expect(page.getByLabel('Shopadresse (HTTPS)')).toHaveValue('https://shop.example/')
    await page.getByRole('button', { name: 'Shopverbindung entfernen', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Verbindung endgueltig entfernen' }).click()
    await expect(page.getByRole('status')).toContainText('Shopverbindung entfernt')
    expect(await page.evaluate(() => window.catalogDesk!.shopConnection())).toEqual({ ok: true, value: null })
  } finally {
    await application?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
