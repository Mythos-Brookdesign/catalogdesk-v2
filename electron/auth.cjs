const { randomBytes, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto')
const { promisify } = require('node:util')
const { z } = require('zod')

const scrypt = promisify(scryptCallback)
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const passwordSchema = z.string().min(8).max(128)
const usernameSchema = z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9._-]+$/)
const profileSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  username: usernameSchema,
  password: passwordSchema,
}).strict()
const loginSchema = z.object({ username: usernameSchema, password: passwordSchema }).strict()
const dummySalt = Buffer.from('42'.repeat(16), 'hex')
const dummyHash = Buffer.alloc(64, 0xa5)
const permissions = {
  admin: new Set(['catalog:read', 'catalog:write', 'users:manage', 'settings:manage']),
  editor: new Set(['catalog:read', 'catalog:write']),
  reader: new Set(['catalog:read']),
}

function publicUser(user) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    username: user.username,
    role: user.role,
  }
}

function createAuthenticator(database, {
  now = Date.now,
  sessionTtl = 30 * 60_000,
  failuresBeforeLock = 5,
  lockDuration = 60_000,
} = {}) {
  const sessions = new Map()
  const failures = new Map()

  async function derive(password, salt) {
    return Buffer.from(await scrypt(password, salt, 64, scryptOptions))
  }

  function createSession(user) {
    const token = randomBytes(32).toString('base64url')
    const safeUser = publicUser(user)
    sessions.set(token, { user: safeUser, lastSeen: now() })
    return { sessionToken: token, user: safeUser }
  }

  function requireSession(token, permission) {
    const current = sessions.get(token)
    if (!current || now() - current.lastSeen >= sessionTtl) {
      if (current) sessions.delete(token)
      throw new Error('Sitzung abgelaufen. Bitte erneut anmelden.')
    }
    const required = Array.isArray(permission) ? permission : [permission]
    if (!required.every((entry) => permissions[current.user.role]?.has(entry)))
      throw new Error('Fuer diese Aktion fehlt die erforderliche Benutzerrolle.')
    current.lastSeen = now()
    return current.user
  }

  return {
    async state(token) {
      const setupRequired = (await database('userCount')) === 0
      if (setupRequired) return { setupRequired: true, user: null }
      try {
        return {
          setupRequired: false,
          user: token ? requireSession(token, 'catalog:read') : null,
        }
      } catch {
        return { setupRequired: false, user: null }
      }
    },
    async bootstrap(payload) {
      if ((await database('userCount')) !== 0)
        throw new Error('Admin account is already configured.')
      const parsed = profileSchema.parse(payload)
      const salt = randomBytes(16)
      const passwordHash = await derive(parsed.password, salt)
      const user = await database('createInitialAdmin', {
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        email: parsed.email.toLowerCase(),
        username: parsed.username.toLowerCase(),
        salt: salt.toString('hex'),
        passwordHash: passwordHash.toString('hex'),
      })
      return createSession(user)
    },
    async login(payload) {
      const parsed = loginSchema.safeParse(payload)
      if (!parsed.success)
        throw new Error('Benutzername oder Passwort ist falsch oder Konto gesperrt.')
      const username = parsed.data.username.toLowerCase()
      const gate = failures.get(username)
      if (gate?.lockedUntil > now())
        throw new Error('Benutzername oder Passwort ist falsch oder Konto gesperrt.')

      const user = await database('findUserByUsername', username)
      const salt = user ? Buffer.from(user.salt, 'hex') : dummySalt
      const expected = user ? Buffer.from(user.passwordHash, 'hex') : dummyHash
      const candidate = await derive(parsed.data.password, salt)
      const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected)
      if (!user || !user.active || !matches) {
        const count = (gate?.count ?? 0) + 1
        failures.set(username, {
          count,
          lockedUntil: count >= failuresBeforeLock ? now() + lockDuration : 0,
        })
        throw new Error('Benutzername oder Passwort ist falsch oder Konto gesperrt.')
      }
      failures.delete(username)
      await database('recordLogin', user.id)
      return createSession(user)
    },
    logout(token) {
      sessions.delete(token)
      return true
    },
    requireSession,
  }
}

module.exports = { createAuthenticator }
