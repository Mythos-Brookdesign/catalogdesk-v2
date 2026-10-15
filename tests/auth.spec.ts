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
      if (options?.method !== 'GET' || options.redirect !== 'error' || options.headers?.Authorization !== expected)
        throw new Error('Unexpected shop request')
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
    await expect(page.getByRole('heading', { name: 'Admin einrichten', exact: true })).toHaveCount(0)
    await fillLogin(page)
    await page.getByRole('button', { name: 'Einstellungen', exact: true }).click()
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
    expect(await page.evaluate(() => window.catalogDesk!.shopConnection())).toMatchObject({ ok: false, error: expect.stringContaining('Keine Berechtigung') })
    expect(await page.evaluate(() => window.catalogDesk!.testShopConnection(null))).toMatchObject({ ok: false })
    expect(await page.evaluate(() => window.catalogDesk!.saveShopConnection({ url: 'https://other.example/', consumerKey: 'ck_' + 'a'.repeat(40), consumerSecret: 'cs_' + 'b'.repeat(40) }))).toMatchObject({ ok: false })
    expect(await page.evaluate(() => window.catalogDesk!.deleteShopConnection())).toMatchObject({ ok: false })
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
