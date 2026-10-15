import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import authModule from './auth.cjs'

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
