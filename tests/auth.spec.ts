import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { ElectronApplication, Page } from 'playwright'

const testPassword = 'catalogdesk8'

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

test('creates the first admin before showing the app and requires login on the next start', async ({ playwright }) => {
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
    await application.close()

    ;({ application, page } = await launchApp(playwright, userData))
    await expect(page.getByRole('heading', { name: 'Anmelden', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Admin einrichten', exact: true })).toHaveCount(0)
    await fillLogin(page)
  } finally {
    await application?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
