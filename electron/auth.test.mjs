import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import authModule from './auth.cjs'
import storage from './database.cjs'

function createMemoryDatabase() {
  const users = new Map()
  return {
    users,
    async request(operation, payload) {
      if (operation === 'userCount') return users.size
      if (operation === 'createInitialAdmin') {
        if (users.size) throw new Error('Admin account is already configured.')
        const user = {
          id: randomUUID(),
          firstName: payload.firstName,
          lastName: payload.lastName,
          email: payload.email,
          username: payload.username,
          role: 'admin',
          salt: payload.salt,
          passwordHash: payload.passwordHash,
          active: true,
        }
        users.set(user.username, user)
        return user
      }
      if (operation === 'findUserByUsername') return users.get(payload) ?? null
      if (operation === 'recordLogin') return true
      throw new Error(`Unexpected operation: ${operation}`)
    },
  }
}

describe('V2 first-admin authentication', () => {
  it('manages users against SQLite, enforces menu access, revokes sessions and protects the last admin', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'catalogdesk-user-management-'))
    const database = storage.openDatabase(path.join(directory, 'users.sqlite'))
    const auth = authModule.createAuthenticator(async (operation, payload) => database[operation](payload))
    try {
      const admin = await auth.bootstrap({ firstName: 'Ada', lastName: 'Admin', email: 'ada@example.com', username: 'admin', password: 'catalog8' })
      const employeeProfile = { firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com', username: 'grace', role: 'employee', permissions: ['products'], password: 'password8' }
      const id = await auth.saveUser(admin.sessionToken, employeeProfile)
      const employee = await auth.login({ username: 'grace', password: 'password8' })
      expect(auth.requireSession(employee.sessionToken, 'products').role).toBe('employee')
      expect(() => auth.requireSession(employee.sessionToken, 'dashboard')).toThrow('Benutzerrolle')
      await expect(auth.saveUser(employee.sessionToken, { ...employeeProfile, role: 'admin' })).rejects.toThrow('Nur Administratoren')
      await expect(auth.deleteUser(employee.sessionToken, admin.user.id)).rejects.toThrow('Nur Administratoren')
      const users = await auth.listUsers(admin.sessionToken)
      expect(users).toHaveLength(2)
      expect(users[1]).not.toHaveProperty('passwordHash')
      expect(users[1]).not.toHaveProperty('salt')
      await expect(auth.saveUser(admin.sessionToken, { ...employeeProfile, email: 'another@example.com' })).rejects.toThrow()
      expect(database.listUsers()).toHaveLength(2)
      await auth.saveUser(admin.sessionToken, { ...employeeProfile, id, permissions: ['dashboard'], password: 'updated8' })
      expect(() => auth.requireSession(employee.sessionToken, 'products')).toThrow('Sitzung')
      await expect(auth.login({ username: 'grace', password: 'password8' })).rejects.toThrow('Benutzername oder Passwort')
      const updated = await auth.login({ username: 'grace', password: 'updated8' })
      expect(auth.requireSession(updated.sessionToken, 'dashboard')).toMatchObject({ permissions: ['dashboard'] })
      expect(() => auth.requireSession(updated.sessionToken, 'products')).toThrow('Benutzerrolle')
      await expect(auth.deleteUser(admin.sessionToken, admin.user.id)).rejects.toThrow('Mindestens ein Administrator')
      await expect(auth.saveUser(admin.sessionToken, { id: admin.user.id, firstName: 'Ada', lastName: 'Admin', email: 'ada@example.com', username: 'admin', role: 'employee', permissions: [] })).rejects.toThrow('Mindestens ein Administrator')
      expect(database.findUserByUsername('admin').role).toBe('admin')
      await auth.deleteUser(admin.sessionToken, id)
      expect(() => auth.requireSession(updated.sessionToken, 'dashboard')).toThrow('Sitzung')
      await expect(auth.login({ username: 'grace', password: 'updated8' })).rejects.toThrow()
      const secondAdmin = await auth.saveUser(admin.sessionToken, { ...employeeProfile, role: 'admin', permissions: [] })
      await auth.saveUser(admin.sessionToken, { ...employeeProfile, id: secondAdmin, role: 'employee', permissions: ['dashboard'] })
      expect(database.findUserByUsername('grace').role).toBe('employee')
      await auth.deleteUser(admin.sessionToken, secondAdmin)
      expect(database.userCount()).toBe(1)
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  it('requires one admin setup, hashes the password, then supports logout and login', async () => {
    const database = createMemoryDatabase()
    const auth = authModule.createAuthenticator(database.request)

    expect(await auth.state()).toEqual({ setupRequired: true, user: null })
    const setup = await auth.bootstrap({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ADA@example.com',
      username: 'Ada.Admin',
      password: 'catalog8',
    })
    expect(setup.user).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      username: 'ada.admin',
      role: 'admin',
    })
    expect(await auth.state(setup.sessionToken)).toMatchObject({
      setupRequired: false,
      user: setup.user,
    })
    expect([...database.users.values()][0].passwordHash).not.toBe('catalog8')
    expect([...database.users.values()][0]).not.toHaveProperty('password')
    await expect(
      auth.bootstrap({
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.com',
        username: 'grace',
        password: 'catalog8',
      }),
    ).rejects.toThrow('already configured')

    auth.logout(setup.sessionToken)
    expect(await auth.state(setup.sessionToken)).toEqual({
      setupRequired: false,
      user: null,
    })
    const login = await auth.login({ username: 'ADA.ADMIN', password: 'catalog8' })
    expect(login.user).toMatchObject({ id: setup.user.id, role: 'admin' })
  })

  it('enforces the eight-character minimum and rejects invalid credentials generically', async () => {
    const auth = authModule.createAuthenticator(createMemoryDatabase().request)
    await expect(
      auth.bootstrap({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        username: 'ada',
        password: 'short7',
      }),
    ).rejects.toThrow()
    await expect(auth.login({ username: 'missing', password: 'password8' })).rejects.toThrow(
      'Benutzername oder Passwort ist falsch oder Konto gesperrt.',
    )
  })
})
